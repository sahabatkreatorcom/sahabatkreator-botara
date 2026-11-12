import { createHash } from "node:crypto";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import {
  channelAccounts,
  channelIdentities,
  profilePhotos,
  type Database,
  type ProfilePhoto,
} from "@sahabat-kreator/db";
import type { TenantContext } from "./tenant";
import { withTenantDb } from "./tx";
import { resolveR2ObjectStore } from "./r2-storage";
import type { PlatformSettingsOptions } from "./platform-settings";

/**
 * Avatar asli (Fase 6D) — foto profil Telegram untuk akun channel (bot)
 * dan kontak (pengguna), disimpan sebagai byte di tabel `profile_photos`
 * dan disajikan HANYA lewat endpoint kita sendiri di balik sesi +
 * membership. Alasannya keamanan: URL file Bot API menyematkan token bot
 * (`/file/bot<token>/...`) — mengeksposnya ke klien sama dengan membocorkan
 * kredensial penuh channel. Token juga tidak pernah masuk log modul ini:
 * error jaringan fetch bisa memuat URL bertoken, jadi yang dicatat hanya
 * label tahap yang gagal, bukan objek error-nya.
 *
 * Keputusan ukuran foto: `getUserProfilePhotos` mengembalikan, per foto,
 * daftar ukuran menaik (160/320/640/...). Yang disimpan adalah ukuran
 * TERBESAR yang kedua sisinya ≤ 512px — cukup tajam untuk avatar kartu &
 * daftar (ditampilkan ≤96px) tanpa membebani DB; bila semua ukuran lebih
 * besar dari 512px diambil yang TERKECIL (paling ringan di antara yang
 * ada), dan bila semuanya lebih kecil diambil yang terbesar.
 */

export type ProfilePhotoOwnerType = ProfilePhoto["ownerType"];

/** Batas sisi foto profil yang disimpan (lihat keputusan ukuran di atas). */
export const PROFILE_PHOTO_MAX_EDGE = 512;

/**
 * Awalan kunci objek R2 untuk avatar TikTok: kunci penuhnya
 * `avatars/tiktok/<channel_account_id>.<ext>` — deterministik per
 * akun, jadi pengambilan ulang (reconnect/backfill) MENIMPA objek
 * yang sama, bukan menumpuk objek baru. Hanya avatar TikTok yang
 * memakai R2 (keputusan pemilik 2026-11-12); awalan ini satu-satunya
 * tempat string-nya ditulis agar titik panggil tidak berdrift.
 */
export const TIKTOK_AVATAR_R2_KEY_PREFIX = "avatars/tiktok";
/** Batas keras ukuran unduhan foto (sanity — foto profil Telegram jauh di bawah ini). */
const PROFILE_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TELEGRAM_API_BASE = "https://api.telegram.org";

// ---------------------------------------------------------------------------
// Penyimpanan (konteks tenant, RLS)
// ---------------------------------------------------------------------------

/**
 * Menyimpan/menimpa foto seorang pemilik (upsert atas index unik
 * (tenant, owner_type, owner_id)). `etag` dihitung dari byte foto
 * (SHA-256 hex) untuk cache HTTP endpoint penyaji.
 */
export async function storeProfilePhoto(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  input: {
    ownerType: ProfilePhotoOwnerType;
    ownerId: string;
    contentType: string;
    data: Buffer;
  },
): Promise<ProfilePhoto> {
  const etag = createHash("sha256").update(input.data).digest("hex");
  const now = new Date();
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .insert(profilePhotos)
      .values({
        tenantId: ctx.tenantId,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        contentType: input.contentType,
        storage: "db",
        objectKey: null,
        data: input.data,
        etag,
        fetchedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          profilePhotos.tenantId,
          profilePhotos.ownerType,
          profilePhotos.ownerId,
        ],
        set: {
          contentType: input.contentType,
          // Bentuk bytea menegakkan bentuk barisnya sendiri: bila
          // baris sebelumnya berbentuk R2, penulisan bytea (mis.
          // fallback sesudah R2 dinonaktifkan) mengembalikannya ke
          // bentuk 'db' secara utuh — tidak ada baris campuran.
          storage: "db",
          objectKey: null,
          data: input.data,
          etag,
          fetchedAt: now,
          updatedAt: now,
        },
      })
      .returning();
    return row;
  });
}

