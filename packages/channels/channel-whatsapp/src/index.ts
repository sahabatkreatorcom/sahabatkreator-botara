import {
  DEFAULT_META_API_BASE,
  DEFAULT_META_GRAPH_API_VERSION,
  GraphApiError,
  GraphHttpClient,
  type ChannelAdapter,
  type GraphClientOptions,
  type SendMessageInput,
  type SendMessageResult,
  type StandardEvent,
  type VerifyWebhookInput,
} from "@sahabat-kreator/channel-core";

/**
 * @sahabat-kreator/channel-whatsapp — adapter WhatsApp Cloud API
 * (Fase 7B), menumpang rel Meta Fase 7A: Graph API v26.0 ter-pin,
 * webhook TUNGGAL platform yang sama (`whatsapp_business_account`
 * adalah objek ketiga di endpoint itu), tanda tangan app secret yang
 * sama (diverifikasi di route, bukan di sini). Logika DB (kontak/
 * percakapan/pesan/status) hidup di @sahabat-kreator/core
 * (`whatsapp.ts`), meniru pembagian kerja Messenger/Telegram.
 *
 * Perbedaan bentuk WhatsApp dari Send API Messenger/IG:
 * - Kirim: `POST /{phone_number_id}/messages` dengan
 *   `messaging_product: "whatsapp"`; id pesan hasil = `messages[0].id`
 *   (wamid) — wamid inilah yang dicocokkan webhook `statuses`.
 * - Webhook masuk membawa nama profil pengirim; status pengiriman
 *   (sent/delivered/read/failed) tiba sebagai event terpisah.
 * - Jendela layanan 24 jam: teks bebas hanya sah <24 jam sejak pesan
 *   terakhir pengguna; di luar itu Graph menolak (mis. kode 131047)
 *   dan pemanggil menandai pesan failed — di luar jendela, jalur
 *   resminya adalah pesan TEMPLATE (Fase 10A: manajemen template +
 *   `sendTemplateMessage` di klien ini; dipakai broadcast).
 * - Routing kategori template (RANCANGAN §12.6) belum berlaku: kirim
 *   teks adalah percakapan layanan (service) lewat Cloud API.
 *
 * KEAMANAN: Access Token (System User) dikirim sebagai header
 * `Authorization: Bearer` — tidak pernah sebagai query `access_token=`
 * — dan pesan error hanya memuat status HTTP + kode/pesan resmi Graph.
 */

/**
 * Konstanta base URL & versi Graph kini hidup di @sahabat-kreator/channel-core
 * (Fase 13D) supaya adapter Meta lain memakai nilai yang sama persis.
 * Diekspor ulang di sini agar impor lama tetap bekerja.
 */
export { DEFAULT_META_API_BASE, DEFAULT_META_GRAPH_API_VERSION };

/** Error Graph API yang AMAN dicatat: status HTTP + kode Graph resmi. */
export class WhatsAppGraphError extends GraphApiError {
  constructor(status: number, graphCode: number | null, description: string) {
    super("WhatsApp Graph API", status, graphCode, description);
    this.name = "WhatsAppGraphError";
  }
}

export interface WhatsAppCloudClientOptions extends GraphClientOptions {
  /** Access Token WhatsApp (System User permanen / token sementara). */
  accessToken?: string;
}

/** Profil nomor WhatsApp dari Graph — hasil validasi saat connect. */
export interface WhatsAppPhoneNumberProfile {
  id: string;
  /** Nama bisnis terverifikasi (verified_name). */
  verifiedName: string | null;
  /** Nomor tampil terformat (display_phone_number, mis. "+62 812-3456-7890"). */
  displayPhoneNumber: string | null;
}

/** Satu tombol komponen BUTTONS template (URL / QUICK_REPLY / PHONE_NUMBER / COPY_CODE …). */
export interface WhatsAppTemplateButton {
  type: string;
  text?: string;
  url?: string;
  phone_number?: string;
}

/**
 * Satu komponen template Meta (HEADER / BODY / FOOTER / BUTTONS) —
 * disimpan apa adanya di cermin lokal; hanya field yang kita baca
 * yang dideklarasikan, sisanya lolos lewat index signature tidak ada —
 * parser di bawah membaca defensif dari `unknown`.
 */
