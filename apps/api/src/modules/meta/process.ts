import {
  applyWhatsAppMessageStatus,
  applyWhatsAppTemplateStatus,
  attributeContactToGrowthLink,
  decryptChannelSecret,
  fetchAndStoreMetaContactProfile,
  recordMetaComment,
  recordMetaInboundMessage,
  recordMetaReferralContact,
  recordWhatsAppEchoMessage,
  recordWhatsAppInboundMessage,
  resolveMetaAccountByExternalId,
  resolveWhatsAppAccountByPhoneNumberId,
  resolveWhatsAppAccountsByWabaId,
  type IntegrationLogInboundOutcome,
  type MetaAccountRef,
  type MetaProvider,
  type RecordIntegrationLogInput,
  type WhatsAppAccountRef,
} from "@sahabat-kreator/core";
import {
  parseMetaCommentEvents,
  parseMetaReferralEvents,
  parseMetaWebhookEvents,
} from "@sahabat-kreator/channel-messenger";
import {
  isWhatsAppWebhookPayload,
  parseWhatsAppWebhookEvents,
} from "@sahabat-kreator/channel-whatsapp";
import type { RealtimePublisher } from "@sahabat-kreator/queue";
import type { AuthBundle } from "../../auth";

/**
 * Pemrosesan SATU payload webhook Meta yang SUDAH lolos gerbang
 * kepercayaan (tanda tangan HMAC terverifikasi + JSON valid) —
 * diekstrak dari route webhook (Fase 7B.2) agar jalur yang PERSIS sama
 * bisa dipakai ulang oleh replay log integrasi.
 *
 * Perilaku identik route live: resolusi akun per event, gerbang status
 * `connected`, saringan echo/non-teks, dedup core, nudge realtime, dan
 * pencatatan log per titik keluar lewat sink `log` pemanggil (outcome
 * tiap baris dikumpulkan & dikembalikan berurutan). Error core per
 * event dicatat `error` lalu DILEMPAR ulang, sama seperti route.
 *
 * `tenantScopeId` (hanya replay): payload satu hit Meta dapat memuat
 * event untuk Page/IG/WABA milik BEBERAPA tenant. Saat di-scope,
 * event yang akunnya ter-resolve ke tenant LAIN (atau tidak
 * ter-resolve sama sekali) DILEWATI SENYAP — replay oleh admin satu
 * workspace tidak boleh menulis baris log atau memicu efek di
 * workspace lain; jejak event-event itu sudah ditulis saat hit live
 * tiba. Mode live (tanpa scope) tidak berubah sama sekali.
 */
export interface MetaProcessingDeps {
  db: AuthBundle["db"];
  publisher: RealtimePublisher | null;
  /** Material kunci dekripsi kredensial channel (env CHANNEL_TOKEN_SECRET). */
  channelTokenSecret?: string;
  /** Base URL Graph API (env META_API_BASE; default graph.facebook.com). */
  metaApiBase?: string;
  /** Versi Graph ter-pin (dari @sahabat-kreator/config). */
  graphApiVersion: string;
  /** Sink pencatatan log integrasi (best-effort di pemanggil). */
  log: (entry: RecordIntegrationLogInput) => Promise<void>;
  /** Fase 7B.2: batasi pemrosesan hanya ke event milik tenant ini. */
  tenantScopeId?: string;
}