/**
 * Menyimpan/menimpa foto yang bytenya hidup sebagai OBJEK R2
 * (pasangan `storeProfilePhoto` untuk bentuk 'r2', migrasi 0024):
 * baris hanya mencatat penunjuk objek + content type + etag
 * (SHA-256 byte foto, dihitung PENULIS objek sebelum PUT agar
 * semantik ETag endpoint penyaji identik dengan bentuk bytea).
 * Penulisan objeknya sendiri adalah urusan pemanggil lewat
 * `resolveR2ObjectStore` — fungsi ini murni baris DB.
 */
export async function storeProfilePhotoObject(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  input: {
    ownerType: ProfilePhotoOwnerType;
    ownerId: string;
    contentType: string;
    /** Kunci objek R2 tempat byte foto sudah ditulis. */
    objectKey: string;
    /** SHA-256 hex byte foto (dihitung dari byte, bukan dari objek). */
    etag: string;
  },
): Promise<ProfilePhoto> {
  const now = new Date();
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .insert(profilePhotos)
      .values({
        tenantId: ctx.tenantId,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        contentType: input.contentType,
        storage: "r2",
        objectKey: input.objectKey,
        data: null,
        etag: input.etag,
        fetchedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          profilePhotos.tenantId,
          profilePhotos.ownerType,
          profilePhotos.ownerId,
        ],
        set: {
          contentType: input.contentType,
          storage: "r2",
          objectKey: input.objectKey,
          data: null,
          etag: input.etag,
          fetchedAt: now,
          updatedAt: now,
        },
      })
      .returning();
    return row;
  });
}

/**
 * Byte foto untuk penyajian, apa pun bentuk barisnya: bentuk 'db'
 * langsung dari kolom bytea; bentuk 'r2' diambil dari objek R2 di
 * sisi server (bucket tetap privat — penyajian TIDAK bergantung pada
 * domain publik media, dan web tidak tahu bedanya). Mengembalikan
 * null bila foto tidak bisa dibaca (R2 belum terkonfigurasi, objek
 * hilang, atau R2 tak terjangkau) — penyaji menjawab 404 dan web
 * jatuh ke inisial, persis seperti foto belum ada.
 */
export async function fetchProfilePhotoBytes(
  db: Database,
  photo: ProfilePhoto,
  platformOptions?: PlatformSettingsOptions,
): Promise<Buffer | null> {
  if (photo.storage === "db") {
    return photo.data ? Buffer.from(photo.data) : null;
  }
  if (!photo.objectKey || !platformOptions) return null;
  try {
    const resolved = await resolveR2ObjectStore(db, platformOptions);
    if (!resolved) return null;
    const object = await resolved.store.get(photo.objectKey);
    return object?.data ?? null;
  } catch {
    // Label generik saja — pesan error klien R2 tidak memuat
    // kredensial, tetapi URL endpoint tidak perlu diedarkan ke log.
    console.error(
      `[avatars] pengambilan objek avatar R2 gagal (pemilik ${photo.ownerType}:${photo.ownerId})`,
    );
    return null;
  }
}