export interface WhatsAppTemplateComponent {
  type: string;
  format?: string;
  text?: string;
  example?: {
    body_text?: string[][];
    header_text?: string[];
  };
  buttons?: WhatsAppTemplateButton[];
}

/** Satu template pesan resmi Meta dari `GET /{waba-id}/message_templates`. */
export interface WhatsAppMessageTemplate {
  /** Id template di Meta; null bila respons tidak menyertakannya. */
  id: string | null;
  name: string;
  language: string;
  category: string;
  status: string;
  components: WhatsAppTemplateComponent[];
}

/** Hasil pembuatan template di Meta (`POST /{waba-id}/message_templates`). */
export interface WhatsAppTemplateCreateResult {
  id: string | null;
  status: string;
  category: string;
}

/** Payload pembuatan template (bentuk Graph `message_templates`). */
export interface WhatsAppTemplateCreateInput {
  name: string;
  language: string;
  category: "UTILITY" | "MARKETING" | "AUTHENTICATION";
  components: WhatsAppTemplateComponent[];
}

const TEMPLATE_PLACEHOLDER_RE = /\{\{(\d+)\}\}/g;

/**
 * Jumlah variabel sebuah teks template = indeks {{n}} TERBESAR yang
 * muncul (Meta menomori variabel mulai 1 tanpa celah; teks tanpa
 * placeholder = 0). Murni — dipakai parser komponen di bawah.
 */
