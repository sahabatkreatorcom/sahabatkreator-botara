import type {
  AgentListResponse,
  AgentResponse,
  ApiError,
  AutomationListResponse,
  AutomationResponse,
  BroadcastListResponse,
  BroadcastResponse,
  ChannelAccountListResponse,
  ChannelAccountResponse,
  CommentListResponse,
  CommentResponse,
  ContactListResponse,
  ContactResponse,
  ConversationListResponse,
  CreateContactRequest,
  ErrorCode,
  FlowListResponse,
  FlowResponse,
  FlowTemplateListResponse,
  GrowthLinkListResponse,
  GrowthLinkResponse,
  SegmentListResponse,
  SegmentResponse,
  OrderListResponse,
  OrderResponse,
  AppointmentServiceListResponse,
  BookingListResponse,
  ListAppointmentsQuery,
  KbDocumentListResponse,
  KbDocumentResponse,
  KbStatsResponse,
  ListBroadcastsQuery,
  ListCommentsQuery,
  ListContactsQuery,
  ListConversationsQuery,
  ListFlowsQuery,
  ListMessagesQuery,
  ListWhatsAppTemplatesQuery,
  MessageListResponse,
  MessageResponse,
  ProductListResponse,
  PublicMeResponse,
  SendMessageRequest,
  UpdateContactRequest,
  WhatsAppTemplateListResponse,
} from "@sahabat-kreator/contracts";

/**
 * @sahabat-kreator/sdk — client TypeScript tipis untuk API publik v1
 * Sahabat Kreator (Fase 5B, RANCANGAN §2 & §8).
 *
 * Prinsip: SDK ini TIDAK mendefinisikan ulang bentuk data. Semua tipe
 * request/response diimpor dari @sahabat-kreator/contracts (sumber
 * kebenaran tunggal); yang ditulis tangan di sini hanya transport —
 * autentikasi API key, pemetaan error kontrak, dan pemanggilan endpoint.
 * Tanpa dependensi runtime: memakai `fetch` bawaan (Node 18+ / browser
 * modern / Bun / Deno).
 *
 * Autentikasi: API key per tenant (`sk_live_...`) dibuat dari dashboard
 * Settings → API Keys. Tenant TIDAK PERNAH disebut di URL — server
 * menurunkannya dari kunci, dan scope kunci membatasi metode yang boleh
 * dipanggil (mis. tanpa `messages:write`, sendMessage ditolak 403
 * `API_KEY_SCOPE_DENIED`).
 */

export type {
  AgentListResponse,
  AgentResponse,
  ApiError,
  AutomationListResponse,
  AutomationResponse,
  BroadcastListResponse,
  BroadcastResponse,
  ChannelAccountListResponse,
  ChannelAccountResponse,
  CommentListResponse,
  CommentResponse,
  ContactListResponse,
  ContactResponse,
  ConversationListResponse,
  CreateContactRequest,
  ErrorCode,
  FlowListResponse,
  FlowResponse,
  FlowTemplateListResponse,
  GrowthLinkListResponse,
  GrowthLinkResponse,
  SegmentListResponse,
  SegmentResponse,
  OrderListResponse,
  OrderResponse,
  AppointmentServiceListResponse,
  BookingListResponse,
  ListAppointmentsQuery,
  KbDocumentListResponse,
  KbDocumentResponse,
  KbStatsResponse,
  ListBroadcastsQuery,
  ListCommentsQuery,
  ListContactsQuery,
  ListConversationsQuery,
  ListFlowsQuery,
  ListMessagesQuery,
  ListWhatsAppTemplatesQuery,
  MessageListResponse,
  MessageResponse,
  ProductListResponse,
  PublicMeResponse,
  SendMessageRequest,
  UpdateContactRequest,
  WhatsAppTemplateListResponse,
};

/**
 * Error API yang dilempar semua metode client. Membawa `code` kontrak
 * (mis. `API_KEY_INVALID`, `API_KEY_SCOPE_DENIED`, `NOT_FOUND`) dan status
 * HTTP, sehingga pemanggil bisa bercabang pada kode — bukan pada kalimat.
 */
export class SahabatKreatorApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(init: {
    status: number;
    code: ErrorCode;
    message: string;
    details?: unknown;
    cause?: unknown;
  }) {
    super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = "SahabatKreatorApiError";
    this.status = init.status;
    this.code = init.code;
    this.details = init.details;
  }
}