/** Satu foto pemilik di tenant ini; null bila belum ada. */
export async function getProfilePhoto(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  ownerType: ProfilePhotoOwnerType,
  ownerId: string,
): Promise<ProfilePhoto | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(profilePhotos)
      .where(
        and(
          eq(profilePhotos.tenantId, ctx.tenantId),
          eq(profilePhotos.ownerType, ownerType),
          eq(profilePhotos.ownerId, ownerId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

/**
 * Himpunan ownerId (dari daftar yang ditanyakan) yang SUDAH punya foto —
 * untuk serializer daftar (channel/kontak/percakapan) memutuskan
 * `avatarUrl` tanpa mengambil byte foto sama sekali.
 */
export async function listProfilePhotoOwnerIds(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  ownerType: ProfilePhotoOwnerType,
  ownerIds: string[],
): Promise<Set<string>> {
  if (ownerIds.length === 0) return new Set();
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const rows = await tx
      .select({ ownerId: profilePhotos.ownerId })
      .from(profilePhotos)
      .where(
        and(
          eq(profilePhotos.tenantId, ctx.tenantId),
          eq(profilePhotos.ownerType, ownerType),
          inArray(profilePhotos.ownerId, ownerIds),
        ),
      );
    return new Set(rows.map((r) => r.ownerId));
  });
}

/**
 * Peta contactId → channelAccountId untuk kontak yang ADALAH akun
 * channel itu sendiri: kontak jangkar sasaran linimasa (Page/IG/
 * Threads/Bluesky/YouTube/LinkedIn/Pinterest/Google Business/TikTok —
 * lihat `ensureTimelineTargets` di posts.ts) dibuat dari identitas
 * `(channel_account_id, external_id akun)`, jadi identitas kontak yang
 * `external_user_id`-nya SAMA DENGAN `external_id` akun channel-nya
 * adalah penanda persis "kontak ini = akun itu".
 *
 * Dipakai resolusi avatar efektif (inbox & kontak): baris yang mewakili
 * akun itu sendiri boleh jatuh ke FOTO AKUN CHANNEL bila foto kontak
 * tidak ada — tanpa menyalin byte foto ke baris kontak, dan tanpa
 * pernah menempelkan foto akun ke kontak orang lain (identitas kontak
 * biasa tidak akan cocok dengan uji kesamaan ini).
 */
export async function mapContactsToSelfChannelAccounts(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  contactIds: string[],
): Promise<Map<string, string>> {
  if (contactIds.length === 0) return new Map();
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const rows = await tx
      .select({
        contactId: channelIdentities.contactId,
        channelAccountId: channelAccounts.id,
      })
      .from(channelIdentities)
      .innerJoin(
        channelAccounts,
        eq(channelIdentities.channelAccountId, channelAccounts.id),
      )
      .where(
        and(
          eq(channelIdentities.tenantId, ctx.tenantId),
          eq(channelAccounts.tenantId, ctx.tenantId),
          inArray(channelIdentities.contactId, contactIds),
          // Inti uji "kontak = akun itu sendiri": id eksternal pada
          // identitas kontak sama dengan id eksternal akun channel.
          eq(channelIdentities.externalUserId, channelAccounts.externalId),
        ),
      );
    const map = new Map<string, string>();
    for (const row of rows) {
      // Satu kontak secara praktik hanya bisa menjadi dirinya bagi
      // satu akun; entri pertama dipertahankan agar deterministik.
      if (!map.has(row.contactId)) map.set(row.contactId, row.channelAccountId);
    }
    return map;
  });
}

/** Provider yang secara resmi menyediakan foto profil KONTAK (DM). */
export type ContactPhotoProvider = "telegram" | "messenger" | "instagram";

export interface ContactPhotoFetchCandidate {
  contactId: string;
  provider: ContactPhotoProvider;
  /** Id user kontak di provider (chat_id Telegram / PSID / IGSID). */
  externalUserId: string;
  channelAccountId: string;
  /** Token akun channel TERENKRIPSI — lapisan route yang mendekripsi. */
  accessTokenEncrypted: string;
}

/**
 * Kandidat pengambilan foto kontak untuk backfill malas: identitas
 * kontak-kontak yang ditanyakan pada provider yang menyediakan foto
 * profil kontak (Telegram Bot API `getUserProfilePhotos`; Graph Meta
 * `profile_pic`/`profile_picture_url`), menempel ke akun channel yang
 * masih 'connected' dan membawa token tersimpan.
 *
 * Provider lain SENGAJA tidak masuk: WhatsApp Cloud API tidak
 * menyediakan endpoint foto profil pengguna (webhook hanya membawa
 * nama), dan webchat tidak punya sumber foto sama sekali — kontak
 * provider itu tetap berinisial, itu batas platform yang jujur, bukan
 * sesuatu yang bisa di-backfill. Pemanggil menyaring sendiri kontak
 * yang sudah berfoto; fungsi ini murni resolusi identitas → akun.
 */