export function countTemplateVariables(text: string | null | undefined): number {
  if (!text) return 0;
  let max = 0;
  for (const match of text.matchAll(TEMPLATE_PLACEHOLDER_RE)) {
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

/**
 * Turunan lokal dari komponen template: teks BODY + jumlah variabel
 * BODY-nya (untuk pratinjau & pemetaan parameter broadcast Fase 10A).
 * Komponen dibaca defensif (respons Graph diperlakukan `unknown`
 * sampai divalidasi bentuknya di listMessageTemplates).
 */
export function deriveTemplateBody(components: WhatsAppTemplateComponent[]): {
  bodyText: string | null;
  variableCount: number;
} {
  const body = components.find((c) => c.type === "BODY");
  const bodyText = typeof body?.text === "string" ? body.text : null;
  return { bodyText, variableCount: countTemplateVariables(bodyText) };
}

/** Render pratinjau teks template: ganti {{n}} dengan parameter ke-n (1-based). */
export function renderTemplatePreview(
  bodyText: string,
  bodyParams: string[],
): string {
  return bodyText.replace(TEMPLATE_PLACEHOLDER_RE, (_whole, raw: string) => {
    const idx = Number(raw) - 1;
    return idx >= 0 && idx < bodyParams.length ? bodyParams[idx] : "";
  });
}

/**
 * Klien WhatsApp Cloud API tipis di atas fetch. Satu instance per token.
 * Plumbing HTTP (header Bearer, parse error, GET/POST/DELETE JSON,
 * timeout) diwarisi dari `GraphHttpClient` di channel-core (Fase 13D);
 * kelas ini hanya memetakan kegagalan ke `WhatsAppGraphError`.
 */
export class WhatsAppCloudClient extends GraphHttpClient {
  constructor(options: WhatsAppCloudClientOptions = {}) {
    super(options);
  }

  protected createError(
    status: number,
    graphCode: number | null,
    description: string,
    graphSubcode: number | null,
  ): WhatsAppGraphError {
    return new WhatsAppGraphError(status, graphCode, description);
  }

  /**
   * Daftar template WABA (`GET /{waba-id}/message_templates`) — sumber
   * sinkronisasi cermin lokal Fase 10A. Satu halaman `limit=200`
   * (WABA kreator jauh di bawah itu; paging lanjutan dicatat sebagai
   * batas jujur fase ini). Baris tanpa nama/bahasa dilewati defensif.
   */
  async listMessageTemplates(
    wabaId: string,
  ): Promise<WhatsAppMessageTemplate[]> {
    const body = await this.getJson<{
      data?: Array<Record<string, unknown>>;
    }>(
      `${encodeURIComponent(wabaId)}/message_templates?fields=id,name,language,category,status,components&limit=200`,
    );
    const out: WhatsAppMessageTemplate[] = [];
    for (const row of body.data ?? []) {
      if (typeof row?.name !== "string" || !row.name) continue;
      if (typeof row?.language !== "string" || !row.language) continue;
      out.push({
        id: typeof row.id === "string" ? row.id : null,
        name: row.name,
        language: row.language,
        category: typeof row.category === "string" ? row.category : "UTILITY",
        status: typeof row.status === "string" ? row.status : "PENDING",
        components: Array.isArray(row.components)
          ? (row.components as WhatsAppTemplateComponent[])
          : [],
      });
    }
    return out;
  }

  /**
   * Buat template baru di Meta (`POST /{waba-id}/message_templates`).
   * Meta menjawab `{ id, status, category }` — status awal nyaris
   * selalu PENDING (tinjauan Meta); penolakan bentuk (nama ganda,
   * variabel tanpa contoh, …) melempar WhatsAppGraphError berkode
   * Graph resmi untuk diterjemahkan lapisan API menjadi kode
   * terkontrol META_TEMPLATE_INVALID.
   */
  async createMessageTemplate(
    wabaId: string,
    input: WhatsAppTemplateCreateInput,
  ): Promise<WhatsAppTemplateCreateResult> {
    const body = await this.postJson<{
      id?: string;
      status?: string;
      category?: string;
    }>(`${encodeURIComponent(wabaId)}/message_templates`, {
      name: input.name,
      language: input.language,
      category: input.category,
      components: input.components,
    });
    return {
      id: typeof body.id === "string" ? body.id : null,
      status: typeof body.status === "string" ? body.status : "PENDING",
      category: typeof body.category === "string" ? body.category : input.category,
    };
  }

  /**
   * Hapus template di Meta (`DELETE /{waba-id}/message_templates?name=…`).
   * Meta menghapus template berdasarkan NAMA (semua bahasa) — pemanggil
   * menyelaraskan cermin lokalnya dengan semantik yang sama.
   */
  async deleteMessageTemplate(wabaId: string, name: string): Promise<void> {
    await this.deleteJson<{ success?: boolean }>(
      `${encodeURIComponent(wabaId)}/message_templates?name=${encodeURIComponent(name)}`,
    );
  }

  /**
   * Kirim pesan TEMPLATE (Cloud API): `POST /{phone_number_id}/messages`
   * `type: "template"` — satu-satunya bentuk pesan proaktif yang sah di
   * luar jendela layanan 24 jam (Fase 10A; dipakai broadcast).
   * `bodyParams` = nilai variabel BODY {{1}}, {{2}}, … secara berurutan;
   * array kosong → komponen body tidak dikirim sama sekali (template
   * tanpa variabel). Mengembalikan wamid seperti sendTextMessage.
   */
  async sendTemplateMessage(input: {
    phoneNumberId: string;
    to: string;
    templateName: string;
    languageCode: string;
    bodyParams: string[];
  }): Promise<{ providerMessageId: string }> {
    const body = await this.postJson<{
      messages?: Array<{ id?: string }>;
    }>(`${encodeURIComponent(input.phoneNumberId)}/messages`, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: input.to,
      type: "template",
      template: {
        name: input.templateName,
        language: { code: input.languageCode },
        ...(input.bodyParams.length > 0
          ? {
              components: [
                {
                  type: "body",
                  parameters: input.bodyParams.map((text) => ({
                    type: "text",
                    text,
                  })),
                },
              ],
            }
          : {}),
      },
    });
    const wamid = body.messages?.[0]?.id;
    if (typeof wamid !== "string" || !wamid) {
      throw new WhatsAppGraphError(200, null, "missing_message_id");
    }
    return { providerMessageId: wamid };
  }

  /**
   * Profil nomor (`GET /{phone_number_id}?fields=verified_name,display_phone_number`)
   * — memvalidasi token + mengambil nama bisnis & nomor tampil saat
   * connect. Token/nomor yang ditolak Graph melempar WhatsAppGraphError.
   */
  async getPhoneNumberProfile(
    phoneNumberId: string,
  ): Promise<WhatsAppPhoneNumberProfile> {
    const body = await this.getJson<{
      id?: string;
      verified_name?: string;
      display_phone_number?: string;
    }>(
      `${encodeURIComponent(phoneNumberId)}?fields=verified_name,display_phone_number`,
    );
    return {
      id: typeof body.id === "string" ? body.id : phoneNumberId,
      verifiedName:
        typeof body.verified_name === "string" ? body.verified_name : null,
      displayPhoneNumber:
        typeof body.display_phone_number === "string"
          ? body.display_phone_number
          : null,
    };
  }

  /**
   * Foto profil bisnis (best-effort): `GET /{phone_number_id}/whatsapp_business_profile?fields=profile_picture_url`
   * lalu unduh byte dari URL CDN-nya. Mengembalikan null pada SEMUA
   * kegagalan (profil kosong, field tak tersedia, unduhan gagal) —
   * foto TIDAK PERNAH menjadi penghalang connect; kartu Channels jatuh
   * ke inisial. Berbeda dari kontak: foto profil KONTAK WhatsApp memang
   * tidak disediakan API sama sekali (privasi), jadi tidak ada jalur
   * pengambilan foto kontak di paket ini.
   */
  async getBusinessProfilePicture(
    phoneNumberId: string,
  ): Promise<{ data: Buffer; contentType: string } | null> {
    try {
      const body = await this.getJson<{ profile_picture_url?: string }>(
        `${encodeURIComponent(phoneNumberId)}/whatsapp_business_profile?fields=profile_picture_url`,
      );
      const url =
        typeof body.profile_picture_url === "string"
          ? body.profile_picture_url
          : null;
      if (!url) return null;
      const response = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) return null;
      const data = Buffer.from(await response.arrayBuffer());
      if (data.length === 0) return null;
      return {
        data,
        contentType:
          response.headers.get("content-type")?.split(";")[0]?.trim() ||
          "image/jpeg",
      };
    } catch {
      return null;
    }
  }

  /**
   * Kirim pesan teks (Cloud API): `POST /{phone_number_id}/messages`.
   * Mengembalikan wamid (`messages[0].id`) — id yang nantinya
   * dicocokkan webhook statuses untuk delivered/read/failed.
   *
   * `contextMessageId` (Fase 7B.5): wamid pesan yang dikutip balasan
   * ini → dikirim sebagai `context: { message_id }`, bentuk kutipan
   * native Cloud API (pengguna melihat balasan menempel pada pesan
   * yang dikutip). Tanpa nilai ini body tidak berubah sama sekali.
   */
  async sendTextMessage(input: {
    phoneNumberId: string;
    to: string;
    text: string;
    contextMessageId?: string;
  }): Promise<{ providerMessageId: string }> {
    const body = await this.postJson<{
      messages?: Array<{ id?: string }>;
    }>(`${encodeURIComponent(input.phoneNumberId)}/messages`, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: input.to,
      type: "text",
      text: { body: input.text },
      ...(input.contextMessageId
        ? { context: { message_id: input.contextMessageId } }
        : {}),
    });
    const wamid = body.messages?.[0]?.id;
    if (typeof wamid !== "string" || !wamid) {
      throw new WhatsAppGraphError(200, null, "missing_message_id");
    }
    return { providerMessageId: wamid };
  }
}

