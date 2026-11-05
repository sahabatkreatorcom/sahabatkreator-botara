import {
  extractRawProviderMessageId,
  getMessageProviderMessageId,
  listQueuedMetaDeliveries,
  setChannelAccountTokenType,
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
import type { AuthBundle } from "../../auth";
import {
  startDeliveryPoller,
  type DeliveryPoller,
  type QueuedDeliveryBase,
} from "../delivery-poller";

/**
 * Poller pengiriman Meta (Fase 7A; WhatsApp Fase 7B) — kini berupa
 * SPESIFIKASI di atas runner bersama `modules/delivery-poller.ts`
 * (Hotfix analisis 2026-11-03: siklus klaim/kirim/tandai/log/nudge
 * sebelumnya diduplikasi dengan poller Telegram).
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
  bundle: AuthBundle,
  opts: MetaPollerOptions,
  intervalMs = 2_000,
): MetaDeliveryPoller {
  return startDeliveryPoller<MetaDelivery>(
    bundle,
    {
      name: "meta",
      scan: async (db) =>
        (await listQueuedMetaDeliveries(db)).map((delivery) => ({
          ...delivery,
          encryptedToken: delivery.encryptedAccessToken,
          recipientLabel: delivery.recipientExternalId,
          logProvider: delivery.provider,
        })),
      emptyTextCode: "meta_empty_text",
      missingCredentialsCode: "meta_missing_credentials",
      undecryptableCode: "meta_token_undecryptable",
      async send(delivery, token, db) {
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
              db,
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
          // Fase 10A: pesan bertemplatePayload dikirim sebagai pesan
          // TEMPLATE resmi (satu-satunya bentuk proaktif di luar jendela
          // 24 jam); kutipan tidak berlaku untuk template.
          return delivery.templatePayload
            ? (
                await waClient.sendTemplateMessage({
                  phoneNumberId: delivery.accountExternalId,
                  to: delivery.recipientExternalId,
                  templateName: delivery.templatePayload.name,
                  languageCode: delivery.templatePayload.languageCode,
                  bodyParams: delivery.templatePayload.bodyParams,
                })
              ).providerMessageId
            : (
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
                    bundle.db,
                    { tenantId: delivery.tenantId },
                    delivery.channelAccountId,
                    tokenType,
                  ),
              )
            : delivery.accountExternalId;
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