export async function listContactPhotoFetchCandidates(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  contactIds: string[],
): Promise<ContactPhotoFetchCandidate[]> {
  if (contactIds.length === 0) return [];
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const rows = await tx
      .select({
        contactId: channelIdentities.contactId,
        provider: channelIdentities.provider,
        externalUserId: channelIdentities.externalUserId,
        channelAccountId: channelAccounts.id,
        accessTokenEncrypted: channelAccounts.accessTokenEncrypted,
      })
      .from(channelIdentities)
      .innerJoin(
        channelAccounts,
        eq(channelIdentities.channelAccountId, channelAccounts.id),
      )
      .where(
        and(
          eq(channelIdentities.tenantId, ctx.tenantId),
          eq(channelAccounts.tenantId, ctx.tenantId),
          inArray(channelIdentities.contactId, contactIds),
          inArray(channelIdentities.provider, [
            "telegram",
            "messenger",
            "instagram",
          ]),
          eq(channelAccounts.status, "connected"),
          isNotNull(channelAccounts.accessTokenEncrypted),
        ),
      );
    const candidates: ContactPhotoFetchCandidate[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      // Satu kandidat per kontak sudah cukup untuk satu putaran
      // backfill; identitas lain dicoba pada putaran berikutnya bila
      // yang ini tidak menghasilkan foto (cache negatif menjarakinya).
      if (seen.has(row.contactId) || !row.accessTokenEncrypted) continue;
      seen.add(row.contactId);
      candidates.push({
        contactId: row.contactId,
        provider: row.provider as ContactPhotoProvider,
        externalUserId: row.externalUserId,
        channelAccountId: row.channelAccountId,
        accessTokenEncrypted: row.accessTokenEncrypted,
      });
    }
    return candidates;
  });
}

/**
 * Menghapus foto milik satu akun channel — dipakai purge Sampah (Fase 6I)
 * agar baris foto tidak yatim saat akunnya dihapus permanen. Foto KONTAK
 * tidak disentuh purge (kontak dipertahankan sebagai CRM tenant).
 * Mengembalikan jumlah baris terhapus.
 */
export async function deleteChannelAccountProfilePhoto(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  channelAccountId: string,
): Promise<number> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const removed = await tx
      .delete(profilePhotos)
      .where(
        and(
          eq(profilePhotos.tenantId, ctx.tenantId),
          eq(profilePhotos.ownerType, "channel_account"),
          eq(profilePhotos.ownerId, channelAccountId),
        ),
      )
      .returning({ id: profilePhotos.id });
    return removed.length;
  });
}

/**
 * Ambil & simpan foto profil dari URL publik yang diberikan API
 * platform (Threads `threads_profile_picture_url`, TikTok `avatar_url`,
 * LinkedIn `picture`, Pinterest `profile_image`, Bluesky `avatar`) —
 * pasangan URL dari `fetchAndStoreTelegramProfilePhoto`: byte foto
 * diunduh SEKALI lalu disimpan ke `profile_photos` dan disajikan lewat
 * endpoint kita sendiri, jadi URL CDN platform (yang bisa kedaluwarsa /
 * bertanda tangan) tidak pernah diekspos ke klien.
 *
 * Fail-soft total seperti pola avatar lain: mengembalikan false untuk
 * SEMUA kegagalan (URL kosong/bukan http(s), unduhan gagal, bukan
 * gambar, terlalu besar) dan TIDAK PERNAH melempar — kegagalan foto
 * tidak boleh menggagalkan connect; kartu Channels jatuh ke inisial
 * dan backfill daftar channel mencoba lagi nanti. URL tidak pernah
 * masuk log (URL CDN bisa memuat tanda tangan).
 *
 * Opsi `r2` (KHUSUS TikTok — keputusan pemilik 2026-11-12): bila
 * pengisi memintanya, byte yang terunduh ditulis ke Cloudflare R2
 * lebih dulu dan baris `profile_photos` menunjuk objeknya, karena
 * URL avatar CDN TikTok bertanda tangan & kedaluwarsa sehingga
 * salinan berkasnya harus tinggal di penyimpanan objek platform
 * sendiri. FALLBACK WAJIB: R2 belum terkonfigurasi (kredensial panel
 * kosong) ATAU tulis R2 gagal → bytea basis data persis seperti tanpa
 * opsi ini (dicatat jujur di log internal) — bentuk R2 aktif dengan
 * sendirinya pada pengambilan berikutnya begitu kredensial R2 di
 * Panel Admin terisi. Pemanggil non-TikTok TIDAK mengisi opsi ini.
 */