// ---------------------------------------------------------------------------
// Webhook: normalisasi payload whatsapp_business_account (fungsi murni)
// ---------------------------------------------------------------------------

/** Tipe pesan masuk ternormalisasi — sejajar enum `message_type` DB kita. */
export type WhatsAppInboundType =
  | "text"
  | "image"
  | "audio"
  | "video"
  | "document"
  | "sticker"
  | "other";

const WHATSAPP_TYPE_MAP: Record<string, WhatsAppInboundType> = {
  text: "text",
  image: "image",
  audio: "audio",
  video: "video",
  document: "document",
  sticker: "sticker",
};

/** Satu pesan masuk WhatsApp yang dinormalisasi. */
export interface WhatsAppInboundMessageEvent {
  /** entry.id — WABA ID induk (konteks; BUKAN kunci resolusi akun). */
  wabaId: string;
  /** value.metadata.phone_number_id — kunci resolusi akun. */
  phoneNumberId: string;
  /** wa_id pengirim. */
  senderWaId: string;
  /** Nama profil pengirim dari value.contacts[]; null bila tak disertakan. */
  contactName: string | null;
  /** wamid pesan masuk — id dedup provider. */
  providerMessageId: string;
  /**
   * Wamid pesan yang dikutip pesan ini (`messages[].context.id`, Fase
   * 7B.5); null bila bukan balasan terkutip. WhatsApp menyertakan
   * context pada SEMUA balasan terkutip pengguna (teks maupun media).
   */
  replyToProviderMessageId: string | null;
  type: WhatsAppInboundType;
  /** Teks pesan; untuk media = caption bila ada, selain itu null. */
  text: string | null;
  timestamp: number | null;
}

