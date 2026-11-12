import type { Database } from "@sahabat-kreator/db";
import {
  extractRawProviderMessageId,
  getMediaForServing,
  getMessageProviderMessageId,
  listQueuedMetaDeliveries,
  messageTypeForMime,
  setChannelAccountTokenType,
  type MediaObjectStore,
  type MetaQueuedDelivery,
} from "@sahabat-kreator/core";
import {
  MetaGraphClient,
  MetaGraphError,
} from "@sahabat-kreator/channel-messenger";
import {
  WhatsAppCloudClient,
  WhatsAppGraphError,
} from "@sahabat-kreator/channel-whatsapp";
import type { RealtimePublisher } from "@sahabat-kreator/queue";
import {
  startDeliveryPoller,
  type DeliveryPoller,
  type QueuedDeliveryBase,
} from "./runner";

/**
 * Poller pengiriman Meta (Fase 7A; WhatsApp Fase 7B) — berupa
 * SPESIFIKASI di atas runner bersama `./runner.ts` (Hotfix analisis
 * 2026-11-03: siklus klaim/kirim/tandai/log/nudge sebelumnya
 * diduplikasi dengan poller Telegram).
 *
 * Semua balasan (dashboard, automation, sequence, agent AI) untuk
 * percakapan messenger/instagram/whatsapp berakhir sebagai pesan outbound
 * `queued` di DB. Runner memindai antrean lintas tenant, mengklaim tiap
 * baris, lalu memanggil `send` di bawah:
 * - Messenger: Send API `POST /{page-id}/messages` (messaging_type
 *   RESPONSE);
 * - Instagram: Send API `POST /{objek}/messages` — objek mengikuti
 *   varian token akun (probe `/me` ber-cache): System User token
 *   (SUAT/Unified Login) → id akun IG, Page token (Facebook Login) →
 *   `me` (hotfix bug balasan IG 2026-11-05, `meta_graph_100` subcode
 *   2534014);
 * - WhatsApp: Cloud API `POST /{phone_number_id}/messages`
 *   (messaging_product whatsapp; template resmi bila payload template).
 *
 * Token TIDAK PERNAH dicatat: log hanya memuat kode error aman.
 */

type MetaDelivery = MetaQueuedDelivery & QueuedDeliveryBase;

export interface MetaPollerOptions {
  /** Material kunci enkripsi kredensial channel (env CHANNEL_TOKEN_SECRET). */
  channelTokenSecret: string | undefined;
  /** Base URL Graph API (env META_API_BASE; default graph.facebook.com). */
  metaApiBase: string | undefined;
  /** Versi Graph ter-pin (dari @sahabat-kreator/config). */
  graphApiVersion: string;
  /** Penerbit nudge realtime (Fase 6G). */
  publisher?: RealtimePublisher | null;
  /**
   * Penyimpanan objek media (Fase 18B). Diperlukan untuk mengirim
   * lampiran: byte-nya dibaca dari sini lalu diunggah ke Meta.
   * Tanpa store, pesan berlampiran gagal dengan kode yang jelas —
   * bukan terkirim sebagai teks kosong.
   */
  mediaStore?: MediaObjectStore | null;
}

export type MetaDeliveryPoller = DeliveryPoller;

/**
 * Cache varian token per akun IG: `suat=true` berarti token System User
 * (Unified Login/SUAT) → kirim ke id akun IG; selain itu Page token →
 * kirim ke `me`. Sejak lifecycle 0010 cache hanya jaring pengaman:
 * varian tersimpan di kolom `token_type` (tersimpan saat connect atau
 * hasil write-back probe pertama), sehingga tiap akun membayar SATU
 * probe `/me` seumur hidup proses, bukan per TTL.
 */
const instagramSendVariant = new Map<
  string,
  { suat: boolean; expiresAt: number }
>();

/** TTL pengaman bila varian masih harus di-probe (akun warisan). */
const INSTAGRAM_SEND_VARIANT_TTL_MS = 5 * 60_000;

/**
 * Peta varian token tersimpan → apakah token System User:
 * - system_user_token / business_token → ya (kirim ke id akun IG);
 * - page_access_token → tidak (kirim ke `me`);
 * - null (akun warisan) → null = belum tahu, perlu probe.
 */
export function instagramSendVariantFromTokenType(
  tokenType: string | null,
): boolean | null {
  if (tokenType === "system_user_token" || tokenType === "business_token") {
    return true;
  }
  if (tokenType === "page_access_token") return false;
  return null;
}