export async function processMetaWebhookPayload(
  deps: MetaProcessingDeps,
  payload: unknown,
): Promise<IntegrationLogInboundOutcome[]> {
  const outcomes: IntegrationLogInboundOutcome[] = [];
  const log = async (entry: RecordIntegrationLogInput): Promise<void> => {
    outcomes.push(entry.outcome as IntegrationLogInboundOutcome);
    await deps.log(entry);
  };
  const scoped = deps.tenantScopeId !== undefined;

  // Objek ketiga (Fase 7B): WhatsApp Business Account — bentuk
  // payload-nya berbeda total dari messaging Page/IG, jadi jalurnya
  // terpisah penuh di bawah (parser + core whatsapp.ts).
  if (isWhatsAppWebhookPayload(payload)) {
    await handleWhatsAppWebhook(deps, payload, log);
    return outcomes;
  }

  const events = parseMetaWebhookEvents(payload);
  // Resolusi akun per (provider, entry.id) di-cache dalam request ini:
  // satu payload bisa memuat banyak pesan untuk Page/IG yang sama.
  const accountCache = new Map<string, MetaAccountRef | null>();
  const resolveAccount = async (
    provider: MetaProvider,
    externalId: string,
  ): Promise<MetaAccountRef | null> => {
    const key = `${provider}:${externalId}`;
    const cached = accountCache.get(key);
    if (cached !== undefined) return cached;
    const account = await resolveMetaAccountByExternalId(
      deps.db,
      provider,
      externalId,
    );
    accountCache.set(key, account);
    return account;
  };

  for (const event of events) {
    const provider: MetaProvider =
      event.objectKind === "page" ? "messenger" : "instagram";
    // Fase 7B.1: resolusi akun didahulukan dari saringan echo/teks
    // agar SETIAP event berjejak dengan tenant yang benar; perilaku
    // pencatatan pesan tidak berubah (echo & non-teks tetap dilewati).
    const account = await resolveAccount(provider, event.entryExternalId);
    if (!account) {
      if (scoped) continue; // Event tenant lain/tak dikenal: bukan urusan replay ini.
      await log({
        direction: "in",
        provider,
        signatureValid: true,
        outcome: "unresolved_account",
        summary: `unknown ${provider} account ${event.entryExternalId}`,
        payload,
      });
      continue;
    }
    if (scoped && account.tenantId !== deps.tenantScopeId) continue;
    if (account.status !== "connected") {
      await log({
        direction: "in",
        provider,
        tenantId: account.tenantId,
        channelAccountId: account.id,
        signatureValid: true,
        outcome: "ignored_disconnected",
        summary: `event for ${account.status} account`,
        payload,
      });
      continue;
    }
    // Echo = pantulan pesan yang kita kirim sendiri (sudah tercatat
    // sebagai outbound saat dikirim poller) — jangan jadi pesan masuk.
    if (event.isEcho) {
      await log({
        direction: "in",
        provider,
        tenantId: account.tenantId,
        channelAccountId: account.id,
        signatureValid: true,
        outcome: "ignored_echo",
        summary: "echo of own outbound message",
        payload,
      });
      continue;
    }
    // v1 hanya pesan teks (lampiran/stiker/like belum dicatat).
    if (!event.text || !event.text.trim()) {
      await log({
        direction: "in",
        provider,
        tenantId: account.tenantId,
        channelAccountId: account.id,
        signatureValid: true,
        outcome: "ignored_status_only",
        summary: "non-text message event",
        payload,
      });
      continue;
    }

    let recorded: Awaited<ReturnType<typeof recordMetaInboundMessage>>;
    try {
      recorded = await recordMetaInboundMessage(deps.db, account, {
        senderExternalId: event.senderExternalId,
        providerMessageId: event.providerMessageId,
        // Fase 7B.5: message.reply_to.mid (mentah; core menyusun majemuk).
        replyToProviderMessageId: event.replyToProviderMessageId,
        text: event.text,
      });
    } catch (err) {
      await log({
        direction: "in",
        provider,
        tenantId: account.tenantId,
        channelAccountId: account.id,
        signatureValid: true,
        outcome: "error",
        errorCode: "processing_error",
        summary: `failed to record message from ${event.senderExternalId}`,
        payload,
      });
      throw err;
    }
    await log({
      direction: "in",
      provider,
      tenantId: account.tenantId,
      channelAccountId: account.id,
      signatureValid: true,
      outcome:
        recorded === null || recorded.duplicate ? "duplicate" : "recorded",
      summary: `text message from ${event.senderExternalId}`,
      payload,
    });
    if (!recorded) continue;

    if (recorded.identityCreated) {
      triggerContactProfile(deps, account, recorded.contactId, event.senderExternalId);
    }
    if (deps.publisher) {
      await deps.publisher.publishNudge({
        kind: "message.received",
        tenantId: account.tenantId,
        conversationId: recorded.message.conversationId,
      });
    }
  }
  // Fase 10B: event KOMENTAR (entry.changes) diproses sesudah loop
  // messaging, dengan cache resolusi akun yang sama. Komentar disimpan
  // ke tabel `comments` (dedup core); evaluasi aturan comment-to-DM
  // berjalan asinkron lewat outbox `comment.received` → job worker —
  // webhook tetap menjawab seketika. Event non-komentar tidak tersentuh
  // jalur ini sama sekali.
  const commentEvents = parseMetaCommentEvents(payload);
  for (const event of commentEvents) {
    const provider: MetaProvider =
      event.objectKind === "page" ? "messenger" : "instagram";
    const account = await resolveAccount(provider, event.entryExternalId);
    if (!account) {
      if (scoped) continue;
      await log({
        direction: "in",
        provider,
        signatureValid: true,
        outcome: "unresolved_account",
        summary: `comment for unknown ${provider} account ${event.entryExternalId}`,
        payload,
      });
      continue;
    }
    if (scoped && account.tenantId !== deps.tenantScopeId) continue;
    if (account.status !== "connected") {
      await log({
        direction: "in",
        provider,
        tenantId: account.tenantId,
        channelAccountId: account.id,
        signatureValid: true,
        outcome: "ignored_disconnected",
        summary: `comment for ${account.status} account`,
        payload,
      });
      continue;
    }
    let recorded: Awaited<ReturnType<typeof recordMetaComment>>;
    try {
      recorded = await recordMetaComment(deps.db, account, {
        providerCommentId: event.providerCommentId,
        mediaId: event.mediaId,
        postId: event.postId,
        parentId: event.parentId,
        authorExternalId: event.authorExternalId,
        authorUsername: event.authorUsername,
        text: event.text,
        providerCreatedAt: event.providerCreatedAt,
      });
    } catch (err) {
      await log({
        direction: "in",
        provider,
        tenantId: account.tenantId,
        channelAccountId: account.id,
        signatureValid: true,
        outcome: "error",
        errorCode: "processing_error",
        summary: `failed to record comment ${event.providerCommentId}`,
        payload,
      });
      throw err;
    }
    await log({
      direction: "in",
      provider,
      tenantId: account.tenantId,
      channelAccountId: account.id,
      signatureValid: true,
      outcome: recorded.status === "recorded" ? "recorded" : "duplicate",
      summary: `comment ${event.providerCommentId} from ${event.authorExternalId}`,
      payload,
    });
  }
  // Fase 13B: event REFERRAL (messaging_referrals) — kedatangan lewat
  // tautan m.me/ig.me ber-ref (ref = slug growth link). Tidak ada
  // pesan: core find-or-create kontak+percakapan mengikuti pola
  // inbound, lalu atribusi growth link (sumber + auto-tag + event
  // konversi). Referral yang ref-nya bukan slug dikenal adalah no-op
  // atribusi (kontak/percakapan tetap tercatat — orangnya memang
  // datang). Gerbang akun sama seperti messaging/komentar.
  const referralEvents = parseMetaReferralEvents(payload);
  for (const event of referralEvents) {
    const provider: MetaProvider =
      event.objectKind === "page" ? "messenger" : "instagram";
    const account = await resolveAccount(provider, event.entryExternalId);
    if (!account) {
      if (scoped) continue;
      await log({
        direction: "in",
        provider,
        signatureValid: true,
        outcome: "unresolved_account",
        summary: `referral for unknown ${provider} account ${event.entryExternalId}`,
        payload,
      });
      continue;
    }
    if (scoped && account.tenantId !== deps.tenantScopeId) continue;
    if (account.status !== "connected") {
      await log({
        direction: "in",
        provider,
        tenantId: account.tenantId,
        channelAccountId: account.id,
        signatureValid: true,
        outcome: "ignored_disconnected",
        summary: `referral for ${account.status} account`,
        payload,
      });
      continue;
    }
    let recorded: Awaited<ReturnType<typeof recordMetaReferralContact>>;
    try {
      recorded = await recordMetaReferralContact(deps.db, account, {
        senderExternalId: event.senderExternalId,
      });
      await attributeContactToGrowthLink(deps.db, {
        tenantId: account.tenantId,
        contactId: recorded.contactId,
        slug: event.ref,
        channelAccountId: account.id,
      });
    } catch (err) {
      await log({
        direction: "in",
        provider,
        tenantId: account.tenantId,
        channelAccountId: account.id,
        signatureValid: true,
        outcome: "error",
        errorCode: "processing_error",
        summary: `failed to record referral from ${event.senderExternalId}`,
        payload,
      });
      throw err;
    }
    await log({
      direction: "in",
      provider,
      tenantId: account.tenantId,
      channelAccountId: account.id,
      signatureValid: true,
      outcome: "recorded",
      summary: `referral ref=${event.ref} from ${event.senderExternalId}`,
      payload,
    });
    if (recorded.identityCreated) {
      triggerContactProfile(deps, account, recorded.contactId, event.senderExternalId);
    }
  }
  if (events.length === 0 && commentEvents.length === 0 && referralEvents.length === 0 && !scoped) {
    // Payload sah tanpa event messaging yang dikenal parser (receipt
    // delivery/read murni, postback, objek selain page/instagram):
    // tetap satu baris agregat agar tidak ada hit yang senyap.
    // (Mode replay ber-scope tidak menulis baris agregat platform.)
    await log({
      direction: "in",
      provider: "meta",
      signatureValid: true,
      outcome: "ignored_status_only",
      summary: "payload without messaging events (receipts/postbacks)",
      payload,
    });
  }
  return outcomes;
}