export interface SahabatKreatorClientOptions {
  /**
   * Origin API, TANPA path — mis. `https://botara.my.id`. Client memanggil
   * `{baseUrl}/api/v1/...`.
   */
  baseUrl: string;
  /** API key tenant (`sk_live_...`). Simpan sebagai rahasia (env/secret store). */
  apiKey: string;
  /** Override `fetch` (test/injeksi runtime); default `globalThis.fetch`. */
  fetch?: typeof fetch;
}

export class SahabatKreatorClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SahabatKreatorClientOptions) {
    if (!options.apiKey) {
      throw new Error("SahabatKreatorClient: `apiKey` wajib diisi");
    }
    if (!options.baseUrl) {
      throw new Error("SahabatKreatorClient: `baseUrl` wajib diisi");
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  private async request<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    init?: { query?: Record<string, string | number | undefined>; body?: unknown },
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}/api/v1${path}`);
    for (const [key, value] of Object.entries(init?.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          ...(init?.body !== undefined
            ? { "content-type": "application/json" }
            : {}),
        },
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
    } catch (err) {
      // Kegagalan jaringan: tidak ada respons HTTP. Dibungkus sebagai error
      // bertipe dengan status 0 agar pemanggil punya satu jalur penanganan.
      throw new SahabatKreatorApiError({
        status: 0,
        code: "INTERNAL_ERROR",
        message: `Network request to ${url.origin} failed`,
        cause: err,
      });
    }

    const text = await response.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }

    if (!response.ok) {
      const apiError = (parsed as ApiError | undefined)?.error;
      throw new SahabatKreatorApiError({
        status: response.status,
        code: apiError?.code ?? "INTERNAL_ERROR",
        message: apiError?.message ?? `Request failed with HTTP ${response.status}`,
        details: apiError?.details,
      });
    }
    return parsed as T;
  }

  /** GET /v1/me — identitas tenant pemilik kunci + scope kunci. */
  async me(): Promise<PublicMeResponse> {
    return this.request<PublicMeResponse>("GET", "/me");
  }

  /** GET /v1/contacts (scope `contacts:read`) — daftar + cari + pagination. */
  async listContacts(
    query: ListContactsQuery = {},
  ): Promise<ContactListResponse> {
    return this.request<ContactListResponse>("GET", "/contacts", {
      query: { search: query.search, limit: query.limit, offset: query.offset },
    });
  }

  /** POST /v1/contacts (scope `contacts:write`) — buat kontak baru. */
  async createContact(input: CreateContactRequest): Promise<ContactResponse> {
    return this.request<ContactResponse>("POST", "/contacts", { body: input });
  }

  /**
   * PATCH /v1/contacts/:id (scope `contacts:write`) — ubah kontak
   * (Fase 13A). `customFields` digabung per kunci di server: kunci yang
   * dikirim menimpa, yang tidak disebut dipertahankan.
   */
  async updateContact(
    contactId: string,
    input: UpdateContactRequest,
  ): Promise<ContactResponse> {
    return this.request<ContactResponse>(
      "PATCH",
      `/contacts/${encodeURIComponent(contactId)}`,
      { body: input },
    );
  }

  /** GET /v1/conversations (scope `conversations:read`). */
  async listConversations(
    query: ListConversationsQuery = {},
  ): Promise<ConversationListResponse> {
    return this.request<ConversationListResponse>("GET", "/conversations", {
      query: { status: query.status },
    });
  }

  /** GET /v1/conversations/:id/messages (scope `conversations:read`). */
  async listMessages(
    conversationId: string,
    query: ListMessagesQuery = {},
  ): Promise<MessageListResponse> {
    return this.request<MessageListResponse>(
      "GET",
      `/conversations/${encodeURIComponent(conversationId)}/messages`,
      { query: { limit: query.limit } },
    );
  }

  /**
   * POST /v1/conversations/:id/messages (scope `messages:write`) — kirim
   * pesan keluar sebagai workspace. Pesan masuk antrean pengiriman yang
   * sama dengan balasan dashboard (webchat: didorong realtime lewat hub
   * bila pengunjung terhubung).
   */
  async sendMessage(
    conversationId: string,
    contentText: string,
  ): Promise<MessageResponse> {
    const body: SendMessageRequest = { contentText };
    return this.request<MessageResponse>(
      "POST",
      `/conversations/${encodeURIComponent(conversationId)}/messages`,
      { body },
    );
  }

  /** GET /v1/products (scope `products:read`). */
  async listProducts(): Promise<ProductListResponse> {
    return this.request<ProductListResponse>("GET", "/products");
  }

  /**
   * GET /v1/comments (scope `comments:read`) — komentar Instagram/
   * Messenger yang tercatat dari webhook, terbaru dulu, beserta jejak
   * aksi aturan comment-to-DM/moderasi (Fase 10B).
   */
  async listComments(
    query: ListCommentsQuery = {},
  ): Promise<CommentListResponse> {
    return this.request<CommentListResponse>("GET", "/comments", {
      query: {
        channelAccountId: query.channelAccountId,
        automationId: query.automationId,
        limit: query.limit,
      },
    });
  }

  /**
   * POST /v1/comments/:id/hide (scope `comments:write`) — sembunyikan
   * komentar di Meta; status lokal berubah hanya bila Meta menerima.
   */
  async hideComment(commentId: string): Promise<CommentResponse> {
    return this.request<CommentResponse>(
      "POST",
      `/comments/${encodeURIComponent(commentId)}/hide`,
    );
  }

  /** POST /v1/comments/:id/unhide (scope `comments:write`). */
  async unhideComment(commentId: string): Promise<CommentResponse> {
    return this.request<CommentResponse>(
      "POST",
      `/comments/${encodeURIComponent(commentId)}/unhide`,
    );
  }

  // ---------------------------------------------------------------------
  // Fase 15A — permukaan BACA untuk sumber daya yang sebelumnya hanya
  // dashboard. Semua metode di bawah GET dengan scope baca khusus;
  // bentuk respons persis kontrak yang dipakai dashboard (satu sumber
  // kebenaran). Tulis untuk sumber daya ini tetap dashboard-only —
  // lihat docs/COVERAGE-MATRIX.md.
  // ---------------------------------------------------------------------

  /** GET /v1/broadcasts (scope `broadcasts:read`) — daftar berkursor + statistik per broadcast. */
  async listBroadcasts(
    query: ListBroadcastsQuery = {},
  ): Promise<BroadcastListResponse> {
    return this.request<BroadcastListResponse>("GET", "/broadcasts", {
      query: { status: query.status, cursor: query.cursor, limit: query.limit },
    });
  }

  /** GET /v1/broadcasts/:id (scope `broadcasts:read`) — detail + statistik penerima. */
  async getBroadcast(broadcastId: string): Promise<BroadcastResponse> {
    return this.request<BroadcastResponse>(
      "GET",
      `/broadcasts/${encodeURIComponent(broadcastId)}`,
    );
  }

  /** GET /v1/flows (scope `flows:read`) — daftar berkursor, graf ikut serta. */
  async listFlows(query: ListFlowsQuery = {}): Promise<FlowListResponse> {
    return this.request<FlowListResponse>("GET", "/flows", {
      query: { status: query.status, cursor: query.cursor, limit: query.limit },
    });
  }

  /** GET /v1/flows/:id (scope `flows:read`) — satu flow + graf lengkapnya. */
  async getFlow(flowId: string): Promise<FlowResponse> {
    return this.request<FlowResponse>(
      "GET",
      `/flows/${encodeURIComponent(flowId)}`,
    );
  }

  /** GET /v1/flow-templates (scope `flows:read`) — katalog template flow (ringkasan). */
  async listFlowTemplates(): Promise<FlowTemplateListResponse> {
    return this.request<FlowTemplateListResponse>("GET", "/flow-templates");
  }

  /** GET /v1/automations (scope `automations:read`) — keyword, sequence & aturan komentar. */
  async listAutomations(): Promise<AutomationListResponse> {
    return this.request<AutomationListResponse>("GET", "/automations");
  }

  /** GET /v1/automations/:id (scope `automations:read`). */
  async getAutomation(automationId: string): Promise<AutomationResponse> {
    return this.request<AutomationResponse>(
      "GET",
      `/automations/${encodeURIComponent(automationId)}`,
    );
  }

  /** GET /v1/agents (scope `agents:read`) — konfigurasi agen AI workspace. */
  async listAgents(): Promise<AgentListResponse> {
    return this.request<AgentListResponse>("GET", "/agents");
  }

  /** GET /v1/agents/:id (scope `agents:read`). */
  async getAgent(agentId: string): Promise<AgentResponse> {
    return this.request<AgentResponse>(
      "GET",
      `/agents/${encodeURIComponent(agentId)}`,
    );
  }

  /** GET /v1/channels (scope `channels:read`) — akun channel + status kesehatan (tanpa kredensial). */
  async listChannels(): Promise<ChannelAccountListResponse> {
    return this.request<ChannelAccountListResponse>("GET", "/channels");
  }

  /** GET /v1/channels/:id (scope `channels:read`). */
  async getChannel(channelId: string): Promise<ChannelAccountResponse> {
    return this.request<ChannelAccountResponse>(
      "GET",
      `/channels/${encodeURIComponent(channelId)}`,
    );
  }

  /**
   * GET /v1/whatsapp-templates (scope `whatsapp_templates:read`) —
   * cermin template WhatsApp satu akun channel (wajib `channelAccountId`).
   */
  async listWhatsAppTemplates(
    query: ListWhatsAppTemplatesQuery,
  ): Promise<WhatsAppTemplateListResponse> {
    return this.request<WhatsAppTemplateListResponse>(
      "GET",
      "/whatsapp-templates",
      { query: { channelAccountId: query.channelAccountId } },
    );
  }

  /** GET /v1/knowledge/documents (scope `knowledge:read`) — entri basis pengetahuan + jumlah chunk. */
  async listKnowledgeDocuments(): Promise<KbDocumentListResponse> {
    return this.request<KbDocumentListResponse>("GET", "/knowledge/documents");
  }

  /** GET /v1/knowledge/documents/:id (scope `knowledge:read`). */
  async getKnowledgeDocument(documentId: string): Promise<KbDocumentResponse> {
    return this.request<KbDocumentResponse>(
      "GET",
      `/knowledge/documents/${encodeURIComponent(documentId)}`,
    );
  }

  /** GET /v1/knowledge/stats (scope `knowledge:read`) — cakupan embedding + status pencarian semantik. */
  async getKnowledgeStats(): Promise<KbStatsResponse> {
    return this.request<KbStatsResponse>("GET", "/knowledge/stats");
  }

  /** GET /v1/growth-links (scope `growth_links:read`) — tautan growth + statistik turunan event (Fase 13B). */
  async listGrowthLinks(): Promise<GrowthLinkListResponse> {
    return this.request<GrowthLinkListResponse>("GET", "/growth-links");
  }

  /** GET /v1/growth-links/:id (scope `growth_links:read`). */
  async getGrowthLink(linkId: string): Promise<GrowthLinkResponse> {
    return this.request<GrowthLinkResponse>(
      "GET",
      `/growth-links/${encodeURIComponent(linkId)}`,
    );
  }

  /** GET /v1/segments (scope `segments:read`) — definisi segmen audiens workspace (Fase 13C). */
  async listSegments(): Promise<SegmentListResponse> {
    return this.request<SegmentListResponse>("GET", "/segments");
  }

  /** GET /v1/segments/:id (scope `segments:read`). */
  async getSegment(segmentId: string): Promise<SegmentResponse> {
    return this.request<SegmentResponse>(
      "GET",
      `/segments/${encodeURIComponent(segmentId)}`,
    );
  }

  /**
   * GET /v1/orders (scope `orders:read`) — order commerce yang lahir
   * dari checkout flow (node cart_checkout), terbaru dulu (Fase 13F).
   * Status order mengikuti tautan bayarnya; pembayaran fase ini
   * masih SIMULASI sampai gerbang merchant nyata (Fase 14A).
   * Keranjang SENGAJA tidak diekspos: keadaan sesi percakapan.
   */
  async listOrders(): Promise<OrderListResponse> {
    return this.request<OrderListResponse>("GET", "/orders");
  }

  /** GET /v1/orders/:id (scope `orders:read`) — detail + item snapshot + referensi tautan bayar. */
  async getOrder(orderId: string): Promise<OrderResponse> {
    return this.request<OrderResponse>(
      "GET",
      `/orders/${encodeURIComponent(orderId)}`,
    );
  }

  /**
   * GET /v1/appointments (scope `appointments:read`) — daftar booking
   * janji temu (Fase 13G), menaik per waktu mulai; saring opsional
   * from/to (ISO) + status. Booking lahir dari node flow
   * book_appointment atau dashboard — tulis SENGAJA bukan permukaan
   * publik (lihat docs/COVERAGE-MATRIX.md).
   */
  async listAppointments(
    query: ListAppointmentsQuery = {},
  ): Promise<BookingListResponse> {
    return this.request<BookingListResponse>("GET", "/appointments", {
      query: { from: query.from, to: query.to, status: query.status },
    });
  }

  /** GET /v1/appointment-services (scope `appointments:read`) — layanan janji tenant (termasuk nonaktif). */
  async listAppointmentServices(): Promise<AppointmentServiceListResponse> {
    return this.request<AppointmentServiceListResponse>(
      "GET",
      "/appointment-services",
    );
  }
}