/** Satu status pengiriman pesan KELUAR kita dari value.statuses[]. */
export interface WhatsAppStatusEvent {
  wabaId: string;
  phoneNumberId: string;
  /** wamid pesan keluar kita yang statusnya berubah. */
  providerMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  /** Kode error numerik Graph dari errors[0].code (status failed); null selain itu. */
  errorCode: number | null;
  timestamp: number | null;
}

export interface WhatsAppWebhookEvents {
  messages: WhatsAppInboundMessageEvent[];
  statuses: WhatsAppStatusEvent[];
}

interface WhatsAppWebhookPayload {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{
      field?: string;
      value?: {
        metadata?: {
          display_phone_number?: string;
          phone_number_id?: string;
        };
        contacts?: Array<{
          wa_id?: string;
          profile?: { name?: string };
        }>;
        messages?: Array<{
          from?: string;
          id?: string;
          timestamp?: string;
          type?: string;
          context?: { id?: string; from?: string };
          text?: { body?: string };
          image?: { caption?: string };
          video?: { caption?: string };
          document?: { caption?: string; filename?: string };
        }>;
        statuses?: Array<{
          id?: string;
          status?: string;
          timestamp?: string;
          errors?: Array<{ code?: number; title?: string }>;
        }>;
      };
    }>;
  }>;
}

/** true bila payload adalah objek webhook WhatsApp Business Account. */
export function isWhatsAppWebhookPayload(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { object?: unknown }).object === "whatsapp_business_account"
  );
}

/**
 * Menormalkan payload webhook WhatsApp menjadi event pesan masuk +
 * event status. Hanya `changes[].field === "messages"` yang dibaca.
 * Pesan non-teks TETAP dikembalikan dengan tipenya (caption sebagai
 * teks bila ada) — keputusan pencatatan ada di core; status yang tidak
 * dikenal dilewati. Nama kontak dicocokkan dari `value.contacts[]`
 * berdasarkan wa_id.
 */