/**
 * Pilih objek pemilik endpoint Send API Instagram dari varian token
 * akun (hasil probe `/me`).
 *
 * - Page Access Token (Facebook Login; webhook `entry.id` tetap id akun
 *   IG): IGSID hanya ter-resolve di konteks Page — memakai
 *   `/{ig-user-id}/messages` ditolak Graph code 100 subcode 2534014
 *   "Pengguna yang diminta tidak dapat ditemukan" walau percakapannya
 *   nyata. Meta mendokumentasikan `/{page-id}/messages` atau `/me`
 *   untuk varian ini → kirim ke `me`.
 * - System User token (Unified Login/SUAT): `/me` adalah business
 *   integration system user, BUKAN akun IG ("Always use the Instagram
 *   account ID" — docs Meta) → kirim ke id akun IG tersimpan.
 */
export function pickInstagramSendObjectId(
  suat: boolean,
  accountExternalId: string,
): string {
  return suat ? accountExternalId : "me";
}

/**
 * Resolusi objek kirim Instagram (lifecycle 0010):
 * 1. Varian TERsimpan (`token_type` kolom akun) dipakai langsung — tanpa
 *    panggilan Graph apa pun.
 * 2. Akun warisan (varian NULL) di-probe sekali (`/me?fields=
 *    id,client_business_id`; field itu hanya ada pada System User token)
 *    lalu hasilnya ditulis balik ke DB lewat `persist` dan di-cache —
 *    pengiriman berikutnya tak pernah men-probe lagi.
 */
export async function resolveInstagramSendObjectId(
  client: MetaGraphClient,
  delivery: Pick<
    MetaDelivery,
    "channelAccountId" | "accountExternalId" | "tokenType"
  >,
  persist?: (tokenType: "page_access_token" | "system_user_token") => Promise<void>,
): Promise<string> {
  const key = delivery.channelAccountId;
  const stored = instagramSendVariantFromTokenType(delivery.tokenType ?? null);
  if (stored !== null) return pickInstagramSendObjectId(stored, delivery.accountExternalId);

  const now = Date.now();
  let variant = instagramSendVariant.get(key);
  if (!variant || variant.expiresAt <= now) {
    const profile = await client.getTokenProfile().catch(() => null);
    const suat = Boolean(profile?.clientBusinessId);
    variant = { suat, expiresAt: now + INSTAGRAM_SEND_VARIANT_TTL_MS };
    instagramSendVariant.set(key, variant);
    // Tulis balik varian yang terbaca (best-effort — kegagalan DB tidak
    // boleh menggagalkan pengiriman; probe akan berulang di siklus lain).
    void persist?.(suat ? "system_user_token" : "page_access_token").catch(
      () => {},
    );
  }
  return pickInstagramSendObjectId(variant.suat, delivery.accountExternalId);
}

/**
 * Deteksi error KREDENSIAL MATI (Graph 190 — token kedaluwarsa/invalid/
 * dicabut) untuk Meta & WhatsApp. Diekspor agar teruji langsung dan
 * dipakai spec poller Meta (`isAuthError` runner → akun 'error').
 */
export function metaSendSpecIsAuthError(err: unknown): boolean {
  return (
    (err instanceof MetaGraphError || err instanceof WhatsAppGraphError) &&
    err.graphCode === 190
  );
}

