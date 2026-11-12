import {
  attributeContactToGrowthLink,
  decryptChannelSecret,
  fetchAndStoreTelegramProfilePhoto,
  recordTelegramChannelPost,
  recordTelegramInboundMessage,
  recordTelegramMyChatMember,
  type IntegrationLogInboundOutcome,
  type RecordIntegrationLogInput,
  type TelegramAccountRef,
} from "@sahabat-kreator/core";
import {
  parseTelegramCallbackQuery,
  parseTelegramChannelPost,
  parseTelegramUpdate,
  type TelegramUpdate,
} from "@sahabat-kreator/channel-telegram";
import type { RealtimePublisher } from "@sahabat-kreator/queue";
import type { AuthBundle } from "../../auth";

/**
 * Pemrosesan SATU update Telegram yang SUDAH lolos gerbang kepercayaan
 * (akun ter-resolve + secret terverifikasi + JSON valid) — diekstrak
 * dari route webhook (Fase 7B.2) agar jalur yang PERSIS sama bisa
 * dipakai ulang oleh replay log integrasi: replay tidak memalsukan
 * jalur baru, ia memanggil fungsi ini dengan payload tersimpan.
 *
 * Perilaku identik route live, termasuk:
 * - gerbang status akun: bukan `connected` → dicatat
 *   `ignored_disconnected` dan selesai (replay event lama sesudah akun
 *   reconnect akan lolos gerbang ini secara alami);
 * - setiap titik keluar menulis baris log lewat sink `log` yang
 *   diberikan pemanggil (route: pencatatan polos; replay: pencatatan +
 *   provenance di summary) — outcome tiap baris dikumpulkan dan
 *   dikembalikan berurutan;
 * - error core per event dicatat `error` lalu DILEMPAR ulang, sama
 *   seperti route (respons webhook live menjadi 500; pemanggil replay
 *   menangkapnya dan melaporkan outcome `error`).
 */
export interface TelegramProcessingDeps {
  db: AuthBundle["db"];
  publisher?: RealtimePublisher | null;
  /** Material kunci enkripsi kredensial channel (env CHANNEL_TOKEN_SECRET). */
  channelTokenSecret?: string;
  /** Base URL Bot API (env TELEGRAM_API_BASE; default api.telegram.org). */
  telegramApiBase?: string;
  /** Sink pencatatan log integrasi (best-effort di pemanggil). */
  log: (entry: RecordIntegrationLogInput) => Promise<void>;
}