export function parseWhatsAppWebhookEvents(
  payload: unknown,
): WhatsAppWebhookEvents {
  const result: WhatsAppWebhookEvents = { messages: [], statuses: [] };
  if (!isWhatsAppWebhookPayload(payload)) return result;
  const body = payload as WhatsAppWebhookPayload;
  for (const entry of body.entry ?? []) {
    const wabaId = typeof entry?.id === "string" ? entry.id : "";
    for (const change of entry?.changes ?? []) {
      if (change?.field !== "messages") continue;
      const value = change.value;
      const phoneNumberId = value?.metadata?.phone_number_id;
      if (typeof phoneNumberId !== "string" || !phoneNumberId) continue;

      const names = new Map<string, string>();
      for (const contact of value.contacts ?? []) {
        if (
          typeof contact?.wa_id === "string" &&
          typeof contact?.profile?.name === "string" &&
          contact.profile.name.trim()
        ) {
          names.set(contact.wa_id, contact.profile.name.trim());
        }
      }

      for (const message of value.messages ?? []) {
        const from = message?.from;
        const wamid = message?.id;
        if (typeof from !== "string" || !from) continue;
        if (typeof wamid !== "string" || !wamid) continue;
        const rawType = typeof message.type === "string" ? message.type : "";
        const type = WHATSAPP_TYPE_MAP[rawType] ?? "other";
        const text =
          type === "text"
            ? typeof message.text?.body === "string"
              ? message.text.body
              : null
            : (typeof message.image?.caption === "string" &&
                message.image.caption) ||
              (typeof message.video?.caption === "string" &&
                message.video.caption) ||
              (typeof message.document?.caption === "string" &&
                message.document.caption) ||
              null;
        result.messages.push({
          wabaId,
          phoneNumberId,
          senderWaId: from,
          contactName: names.get(from) ?? null,
          providerMessageId: wamid,
          replyToProviderMessageId:
            typeof message.context?.id === "string" && message.context.id
              ? message.context.id
              : null,
          type,
          text,
          timestamp:
            typeof message.timestamp === "string"
              ? Number(message.timestamp) || null
              : null,
        });
      }

      for (const status of value.statuses ?? []) {
        const wamid = status?.id;
        const state = status?.status;
        if (typeof wamid !== "string" || !wamid) continue;
        if (
          state !== "sent" &&
          state !== "delivered" &&
          state !== "read" &&
          state !== "failed"
        ) {
          continue;
        }
        const firstError = status.errors?.[0];
        result.statuses.push({
          wabaId,
          phoneNumberId,
          providerMessageId: wamid,
          status: state,
          errorCode:
            state === "failed" && typeof firstError?.code === "number"
              ? firstError.code
              : null,
          timestamp:
            typeof status.timestamp === "string"
              ? Number(status.timestamp) || null
              : null,
        });
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Adapter channel-core
// ---------------------------------------------------------------------------

/**
 * Adapter WhatsApp untuk satu akun (satu klien = satu token). account
 * pada SendMessageInput menunjuk akun channel; externalId-nya adalah
 * phone_number_id. Pengiriman produksi kita tetap lewat antrean
 * `queued` + poller API (keluarga poller Meta).
 */
export class WhatsAppChannelAdapter implements ChannelAdapter {
  readonly provider = "whatsapp" as const;
  private readonly client: WhatsAppCloudClient;

  constructor(client: WhatsAppCloudClient) {
    this.client = client;
  }

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const result = await this.client.sendTextMessage({
      phoneNumberId: input.account.externalId,
      to: input.toExternalId,
      text: input.text,
    });
    return { providerMessageId: result.providerMessageId };
  }

  /**
   * Verifikasi webhook WhatsApp memerlukan app secret PLATFORM (bukan
   * milik instance akun) — jalur produksi memverifikasi di route
   * webhook terhadap resolver panel→env (Fase 7A.1). Selalu false di
   * sini agar tidak ada jalur yang menganggap payload tepercaya tanpa
   * secret itu (pola Messenger).
   */
  verifyWebhookSignature(_input: VerifyWebhookInput): boolean {
    return false;
  }

  parseWebhookEvents(payload: unknown): StandardEvent[] {
    const parsed = parseWhatsAppWebhookEvents(payload);
    const events: StandardEvent[] = parsed.messages.map((m) => ({
      type: "message.received" as const,
      provider: "whatsapp" as const,
      providerEventId: m.providerMessageId,
      message: {
        providerMessageId: m.providerMessageId,
        conversationExternalId: m.senderWaId,
        conversationKind: "private" as const,
        senderExternalId: m.senderWaId,
        replyToProviderMessageId: m.replyToProviderMessageId ?? undefined,
        direction: "inbound" as const,
        // StandardMessageType channel-core tidak punya 'sticker'/'other'
        // — keduanya jatuh ke 'unknown' di permukaan adapter ini (core
        // DB tetap mencatat tipe persisnya lewat parser webhook).
        type:
          m.type === "text" ||
          m.type === "image" ||
          m.type === "audio" ||
          m.type === "video" ||
          m.type === "document"
            ? m.type
            : ("unknown" as const),
        text: m.text ?? undefined,
        sentAt: m.timestamp
          ? new Date(m.timestamp * 1000).toISOString()
          : new Date().toISOString(),
      },
      raw: payload,
      receivedAt: new Date().toISOString(),
    }));
    for (const s of parsed.statuses) {
      events.push({
        type: "message.status" as const,
        provider: "whatsapp" as const,
        providerEventId: s.providerMessageId,
        raw: payload,
        receivedAt: new Date().toISOString(),
      });
    }
    return events;
  }
}