export async function fetchAndStoreProfilePhotoFromUrl(
  db: Database,
  input: {
    tenantId: string;
    /** Id baris channel_accounts pemilik foto. */
    channelAccountId: string;
    /** URL foto dari respons API platform; null/kosong = tidak ada foto. */
    pictureUrl: string | null | undefined;
    /** Batas waktu unduhan (default 5 dtk — jalur ini best-effort). */
    timeoutMs?: number;
    /**
     * Simpan byte ke R2 (bukan bytea) — hanya titik panggil TikTok
     * yang mengisinya; lihat catatan `r2` pada komentar fungsi.
     */
    r2?: {
      /** Resolver Panel Admin untuk identitas + kredensial R2. */
      platformOptions: PlatformSettingsOptions;
      /** Awalan kunci objek; kunci penuh `${keyPrefix}/${channelAccountId}.${ext}`. */
      keyPrefix: string;
    };
  },
): Promise<boolean> {
  const url = input.pictureUrl?.trim();
  if (!url || !/^https?:\/\//i.test(url)) return false;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(input.timeoutMs ?? 5_000),
    });
    if (!response.ok) return false;
    const contentType =
      response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    if (contentType && !contentType.startsWith("image/")) return false;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > PROFILE_PHOTO_MAX_BYTES) {
      return false;
    }
    const effectiveContentType = contentType || "image/jpeg";
    if (input.r2) {
      const storedToR2 = await tryStoreProfilePhotoToR2(db, {
        tenantId: input.tenantId,
        channelAccountId: input.channelAccountId,
        contentType: effectiveContentType,
        bytes,
        r2: input.r2,
      });
      if (storedToR2) return true;
      // Jatuh ke bytea di bawah — TANPA melempar: fallback ini adalah
      // perilaku normal selama kredensial R2 panel belum terisi.
    }
    await storeProfilePhoto(db, { tenantId: input.tenantId }, {
      ownerType: "channel_account",
      ownerId: input.channelAccountId,
      contentType: effectiveContentType,
      data: bytes,
    });
    return true;
  } catch {
    // SENGAJA tanpa objek error/URL: cukup label generik.
    console.error(
      `[avatars] pengambilan foto profil dari URL gagal (akun ${input.channelAccountId})`,
    );
    return false;
  }
}

/** Ekstensi kunci objek dari content type (avatar TikTok: jpeg/webp pada praktiknya). */
function extensionForAvatarContentType(contentType: string): string {
  switch (contentType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default: {
      const subtype = contentType
        .split("/")[1]
        ?.replace(/[^a-z0-9]/gi, "")
        .toLowerCase();
      return subtype || "bin";
    }
  }
}

/**
 * Satu percobaan menulis avatar ke R2 + mencatat baris penunjuknya.
 * Mengembalikan false untuk SEMUA kegagalan (belum terkonfigurasi,
 * PUT ditolak, baris gagal ditulis) agar pemanggil jatuh ke bytea —
 * alasan spesifik dicatat di sini dengan label tahap saja (kredensial
 * dan URL tidak pernah masuk log).
 */
