import type { Database } from "@sahabat-kreator/db";
import {
  claimPostForPublish,
  decryptChannelSecret,
  getPostForPublish,
  markPostFailed,
  markPostPublished,
  recordIntegrationLog,
  type PostPublishPayload,
} from "@sahabat-kreator/core";
import {
  TikTokApiError,
  TikTokClient,
  tiktokErrorCode,
  type TikTokPrivacyLevel,
} from "@sahabat-kreator/channel-tiktok";
import {
  resolvePostPublicMediaUrl,
  type PostPublisherAdapter,
  type PostPublisherOptions,
  type PublishPostResult,
} from "./post-publisher";

/**
 * Penerbit TikTok (Gelombang 4) — publikasi saja, BUKAN inbox.
 *
 * Alurnya meniru adapter lain persis pada bagian yang menjaga
 * keamanan publikasi: klaim atomik dengan pencocokan jadwal lebih
 * dulu, lalu muat payload, dekripsi kredensial akun, kirim, dan
 * tandai hasil. Perbedaan TikTok ada pada protokol dan gerbangnya:
 *
 * - Konten = tepat SATU video ATAU foto/carousel khusus foto
 *   (capability + core menolak komposisi lain saat penjadwalan;
 *   pemeriksaan di sini pertahanan terakhir — campuran foto+video,
 *   multi-video, dan dokumen tidak pernah sampai ke provider).
 *   Video: biner dibaca dari object store privat lalu diunggah
 *   FILE_UPLOAD per potongan oleh klien — TikTok tidak menuntut
 *   URL publik untuk video, sama seperti YouTube/Bluesky. Foto:
 *   TIDAK ada jalur biner; TikTok menariknya dari URL publik
 *   (`PULL_FROM_URL`), jadi URL diselesaikan dari resolver media
 *   publik (Panel Admin → env → null) dan postingan gagal aman
 *   `tiktok_public_media_url_unavailable` SEBELUM panggilan API
 *   apa pun bila URL tidak tersedia (pola Instagram). Domain base
 *   URL itu harus diverifikasi pemilik di portal TikTok, kalau
 *   tidak provider menolak `url_ownership_unverified`.
 * - Judul postingan TikTok adalah CAPTION post itu sendiri
 *   (video: `post_info.title`; foto: caption menjadi `title` foto
 *   maks 90 sekaligus `description` maks 4000); kolom `title` post
 *   tidak dikirim ke platform dan tetap label internal kalender.
 * - Postingan foto membawa AUTO MUSIC: `auto_add_music: true`
 *   pada post_info foto (parameter resmi, hanya DIRECT_POST) —
 *   permintaan pemilik; TikTok menambahkan musik rekomendasi dan
 *   hasil terbit mencatatnya di log integrasi.
 * - PILIHAN KREATOR PER POSTINGAN (gelombang Pilihan Privasi &
 *   AI): level privasi = pilihan pengguna pada postingan
 *   (Content Sharing Guidelines mewajibkan kreator memilihnya
 *   sendiri; penjadwalan dari formulir menolak tanpa pilihan).
 *   Postingan TANPA pilihan (lama/non-formulir) memakai bawaan
 *   platform (Panel Admin → env, bawaan `SELF_ONLY` — level yang
 *   diizinkan sebelum aplikasi lolos audit) dan kejadian itu
 *   dicatat apa adanya di log integrasi ("privacy source default").
 *   Apa pun sumbernya, klien memvalidasi level terhadap
 *   `privacy_level_options` akun sebelum unggah dan TIDAK pernah
 *   menurunkannya diam-diam; hasil terbit mencatat levelnya di log
 *   integrasi, dan providerMessageId jatuh ke `publish_id` bila
 *   postingan tidak punya id publik (kasus SELF_ONLY) — postingan
 *   privat TIDAK pernah dicatat atau diklaim sebagai publik.
 *   Toggle interaksi, pengungkapan komersial, dan `is_aigc` juga
 *   dari opsi postingan (bawaan mati/tidak dinyatakan bila absen —
 *   sesuai guidelines, bukan pernyataan karangan).
 * - Access token OAuth pada akun channel berumur ±24 jam; sejak
 *   gelombang Semua OAuth, connect menyimpan refresh token
 *   terenkripsi dan worker lifecycle (src/tiktok-token-lifecycle.ts)
 *   menyegarkannya dengan grant `refresh_token` SEBELUM kedaluwarsa
 *   (rotasi penuh access+refresh). Token yang tetap kedaluwarsa —
 *   misalnya refresh token dicabut — dipetakan klien ke
 *   `tiktok_unauthorized` agar operator menghubungkan ulang akun.
 *
 * Satu-satunya percakapan yang disentuh adalah sasaran sintetis
 * `kind='channel'` milik akun TikTok itu sendiri.
 */