export function startMetaDeliveryPoller(
  db: Database,
  opts: MetaPollerOptions,
  intervalMs = 2_000,
): MetaDeliveryPoller {
  return startDeliveryPoller<MetaDelivery>(
    db,
    {
      name: "meta",
      scan: async (conn) =>
        (await listQueuedMetaDeliveries(conn)).map((delivery) => ({
          ...delivery,
          encryptedToken: delivery.encryptedAccessToken,
          recipientLabel: delivery.recipientExternalId,
          logProvider: delivery.provider,
        })),
      emptyTextCode: "meta_empty_text",
      missingCredentialsCode: "meta_missing_credentials",
      undecryptableCode: "meta_token_undecryptable",
      async send(delivery, token, conn) {
        // Fase 7B.5: kutipan keluar. Id mentah target (wamid/mid)
        // diturunkan dari baris targetnya dalam konteks tenant ini —
        // tidak pernah disimpan duplikat di antrean lintas tenant.
        // - WhatsApp: diteruskan sebagai context.message_id (native).
        // - Messenger/IG: Send API TIDAK mendokumentasikan parameter
        //   kutipan keluar (lihat catatan keterbatasan di
        //   MetaGraphClient.sendMessage) → id ini SENGAJA tidak dipakai
        //   di cabang itu; pesan tetap terkirim polos dan blok kutipannya
        //   hidup di inbox kita.
        let quotedRawId: string | null = null;
        if (delivery.replyToMessageId) {
          quotedRawId = extractRawProviderMessageId(
            await getMessageProviderMessageId(
              conn,
              { tenantId: delivery.tenantId },
              delivery.replyToMessageId,
            ),
          );
        }

        if (delivery.provider === "whatsapp") {
          const waClient = new WhatsAppCloudClient({
            baseUrl: opts.metaApiBase,
            apiVersion: opts.graphApiVersion,
            accessToken: token,
          });
          // Fase 18B: pesan berlampiran. Byte dibaca di konteks tenant
          // (bukan dari hasil pindai lintas tenant — `media` tidak
          // terbuka untuk pindai), lalu diunggah ke Meta. Caption
          // diambil dari contentText.
          if (delivery.mediaId) {
            if (!opts.mediaStore) {
              throw new Error("media_store_not_configured");
            }
            const attachment = await getMediaForServing(
              conn,
              { tenantId: delivery.tenantId },
              delivery.mediaId,
            );
            if (!attachment) throw new Error("media_row_missing");
            const object = await opts.mediaStore.get(attachment.r2Key);
            // Baris ada, objek tidak: volume penyimpanan diganti atau
            // berkas terhapus. Dibiarkan melempar supaya pesan berakhir
            // `failed` dengan kode yang bisa ditelusuri, bukan terkirim
            // sebagai pesan kosong.
            if (!object) throw new Error("media_object_missing");
            const mimeType =
              attachment.mimeType ?? object.contentType ?? "application/octet-stream";
            return (
              await waClient.sendMediaMessage({
                phoneNumberId: delivery.accountExternalId,
                to: delivery.recipientExternalId,
                kind: messageTypeForMime(mimeType),
                data: object.data,
                mimeType,
                fileName: attachment.fileName,
                caption: delivery.contentText,
                ...(quotedRawId ? { contextMessageId: quotedRawId } : {}),
              })
            ).providerMessageId;
          }
          // Fase 10A: pesan bertemplatePayload dikirim sebagai pesan
          // TEMPLATE resmi (satu-satunya bentuk proaktif di luar jendela
          // 24 jam); kutipan tidak berlaku untuk template.
          if (delivery.templatePayload) {
            // Fase 18C: header media harus diunggah ke Meta lebih dulu.
            // Media id kita tidak dikenal Meta, dan Cloud API tidak bisa
            // menarik berkas dari penyimpanan privat kita.
            let headerMedia:
              | { kind: "image" | "video" | "document"; mediaId: string }
              | undefined;
            const headerMediaId = delivery.templatePayload.headerMediaId;
            if (headerMediaId) {
              if (!opts.mediaStore) throw new Error("media_store_not_configured");
              const attachment = await getMediaForServing(
                conn,
                { tenantId: delivery.tenantId },
                headerMediaId,
              );
              if (!attachment) throw new Error("media_row_missing");
              const object = await opts.mediaStore.get(attachment.r2Key);
              if (!object) throw new Error("media_object_missing");
              const mimeType =
                attachment.mimeType ??
                object.contentType ??
                "application/octet-stream";
              const uploaded = await waClient.uploadMedia({
                phoneNumberId: delivery.accountExternalId,
                data: object.data,
                mimeType,
                fileName: attachment.fileName,
              });
              // Jenis header diturunkan dari MIME berkas. Antrean sudah
              // menolak pasangan yang mustahil (gambar untuk header VIDEO,
              // audio untuk header DOCUMENT), jadi audio di sini berarti
              // ada jalur yang melewati validasi — gagal keras lebih baik
              // daripada mengirim header yang pasti ditolak Meta.
              const headerKind = messageTypeForMime(mimeType);
              if (headerKind === "audio") {
                throw new Error("template_header_audio_unsupported");
              }
              headerMedia = { kind: headerKind, mediaId: uploaded.mediaId };
            }
            return (
              await waClient.sendTemplateMessage({
                phoneNumberId: delivery.accountExternalId,
                to: delivery.recipientExternalId,
                templateName: delivery.templatePayload.name,
                languageCode: delivery.templatePayload.languageCode,
                bodyParams: delivery.templatePayload.bodyParams,
                // Fase 17: template ber-variabel header/tombol URL hanya
                // bisa dikirim bila komponennya ikut — Meta memvalidasi
                // per komponen, bukan sebagai satu daftar parameter.
                headerParams: delivery.templatePayload.headerParams,
                buttonParams: delivery.templatePayload.buttonParams,
                ...(headerMedia ? { headerMedia } : {}),
              })
            ).providerMessageId;
          }
          // G17: katalog natif — muatan daftar interaktif dibentuk
          // menjadi pesan daftar WhatsApp resmi; body-nya adalah
          // contentText (daftar terbaca manusia) baris yang sama.
          if (delivery.interactivePayload?.kind === "whatsapp_list") {
            const list = delivery.interactivePayload;
            return (
              await waClient.sendInteractiveListMessage({
                phoneNumberId: delivery.accountExternalId,
                to: delivery.recipientExternalId,
                bodyText: delivery.contentText ?? "",
                buttonText: list.buttonText,
                sections: list.sections,
                ...(quotedRawId ? { contextMessageId: quotedRawId } : {}),
              })
            ).providerMessageId;
          }
          return (
                await waClient.sendTextMessage({
                  phoneNumberId: delivery.accountExternalId,
                  to: delivery.recipientExternalId,
                text: delivery.contentText!,
                ...(quotedRawId ? { contextMessageId: quotedRawId } : {}),
              })
            ).providerMessageId;
        }

        const client = new MetaGraphClient({
          baseUrl: opts.metaApiBase,
          apiVersion: opts.graphApiVersion,
          accessToken: token,
        });
        // Objek path kirim Instagram mengikuti varian token akun
        // (kolom token_type; probe `/me` hanya untuk akun warisan, hasil
        //nya ditulis balik ke DB). Lihat resolveInstagramSendObjectId.
        const sendObjectId =
          delivery.provider === "instagram"
            ? await resolveInstagramSendObjectId(
                client,
                delivery,
                // Write-back varian akun warisan (best-effort).
                (tokenType) =>
                  setChannelAccountTokenType(
                    conn,
                    { tenantId: delivery.tenantId },
                    delivery.channelAccountId,
                    tokenType,
                  ),
              )
            : delivery.accountExternalId;
        // G18: tombol aksi — template tombol Send API (Messenger;
        // hanya tombol telepon yang natif di sini, teks salin sudah
        // diturunkan core menjadi baris teks di contentText).
        if (
          delivery.provider === "messenger" &&
          delivery.interactivePayload?.kind === "messenger_button_template"
        ) {
          return (
            await client.sendButtonTemplateMessage({
              accountExternalId: sendObjectId,
              recipientExternalId: delivery.recipientExternalId,
              text: delivery.contentText ?? "",
              buttons: delivery.interactivePayload.buttons,
              recipientCommentId: delivery.providerCommentId,
            })
          ).providerMessageId;
        }
        // G17: katalog natif — template generik Send API (satu
        // elemen per produk + tombol postback Tambah ke Keranjang).
        if (delivery.interactivePayload?.kind === "generic_template") {
          return (
            await client.sendGenericTemplateMessage({
              accountExternalId: sendObjectId,
              recipientExternalId: delivery.recipientExternalId,
              elements: delivery.interactivePayload.elements,
              recipientCommentId: delivery.providerCommentId,
            })
          ).providerMessageId;
        }
        return (
          await client.sendMessage({
            accountExternalId: sendObjectId,
            recipientExternalId: delivery.recipientExternalId,
            text: delivery.contentText!,
            // Fase 10B: pesan DM comment-to-DM dikirim sebagai private
            // reply (recipient comment_id), bukan ke id pengguna.
            recipientCommentId: delivery.providerCommentId,
          })
        ).providerMessageId;
      },
      compositeProviderMessageId: (delivery, rawProviderId) =>
        `meta:${delivery.accountExternalId}:${rawProviderId}`,
      errorCode(err) {
        const graphErr =
          err instanceof MetaGraphError || err instanceof WhatsAppGraphError
            ? err
            : null;
        if (!graphErr) return "meta_send_error";
        if (graphErr.status === 0) return "meta_network_error";
        if (graphErr.graphCode === null) return `meta_http_${graphErr.status}`;
        // Subcode membedakan penyebab yang berbagi code 100 (mis.
        // 2534014 = penerima tak ter-resolve) — tanpa ini diagnosis
        // hanya bisa menebak dari "meta_graph_100".
        return graphErr.graphSubcode !== null
          ? `meta_graph_${graphErr.graphCode}_${graphErr.graphSubcode}`
          : `meta_graph_${graphErr.graphCode}`;
      },
      // Graph 190 = token ditolak (kedaluwarsa/invalid/dicabut). Tanpa
      // penandaan ini akun tetap 'connected' dan setiap balasan gagal
      // senyap; dengan ini inbox meminta "hubungkan ulang" (lifecycle 0010).
      isAuthError: metaSendSpecIsAuthError,
    },
    {
      channelTokenSecret: opts.channelTokenSecret,
      publisher: opts.publisher,
    },
    intervalMs,
  );
}