export async function processTelegramUpdate(
  deps: TelegramProcessingDeps,
  account: TelegramAccountRef,
  payload: unknown,
): Promise<IntegrationLogInboundOutcome[]> {
  const outcomes: IntegrationLogInboundOutcome[] = [];
  const log = async (entry: RecordIntegrationLogInput): Promise<void> => {
    outcomes.push(entry.outcome as IntegrationLogInboundOutcome);
    await deps.log(entry);
  };

  if (account.status !== "connected") {
    await log({
      direction: "in",
      provider: "telegram",
      tenantId: account.tenantId,
      channelAccountId: account.id,
      signatureValid: true,
      outcome: "ignored_disconnected",
      summary: `update for ${account.status} account`,
      payload,
    });
    return outcomes;
  }

  // Update `my_chat_member` (Fase 6A.1): bot dimasukkan/dikeluarkan
  // grup. Bukan pesan — cukup jejak audit. Fase 6A.2: untuk chat
  // bertipe channel, bot yang menjadi ADMIN juga membuat percakapan
  // channel-nya tampil di dashboard (diurus core).
  // Kegagalan mencatat TIDAK boleh menggagalkan webhook (tetap 200).
  const memberUpdate = (payload as TelegramUpdate).my_chat_member;
  if (memberUpdate?.chat && typeof memberUpdate.chat.id === "number") {
    try {
      await recordTelegramMyChatMember(deps.db, account, {
        chatExternalId: String(memberUpdate.chat.id),
        chatTitle: memberUpdate.chat.title ?? null,
        memberStatus: memberUpdate.new_chat_member?.status ?? "unknown",
        chatType: memberUpdate.chat.type ?? null,
      });
      await log({
        direction: "in",
        provider: "telegram",
        tenantId: account.tenantId,
        channelAccountId: account.id,
        signatureValid: true,
        outcome: "recorded",
        summary: `my_chat_member update for chat ${memberUpdate.chat.id}`,
        payload,
      });
    } catch (err) {
      console.error("[telegram] gagal mencatat my_chat_member", err);
      await log({
        direction: "in",
        provider: "telegram",
        tenantId: account.tenantId,
        channelAccountId: account.id,
        signatureValid: true,
        outcome: "error",
        errorCode: "processing_error",
        summary: "failed to record my_chat_member update",
        payload,
      });
    }
    return outcomes;
  }

  // Update `channel_post` (Fase 6A.2): postingan channel tempat bot
  // menjadi admin — termasuk pantulan postingan yang kita kirim
  // sendiri dari dashboard (ter-dedup di core terhadap pesan outbound
  // yang menyimpan message_id yang sama). Bukan pesan percakapan:
  // masuk linimasa channel tanpa unread & tanpa automation/agent.
  // Non-teks → parser mengembalikan null → 200 diabaikan.
  if ((payload as TelegramUpdate).channel_post) {
    const post = parseTelegramChannelPost(payload);
    if (!post) {
      await log({
        direction: "in",
        provider: "telegram",
        tenantId: account.tenantId,
        channelAccountId: account.id,
        signatureValid: true,
        outcome: "ignored_status_only",
        summary: "non-text channel post",
        payload,
      });
      return outcomes;
    }
    let recorded: Awaited<ReturnType<typeof recordTelegramChannelPost>>;
    try {
      recorded = await recordTelegramChannelPost(deps.db, account, {
        chatExternalId: post.chatExternalId,
        chatTitle: post.chatTitle,
        // Sematkan id bot seperti jalur pesan: index unik global.
        providerMessageId: `telegram:${account.externalId}:${post.providerMessageId}`,
        // Fase 7B.5: kutipan antar-postingan — bentuk majemuk yang sama.
        replyToProviderMessageId: post.replyToProviderMessageId
          ? `telegram:${account.externalId}:${post.replyToProviderMessageId}`
          : null,
        // Hotfix 7B.6: snapshot isi postingan yang dikutip.
        replyToSnapshot: post.replyToSnapshot,
        text: post.text,
      });
    } catch (err) {
      await log({
        direction: "in",
        provider: "telegram",
        tenantId: account.tenantId,
        channelAccountId: account.id,
        signatureValid: true,
        outcome: "error",
        errorCode: "processing_error",
        summary: "failed to record channel post",
        payload,
      });
      throw err;
    }
    await log({
      direction: "in",
      provider: "telegram",
      tenantId: account.tenantId,
      channelAccountId: account.id,
      signatureValid: true,
      outcome: !recorded || recorded.duplicate ? "duplicate" : "recorded",
      summary: `channel post in chat ${post.chatExternalId}`,
      payload,
    });
    // Fase 6G: linimasa channel berubah — nudge dashboard (postingan
    // pantulan milik tenant lain mengembalikan null di core dan
    // tidak menghasilkan nudge di sini).
    if (recorded && deps.publisher) {
      await deps.publisher.publishNudge({
        kind: "message.received",
        tenantId: account.tenantId,
        conversationId: recorded.message.conversationId,
      });
    }
    return outcomes;
  }

  // Update `callback_query` (G5): ketukan tombol inline — padanan
  // postback Meta. Dicatat sebagai pesan masuk bersinyal postback
  // lewat record yang sama dengan pesan teks (kontak/percakapan dari
  // chat tempat tombol menempel; id dedup dari id callback, BUKAN
  // message_id pesan lama tempat tombol menempel). Data tombol adalah
  // payload sekaligus teks tampilnya (Telegram tidak memisahkan
  // judul). Callback tanpa data/pesan chat → parser null → diabaikan
  // berjejak. CATATAN: update ini hanya tiba bila webhook didaftarkan
  // dengan allowed_updates memuat callback_query (lihat channel).
  if ((payload as TelegramUpdate).callback_query) {
    const callback = parseTelegramCallbackQuery(payload);
    if (!callback) {
      await log({
        direction: "in",
        provider: "telegram",
        tenantId: account.tenantId,
        channelAccountId: account.id,
        signatureValid: true,
        outcome: "ignored_status_only",
        summary: "callback query without recordable payload",
        payload,
      });
      return outcomes;
    }
    let recorded: Awaited<ReturnType<typeof recordTelegramInboundMessage>>;
    try {
      recorded = await recordTelegramInboundMessage(deps.db, account, {
        senderExternalId: callback.senderExternalId,
        senderName: callback.senderName,
        senderUsername: callback.senderUsername ?? undefined,
        chatExternalId: callback.chatExternalId,
        isGroup: callback.isGroup,
        chatTitle: callback.chatTitle,
        providerMessageId: `telegram:${account.externalId}:cbq:${callback.callbackQueryId}`,
        text: callback.data,
        triggerSignal: {
          kind: "postback",
          payload: callback.data,
          title: null,
        },
      });
    } catch (err) {
      await log({
        direction: "in",
        provider: "telegram",
        tenantId: account.tenantId,
        channelAccountId: account.id,
        signatureValid: true,
        outcome: "error",
        errorCode: "processing_error",
        summary: `failed to record callback query from ${callback.senderExternalId}`,
        payload,
      });
      throw err;
    }
    await log({
      direction: "in",
      provider: "telegram",
      tenantId: account.tenantId,
      channelAccountId: account.id,
      signatureValid: true,
      outcome:
        recorded === null || recorded.duplicate ? "duplicate" : "recorded",
      summary: `callback query data=${callback.data} from ${callback.senderExternalId}`,
      payload,
    });
    if (recorded) {
      if (recorded.identityCreated) {
        triggerContactPhoto(deps, account, recorded.contactId, callback.senderExternalId);
      }
      if (deps.publisher) {
        await deps.publisher.publishNudge({
          kind: "message.received",
          tenantId: account.tenantId,
          conversationId: recorded.message.conversationId,
        });
      }
    }
    return outcomes;
  }

  const events = parseTelegramUpdate(payload);
  let handledCount = 0;
  if (events.length > 0) {
    const update = payload as TelegramUpdate;
    const from = update.message?.from;
    const senderName =
      [from?.first_name, from?.last_name]
        .filter((part): part is string => Boolean(part?.trim()))
        .join(" ")
        .trim() || "Telegram user";
    for (const event of events) {
      if (event.type !== "message.received" || !event.message?.text) {
        continue;
      }
      handledCount += 1;
      let recorded: Awaited<ReturnType<typeof recordTelegramInboundMessage>>;
      try {
        recorded = await recordTelegramInboundMessage(deps.db, account, {
          senderExternalId: event.message.senderExternalId,
          senderName,
          senderUsername: from?.username,
          // Fase 6A.1: alamat balasan = id CHAT (grup: id grup negatif),
          // terpisah dari identitas pengirim di atas.
          chatExternalId: event.message.conversationExternalId,
          isGroup: event.message.conversationKind === "group",
          chatTitle: event.message.conversationTitle ?? null,
          // Index unik provider_message_id bersifat global → sematkan id
          // bot agar pesan dari bot berbeda tidak bertabrakan.
          providerMessageId: `telegram:${account.externalId}:${event.message.providerMessageId ?? event.providerEventId ?? ""}`,
          // Fase 7B.5: reply_to_message pengirim — majemuk yang sama.
          replyToProviderMessageId: event.message.replyToProviderMessageId
            ? `telegram:${account.externalId}:${event.message.replyToProviderMessageId}`
            : null,
          // Hotfix 7B.6: snapshot isi pesan yang dikutip.
          replyToSnapshot: event.message.replyToSnapshot ?? null,
          text: event.message.text,
        });
      } catch (err) {
        await log({
          direction: "in",
          provider: "telegram",
          tenantId: account.tenantId,
          channelAccountId: account.id,
          signatureValid: true,
          outcome: "error",
          errorCode: "processing_error",
          summary: `failed to record message from ${event.message.senderExternalId}`,
          payload,
        });
        throw err;
      }
      await log({
        direction: "in",
        provider: "telegram",
        tenantId: account.tenantId,
        channelAccountId: account.id,
        signatureValid: true,
        outcome:
          recorded === null || recorded.duplicate ? "duplicate" : "recorded",
        summary: `text message from ${event.message.senderExternalId}`,
        payload,
      });
      if (recorded) {
        // Fase 6D: pengirim pertama kali terlihat → ambil foto profil
        // kontaknya (best-effort, tidak menahan jawaban webhook).
        if (recorded.identityCreated) {
          triggerContactPhoto(deps, account, recorded.contactId, event.message.senderExternalId);
        }
        // Fase 6G: nudge dashboard setelah commit (null = kembaran milik
        // tenant lain / duplikat webhook — tidak ada perubahan lokal).
        if (deps.publisher) {
          await deps.publisher.publishNudge({
            kind: "message.received",
            tenantId: account.tenantId,
            conversationId: recorded.message.conversationId,
          });
        }
        // Fase 13B: payload deep-link "/start <slug>" pada chat privat —
        // atribusi growth link (sumber kontak + auto-tag + event
        // konversi, sekali per kontak). Pesan ini SUDAH tercatat &
        // terbit ke outbox `message.received` di atas, jadi pemicu
        // keyword/flow/agent tetap melihat teks "/start <slug>" apa
        // adanya — atribusi berjalan DI SAMPING alur normal, tidak
        // menelannya. Best-effort: kegagalan atribusi tidak mengubah
        // outcome log dan tidak menggagalkan webhook.
        if (event.message.conversationKind !== "group") {
          const startMatch = /^\/start(?:@[A-Za-z0-9_]+)?\s+([a-z0-9][a-z0-9-]{1,62}[a-z0-9])\s*$/.exec(
            event.message.text,
          );
          if (startMatch) {
            try {
              await attributeContactToGrowthLink(deps.db, {
                tenantId: account.tenantId,
                contactId: recorded.contactId,
                slug: startMatch[1]!,
                channelAccountId: account.id,
              });
            } catch (err) {
              console.error("[telegram] atribusi growth link gagal", err);
            }
          }
        }
      }
    }
  }
  if (handledCount === 0) {
    // Update valid tanpa konten yang bisa dicatat (edit, reaksi,
    // pesan non-teks, service update, ...) — tetap berjejak di log.
    await log({
      direction: "in",
      provider: "telegram",
      tenantId: account.tenantId,
      channelAccountId: account.id,
      signatureValid: true,
      outcome: "ignored_status_only",
      summary: "update without recordable message content",
      payload,
    });
  }
  return outcomes;
}

/**
 * Fase 6D: identitas Telegram yang BARU pertama kali terlihat memicu
 * pengambilan foto profil kontaknya — best-effort & fire-and-forget
 * (webhook tetap menjawab seketika; helper core tidak pernah melempar),
 * dan TIDAK diulang pada pesan berikutnya dari kontak yang sama.
 */
function triggerContactPhoto(
  deps: TelegramProcessingDeps,
  account: TelegramAccountRef,
  contactId: string,
  senderExternalId: string,
): void {
  if (!account.accessTokenEncrypted || !deps.channelTokenSecret) return;
  const botToken = decryptChannelSecret(
    deps.channelTokenSecret,
    account.accessTokenEncrypted,
  );
  if (!botToken) return;
  void fetchAndStoreTelegramProfilePhoto(deps.db, {
    tenantId: account.tenantId,
    botToken,
    telegramApiBase: deps.telegramApiBase,
    telegramUserId: senderExternalId,
    ownerType: "contact",
    ownerId: contactId,
  });
}