async function tryStoreProfilePhotoToR2(
  db: Database,
  input: {
    tenantId: string;
    channelAccountId: string;
    contentType: string;
    bytes: Buffer;
    r2: {
      platformOptions: PlatformSettingsOptions;
      keyPrefix: string;
    };
  },
): Promise<boolean> {
  let resolved: Awaited<ReturnType<typeof resolveR2ObjectStore>>;
  try {
    resolved = await resolveR2ObjectStore(db, input.r2.platformOptions);
  } catch {
    console.error(
      `[avatars] resolusi R2 gagal — avatar disimpan ke basis data (akun ${input.channelAccountId})`,
    );
    return false;
  }
  if (!resolved) {
    // Keadaan produksi yang sah sampai pemilik mengisi kredensial R2
    // di Panel Admin — bukan kegagalan, tetapi dicatat agar operator
    // tahu bentuk R2 belum aktif, bukan mengira sudah.
    console.error(
      `[avatars] kredensial R2 belum terisi — avatar disimpan ke basis data (akun ${input.channelAccountId})`,
    );
    return false;
  }
  const objectKey =
    `${input.r2.keyPrefix}/${input.channelAccountId}.` +
    extensionForAvatarContentType(input.contentType);
  try {
    await resolved.store.put(objectKey, input.bytes, input.contentType);
    await storeProfilePhotoObject(
      db,
      { tenantId: input.tenantId },
      {
        ownerType: "channel_account",
        ownerId: input.channelAccountId,
        contentType: input.contentType,
        objectKey,
        etag: createHash("sha256").update(input.bytes).digest("hex"),
      },
    );
    return true;
  } catch {
    console.error(
      `[avatars] penulisan avatar ke R2 gagal — disimpan ke basis data (akun ${input.channelAccountId})`,
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Pengambilan dari Telegram Bot API
// ---------------------------------------------------------------------------

interface TelegramPhotoSize {
  file_id: string;
  width: number;
  height: number;
}

/** Memilih ukuran foto sesuai keputusan di header modul. */
export function pickTelegramPhotoSize(
  sizes: TelegramPhotoSize[],
): TelegramPhotoSize | null {
  const valid = sizes.filter(
    (s) =>
      typeof s.file_id === "string" &&
      typeof s.width === "number" &&
      typeof s.height === "number",
  );
  if (valid.length === 0) return null;
  const sorted = [...valid].sort((a, b) => a.width - b.width);
  const withinCap = sorted.filter(
    (s) => s.width <= PROFILE_PHOTO_MAX_EDGE && s.height <= PROFILE_PHOTO_MAX_EDGE,
  );
  if (withinCap.length > 0) return withinCap[withinCap.length - 1];
  return sorted[0];
}

function contentTypeForTelegramFile(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  // Foto profil Telegram pada praktiknya selalu JPEG.
  return "image/jpeg";
}

export interface FetchTelegramProfilePhotoInput {
  tenantId: string;
  /** Token bot MENTAH — pemanggil yang mendekripsi (route connect memegangnya langsung). */
  botToken: string;
  /** Base URL Bot API (env TELEGRAM_API_BASE; default api.telegram.org). */
  telegramApiBase?: string;
  /** Id numerik pengguna Telegram (id bot untuk foto bot, id pengirim untuk kontak). */
  telegramUserId: string;
  ownerType: ProfilePhotoOwnerType;
  ownerId: string;
  /** Batas waktu per panggilan HTTP (default 5 dtk — jalur ini best-effort). */
  timeoutMs?: number;
}

/**
 * Mengambil foto profil Telegram seorang pengguna lewat Bot API akun
 * channel dan menyimpannya: `getUserProfilePhotos` → pilih ukuran →
 * `getFile` → unduh byte dari jalur file → upsert ke `profile_photos`.
 *
 * Mengembalikan true bila foto tersimpan; false untuk SEMUA kegagalan
 * maupun keadaan "pengguna tidak punya foto" — fungsi ini TIDAK PERNAH
 * melempar, karena semua pemicunya best-effort (connect, webhook, backfill
 * daftar): foto yang gagal tidak boleh menggagalkan alur utamanya.
 */
export async function fetchAndStoreTelegramProfilePhoto(
  db: Database,
  input: FetchTelegramProfilePhotoInput,
): Promise<boolean> {
  const base = (input.telegramApiBase ?? DEFAULT_TELEGRAM_API_BASE).replace(
    /\/+$/,
    "",
  );
  const timeoutMs = input.timeoutMs ?? 5_000;
  try {
    const callApi = async <T>(method: string, params: Record<string, unknown>): Promise<T | null> => {
      const response = await fetch(`${base}/bot${input.botToken}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return null;
      const body = (await response.json()) as {
        ok?: boolean;
        result?: T;
      };
      return body.ok === true && body.result !== undefined ? body.result : null;
    };

    const photos = await callApi<{
      total_count: number;
      photos: TelegramPhotoSize[][];
    }>("getUserProfilePhotos", { user_id: Number(input.telegramUserId) });
    if (!photos || photos.total_count === 0 || !photos.photos?.[0]) {
      return false; // pengguna memang tidak punya foto profil
    }
    const size = pickTelegramPhotoSize(photos.photos[0]);
    if (!size) return false;

    const file = await callApi<{ file_path?: string }>("getFile", {
      file_id: size.file_id,
    });
    if (!file?.file_path) return false;

    const download = await fetch(
      `${base}/file/bot${input.botToken}/${file.file_path}`,
      { signal: AbortSignal.timeout(timeoutMs) },
    );
    if (!download.ok) return false;
    const bytes = Buffer.from(await download.arrayBuffer());
    if (bytes.length === 0 || bytes.length > PROFILE_PHOTO_MAX_BYTES) {
      return false;
    }

    await storeProfilePhoto(db, { tenantId: input.tenantId }, {
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      contentType: contentTypeForTelegramFile(file.file_path),
      data: bytes,
    });
    return true;
  } catch {
    // SENGAJA tanpa objek error: pesan error fetch bisa memuat URL
    // bertoken. Cukup label tahap di pemanggil bila perlu.
    console.error(
      `[avatars] pengambilan foto profil telegram gagal (owner ${input.ownerType}:${input.ownerId})`,
    );
    return false;
  }
}