export async function publishTikTokPost(
  db: Database,
  input: { tenantId: string; postId: string; scheduledAt: string },
  opts: PostPublisherOptions,
): Promise<PublishPostResult> {
  const ctx = { tenantId: input.tenantId };
  const claim = await claimPostForPublish(db, {
    tenantId: input.tenantId,
    postId: input.postId,
    expectedScheduledAt: new Date(input.scheduledAt),
  });
  if (claim.kind === "not_found") {
    console.error(`[post] ${input.postId} tidak ditemukan — job dilewati`);
    return { published: false, reason: "not_found" };
  }
  if (claim.kind === "skipped") {
    console.log(
      `[post] ${input.postId} dilewati: status=${claim.status} (jadwal ${input.scheduledAt})`,
    );
    return { published: false, reason: `status_${claim.status}` };
  }

  const fail = async (code: string): Promise<PublishPostResult> => {
    await markPostFailed(db, { ...ctx, postId: input.postId, errorCode: code });
    await recordIntegrationLog(db, {
      direction: "out",
      provider: "tiktok",
      tenantId: input.tenantId,
      outcome: "failed",
      errorCode: code,
      summary: `channel post ${input.postId} failed`,
    });
    console.error(`[post] ${input.postId} gagal terbit: ${code}`);
    return { published: false, reason: code };
  };

  const payload = await getPostForPublish(db, {
    tenantId: input.tenantId,
    postId: input.postId,
  });
  if (!payload) return fail("post_target_missing");
  if (!payload.encryptedToken) return fail("tiktok_missing_credentials");
  if (!opts.channelTokenSecret) return fail("tiktok_token_secret_unset");
  const accessToken = decryptChannelSecret(
    opts.channelTokenSecret,
    payload.encryptedToken,
  );
  if (!accessToken) return fail("tiktok_token_undecryptable");

  // Komposisi media divalidasi SEBELUM API dipanggil (capability +
  // core menegakkannya saat penjadwalan; pemeriksaan di sini
  // pertahanan terakhir): tepat satu video, ATAU satu+ foto tanpa
  // campuran apa pun. Komposisi lain adalah kegagalan pasti yang
  // tidak boleh membakar panggilan creator_info/init.
  const isPhotoPost =
    payload.media.length > 0 &&
    payload.media.every((item) => item.kind === "photo");
  const isVideoPost =
    payload.media.length === 1 && payload.media[0]!.kind === "video";
  if (!isPhotoPost && !isVideoPost) {
    return fail("tiktok_media_kind_unsupported");
  }

  // Foto ditarik TikTok dari URL publik: selesaikan SEMUA URL lebih
  // dulu. Satu saja tidak tersedia → gagal aman di sini, sebelum
  // creator_info/init dipanggil (pola Instagram persis).
  let photoUrls: string[] | null = null;
  if (isPhotoPost) {
    photoUrls = [];
    for (const item of payload.media) {
      const url = resolvePostPublicMediaUrl(opts, item);
      if (!url) return fail("tiktok_public_media_url_unavailable");
      photoUrls.push(url);
    }
  }

  // Resolusi privasi berlapis: pilihan postingan → bawaan platform
  // (resolver panel→env di worker). `privacyFromDefault` dicatat di
  // log hasil terbit agar lapis yang dipakai tidak pernah tersamar.
  const postOptions = payload.publishOptions;
  const privacyFromDefault = !postOptions?.tiktokPrivacyLevel;
  const privacyLevel = (postOptions?.tiktokPrivacyLevel ??
    opts.tiktokPrivacyLevel ??
    "SELF_ONLY") as TikTokPrivacyLevel;
  const client = new TikTokClient({ baseUrl: opts.tiktokApiBase });

  try {
    const result = photoUrls
      ? await client.publishPhotos({
          accessToken,
          // Caption menjadi title foto (maks 90) + description
          // (maks 4000) — lihat pembangun payload di channel-tiktok.
          caption: payload.caption,
          privacyLevel,
          photoUrls,
          // Auto music: permintaan pemilik, dinyalakan eksplisit
          // di sini dan dicatat pada summary log di bawah.
          autoAddMusic: true,
          allowComment: postOptions?.tiktokAllowComment,
          brandOrganic: postOptions?.tiktokBrandOrganic,
          brandContent: postOptions?.tiktokBrandContent,
          isAigc: postOptions?.aiGenerated,
          pollIntervalMs: opts.tiktokStatusPollIntervalMs,
          maxPolls: opts.tiktokStatusMaxPolls,
        })
      : await publishSingleVideo(payload, accessToken);
    await markPostPublished(db, {
      ...ctx,
      postId: input.postId,
      providerMessageId: result.postId ?? result.publishId,
    });
    await recordIntegrationLog(db, {
      direction: "out",
      provider: "tiktok",
      tenantId: input.tenantId,
      channelAccountId: payload.channelAccountId,
      outcome: "sent",
      summary:
        `channel post ${input.postId} published ` +
        `(privacy ${result.privacyLevel}` +
        (privacyFromDefault ? " dari bawaan platform" : "") +
        `, status ${result.finalStatus}` +
        (photoUrls
          ? `, photos ${photoUrls.length}, auto music on`
          : ", video") +
        `)`,
    });
    console.log(
      `[post] ${input.postId} terbit (${result.postId ?? result.publishId}, ` +
        `privacy ${result.privacyLevel})`,
    );
    return { published: true };
  } catch (err) {
    // Error provider dipetakan dari kode resminya; kegagalan lokal
    // yang disengaja membawa kode aman pada `message` (pola adapter
    // Meta: `post_media_missing` dari muat biner video di atas).
    const code =
      err instanceof TikTokApiError
        ? tiktokErrorCode(err)
        : err instanceof Error && /^[a-z_]+$/.test(err.message)
          ? err.message
          : tiktokErrorCode(err);
    const detail =
      err instanceof TikTokApiError
        ? ` — ${err.description.slice(0, 200)}`
        : "";
    console.error(`[post] ${input.postId} ditolak provider: ${code}${detail}`);
    return fail(code);
  }

  // Payload diteruskan sebagai parameter (bukan tangkapan closure)
  // agar penyempitan non-null dari pemeriksaan di atas tetap
  // berlaku di dalam fungsi ini.
  async function publishSingleVideo(
    loaded: PostPublishPayload,
    token: string,
  ) {
    const media = loaded.media[0]!;
    const object = await opts.mediaStore.get(media.r2Key);
    if (!object) {
      // Kode yang sama seperti kegagalan muat media sebelumnya:
      // dilempar sebagai Error berkode aman agar tertangkap
      // pemetaan di atas dan ditandai gagal, bukan terkirim.
      throw new Error("post_media_missing");
    }
    const data = new Uint8Array(object.data);
    const contentType = media.mimeType ?? object.contentType ?? "video/mp4";
    return client.publishVideo({
      accessToken: token,
      // Judul postingan TikTok ADALAH caption; `title` post adalah
      // label internal kalender dan tidak dikirim ke platform.
      title: loaded.caption,
      privacyLevel,
      data,
      contentType,
      allowComment: postOptions?.tiktokAllowComment,
      allowDuet: postOptions?.tiktokAllowDuet,
      allowStitch: postOptions?.tiktokAllowStitch,
      brandOrganic: postOptions?.tiktokBrandOrganic,
      brandContent: postOptions?.tiktokBrandContent,
      isAigc: postOptions?.aiGenerated,
      pollIntervalMs: opts.tiktokStatusPollIntervalMs,
      maxPolls: opts.tiktokStatusMaxPolls,
    });
  }
}

export const tiktokPostPublisher: PostPublisherAdapter = {
  provider: "tiktok",
  publish: publishTikTokPost,
};