/**
 * Jalur WhatsApp (Fase 7B) pada webhook yang sama: payload
 * `whatsapp_business_account` sudah lolos verifikasi tanda tangan yang
 * sama di pemanggil. Resolusi akun dari `metadata.phone_number_id`
 * (BUKAN entry.id = WABA — satu WABA menaungi banyak nomor/tenant).
 * Akun tak dikenal / tidak 'connected' → event diabaikan (tetap 200).
 *
 * - Pesan masuk: teks dicatat apa adanya; non-teks dicatat dengan
 *   tipenya (caption sebagai isi) — media tidak diunduh di v1. Nama
 *   kontak datang dari payload (contacts[].profile.name).
 * - Statuses: diterapkan ke pesan keluar kita lewat core (hanya maju;
 *   failed terminal berkode) + nudge realtime bila benar-benar berubah
 *   (failed → message.failed; delivered/read → conversation.updated
 *   agar label status di utas inbox menyegar).
 */
async function handleWhatsAppWebhook(
  deps: MetaProcessingDeps,
  payload: unknown,
  log: (entry: RecordIntegrationLogInput) => Promise<void>,
): Promise<void> {
  const scoped = deps.tenantScopeId !== undefined;
  // Fase 7B.1: error per event dicatat di titiknya lalu dilempar ulang
  // (respons webhook tidak berubah); error lain (parser/resolusi)
  // dicatat agregat oleh pembungkus di bawah. `errorLogged` mencegah
  // pencatatan ganda untuk error yang sama. Dalam mode replay
  // ber-scope baris agregat ini dilekatkan ke tenant pemilik replay
  // (bukan baris platform tenant-NULL dari endpoint tenant).
  let errorLogged = false;
  const logErrorOnce = async (summary: string): Promise<void> => {
    if (errorLogged) return;
    errorLogged = true;
    await log({
      direction: "in",
      provider: "whatsapp",
      tenantId: scoped ? deps.tenantScopeId : undefined,
      signatureValid: true,
      outcome: "error",
      errorCode: "processing_error",
      summary,
      payload,
    });
  };
  try {
    const parsed = parseWhatsAppWebhookEvents(payload);
    if (
      parsed.messages.length === 0 &&
      parsed.statuses.length === 0 &&
      parsed.echoes.length === 0 &&
      parsed.templateStatuses.length === 0
    ) {
      if (!scoped) {
        await log({
          direction: "in",
          provider: "whatsapp",
          signatureValid: true,
          outcome: "ignored_status_only",
          summary: "whatsapp payload without messages or statuses",
          payload,
        });
      }
      return;
    }

    const accountCache = new Map<string, WhatsAppAccountRef | null>();
    // Cache terpisah untuk event tingkat WABA: kuncinya WABA id, bukan
    // phone_number_id, dan hasilnya daftar (satu WABA bisa banyak nomor).
    const wabaCache = new Map<string, WhatsAppAccountRef[]>();
    const resolveAccount = async (
      phoneNumberId: string,
    ): Promise<WhatsAppAccountRef | null> => {
      const cached = accountCache.get(phoneNumberId);
      if (cached !== undefined) return cached;
      const account = await resolveWhatsAppAccountByPhoneNumberId(
        deps.db,
        phoneNumberId,
      );
      accountCache.set(phoneNumberId, account);
      return account;
    };

    for (const message of parsed.messages) {
      // Pesan teks tanpa isi adalah anomali payload — lewati seperti
      // jalur Meta; non-teks tetap dicatat bertipe (linimasa jujur).
      // (Dalam mode replay, pemeriksaan ini tetap dicatat hanya bila
      // nomornya milik tenant scope — nomor ditentukan sesudah resolusi
      // di bawah untuk teks kosong pun; urutan live dipertahankan untuk
      // mode tanpa scope.)
      if (!scoped && message.type === "text" && (!message.text || !message.text.trim())) {
        await log({
          direction: "in",
          provider: "whatsapp",
          signatureValid: true,
          outcome: "ignored_status_only",
          summary: "empty text message",
          payload,
        });
        continue;
      }
      const account = await resolveAccount(message.phoneNumberId);
      if (!account) {
        if (scoped) continue;
        await log({
          direction: "in",
          provider: "whatsapp",
          signatureValid: true,
          outcome: "unresolved_account",
          summary: `unknown phone_number_id ${message.phoneNumberId}`,
          payload,
        });
        continue;
      }
      if (scoped && account.tenantId !== deps.tenantScopeId) continue;
      if (message.type === "text" && (!message.text || !message.text.trim())) {
        await log({
          direction: "in",
          provider: "whatsapp",
          tenantId: account.tenantId,
          channelAccountId: account.id,
          signatureValid: true,
          outcome: "ignored_status_only",
          summary: "empty text message",
          payload,
        });
        continue;
      }
      if (account.status !== "connected") {
        await log({
          direction: "in",
          provider: "whatsapp",
          tenantId: account.tenantId,
          channelAccountId: account.id,
          signatureValid: true,
          outcome: "ignored_disconnected",
          summary: `message for ${account.status} account`,
          payload,
        });
        continue;
      }
      let recorded: Awaited<ReturnType<typeof recordWhatsAppInboundMessage>>;
      try {
        recorded = await recordWhatsAppInboundMessage(deps.db, account, {
          senderWaId: message.senderWaId,
          contactName: message.contactName,
          providerMessageId: message.providerMessageId,
          // Fase 7B.5: messages[].context.id (wamid yang dikutip).
          replyToProviderMessageId: message.replyToProviderMessageId,
          type: message.type,
          text: message.text,
        });
      } catch (err) {
        await log({
          direction: "in",
          provider: "whatsapp",
          tenantId: account.tenantId,
          channelAccountId: account.id,
          signatureValid: true,
          outcome: "error",
          errorCode: "processing_error",
          summary: `failed to record message from ${message.senderWaId}`,
          payload,
        });
        errorLogged = true;
        throw err;
      }
      await log({
        direction: "in",
        provider: "whatsapp",
        tenantId: account.tenantId,
        channelAccountId: account.id,
        signatureValid: true,
        outcome:
          recorded === null || recorded.duplicate ? "duplicate" : "recorded",
        summary: `${message.type} message from ${message.senderWaId}`,
        payload,
      });
      if (!recorded) continue;
      if (deps.publisher) {
        await deps.publisher.publishNudge({
          kind: "message.received",
          tenantId: account.tenantId,
          conversationId: recorded.message.conversationId,
        });
      }
    }

    // Coexistence (`smb_message_echoes`): pesan yang diketik staf lewat
    // aplikasi WhatsApp Business di HP. Dicatat sebagai pesan KELUAR
    // tanpa memicu automation/AI — lihat recordWhatsAppEchoMessage.
    // Nudge yang dipakai `conversation.updated`, bukan `message.received`:
    // inbox perlu menyegar, tetapi tidak ada yang boleh "menjawab" ini.
    for (const echo of parsed.echoes) {
      const account = await resolveAccount(echo.phoneNumberId);
      if (!account) {
        if (scoped) continue;
        await log({
          direction: "in",
          provider: "whatsapp",
          signatureValid: true,
          outcome: "unresolved_account",
          summary: `echo for unknown phone_number_id ${echo.phoneNumberId}`,
          payload,
        });
        continue;
      }
      if (scoped && account.tenantId !== deps.tenantScopeId) continue;
      if (account.status !== "connected") {
        await log({
          direction: "in",
          provider: "whatsapp",
          tenantId: account.tenantId,
          channelAccountId: account.id,
          signatureValid: true,
          outcome: "ignored_disconnected",
          summary: `echo for ${account.status} account`,
          payload,
        });
        continue;
      }
      // `revoke`/`edit` dari HP belum diterapkan ke baris kita. Dicatat
      // eksplisit supaya tidak ada perubahan pelanggan yang senyap.
      if (echo.isRevoke || echo.isEdit) {
        await log({
          direction: "in",
          provider: "whatsapp",
          tenantId: account.tenantId,
          channelAccountId: account.id,
          signatureValid: true,
          outcome: "ignored_status_only",
          summary: echo.isRevoke
            ? `echo revoke for ${echo.providerMessageId} not applied`
            : `echo edit for ${echo.providerMessageId} not applied`,
          payload,
        });
        continue;
      }
      let echoed: Awaited<ReturnType<typeof recordWhatsAppEchoMessage>>;
      try {
        echoed = await recordWhatsAppEchoMessage(deps.db, account, {
          customerWaId: echo.toWaId,
          providerMessageId: echo.providerMessageId,
          type: echo.type,
          text: echo.text,
        });
      } catch (err) {
        await log({
          direction: "in",
          provider: "whatsapp",
          tenantId: account.tenantId,
          channelAccountId: account.id,
          signatureValid: true,
          outcome: "error",
          errorCode: "processing_error",
          summary: `failed to record echo to ${echo.toWaId}`,
          payload,
        });
        errorLogged = true;
        throw err;
      }
      await log({
        direction: "in",
        provider: "whatsapp",
        tenantId: account.tenantId,
        channelAccountId: account.id,
        signatureValid: true,
        outcome:
          echoed === null || echoed.duplicate ? "duplicate" : "recorded",
        summary: `echo ${echo.type} to ${echo.toWaId}`,
        payload,
      });
      if (!echoed || echoed.duplicate) continue;
      if (deps.publisher) {
        await deps.publisher.publishNudge({
          kind: "conversation.updated",
          tenantId: account.tenantId,
          conversationId: echoed.conversationId,
        });
      }
    }

    for (const status of parsed.statuses) {
      const account = await resolveAccount(status.phoneNumberId);
      if (!account) {
        if (scoped) continue;
        await log({
          direction: "in",
          provider: "whatsapp",
          signatureValid: true,
          outcome: "unresolved_account",
          summary: `delivery status for unknown phone_number_id ${status.phoneNumberId}`,
          payload,
        });
        continue;
      }
      if (scoped && account.tenantId !== deps.tenantScopeId) continue;
      if (account.status !== "connected") {
        await log({
          direction: "in",
          provider: "whatsapp",
          tenantId: account.tenantId,
          channelAccountId: account.id,
          signatureValid: true,
          outcome: "ignored_disconnected",
          summary: `delivery status for ${account.status} account`,
          payload,
        });
        continue;
      }
      const applied = await applyWhatsAppMessageStatus(deps.db, account, {
        providerMessageId: status.providerMessageId,
        status: status.status,
        graphErrorCode: status.errorCode,
      });
      if (!applied) {
        await log({
          direction: "in",
          provider: "whatsapp",
          tenantId: account.tenantId,
          channelAccountId: account.id,
          signatureValid: true,
          outcome: "ignored_status_only",
          summary: `delivery status ${status.status} for unknown message`,
          payload,
        });
        continue;
      }
      await log({
        direction: "in",
        provider: "whatsapp",
        tenantId: account.tenantId,
        channelAccountId: account.id,
        signatureValid: true,
        outcome: applied.applied ? "recorded" : "ignored_status_only",
        errorCode:
          status.status === "failed" && status.errorCode
            ? `meta_graph_${status.errorCode}`
            : null,
        summary: applied.applied
          ? `delivery status ${status.status} applied`
          : `stale delivery status ${status.status} ignored`,
        payload,
      });
      if (!applied?.applied || !deps.publisher) continue;
      await deps.publisher.publishNudge({
        kind: applied.status === "failed" ? "message.failed" : "conversation.updated",
        tenantId: account.tenantId,
        conversationId: applied.conversationId,
      });
    }

    // Status template (`message_template_status_update`) — event tingkat
    // WABA: payload tidak menyebut nomor telepon sama sekali, jadi akun
    // di-resolve lewat parent_external_id (WABA id), bukan phone_number_id.
    // Satu WABA bisa menaungi beberapa nomor, dan cermin template hidup
    // per akun — karena itu SEMUA akun milik WABA itu diperbarui.
    for (const change of parsed.templateStatuses) {
      let wabaAccounts = wabaCache.get(change.wabaId);
      if (wabaAccounts === undefined) {
        wabaAccounts = await resolveWhatsAppAccountsByWabaId(
          deps.db,
          change.wabaId,
        );
        wabaCache.set(change.wabaId, wabaAccounts);
      }
      if (wabaAccounts.length === 0) {
        if (scoped) continue;
        await log({
          direction: "in",
          provider: "whatsapp",
          signatureValid: true,
          outcome: "unresolved_account",
          summary: `template status for unknown WABA ${change.wabaId}`,
          payload,
        });
        continue;
      }
      for (const account of wabaAccounts) {
        if (scoped && account.tenantId !== deps.tenantScopeId) continue;
        // Alasan penolakan rinci lebih berguna daripada kode `reason`;
        // kalau Meta tidak menyertakannya, pakai kode itu apa adanya.
        const reason =
          change.rejectionReason ?? change.reason ?? null;
        const applied = await applyWhatsAppTemplateStatus(deps.db, {
          tenantId: account.tenantId,
          channelAccountId: account.id,
          metaTemplateId: change.templateId,
          name: change.templateName,
          language: change.language,
          status: change.event,
          category: change.category,
          reason,
        });
        await log({
          direction: "in",
          provider: "whatsapp",
          tenantId: account.tenantId,
          channelAccountId: account.id,
          signatureValid: true,
          outcome: applied.updated ? "recorded" : "ignored_status_only",
          summary: applied.updated
            ? `template ${change.templateName} ${applied.previousStatus} -> ${change.event}`
            : `template ${change.templateName} ${change.event} without mirror change`,
          payload,
        });
      }
    }
  } catch (err) {
    await logErrorOnce("whatsapp webhook processing failed");
    throw err;
  }
}

/**
 * Fase 7A (pola 6D): identitas Meta yang BARU pertama kali terlihat
 * memicu pengambilan profil Graph pengirimnya — nama asli (webhook Meta
 * tidak menyertakan nama) + foto profil. Best-effort & fire-and-forget:
 * webhook tetap menjawab seketika dan helper core tidak pernah melempar.
 */
function triggerContactProfile(
  deps: MetaProcessingDeps,
  account: MetaAccountRef,
  contactId: string,
  senderExternalId: string,
): void {
  if (!account.accessTokenEncrypted || !deps.channelTokenSecret) return;
  const accessToken = decryptChannelSecret(
    deps.channelTokenSecret,
    account.accessTokenEncrypted,
  );
  if (!accessToken) return;
  void fetchAndStoreMetaContactProfile(deps.db, {
    tenantId: account.tenantId,
    accessToken,
    metaApiBase: deps.metaApiBase,
    graphApiVersion: deps.graphApiVersion,
    provider: account.provider as MetaProvider,
    senderExternalId,
    contactId,
  });
}
