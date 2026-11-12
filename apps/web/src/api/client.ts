import type {
  AgentListResponse,
  AiUsageReportResponse,
  ApiKeyListResponse,
  AuditLogListResponse,
  DashboardSummaryResponse,
  ApiKeyResponse,
  CreatedApiKeyResponse,
  CreateApiKeyRequest,
  AgentResponse,
  AgentInstructionTemplateListResponse,
  AgentInstructionTemplateResponse,
  AgentPlaygroundDraftRequest,
  AgentPlaygroundRequest,
  AgentPlaygroundResponse,
  AgentSuggestionListResponse,
  AgentSuggestionResponse,
  AutomationListResponse,
  AutomationResponse,
  AutomationRunListResponse,
  AutomationRunResponse,
  AutomationTemplateListResponse,
  BroadcastAudiencePreviewResponse,
  BroadcastAbResultsResponse,
  BroadcastListResponse,
  BroadcastRecipientListResponse,
  BroadcastResponse,
  CreateBroadcastRequest,
  CreatePostGroupRequest,
  CreatePostRequest,
  PostGroupResponse,
  PostListResponse,
  PostResponse,
  PostStatus,
  PostTargetListResponse,
  UpdatePostRequest,
  ScheduleBroadcastRequest,
  UpdateBroadcastRequest,
  CreateWhatsAppTemplateRequest,
  SyncWhatsAppTemplatesResponse,
  WhatsAppTemplateListResponse,
  WhatsAppTemplateResponse,
  ChannelAccountListResponse,
  ChannelAccountResponse,
  CommentListResponse,
  CommentResponse,
  ContactDuplicatesResponse,
  ContactListResponse,
  ContactResponse,
  ConversationListResponse,
  ConversationResponse,
  ConversationStatus,
  ConversationNoteListResponse,
  ConversationNoteResponse,
  InvitationListResponse,
  InvitationPreviewResponse,
  InvitationResponse,
  AcceptInvitationResponse,
  TeamMemberListResponse,
  TeamMemberResponse,
  InvitableRole,
  CreateAgentRequest,
  CreateAgentInstructionTemplateRequest,
  CreateAutomationRequest,
  CreateSequenceTemplateRequest,
  InstantiateAutomationTemplateRequest,
  InstantiateSequenceTemplateRequest,
  CreateContactRequest,
  CreateFlowRequest,
  CreateGrowthLinkRequest,
  GrowthLinkAttributedContactsResponse,
  GrowthLinkListResponse,
  GrowthLinkResponse,
  OptInSettingsResponse,
  SegmentListResponse,
  SegmentPreviewResponse,
  SegmentResponse,
  CreateSegmentRequest,
  UpdateSegmentRequest,
  SegmentDefinition,
  UpdateOptInSettingsRequest,
  UpdateGrowthLinkRequest,
  CreateSavedReplyRequest,
  SavedReplyListResponse,
  SavedReplyResponse,
  UpdateSavedReplyRequest,
  FlowGraph,
  FlowGraphIssue,
  FlowListResponse,
  FlowResponse,
  FlowExperimentsResponse,
  FlowRunListResponse,
  FlowRunStepListResponse,
  FlowTemplateListResponse,
  InstantiateFlowTemplateRequest,
  FlowValidationResponse,
  CreateKbDocumentRequest,
  CreatePaymentLinkRequest,
  CreateProductRequest,
  FailedMessageListResponse,
  FailedMessageRetryResponse,
  IntegrationLogDetailResponse,
  IntegrationLogListResponse,
  IntegrationLogReplayResponse,
  KbDocumentListResponse,
  KbDocumentResponse,
  KbFileDocumentListResponse,
  KbFileDocumentResponse,
  KbStatsResponse,
  MediaUploadResponse,
  MessageListResponse,
  MessageResponse,
  MetaOAuthCompleteResponse,
  MetaOAuthInfoResponse,
  MetaOAuthProvider,
  MetaOAuthSessionResponse,
  MetaOAuthStartResponse,
  MetaWebhookInfoResponse,
  ThreadsOAuthInfoResponse,
  ThreadsOAuthStartResponse,
  TikTokOAuthInfoResponse,
  TikTokOAuthStartResponse,
  LinkedInOAuthInfoResponse,
  LinkedInOAuthStartResponse,
  PinterestOAuthInfoResponse,
  PinterestOAuthStartResponse,
  PinterestBoardCreateRequest,
  PinterestBoardCreateResponse,
  PinterestBoardsResponse,
  BlueskyConnectRequest,
  BlueskyConnectResponse,
  PaymentLinkListResponse,
  PaymentLinkResponse,
  OrderListResponse,
  OrderResponse,
  AppointmentAvailabilityResponse,
  AppointmentServiceListResponse,
  AppointmentServiceResponse,
  AppointmentSettingsResponse,
  AppointmentSlotListResponse,
  BookingListResponse,
  BookingResponse,
  CreateAppointmentServiceRequest,
  CreateBookingRequest,
  GoogleCalendarConnectionResponse,
  GoogleCalendarListResponse,
  GoogleConnectStartResponse,
  GoogleService,
  GoogleServiceConnectionsResponse,
  UpdateAppointmentAvailabilityRequest,
  UpdateAppointmentServiceRequest,
  UpdateAppointmentSettingsRequest,
  UpdateGoogleCalendarRequest,
  PlatformSettingKey,
  PlatformSettingsResponse,
  PlatformSettingStatus,
  PlatformSettingTestResult,
  PlatformOverviewResponse,
  PlatformTenantListResponse,
  PlatformTenantDetailResponse,
  PlatformUserListResponse,
  RevokeSessionsResponse,
  SetPlatformTenantStatusResponse,
  DeadLetterOutboxListResponse,
  RetryOutboxResponse,
  PlatformSystemResponse,
  PlatformAdminListResponse,
  AddPlatformAdminResponse,
  RemovePlatformAdminResponse,
  PlatformBackupResponse,
  TenantStatus,
  ProductListResponse,
  ProductResponse,
  PublicPaymentResponse,
  PaymentSettingsResponse,
  PaymentSettingsTestResponse,
  UpdatePaymentSettingsRequest,
  SequenceEnrollmentListResponse,
  SequenceEnrollmentResponse,
  EnrollConversationListResponse,
  EnrollConversationResponse,
  EnrollSequenceByTagRequest,
  EnrollSequenceByTagResponse,
  EnrollSequenceContactRequest,
  EnrollSequenceContactResponse,
  SequenceTemplateListResponse,
  SequenceTemplateResponse,
  TenantListResponse,
  TenantResponse,
  UpdateAgentRequest,
  UpdateAutomationRequest,
  UpdateContactRequest,
  UpdateFlowRequest,
  UpdateProductRequest,
} from "@sahabat-kreator/contracts";

/**
 * Klien API tipis untuk web (Fase 1C).
 *
 * - Satu origin dengan API: semua path berawalan "/api" (di staging diteruskan
 *   Vite preview ke API Hono; lihat vite.config.ts).
 * - Sesi adalah cookie httpOnly Better Auth → selalu `credentials: "include"`.
 * - Error dinormalisasi ke ApiClientError {status, code}: kode diambil dari
 *   format kontrak {error:{code,message}} (modul bisnis kita) ATAU format
 *   Better Auth {code,message} (endpoint /api/auth/*). UI menerjemahkan `code`
 *   ke teks lewat i18n (lihat errorText.ts) — pesan mentah server tidak pernah
 *   ditampilkan ke pengguna.
 */

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  /**
   * Flag Panel Admin Platform (Fase 6C) dari respons get-session —
   * menentukan visibilitas menu Admin. Bukan gerbang keamanan (API yang
   * menegakkan: non-admin → 404 di /api/admin/*).
   */
  isPlatformAdmin?: boolean;
}

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  /**
   * Detail terstruktur opsional dari server (format kontrak
   * `{error:{code,message,details}}`) — dipakai builder flow (Fase 8B)
   * untuk membaca `details.issues` pada 422 FLOW_GRAPH_INVALID.
   */
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function fallbackCodeForStatus(status: number): string {
  if (status === 401) return "UNAUTHORIZED";
  if (status === 404) return "NOT_FOUND";
  if (status === 429) return "RATE_LIMITED";
  if (status === 400 || status === 422) return "VALIDATION_ERROR";
  return "INTERNAL_ERROR";
}

/**
 * URL penyajian media (Fase 18).
 *
 * Sengaja BUKAN `fetch` ber-header: gambar/audio/video dipasang langsung
 * pada `src`, dan elemen itu tidak bisa membawa header Authorization.
 * Sesi dashboard berupa cookie httpOnly pada origin yang sama (proxy
 * `/api`), jadi permintaan media ikut terautentikasi tanpa tambahan apa
 * pun — dan server tetap memeriksa keanggotaan workspace per tenant.
 */
export function mediaUrl(tenantId: string, mediaId: string): string {
  return `/api/tenants/${tenantId}/media/${mediaId}`;
}

/**
 * Event global saat server menjawab 401 (sesi kedaluwarsa / dicabut).
 * AuthProvider mendengarkannya lalu menyegarkan sesi — pengguna langsung
 * dialihkan ke /login alih-alih melihat error per halaman.
 */
export const UNAUTHORIZED_EVENT = "sk:unauthorized";
let lastUnauthorizedAt = 0;

function notifyUnauthorized(): void {
  if (typeof window === "undefined") return;
  // Banyak request paralel bisa 401 bersamaan; cukup satu event per 2 dtk.
  const now = Date.now();
  if (now - lastUnauthorizedAt < 2_000) return;
  lastUnauthorizedAt = now;
  window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
}

/** Parse body + terjemahkan error kontrak — dipakai request & multipart. */
async function parseResponse<T>(res: Response): Promise<T> {
  const raw = await res.text();
  let body: unknown = null;
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
  }

  if (!res.ok) {
    const record = (body ?? {}) as Record<string, unknown>;
    const contractError = record.error as Record<string, unknown> | undefined;
    const code =
      (typeof contractError?.code === "string" && contractError.code) ||
      (typeof record.code === "string" && record.code) ||
      fallbackCodeForStatus(res.status);
    const message =
      (typeof contractError?.message === "string" && contractError.message) ||
      (typeof record.message === "string" && record.message) ||
      res.statusText;
    if (res.status === 401) notifyUnauthorized();
    throw new ApiClientError(res.status, code, message, contractError?.details);
  }

  return body as T;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  const headers = new Headers(init?.headers);
  // Default JSON, TAPI header pemanggil menang (bug lama: `...init` setelah
  // headers membuat Content-Type pemanggil hilang).
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  try {
    res = await fetch(path, {
      credentials: "include",
      ...init,
      headers,
    });
  } catch {
    throw new ApiClientError(0, "NETWORK_ERROR", "Network request failed");
  }
  return parseResponse<T>(res);
}

/**
 * Varian multipart (Fase 12C — unggah berkas KB): TANPA header
 * Content-Type JSON agar browser mengisi
 * `multipart/form-data; boundary=...` sendiri. Penanganan error
 * identik request() — kode kontrak diterjemahkan UI lewat errorText.
 */
async function requestFormData<T>(
  path: string,
  form: FormData,
  init?: { signal?: AbortSignal },
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      credentials: "include",
      body: form,
      ...(init?.signal ? { signal: init.signal } : {}),
    });
  } catch {
    throw new ApiClientError(0, "NETWORK_ERROR", "Network request failed");
  }
  return parseResponse<T>(res);
}

export const api = {
  media: {
    /**
     * POST /api/tenants/:tenantId/media (multipart, bagian `file`).
     *
     * Unggah dipisah dari pengiriman (Fase 18B): berkas bisa diunggah
     * sekali lalu dipakai untuk beberapa percakapan, dan kegagalan
     * unggah tidak boleh terlihat sebagai kegagalan kirim. Memakai
     * `requestFormData` supaya Content-Type multipart diisi browser.
     */
    async upload(
      tenantId: string,
      file: File,
      signal?: AbortSignal,
    ): Promise<MediaUploadResponse> {
      const form = new FormData();
      form.append("file", file);
      return requestFormData<MediaUploadResponse>(
        `/api/tenants/${tenantId}/media`,
        form,
        signal ? { signal } : undefined,
      );
    },
  },
  auth: {
    /** GET /api/auth/get-session → user bila sesi valid, null bila belum login. */
    async getSessionUser(): Promise<SessionUser | null> {
      const body = await request<{ user?: SessionUser } | null>(
        "/api/auth/get-session",
        { method: "GET" },
      );
      return body?.user ?? null;
    },
    signIn(email: string, password: string): Promise<unknown> {
      return request("/api/auth/sign-in/email", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
    },
    signUp(name: string, email: string, password: string): Promise<unknown> {
      return request("/api/auth/sign-up/email", {
        method: "POST",
        body: JSON.stringify({ name, email, password }),
      });
    },
    signOut(): Promise<unknown> {
      return request("/api/auth/sign-out", {
        method: "POST",
        body: JSON.stringify({}),
      });
    },
    /**
     * POST /api/auth/request-password-reset (Better Auth, Fase 14C) —
     * server mengirim email reset lewat Resend bila akunnya ada; respons
     * selalu sukses untuk alamat apa pun (anti-enumerasi), jadi UI
     * menampilkan keadaan "periksa email" tanpa membedakan. `redirectTo`
     * adalah halaman web yang dituju tautan email sesudah tokennya
     * diverifikasi server auth.
     */
    requestPasswordReset(email: string, redirectTo: string): Promise<unknown> {
      return request("/api/auth/request-password-reset", {
        method: "POST",
        body: JSON.stringify({ email, redirectTo }),
      });
    },
    /**
     * POST /api/auth/reset-password (Better Auth, Fase 14C) — menukar
     * token dari tautan email dengan kata sandi baru. Token tidak valid /
     * kedaluwarsa / sudah dipakai → error berkode INVALID_TOKEN.
     */
    resetPassword(token: string, newPassword: string): Promise<unknown> {
      return request("/api/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ token, newPassword }),
      });
    },
    /**
     * POST /api/auth/change-password (Better Auth) — verifikasi kata
     * sandi saat ini di server; `revokeOtherSessions: true` mencabut
     * sesi perangkat lain, sesi perangkat ini diperbarui & tetap masuk.
     * Error Better Auth: INVALID_PASSWORD (saat ini salah) /
     * PASSWORD_TOO_SHORT — diterjemahkan errorText dari kodenya.
     */
    changePassword(
      currentPassword: string,
      newPassword: string,
    ): Promise<unknown> {
      return request("/api/auth/change-password", {
        method: "POST",
        body: JSON.stringify({
          currentPassword,
          newPassword,
          revokeOtherSessions: true,
        }),
      });
    },
  },
  tenants: {
    async list(): Promise<TenantResponse[]> {
      const body = await request<TenantListResponse>("/api/tenants", {
        method: "GET",
      });
      return body.tenants;
    },
    create(name: string): Promise<TenantResponse> {
      return request<TenantResponse>("/api/tenants", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
    },
  },
  dashboard: {
    /** GET /api/tenants/:tenantId/dashboard/summary — ringkasan live workspace (Fase 16A). */
    summary(tenantId: string): Promise<DashboardSummaryResponse> {
      return request<DashboardSummaryResponse>(
        `/api/tenants/${tenantId}/dashboard/summary`,
        { method: "GET" },
      );
    },
  },
  contacts: {
    /** GET /api/tenants/:tenantId/contacts?search=&limit=&offset=&segmentId= → {contacts,total} */
    list(
      tenantId: string,
      opts?: {
        search?: string;
        limit?: number;
        offset?: number;
        segmentId?: string;
      },
    ): Promise<ContactListResponse> {
      const q = new URLSearchParams();
      if (opts?.search) q.set("search", opts.search);
      if (opts?.limit !== undefined) q.set("limit", String(opts.limit));
      if (opts?.offset !== undefined) q.set("offset", String(opts.offset));
      if (opts?.segmentId) q.set("segmentId", opts.segmentId);
      const qs = q.toString();
      return request<ContactListResponse>(
        `/api/tenants/${tenantId}/contacts${qs ? `?${qs}` : ""}`,
        { method: "GET" },
      );
    },
    create(
      tenantId: string,
      input: CreateContactRequest,
    ): Promise<ContactResponse> {
      return request<ContactResponse>(`/api/tenants/${tenantId}/contacts`, {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    get(tenantId: string, contactId: string): Promise<ContactResponse> {
      return request<ContactResponse>(
        `/api/tenants/${tenantId}/contacts/${contactId}`,
        { method: "GET" },
      );
    },
    update(
      tenantId: string,
      contactId: string,
      input: UpdateContactRequest,
    ): Promise<ContactResponse> {
      return request<ContactResponse>(
        `/api/tenants/${tenantId}/contacts/${contactId}`,
        { method: "PATCH", body: JSON.stringify(input) },
      );
    },
    /** GET /api/tenants/:tenantId/contacts/duplicates → kelompok kandidat duplikat (Fase 9B). */
    duplicates(tenantId: string): Promise<ContactDuplicatesResponse> {
      return request<ContactDuplicatesResponse>(
        `/api/tenants/${tenantId}/contacts/duplicates`,
        { method: "GET" },
      );
    },
    /** POST /api/tenants/:tenantId/contacts/:survivorId/merge { mergedId } → survivor hasil gabungan (owner/admin). */
    merge(
      tenantId: string,
      survivorId: string,
      mergedId: string,
    ): Promise<ContactResponse> {
      return request<ContactResponse>(
        `/api/tenants/${tenantId}/contacts/${survivorId}/merge`,
        { method: "POST", body: JSON.stringify({ mergedId }) },
      );
    },
  },
  channels: {
    /** GET /api/tenants/:tenantId/channels */
    async list(tenantId: string): Promise<ChannelAccountResponse[]> {
      const body = await request<ChannelAccountListResponse>(
        `/api/tenants/${tenantId}/channels`,
        { method: "GET" },
      );
      return body.channels;
    },
    /**
     * POST /api/tenants/:tenantId/channels — buat/hubungkan channel
     * (1F webchat, 6A telegram, 7A messenger/instagram dengan
     * pageId/igUserId/pageAccessToken).
     */
    create(
      tenantId: string,
      input: {
        provider: string;
        displayName?: string;
        botToken?: string;
        pageId?: string;
        igUserId?: string;
        pageAccessToken?: string;
        /** Fase 7D.3: jenis token connect manual Instagram. */
        tokenType?: "page_access_token" | "system_user_token";
        wabaId?: string;
        phoneNumberId?: string;
        accessToken?: string;
      },
    ): Promise<ChannelAccountResponse & { warnings?: string[] }> {
      return request<ChannelAccountResponse & { warnings?: string[] }>(
        `/api/tenants/${tenantId}/channels`,
        { method: "POST", body: JSON.stringify(input) },
      );
    },
    /**
     * GET /api/tenants/:tenantId/channels/meta-webhook-info — URL webhook
     * Meta + verify token untuk dipasang di Meta App (Fase 7A).
     * Owner/admin saja; peran lain menerima 403 (UI menyembunyikan panel).
     */
    metaWebhookInfo(tenantId: string): Promise<MetaWebhookInfoResponse> {
      return request<MetaWebhookInfoResponse>(
        `/api/tenants/${tenantId}/channels/meta-webhook-info`,
        { method: "GET" },
      );
    },
    /**
     * GET /api/tenants/:tenantId/channels/meta-oauth-info — ketersediaan
     * OAuth Meta per provider (Fase 7D). Owner/admin saja; tidak pernah
     * membawa App Secret (App ID/config ID publik boleh tampil).
     */
    metaOAuthInfo(tenantId: string): Promise<MetaOAuthInfoResponse> {
      return request<MetaOAuthInfoResponse>(
        `/api/tenants/${tenantId}/channels/meta-oauth-info`,
        { method: "GET" },
      );
    },
    /**
     * POST /api/tenants/:tenantId/meta-oauth/start — buat state sekali
     * pakai + URL dialog Meta; pemanggil mengarahkan browser ke sana
     * (redirect penuh, pola navigasi aplikasi).
     */
    metaOAuthStart(
      tenantId: string,
      provider: MetaOAuthProvider,
    ): Promise<MetaOAuthStartResponse> {
      return request<MetaOAuthStartResponse>(
        `/api/tenants/${tenantId}/meta-oauth/start`,
        { method: "POST", body: JSON.stringify({ provider }) },
      );
    },
    /**
     * GET /api/tenants/:tenantId/meta-oauth/sessions/:sessionId — aset
     * hasil login Meta untuk dialog pemilih (tanpa token apa pun).
     */
    metaOAuthSession(
      tenantId: string,
      sessionId: string,
    ): Promise<MetaOAuthSessionResponse> {
      return request<MetaOAuthSessionResponse>(
        `/api/tenants/${tenantId}/meta-oauth/sessions/${sessionId}`,
        { method: "GET" },
      );
    },
    /**
     * POST .../meta-oauth/sessions/:sessionId/complete {assetId} —
     * hubungkan aset terpilih; respons membawa channel + peringatan
     * berkode (mis. subscribe gagal) untuk ditampilkan UI.
     */
    metaOAuthComplete(
      tenantId: string,
      sessionId: string,
      assetId: string,
    ): Promise<MetaOAuthCompleteResponse> {
      return request<MetaOAuthCompleteResponse>(
        `/api/tenants/${tenantId}/meta-oauth/sessions/${sessionId}/complete`,
        { method: "POST", body: JSON.stringify({ assetId }) },
      );
    },
    /**
     * GET /api/tenants/:tenantId/channels/threads-oauth-info —
     * ketersediaan connect Threads (integrasi Threads). Owner/admin
     * saja; membawa Redirect URI resmi + status konfigurasi kredensial
     * aplikasi Threads (App ID publik boleh tampil; secret tidak).
     */
    threadsOAuthInfo(tenantId: string): Promise<ThreadsOAuthInfoResponse> {
      return request<ThreadsOAuthInfoResponse>(
        `/api/tenants/${tenantId}/channels/threads-oauth-info`,
        { method: "GET" },
      );
    },
    /**
     * POST /api/tenants/:tenantId/threads-oauth/start — buat state
     * sekali pakai + URL dialog authorize Threads; pemanggil
     * mengarahkan browser ke sana (redirect penuh). Callback langsung
     * menghubungkan akun (tanpa sesi pemilih seperti Meta).
     */
    threadsOAuthStart(tenantId: string): Promise<ThreadsOAuthStartResponse> {
      return request<ThreadsOAuthStartResponse>(
        `/api/tenants/${tenantId}/threads-oauth/start`,
        { method: "POST", body: JSON.stringify({}) },
      );
    },
    /**
     * GET /api/tenants/:tenantId/channels/tiktok-oauth-info —
     * ketersediaan connect TikTok (Login Kit). Pola Threads:
     * Redirect URI resmi + status kredensial aplikasi (Client Key
     * publik boleh tampil; secret tidak).
     */
    tiktokOAuthInfo(tenantId: string): Promise<TikTokOAuthInfoResponse> {
      return request<TikTokOAuthInfoResponse>(
        `/api/tenants/${tenantId}/channels/tiktok-oauth-info`,
        { method: "GET" },
      );
    },
    /**
     * POST /api/tenants/:tenantId/tiktok-oauth/start — state sekali
     * pakai + URL dialog authorize TikTok; browser diarahkan ke sana.
     */
    tiktokOAuthStart(tenantId: string): Promise<TikTokOAuthStartResponse> {
      return request<TikTokOAuthStartResponse>(
        `/api/tenants/${tenantId}/tiktok-oauth/start`,
        { method: "POST", body: JSON.stringify({}) },
      );
    },
    /** GET .../channels/linkedin-oauth-info — ketersediaan connect LinkedIn. */
    linkedinOAuthInfo(tenantId: string): Promise<LinkedInOAuthInfoResponse> {
      return request<LinkedInOAuthInfoResponse>(
        `/api/tenants/${tenantId}/channels/linkedin-oauth-info`,
        { method: "GET" },
      );
    },
    /** POST .../linkedin-oauth/start — state + URL dialog LinkedIn. */
    linkedinOAuthStart(tenantId: string): Promise<LinkedInOAuthStartResponse> {
      return request<LinkedInOAuthStartResponse>(
        `/api/tenants/${tenantId}/linkedin-oauth/start`,
        { method: "POST", body: JSON.stringify({}) },
      );
    },
    /** GET .../channels/pinterest-oauth-info — ketersediaan connect Pinterest. */
    pinterestOAuthInfo(tenantId: string): Promise<PinterestOAuthInfoResponse> {
      return request<PinterestOAuthInfoResponse>(
        `/api/tenants/${tenantId}/channels/pinterest-oauth-info`,
        { method: "GET" },
      );
    },
    /** POST .../pinterest-oauth/start — state + URL dialog Pinterest. */
    pinterestOAuthStart(tenantId: string): Promise<PinterestOAuthStartResponse> {
      return request<PinterestOAuthStartResponse>(
        `/api/tenants/${tenantId}/pinterest-oauth/start`,
        { method: "POST", body: JSON.stringify({}) },
      );
    },
    /**
     * GET .../channels/:channelId/pinterest-boards — daftar board akun
     * Pinterest + pilihan board tujuan tersimpan (pemilih board).
     * Owner/admin saja.
     */
    pinterestBoards(
      tenantId: string,
      channelId: string,
    ): Promise<PinterestBoardsResponse> {
      return request<PinterestBoardsResponse>(
        `/api/tenants/${tenantId}/channels/${channelId}/pinterest-boards`,
        { method: "GET" },
      );
    },
    /**
     * PUT .../channels/:channelId/pinterest-board {boardId} — simpan
     * pilihan board tujuan akun (server memvalidasi board milik akun
     * itu); boardId null membersihkan pilihan → board pertama.
     */
    pinterestBoardSelect(
      tenantId: string,
      channelId: string,
      boardId: string | null,
    ): Promise<PinterestBoardsResponse> {
      return request<PinterestBoardsResponse>(
        `/api/tenants/${tenantId}/channels/${channelId}/pinterest-board`,
        { method: "PUT", body: JSON.stringify({ boardId }) },
      );
    },
    /**
     * POST .../channels/:channelId/pinterest-boards — buat board baru
     * di akun Pinterest (POST /v5/boards); board baru otomatis menjadi
     * pilihan tujuan akun.
     */
    pinterestBoardCreate(
      tenantId: string,
      channelId: string,
      body: PinterestBoardCreateRequest,
    ): Promise<PinterestBoardCreateResponse> {
      return request<PinterestBoardCreateResponse>(
        `/api/tenants/${tenantId}/channels/${channelId}/pinterest-boards`,
        { method: "POST", body: JSON.stringify(body) },
      );
    },
    /**
     * POST /api/tenants/:tenantId/bluesky-connect — hubungkan Bluesky
     * dengan handle + App Password (bukan OAuth). App password hanya
     * dikirim sekali ini; respons membawa channel hasil connect.
     */
    blueskyConnect(
      tenantId: string,
      body: BlueskyConnectRequest,
    ): Promise<BlueskyConnectResponse> {
      return request<BlueskyConnectResponse>(
        `/api/tenants/${tenantId}/bluesky-connect`,
        { method: "POST", body: JSON.stringify(body) },
      );
    },
    /** DELETE /api/tenants/:tenantId/channels/:channelId — putuskan koneksi (hotfix Telegram); riwayat percakapan tidak dihapus. */
    disconnect(tenantId: string, channelId: string): Promise<void> {
      return request<void>(
        `/api/tenants/${tenantId}/channels/${channelId}`,
        { method: "DELETE" },
      );
    },
    /** GET /api/tenants/:tenantId/channels/trash — daftar Sampah (Fase 6I). */
    async listTrash(tenantId: string): Promise<ChannelAccountResponse[]> {
      const body = await request<ChannelAccountListResponse>(
        `/api/tenants/${tenantId}/channels/trash`,
        { method: "GET" },
      );
      return body.channels;
    },
    /** POST .../channels/:channelId/trash {confirmationName} — buang ke Sampah; server memvalidasi nama persis (Fase 6I). */
    trash(
      tenantId: string,
      channelId: string,
      confirmationName: string,
    ): Promise<ChannelAccountResponse> {
      return request<ChannelAccountResponse>(
        `/api/tenants/${tenantId}/channels/${channelId}/trash`,
        { method: "POST", body: JSON.stringify({ confirmationName }) },
      );
    },
    /** POST .../channels/:channelId/restore — pulihkan dari Sampah (tetap disconnected; Fase 6I). */
    restore(
      tenantId: string,
      channelId: string,
    ): Promise<ChannelAccountResponse> {
      return request<ChannelAccountResponse>(
        `/api/tenants/${tenantId}/channels/${channelId}/restore`,
        { method: "POST" },
      );
    },
    /**
     * GET .../channels/:channelId/export — unduh ekspor riwayat JSON
     * (Fase 6I). Bukan `request` biasa: responsnya berkas unduhan, jadi
     * fetch berkredensial langsung, lalu simpan lewat blob URL dengan
     * nama berkas dari Content-Disposition server.
     */
    async downloadExport(tenantId: string, channelId: string): Promise<void> {
      let res: Response;
      try {
        res = await fetch(
          `/api/tenants/${tenantId}/channels/${channelId}/export`,
          { credentials: "include" },
        );
      } catch {
        throw new ApiClientError(0, "NETWORK_ERROR", "Network request failed");
      }
      if (!res.ok) {
        throw new ApiClientError(
          res.status,
          fallbackCodeForStatus(res.status),
          res.statusText,
        );
      }
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(disposition);
      const filename = match?.[1] ?? `channel-export-${channelId.slice(0, 8)}.json`;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    },
  },
  conversations: {
    /** GET /api/tenants/:tenantId/conversations?status=&assignment=mine|unassigned&q= */
    async list(
      tenantId: string,
      opts?: { status?: string; assignment?: "mine" | "unassigned"; q?: string },
    ): Promise<ConversationResponse[]> {
      const q = new URLSearchParams();
      if (opts?.status) q.set("status", opts.status);
      if (opts?.assignment) q.set("assignment", opts.assignment);
      // Fase 16C: pencarian nama kontak / nomor / judul percakapan.
      if (opts?.q) q.set("q", opts.q);
      const qs = q.toString();
      const body = await request<ConversationListResponse>(
        `/api/tenants/${tenantId}/conversations${qs ? `?${qs}` : ""}`,
        { method: "GET" },
      );
      return body.conversations;
    },
    /**
     * POST .../conversations/:id/assign {assigneeUserId|null} (Fase 9C)
     * → percakapan terbarui. Penerima bukan member → 422
     * ASSIGNEE_NOT_MEMBER.
     */
    assign(
      tenantId: string,
      conversationId: string,
      assigneeUserId: string | null,
    ): Promise<ConversationResponse> {
      return request<ConversationResponse>(
        `/api/tenants/${tenantId}/conversations/${conversationId}/assign`,
        {
          method: "POST",
          body: JSON.stringify({ assigneeUserId }),
        },
      );
    },
    /**
     * PATCH .../conversations/:id {status} (Fase 16C) → percakapan
     * terbarui. Status hanya label kerja tim; tidak menyentuh AI.
     */
    setStatus(
      tenantId: string,
      conversationId: string,
      status: ConversationStatus,
    ): Promise<ConversationResponse> {
      return request<ConversationResponse>(
        `/api/tenants/${tenantId}/conversations/${conversationId}`,
        { method: "PATCH", body: JSON.stringify({ status }) },
      );
    },
    /**
     * POST .../conversations/:id/agent {agentEnabled} (Fase 16C) →
     * percakapan terbarui. Satu-satunya jalan menyalakan kembali AI
     * setelah handoff.
     */
    setAgentEnabled(
      tenantId: string,
      conversationId: string,
      agentEnabled: boolean,
    ): Promise<ConversationResponse> {
      return request<ConversationResponse>(
        `/api/tenants/${tenantId}/conversations/${conversationId}/agent`,
        { method: "POST", body: JSON.stringify({ agentEnabled }) },
      );
    },
    /**
     * POST .../conversations/:id/template {templateId, bodyParams} →
     * pesan template terantre (Fase 16C). Satu-satunya pesan yang boleh
     * keluar setelah jendela 24 jam WhatsApp tertutup.
     */
    /**
     * Kirim template (Fase 16C; parameter per komponen sejak Fase 17).
     * Header dan tombol URL membawa variabelnya sendiri — Meta menolak
     * template ber-header `{{1}}` bila hanya body yang dikirim.
     */
    sendTemplate(
      tenantId: string,
      conversationId: string,
      templateId: string,
      params: {
        bodyParams: string[];
        headerParams?: string[];
        buttonParams?: Array<{ index: number; text: string }>;
      },
    ): Promise<MessageResponse> {
      return request<MessageResponse>(
        `/api/tenants/${tenantId}/conversations/${conversationId}/template`,
        {
          method: "POST",
          body: JSON.stringify({
            templateId,
            bodyParams: params.bodyParams,
            headerParams: params.headerParams ?? [],
            buttonParams: params.buttonParams ?? [],
          }),
        },
      );
    },
    /**
     * POST .../conversations/:id/media → kirim lampiran (Fase 18B).
     * Berkas harus sudah diunggah lewat `api.media.upload`.
     */
    async sendMedia(
      tenantId: string,
      conversationId: string,
      input: { mediaId: string; caption?: string },
    ): Promise<MessageResponse> {
      return request<MessageResponse>(
        `/api/tenants/${tenantId}/conversations/${conversationId}/media`,
        {
          method: "POST",
          body: JSON.stringify({
            mediaId: input.mediaId,
            ...(input.caption?.trim() ? { caption: input.caption.trim() } : {}),
          }),
        },
      );
    },
    /** GET .../conversations/:id/notes → catatan internal (Fase 9C). */
    async listNotes(
      tenantId: string,
      conversationId: string,
    ): Promise<ConversationNoteResponse[]> {
      const body = await request<ConversationNoteListResponse>(
        `/api/tenants/${tenantId}/conversations/${conversationId}/notes`,
        { method: "GET" },
      );
      return body.notes;
    },
    /** POST .../conversations/:id/notes {body} → catatan baru. */
    createNote(
      tenantId: string,
      conversationId: string,
      body: string,
    ): Promise<ConversationNoteResponse> {
      return request<ConversationNoteResponse>(
        `/api/tenants/${tenantId}/conversations/${conversationId}/notes`,
        { method: "POST", body: JSON.stringify({ body }) },
      );
    },
    /** DELETE .../conversations/:id/notes/:noteId (penulis / owner / admin). */
    async deleteNote(
      tenantId: string,
      conversationId: string,
      noteId: string,
    ): Promise<void> {
      await request<unknown>(
        `/api/tenants/${tenantId}/conversations/${conversationId}/notes/${noteId}`,
        { method: "DELETE" },
      );
    },
    /**
     * GET .../conversations/:id/messages?limit=&before= → satu halaman
     * pesan kronologis menaik + `hasMore` (Fase 16C). `before` = id pesan
     * TERTUA yang sudah tampil; kembalian berisi pesan yang lebih tua.
     */
    async listMessages(
      tenantId: string,
      conversationId: string,
      opts?: { limit?: number; before?: string },
    ): Promise<{ messages: MessageResponse[]; hasMore: boolean }> {
      const q = new URLSearchParams();
      if (opts?.limit !== undefined) q.set("limit", String(opts.limit));
      if (opts?.before !== undefined) q.set("before", opts.before);
      const qs = q.toString();
      const body = await request<MessageListResponse>(
        `/api/tenants/${tenantId}/conversations/${conversationId}/messages${qs ? `?${qs}` : ""}`,
        { method: "GET" },
      );
      return { messages: body.messages, hasMore: body.hasMore };
    },
    /**
     * POST .../conversations/:id/messages {contentText, replyToMessageId?}
     * → pesan outbound `queued`. `replyToMessageId` (Fase 7B.5) mengutip
     * pesan lain di percakapan yang sama; target tidak sah → 422
     * MESSAGE_REPLY_TARGET_INVALID.
     */
    sendMessage(
      tenantId: string,
      conversationId: string,
      contentText: string,
      replyToMessageId?: string,
    ): Promise<MessageResponse> {
      return request<MessageResponse>(
        `/api/tenants/${tenantId}/conversations/${conversationId}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            contentText,
            ...(replyToMessageId ? { replyToMessageId } : {}),
          }),
        },
      );
    },
  },
  automations: {
    /** GET /api/tenants/:tenantId/automations → daftar + runCount (Fase 2A). */
    async list(tenantId: string): Promise<AutomationResponse[]> {
      const body = await request<AutomationListResponse>(
        `/api/tenants/${tenantId}/automations`,
        { method: "GET" },
      );
      return body.automations;
    },
    /** POST /api/tenants/:tenantId/automations → 201 automation baru. */
    create(
      tenantId: string,
      input: CreateAutomationRequest,
    ): Promise<AutomationResponse> {
      return request<AutomationResponse>(
        `/api/tenants/${tenantId}/automations`,
        { method: "POST", body: JSON.stringify(input) },
      );
    },
    /**
     * GET /api/tenants/:tenantId/automations/templates — katalog template
     * (Fase 16B). Ringkasan + langkah sequence pada locale yang diminta
     * (G2: untuk pratinjau linimasa galeri; bawaan server "id").
     */
    listTemplates(
      tenantId: string,
      locale?: "id" | "en",
    ): Promise<AutomationTemplateListResponse> {
      return request<AutomationTemplateListResponse>(
        `/api/tenants/${tenantId}/automations/templates${locale ? `?locale=${locale}` : ""}`,
        { method: "GET" },
      );
    },
    /**
     * POST /api/tenants/:tenantId/automations/templates/:slug — membuat
     * automation NYATA dari template, SELALU nonaktif agar pemilik bisa
     * menyunting placeholder sebelum ada pesan yang terkirim.
     */
    instantiateTemplate(
      tenantId: string,
      slug: string,
      input: InstantiateAutomationTemplateRequest = {},
    ): Promise<AutomationResponse> {
      return request<AutomationResponse>(
        `/api/tenants/${tenantId}/automations/templates/${slug}`,
        { method: "POST", body: JSON.stringify(input) },
      );
    },
    /** PATCH /api/tenants/:tenantId/automations/:id → automation terbarui. */
    update(
      tenantId: string,
      automationId: string,
      input: UpdateAutomationRequest,
    ): Promise<AutomationResponse> {
      return request<AutomationResponse>(
        `/api/tenants/${tenantId}/automations/${automationId}`,
        { method: "PATCH", body: JSON.stringify(input) },
      );
    },
    /** GET /api/tenants/:tenantId/automations/:id/runs → riwayat eksekusi. */
    async listRuns(
      tenantId: string,
      automationId: string,
    ): Promise<AutomationRunResponse[]> {
      const body = await request<AutomationRunListResponse>(
        `/api/tenants/${tenantId}/automations/${automationId}/runs`,
        { method: "GET" },
      );
      return body.runs;
    },
    /** GET /api/tenants/:tenantId/automations/:id/enrollments → pendaftaran sequence (Fase 2C). */
    async listEnrollments(
      tenantId: string,
      automationId: string,
    ): Promise<SequenceEnrollmentResponse[]> {
      const body = await request<SequenceEnrollmentListResponse>(
        `/api/tenants/${tenantId}/automations/${automationId}/enrollments`,
        { method: "GET" },
      );
      return body.enrollments;
    },
    /**
     * GET /api/tenants/:tenantId/automations/:id/enroll-conversations?contactId=
     * → percakapan pesan (private/group) kontak untuk pemilih jangkar
     * pendaftaran manual (G2b), terbaru dulu.
     */
    async listEnrollConversations(
      tenantId: string,
      automationId: string,
      contactId: string,
    ): Promise<EnrollConversationResponse[]> {
      const body = await request<EnrollConversationListResponse>(
        `/api/tenants/${tenantId}/automations/${automationId}/enroll-conversations?contactId=${contactId}`,
        { method: "GET" },
      );
      return body.conversations;
    },
    /**
     * POST /api/tenants/:tenantId/automations/:id/enroll → daftarkan satu
     * kontak secara manual (G2b). Tanpa conversationId, server memakai
     * percakapan pesan terbaru kontak sebagai jangkar. Penolakan tiba
     * sebagai ApiClientError berkode (ENROLL_NO_CONVERSATION dsb.).
     */
    enrollContact(
      tenantId: string,
      automationId: string,
      input: EnrollSequenceContactRequest,
    ): Promise<EnrollSequenceContactResponse> {
      return request<EnrollSequenceContactResponse>(
        `/api/tenants/${tenantId}/automations/${automationId}/enroll`,
        { method: "POST", body: JSON.stringify(input) },
      );
    },
    /**
     * POST /api/tenants/:tenantId/automations/:id/enroll-by-tag →
     * daftarkan semua kontak bertag (G2b); balasan adalah laporan
     * agregat terdaftar / sudah terdaftar / dilewati per alasan.
     */
    enrollByTag(
      tenantId: string,
      automationId: string,
      input: EnrollSequenceByTagRequest,
    ): Promise<EnrollSequenceByTagResponse> {
      return request<EnrollSequenceByTagResponse>(
        `/api/tenants/${tenantId}/automations/${automationId}/enroll-by-tag`,
        { method: "POST", body: JSON.stringify(input) },
      );
    },
  },
  comments: {
    /** GET /api/tenants/:tenantId/comments → komentar IG/Messenger terbaru (Fase 10B). */
    async list(
      tenantId: string,
      filter?: { channelAccountId?: string; automationId?: string; limit?: number },
    ): Promise<CommentResponse[]> {
      const params = new URLSearchParams();
      if (filter?.channelAccountId)
        params.set("channelAccountId", filter.channelAccountId);
      if (filter?.automationId) params.set("automationId", filter.automationId);
      if (filter?.limit) params.set("limit", String(filter.limit));
      const qs = params.toString();
      const body = await request<CommentListResponse>(
        `/api/tenants/${tenantId}/comments${qs ? `?${qs}` : ""}`,
        { method: "GET" },
      );
      return body.comments;
    },
    /** POST /api/tenants/:tenantId/comments/:id/hide → sembunyikan di Meta + lokal (Fase 10B). */
    hide(tenantId: string, commentId: string): Promise<CommentResponse> {
      return request<CommentResponse>(
        `/api/tenants/${tenantId}/comments/${commentId}/hide`,
        { method: "POST" },
      );
    },
    /** POST /api/tenants/:tenantId/comments/:id/unhide → tampilkan lagi (Fase 10B). */
    unhide(tenantId: string, commentId: string): Promise<CommentResponse> {
      return request<CommentResponse>(
        `/api/tenants/${tenantId}/comments/${commentId}/unhide`,
        { method: "POST" },
      );
    },
  },
  agents: {
    /** GET /api/tenants/:tenantId/agents → daftar agent workspace (Fase 3A). */
    async list(tenantId: string): Promise<AgentResponse[]> {
      const body = await request<AgentListResponse>(
        `/api/tenants/${tenantId}/agents`,
        { method: "GET" },
      );
      return body.agents;
    },
    /** POST /api/tenants/:tenantId/agents → 201 agent baru. */
    create(
      tenantId: string,
      input: CreateAgentRequest,
    ): Promise<AgentResponse> {
      return request<AgentResponse>(`/api/tenants/${tenantId}/agents`, {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    /** PATCH /api/tenants/:tenantId/agents/:id → agent terbarui. */
    update(
      tenantId: string,
      agentId: string,
      input: UpdateAgentRequest,
    ): Promise<AgentResponse> {
      return request<AgentResponse>(
        `/api/tenants/${tenantId}/agents/${agentId}`,
        { method: "PATCH", body: JSON.stringify(input) },
      );
    },
    /**
     * POST /api/tenants/:tenantId/agents/:id/playground → uji KERING agent
     * (Fase 12E): balasan calon + potongan KB terambil + niat tool.
     * Tidak ada data yang berubah di server selain catatan usage uji.
     */
    playground(
      tenantId: string,
      agentId: string,
      input: AgentPlaygroundRequest,
    ): Promise<AgentPlaygroundResponse> {
      return request<AgentPlaygroundResponse>(
        `/api/tenants/${tenantId}/agents/${agentId}/playground`,
        { method: "POST", body: JSON.stringify(input) },
      );
    },
    /**
     * POST /api/tenants/:tenantId/agents/playground-draft → uji KERING
     * konfigurasi DRAF formulir agent (belum tersimpan): balasan calon
     * + potongan KB + niat tool, dari instruction/model/mode/bahasa
     * yang sedang diedit. Bentuk respons sama persis dengan playground.
     */
    playgroundDraft(
      tenantId: string,
      input: AgentPlaygroundDraftRequest,
    ): Promise<AgentPlaygroundResponse> {
      return request<AgentPlaygroundResponse>(
        `/api/tenants/${tenantId}/agents/playground-draft`,
        { method: "POST", body: JSON.stringify(input) },
      );
    },
  },
  agentTemplates: {
    /** GET /api/tenants/:tenantId/agent-templates → templat instruction pribadi tenant. */
    async list(
      tenantId: string,
    ): Promise<AgentInstructionTemplateResponse[]> {
      const body = await request<AgentInstructionTemplateListResponse>(
        `/api/tenants/${tenantId}/agent-templates`,
        { method: "GET" },
      );
      return body.templates;
    },
    /** POST /api/tenants/:tenantId/agent-templates → 201 templat instruction baru. */
    create(
      tenantId: string,
      input: CreateAgentInstructionTemplateRequest,
    ): Promise<AgentInstructionTemplateResponse> {
      return request<AgentInstructionTemplateResponse>(
        `/api/tenants/${tenantId}/agent-templates`,
        { method: "POST", body: JSON.stringify(input) },
      );
    },
    /** DELETE /api/tenants/:tenantId/agent-templates/:id → templat terhapus. */
    remove(
      tenantId: string,
      templateId: string,
    ): Promise<AgentInstructionTemplateResponse> {
      return request<AgentInstructionTemplateResponse>(
        `/api/tenants/${tenantId}/agent-templates/${templateId}`,
        { method: "DELETE" },
      );
    },
  },
  sequenceTemplates: {
    /** GET /api/tenants/:tenantId/sequence-templates → templat sequence pribadi tenant (G2). */
    async list(tenantId: string): Promise<SequenceTemplateResponse[]> {
      const body = await request<SequenceTemplateListResponse>(
        `/api/tenants/${tenantId}/sequence-templates`,
        { method: "GET" },
      );
      return body.templates;
    },
    /** POST /api/tenants/:tenantId/sequence-templates → 201 templat sequence baru. */
    create(
      tenantId: string,
      input: CreateSequenceTemplateRequest,
    ): Promise<SequenceTemplateResponse> {
      return request<SequenceTemplateResponse>(
        `/api/tenants/${tenantId}/sequence-templates`,
        { method: "POST", body: JSON.stringify(input) },
      );
    },
    /** DELETE /api/tenants/:tenantId/sequence-templates/:id → templat terhapus. */
    remove(
      tenantId: string,
      templateId: string,
    ): Promise<SequenceTemplateResponse> {
      return request<SequenceTemplateResponse>(
        `/api/tenants/${tenantId}/sequence-templates/${templateId}`,
        { method: "DELETE" },
      );
    },
    /**
     * POST /api/tenants/:tenantId/sequence-templates/:id/instantiate —
     * membuat automation sequence NYATA dari templat pribadi, SELALU
     * nonaktif (keselamatan yang sama dengan template katalog).
     */
    instantiate(
      tenantId: string,
      templateId: string,
      input: InstantiateSequenceTemplateRequest = {},
    ): Promise<AutomationResponse> {
      return request<AutomationResponse>(
        `/api/tenants/${tenantId}/sequence-templates/${templateId}/instantiate`,
        { method: "POST", body: JSON.stringify(input) },
      );
    },
  },
  suggestions: {
    /** GET /api/tenants/:tenantId/suggestions?status=pending → draf balasan agent mode suggest. */
    async list(
      tenantId: string,
      opts?: { status?: string },
    ): Promise<AgentSuggestionResponse[]> {
      const q = new URLSearchParams();
      if (opts?.status) q.set("status", opts.status);
      const qs = q.toString();
      const body = await request<AgentSuggestionListResponse>(
        `/api/tenants/${tenantId}/suggestions${qs ? `?${qs}` : ""}`,
        { method: "GET" },
      );
      return body.suggestions;
    },
    /** POST .../suggestions/:id/approve → teks saran terkirim sebagai pesan agent. */
    approve(
      tenantId: string,
      suggestionId: string,
    ): Promise<AgentSuggestionResponse> {
      return request<AgentSuggestionResponse>(
        `/api/tenants/${tenantId}/suggestions/${suggestionId}/approve`,
        { method: "POST", body: JSON.stringify({}) },
      );
    },
    /** POST .../suggestions/:id/reject → draf ditolak. */
    reject(
      tenantId: string,
      suggestionId: string,
    ): Promise<AgentSuggestionResponse> {
      return request<AgentSuggestionResponse>(
        `/api/tenants/${tenantId}/suggestions/${suggestionId}/reject`,
        { method: "POST", body: JSON.stringify({}) },
      );
    },
  },
  kb: {
    /** GET /api/tenants/:tenantId/kb/documents → daftar dokumen + chunkCount. */
    async listDocuments(tenantId: string): Promise<KbDocumentResponse[]> {
      const body = await request<KbDocumentListResponse>(
        `/api/tenants/${tenantId}/kb/documents`,
        { method: "GET" },
      );
      return body.documents;
    },
    /** POST /api/tenants/:tenantId/kb/documents → 201 dokumen baru (sudah ter-chunk). */
    createDocument(
      tenantId: string,
      input: CreateKbDocumentRequest,
    ): Promise<KbDocumentResponse> {
      return request<KbDocumentResponse>(
        `/api/tenants/${tenantId}/kb/documents`,
        { method: "POST", body: JSON.stringify(input) },
      );
    },
    /** GET /api/tenants/:tenantId/kb/documents/:id → satu dokumen + chunkCount. */
    getDocument(
      tenantId: string,
      documentId: string,
    ): Promise<KbDocumentResponse> {
      return request<KbDocumentResponse>(
        `/api/tenants/${tenantId}/kb/documents/${documentId}`,
        { method: "GET" },
      );
    },
    /** DELETE /api/tenants/:tenantId/kb/documents/:id → 204 tanpa body. */
    async deleteDocument(
      tenantId: string,
      documentId: string,
    ): Promise<void> {
      await request<unknown>(
        `/api/tenants/${tenantId}/kb/documents/${documentId}`,
        { method: "DELETE" },
      );
    },
    /** GET /api/tenants/:tenantId/kb/files → daftar berkas lampiran (Fase 12C). */
    async listFiles(tenantId: string): Promise<KbFileDocumentResponse[]> {
      const body = await request<KbFileDocumentListResponse>(
        `/api/tenants/${tenantId}/kb/files`,
        { method: "GET" },
      );
      return body.files;
    },
    /**
     * POST /api/tenants/:tenantId/kb/files (multipart) → 201 berkas
     * terimpor; teksnya menjadi entri dokumen biasa. Error khas:
     * KB_DOCUMENT_NO_TEXT / KB_DOCUMENT_TYPE_UNSUPPORTED /
     * KB_DOCUMENT_TOO_LARGE.
     */
    uploadFile(
      tenantId: string,
      file: File,
    ): Promise<KbFileDocumentResponse> {
      const form = new FormData();
      form.append("file", file);
      return requestFormData<KbFileDocumentResponse>(
        `/api/tenants/${tenantId}/kb/files`,
        form,
      );
    },
    /** DELETE /api/tenants/:tenantId/kb/files/:id → 204; entri + chunk ikut terhapus. */
    async deleteFile(tenantId: string, fileId: string): Promise<void> {
      await request<unknown>(`/api/tenants/${tenantId}/kb/files/${fileId}`, {
        method: "DELETE",
      });
    },
    /** GET /api/tenants/:tenantId/kb/stats → cakupan embedding + status semantik (Fase 12D). */
    getStats(tenantId: string): Promise<KbStatsResponse> {
      return request<KbStatsResponse>(`/api/tenants/${tenantId}/kb/stats`, {
        method: "GET",
      });
    },
  },
  products: {
    /** GET /api/tenants/:tenantId/products → daftar produk workspace (Fase 4A). */
    async list(tenantId: string): Promise<ProductResponse[]> {
      const body = await request<ProductListResponse>(
        `/api/tenants/${tenantId}/products`,
        { method: "GET" },
      );
      return body.products;
    },
    /** POST /api/tenants/:tenantId/products → 201 produk baru. */
    create(
      tenantId: string,
      input: CreateProductRequest,
    ): Promise<ProductResponse> {
      return request<ProductResponse>(`/api/tenants/${tenantId}/products`, {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    /** PATCH /api/tenants/:tenantId/products/:id → produk terbarui. */
    update(
      tenantId: string,
      productId: string,
      input: UpdateProductRequest,
    ): Promise<ProductResponse> {
      return request<ProductResponse>(
        `/api/tenants/${tenantId}/products/${productId}`,
        { method: "PATCH", body: JSON.stringify(input) },
      );
    },
    /** DELETE → 204; 409 PRODUCT_HAS_LINKS bila produk sudah punya tautan bayar. */
    async remove(tenantId: string, productId: string): Promise<void> {
      await request<unknown>(`/api/tenants/${tenantId}/products/${productId}`, {
        method: "DELETE",
      });
    },
  },
  paymentLinks: {
    /** GET /api/tenants/:tenantId/payment-links → tautan bayar terbaru workspace. */
    async list(tenantId: string): Promise<PaymentLinkResponse[]> {
      const body = await request<PaymentLinkListResponse>(
        `/api/tenants/${tenantId}/payment-links`,
        { method: "GET" },
      );
      return body.paymentLinks;
    },
    /** POST /api/tenants/:tenantId/payment-links {productId, contactId?} → 201 tautan baru. */
    create(
      tenantId: string,
      input: CreatePaymentLinkRequest,
    ): Promise<PaymentLinkResponse> {
      return request<PaymentLinkResponse>(
        `/api/tenants/${tenantId}/payment-links`,
        { method: "POST", body: JSON.stringify(input) },
      );
    },
  },
  orders: {
    /** GET /api/tenants/:tenantId/orders → order commerce terbaru workspace (Fase 13F). */
    async list(tenantId: string): Promise<OrderResponse[]> {
      const body = await request<OrderListResponse>(
        `/api/tenants/${tenantId}/orders`,
        { method: "GET" },
      );
      return body.orders;
    },
    /** GET /api/tenants/:tenantId/orders/:id → detail order + item. */
    get(tenantId: string, orderId: string): Promise<OrderResponse> {
      return request<OrderResponse>(
        `/api/tenants/${tenantId}/orders/${orderId}`,
        { method: "GET" },
      );
    },
  },

  appointments: {
    /** GET .../appointments/settings → timezone + lead time (Fase 13G). */
    getSettings(tenantId: string): Promise<AppointmentSettingsResponse> {
      return request<AppointmentSettingsResponse>(
        `/api/tenants/${tenantId}/appointments/settings`,
        { method: "GET" },
      );
    },
    /** PUT .../appointments/settings (owner/admin). */
    updateSettings(
      tenantId: string,
      body: UpdateAppointmentSettingsRequest,
    ): Promise<AppointmentSettingsResponse> {
      return request<AppointmentSettingsResponse>(
        `/api/tenants/${tenantId}/appointments/settings`,
        { method: "PUT", body: JSON.stringify(body) },
      );
    },
    /** GET .../appointments/services → semua layanan (aktif + nonaktif). */
    async listServices(
      tenantId: string,
    ): Promise<AppointmentServiceResponse[]> {
      const body = await request<AppointmentServiceListResponse>(
        `/api/tenants/${tenantId}/appointments/services`,
        { method: "GET" },
      );
      return body.services;
    },
    /** POST .../appointments/services → 201 (owner/admin). */
    createService(
      tenantId: string,
      body: CreateAppointmentServiceRequest,
    ): Promise<AppointmentServiceResponse> {
      return request<AppointmentServiceResponse>(
        `/api/tenants/${tenantId}/appointments/services`,
        { method: "POST", body: JSON.stringify(body) },
      );
    },
    /** PATCH .../appointments/services/:id (owner/admin). */
    updateService(
      tenantId: string,
      serviceId: string,
      body: UpdateAppointmentServiceRequest,
    ): Promise<AppointmentServiceResponse> {
      return request<AppointmentServiceResponse>(
        `/api/tenants/${tenantId}/appointments/services/${serviceId}`,
        { method: "PATCH", body: JSON.stringify(body) },
      );
    },
    /** DELETE .../appointments/services/:id (owner/admin). */
    deleteService(tenantId: string, serviceId: string): Promise<void> {
      return request<void>(
        `/api/tenants/${tenantId}/appointments/services/${serviceId}`,
        { method: "DELETE" },
      );
    },
    /** GET .../appointments/availability → jendela mingguan. */
    getAvailability(tenantId: string): Promise<AppointmentAvailabilityResponse> {
      return request<AppointmentAvailabilityResponse>(
        `/api/tenants/${tenantId}/appointments/availability`,
        { method: "GET" },
      );
    },
    /** PUT .../appointments/availability — ganti seluruh jendela (owner/admin). */
    replaceAvailability(
      tenantId: string,
      body: UpdateAppointmentAvailabilityRequest,
    ): Promise<AppointmentAvailabilityResponse> {
      return request<AppointmentAvailabilityResponse>(
        `/api/tenants/${tenantId}/appointments/availability`,
        { method: "PUT", body: JSON.stringify(body) },
      );
    },
    /** GET .../appointments/slots?serviceId=&from=&to= → pratinjau slot bebas. */
    async listSlots(
      tenantId: string,
      serviceId: string,
      from: string,
      to: string,
    ): Promise<AppointmentSlotListResponse> {
      const q = new URLSearchParams({ serviceId, from, to });
      return request<AppointmentSlotListResponse>(
        `/api/tenants/${tenantId}/appointments/slots?${q.toString()}`,
        { method: "GET" },
      );
    },
    /** GET .../appointments/bookings?from=&to=&status= → daftar booking. */
    async listBookings(
      tenantId: string,
      opts?: { from?: string; to?: string; status?: string },
    ): Promise<BookingResponse[]> {
      const q = new URLSearchParams();
      if (opts?.from) q.set("from", opts.from);
      if (opts?.to) q.set("to", opts.to);
      if (opts?.status) q.set("status", opts.status);
      const qs = q.toString();
      const body = await request<BookingListResponse>(
        `/api/tenants/${tenantId}/appointments/bookings${qs ? `?${qs}` : ""}`,
        { method: "GET" },
      );
      return body.bookings;
    },
    /** POST .../appointments/bookings → booking manual dashboard. */
    createBooking(
      tenantId: string,
      body: CreateBookingRequest,
    ): Promise<BookingResponse> {
      return request<BookingResponse>(
        `/api/tenants/${tenantId}/appointments/bookings`,
        { method: "POST", body: JSON.stringify(body) },
      );
    },
    /** POST .../appointments/bookings/:id/cancel → batalkan (idempoten). */
    cancelBooking(
      tenantId: string,
      bookingId: string,
    ): Promise<BookingResponse> {
      return request<BookingResponse>(
        `/api/tenants/${tenantId}/appointments/bookings/${bookingId}/cancel`,
        { method: "POST" },
      );
    },
    /** GET .../appointments/google → status koneksi tenant. */
    googleStatus(tenantId: string): Promise<GoogleCalendarConnectionResponse> {
      return request<GoogleCalendarConnectionResponse>(
        `/api/tenants/${tenantId}/appointments/google`,
        { method: "GET" },
      );
    },
    /** POST .../appointments/google/connect → { url } (owner/admin). */
    googleConnect(tenantId: string): Promise<GoogleConnectStartResponse> {
      return request<GoogleConnectStartResponse>(
        `/api/tenants/${tenantId}/appointments/google/connect`,
        { method: "POST" },
      );
    },
    /**
     * GET /tenants/:tenantId/google/status → keadaan tiga koneksi
     * Google per layanan (Channels; pemisahan Google 2026-11-12).
     */
    googleServicesStatus(
      tenantId: string,
    ): Promise<GoogleServiceConnectionsResponse> {
      return request<GoogleServiceConnectionsResponse>(
        `/api/tenants/${tenantId}/google/status`,
        { method: "GET" },
      );
    },
    /**
     * POST /tenants/:tenantId/google/:service/connect → { url }
     * dialog consent sempit layanan itu (owner/admin).
     */
    googleServiceConnect(
      tenantId: string,
      service: GoogleService,
    ): Promise<GoogleConnectStartResponse> {
      return request<GoogleConnectStartResponse>(
        `/api/tenants/${tenantId}/google/${service}/connect`,
        { method: "POST" },
      );
    },
    /** GET .../appointments/google/calendars → kalender akun (owner/admin). */
    googleCalendars(tenantId: string): Promise<GoogleCalendarListResponse> {
      return request<GoogleCalendarListResponse>(
        `/api/tenants/${tenantId}/appointments/google/calendars`,
        { method: "GET" },
      );
    },
    /** PUT .../appointments/google/calendar → pilih kalender tujuan (owner/admin). */
    googleSetCalendar(
      tenantId: string,
      body: UpdateGoogleCalendarRequest,
    ): Promise<GoogleCalendarConnectionResponse> {
      return request<GoogleCalendarConnectionResponse>(
        `/api/tenants/${tenantId}/appointments/google/calendar`,
        { method: "PUT", body: JSON.stringify(body) },
      );
    },
    /** DELETE .../appointments/google → putuskan koneksi (owner/admin). */
    googleDisconnect(tenantId: string): Promise<void> {
      return request<void>(`/api/tenants/${tenantId}/appointments/google`, {
        method: "DELETE",
      });
    },
  },
  apiKeys: {
    /** GET /api/tenants/:tenantId/api-keys → daftar kunci (tanpa nilai utuh). */
    async list(tenantId: string): Promise<ApiKeyResponse[]> {
      const body = await request<ApiKeyListResponse>(
        `/api/tenants/${tenantId}/api-keys`,
        { method: "GET" },
      );
      return body.apiKeys;
    },
    /** POST /api/tenants/:tenantId/api-keys → 201; `key` utuh hanya di respons ini. */
    create(
      tenantId: string,
      input: CreateApiKeyRequest,
    ): Promise<CreatedApiKeyResponse> {
      return request<CreatedApiKeyResponse>(`/api/tenants/${tenantId}/api-keys`, {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    /** DELETE /api/tenants/:tenantId/api-keys/:id → cabut kunci (204). */
    async revoke(tenantId: string, apiKeyId: string): Promise<void> {
      await request<unknown>(`/api/tenants/${tenantId}/api-keys/${apiKeyId}`, {
        method: "DELETE",
      });
    },
  },
  admin: {
    /** GET /api/admin/settings → status semua kunci platform (TANPA nilai) + info R2. */
    getSettings(): Promise<PlatformSettingsResponse> {
      return request<PlatformSettingsResponse>("/api/admin/settings", {
        method: "GET",
      });
    },
    /** PUT /api/admin/settings/:key {value} → status kunci itu setelah disimpan. */
    setSetting(
      key: PlatformSettingKey,
      value: string,
    ): Promise<PlatformSettingStatus> {
      return request<PlatformSettingStatus>(`/api/admin/settings/${key}`, {
        method: "PUT",
        body: JSON.stringify({ value }),
      });
    },
    /** DELETE /api/admin/settings/:key → hapus nilai panel (kembali ke env). */
    clearSetting(key: PlatformSettingKey): Promise<PlatformSettingStatus> {
      return request<PlatformSettingStatus>(`/api/admin/settings/${key}`, {
        method: "DELETE",
      });
    },
    /** POST /api/admin/settings/:key/test → uji koneksi dgn kunci efektif (hasil ok/kode, tanpa nilai). */
    testSetting(key: PlatformSettingKey): Promise<PlatformSettingTestResult> {
      return request<PlatformSettingTestResult>(
        `/api/admin/settings/${key}/test`,
        { method: "POST", body: JSON.stringify({}) },
      );
    },

    // --- Konsol operasi (migrasi 0010) -----------------------------------
    // Semua route di bawah ini digerbangi sesi + allowlist email platform
    // admin; non-admin menerima 404, bukan 403 (eksistensi panel tidak
    // dibocorkan).

    /** GET /api/admin/overview → angka satu layar untuk halaman Ringkasan. */
    getOverview(): Promise<PlatformOverviewResponse> {
      return request<PlatformOverviewResponse>("/api/admin/overview", {
        method: "GET",
      });
    },

    /** GET /api/admin/tenants?q=&status=&limit=&offset= */
    listTenants(params: {
      q?: string;
      status?: TenantStatus;
      limit?: number;
      offset?: number;
    } = {}): Promise<PlatformTenantListResponse> {
      const search = new URLSearchParams();
      if (params.q) search.set("q", params.q);
      if (params.status) search.set("status", params.status);
      if (params.limit !== undefined) search.set("limit", String(params.limit));
      if (params.offset !== undefined) search.set("offset", String(params.offset));
      const qs = search.toString();
      return request<PlatformTenantListResponse>(
        `/api/admin/tenants${qs ? `?${qs}` : ""}`,
        { method: "GET" },
      );
    },

    /** GET /api/admin/tenants/:id → detail satu workspace. */
    getTenant(tenantId: string): Promise<PlatformTenantDetailResponse> {
      return request<PlatformTenantDetailResponse>(
        `/api/admin/tenants/${tenantId}`,
        { method: "GET" },
      );
    },

    /** PATCH /api/admin/tenants/:id {status, reason} → tangguhkan / aktifkan. */
    setTenantStatus(
      tenantId: string,
      body: { status: TenantStatus; reason?: string },
    ): Promise<SetPlatformTenantStatusResponse> {
      return request<SetPlatformTenantStatusResponse>(
        `/api/admin/tenants/${tenantId}`,
        { method: "PATCH", body: JSON.stringify(body) },
      );
    },

    /** GET /api/admin/users?q= → cari pengguna lintas tenant (min 2 karakter). */
    searchUsers(q: string): Promise<PlatformUserListResponse> {
      return request<PlatformUserListResponse>(
        `/api/admin/users?q=${encodeURIComponent(q)}`,
        { method: "GET" },
      );
    },

    /** POST /api/admin/users/:id/sessions/revoke → paksa logout semua sesi. */
    revokeSessions(userId: string): Promise<RevokeSessionsResponse> {
      return request<RevokeSessionsResponse>(
        `/api/admin/users/${userId}/sessions/revoke`,
        { method: "POST", body: JSON.stringify({}) },
      );
    },

    /** GET /api/admin/operations/outbox → event yang dikarantina. */
    listDeadLetter(): Promise<DeadLetterOutboxListResponse> {
      return request<DeadLetterOutboxListResponse>(
        "/api/admin/operations/outbox",
        { method: "GET" },
      );
    },

    /** POST /api/admin/operations/outbox/:id/retry → kembalikan ke antrean. */
    retryOutbox(id: string): Promise<RetryOutboxResponse> {
      return request<RetryOutboxResponse>(
        `/api/admin/operations/outbox/${id}/retry`,
        { method: "POST", body: JSON.stringify({}) },
      );
    },

    /** GET /api/admin/system → versi aplikasi + statistik database. */
    getSystem(): Promise<PlatformSystemResponse> {
      return request<PlatformSystemResponse>("/api/admin/system", {
        method: "GET",
      });
    },

    /** GET /api/admin/admins → daftar admin (env terkunci + panel). */
    getAdmins(): Promise<PlatformAdminListResponse> {
      return request<PlatformAdminListResponse>("/api/admin/admins", {
        method: "GET",
      });
    },

    /** POST /api/admin/admins {email} → tambah admin platform. */
    addAdmin(email: string): Promise<AddPlatformAdminResponse> {
      return request<AddPlatformAdminResponse>("/api/admin/admins", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
    },

    /** DELETE /api/admin/admins/:email → cabut admin panel. */
    removeAdmin(email: string): Promise<RemovePlatformAdminResponse> {
      return request<RemovePlatformAdminResponse>(
        `/api/admin/admins/${encodeURIComponent(email)}`,
        { method: "DELETE" },
      );
    },

    /** GET /api/admin/backups → riwayat backup harian + drill. */
    getBackups(): Promise<PlatformBackupResponse> {
      return request<PlatformBackupResponse>("/api/admin/backups", {
        method: "GET",
      });
    },
  },
  logs: {
    /**
     * GET /api/tenants/:tenantId/logs — daftar log integrasi workspace
     * (Fase 7B.1; owner/admin saja, anggota biasa 403). Query dibangun
     * dari filter yang terisi saja.
     */
    list(
      tenantId: string,
      query: {
        provider?: string;
        direction?: string;
        outcome?: string;
        channelAccountId?: string;
        cursor?: string;
        limit?: number;
      } = {},
    ): Promise<IntegrationLogListResponse> {
      const params = new URLSearchParams();
      if (query.provider) params.set("provider", query.provider);
      if (query.direction) params.set("direction", query.direction);
      if (query.outcome) params.set("outcome", query.outcome);
      if (query.channelAccountId) {
        params.set("channelAccountId", query.channelAccountId);
      }
      if (query.cursor) params.set("cursor", query.cursor);
      if (query.limit) params.set("limit", String(query.limit));
      const qs = params.toString();
      return request<IntegrationLogListResponse>(
        `/api/tenants/${tenantId}/logs${qs ? `?${qs}` : ""}`,
        { method: "GET" },
      );
    },
    /** GET /api/tenants/:tenantId/logs/:logId — detail + payload tersimpan. */
    get(
      tenantId: string,
      logId: string,
    ): Promise<IntegrationLogDetailResponse> {
      return request<IntegrationLogDetailResponse>(
        `/api/tenants/${tenantId}/logs/${logId}`,
        { method: "GET" },
      );
    },
    /**
     * GET /api/logs/unresolved — baris platform (tenant NULL) untuk sesi
     * platform admin; sesi biasa menerima 404 dari API.
     */
    listUnresolved(
      query: {
        provider?: string;
        direction?: string;
        outcome?: string;
        cursor?: string;
        limit?: number;
      } = {},
    ): Promise<IntegrationLogListResponse> {
      const params = new URLSearchParams();
      if (query.provider) params.set("provider", query.provider);
      if (query.direction) params.set("direction", query.direction);
      if (query.outcome) params.set("outcome", query.outcome);
      if (query.cursor) params.set("cursor", query.cursor);
      if (query.limit) params.set("limit", String(query.limit));
      const qs = params.toString();
      return request<IntegrationLogListResponse>(
        `/api/logs/unresolved${qs ? `?${qs}` : ""}`,
        { method: "GET" },
      );
    },
    /** GET /api/logs/unresolved/:logId — detail baris platform + payload. */
    getUnresolved(logId: string): Promise<IntegrationLogDetailResponse> {
      return request<IntegrationLogDetailResponse>(
        `/api/logs/unresolved/${logId}`,
        { method: "GET" },
      );
    },
    /**
     * POST /api/tenants/:tenantId/logs/:logId/replay — proses ulang event
     * masuk yang eligible (Fase 7B.2; owner/admin). Respons membawa
     * outcome baris-baris baru hasil replay.
     */
    replay(
      tenantId: string,
      logId: string,
    ): Promise<IntegrationLogReplayResponse> {
      return request<IntegrationLogReplayResponse>(
        `/api/tenants/${tenantId}/logs/${logId}/replay`,
        { method: "POST", body: JSON.stringify({}) },
      );
    },
    /**
     * POST /api/logs/unresolved/:logId/replay — proses ulang baris
     * tenant-NULL yang eligible (Fase 13A; sesi platform admin saja,
     * non-admin menerima 404). Respons membawa outcome baris-baris baru
     * hasil replay.
     */
    replayUnresolved(logId: string): Promise<IntegrationLogReplayResponse> {
      return request<IntegrationLogReplayResponse>(
        `/api/logs/unresolved/${logId}/replay`,
        { method: "POST", body: JSON.stringify({}) },
      );
    },
  },
  /**
   * Content Schedule (Fase 23) — postingan terjadwal ke channel Telegram.
   * `targets` kosong berarti bot belum menjadi admin di channel mana pun;
   * UI memakai itu untuk instruksi, bukan pemilih kosong.
   */
  posts: {
    async targets(tenantId: string): Promise<PostTargetListResponse> {
      return request<PostTargetListResponse>(
        `/api/tenants/${tenantId}/posts/targets`,
        { method: "GET" },
      );
    },
    async list(
      tenantId: string,
      params: { status?: PostStatus } = {},
    ): Promise<PostListResponse> {
      const qs = params.status ? `?status=${params.status}` : "";
      return request<PostListResponse>(
        `/api/tenants/${tenantId}/posts${qs}`,
        { method: "GET" },
      );
    },
    create(tenantId: string, input: CreatePostRequest): Promise<PostResponse> {
      return request<PostResponse>(`/api/tenants/${tenantId}/posts`, {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    update(
      tenantId: string,
      postId: string,
      input: UpdatePostRequest,
    ): Promise<PostResponse> {
      return request<PostResponse>(`/api/tenants/${tenantId}/posts/${postId}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      });
    },
    async remove(tenantId: string, postId: string): Promise<void> {
      await request<unknown>(`/api/tenants/${tenantId}/posts/${postId}`, {
        method: "DELETE",
      });
    },
    schedule(
      tenantId: string,
      postId: string,
      scheduledAt?: string | null,
    ): Promise<PostResponse> {
      return request<PostResponse>(
        `/api/tenants/${tenantId}/posts/${postId}/schedule`,
        {
          method: "POST",
          body: JSON.stringify(scheduledAt ? { scheduledAt } : {}),
        },
      );
    },
    cancel(tenantId: string, postId: string): Promise<PostResponse> {
      return request<PostResponse>(
        `/api/tenants/${tenantId}/posts/${postId}/cancel`,
        { method: "POST", body: JSON.stringify({}) },
      );
    },
    /** Buat grup multi-target: satu konten induk → N draft (Gelombang 0). */
    createGroup(
      tenantId: string,
      input: CreatePostGroupRequest,
    ): Promise<PostGroupResponse> {
      return request<PostGroupResponse>(
        `/api/tenants/${tenantId}/posts/group`,
        { method: "POST", body: JSON.stringify(input) },
      );
    },
    /** Jadwalkan ulang post gagal — manual, bukan auto-retry (Gelombang 0). */
    retry(
      tenantId: string,
      postId: string,
      scheduledAt?: string | null,
    ): Promise<PostResponse> {
      return request<PostResponse>(
        `/api/tenants/${tenantId}/posts/${postId}/retry`,
        {
          method: "POST",
          body: JSON.stringify(scheduledAt ? { scheduledAt } : {}),
        },
      );
    },
    /** Bebaskan post macet di publishing → failed publish_outcome_unknown. */
    releaseStuck(tenantId: string, postId: string): Promise<PostResponse> {
      return request<PostResponse>(
        `/api/tenants/${tenantId}/posts/${postId}/release-stuck`,
        { method: "POST", body: JSON.stringify({}) },
      );
    },
    /** Duplikat post menjadi draft baru (jadwal tidak ikut disalin). */
    duplicate(tenantId: string, postId: string): Promise<PostResponse> {
      return request<PostResponse>(
        `/api/tenants/${tenantId}/posts/${postId}/duplicate`,
        { method: "POST", body: JSON.stringify({}) },
      );
    },
  },
  broadcasts: {
    /** GET /api/tenants/:tenantId/broadcasts → daftar + statistik (Fase 7C). */
    list(
      tenantId: string,
      query: { status?: string; cursor?: string; limit?: number } = {},
    ): Promise<BroadcastListResponse> {
      const params = new URLSearchParams();
      if (query.status) params.set("status", query.status);
      if (query.cursor) params.set("cursor", query.cursor);
      if (query.limit) params.set("limit", String(query.limit));
      const qs = params.toString();
      return request<BroadcastListResponse>(
        `/api/tenants/${tenantId}/broadcasts${qs ? `?${qs}` : ""}`,
        { method: "GET" },
      );
    },
    /** GET /api/tenants/:tenantId/broadcasts/:id → detail + statistik. */
    get(tenantId: string, broadcastId: string): Promise<BroadcastResponse> {
      return request<BroadcastResponse>(
        `/api/tenants/${tenantId}/broadcasts/${broadcastId}`,
        { method: "GET" },
      );
    },
    /** POST /api/tenants/:tenantId/broadcasts → 201 draf baru (owner/admin). */
    create(
      tenantId: string,
      input: CreateBroadcastRequest,
    ): Promise<BroadcastResponse> {
      return request<BroadcastResponse>(
        `/api/tenants/${tenantId}/broadcasts`,
        { method: "POST", body: JSON.stringify(input) },
      );
    },
    /** PATCH /api/tenants/:tenantId/broadcasts/:id → edit draf (owner/admin). */
    update(
      tenantId: string,
      broadcastId: string,
      input: UpdateBroadcastRequest,
    ): Promise<BroadcastResponse> {
      return request<BroadcastResponse>(
        `/api/tenants/${tenantId}/broadcasts/${broadcastId}`,
        { method: "PATCH", body: JSON.stringify(input) },
      );
    },
    /** DELETE /api/tenants/:tenantId/broadcasts/:id → hapus draf (owner/admin). */
    async remove(tenantId: string, broadcastId: string): Promise<void> {
      await request<unknown>(
        `/api/tenants/${tenantId}/broadcasts/${broadcastId}`,
        { method: "DELETE" },
      );
    },
    /**
     * POST /api/tenants/:tenantId/broadcasts/:id/schedule — jadwalkan
     * (scheduledAt ISO) atau kirim sekarang (tanpa scheduledAt).
     */
    schedule(
      tenantId: string,
      broadcastId: string,
      input: ScheduleBroadcastRequest,
    ): Promise<BroadcastResponse> {
      return request<BroadcastResponse>(
        `/api/tenants/${tenantId}/broadcasts/${broadcastId}/schedule`,
        { method: "POST", body: JSON.stringify(input) },
      );
    },
    /** POST /api/tenants/:tenantId/broadcasts/:id/cancel → batalkan. */
    cancel(tenantId: string, broadcastId: string): Promise<BroadcastResponse> {
      return request<BroadcastResponse>(
        `/api/tenants/${tenantId}/broadcasts/${broadcastId}/cancel`,
        { method: "POST", body: JSON.stringify({}) },
      );
    },
    /**
     * GET /api/tenants/:tenantId/broadcasts/audience-preview — pratinjau
     * audiens live untuk formulir (Fase 13C; filter sebagai string koma).
     * Rincian dihitung klasifikasi yang sama seperti dispatch.
     */
    previewAudience(
      tenantId: string,
      query: {
        channelAccountId: string;
        tags?: string;
        stages?: string;
        segmentId?: string;
        requireOptIn?: boolean;
        whatsappTemplateId?: string;
        templateVariableSources?: string;
      },
    ): Promise<BroadcastAudiencePreviewResponse> {
      const params = new URLSearchParams();
      params.set("channelAccountId", query.channelAccountId);
      if (query.tags) params.set("tags", query.tags);
      if (query.stages) params.set("stages", query.stages);
      if (query.segmentId) params.set("segmentId", query.segmentId);
      if (query.requireOptIn !== undefined) {
        params.set("requireOptIn", query.requireOptIn ? "true" : "false");
      }
      if (query.whatsappTemplateId) {
        params.set("whatsappTemplateId", query.whatsappTemplateId);
      }
      if (query.templateVariableSources) {
        params.set("templateVariableSources", query.templateVariableSources);
      }
      return request<BroadcastAudiencePreviewResponse>(
        `/api/tenants/${tenantId}/broadcasts/audience-preview?${params.toString()}`,
        { method: "GET" },
      );
    },
    /** GET /api/tenants/:tenantId/opt-in-settings — pengaturan opt-in (Fase 13C). */
    getOptInSettings(tenantId: string): Promise<OptInSettingsResponse> {
      return request<OptInSettingsResponse>(
        `/api/tenants/${tenantId}/opt-in-settings`,
        { method: "GET" },
      );
    },
    /** PATCH /api/tenants/:tenantId/opt-in-settings — ubah pengaturan opt-in (owner/admin). */
    updateOptInSettings(
      tenantId: string,
      input: UpdateOptInSettingsRequest,
    ): Promise<OptInSettingsResponse> {
      return request<OptInSettingsResponse>(
        `/api/tenants/${tenantId}/opt-in-settings`,
        { method: "PATCH", body: JSON.stringify(input) },
      );
    },
    /** GET /api/tenants/:tenantId/broadcasts/:id/recipients → penerima berpaginasi. */
    listRecipients(
      tenantId: string,
      broadcastId: string,
      query: { status?: string; cursor?: string; limit?: number } = {},
    ): Promise<BroadcastRecipientListResponse> {
      const params = new URLSearchParams();
      if (query.status) params.set("status", query.status);
      if (query.cursor) params.set("cursor", query.cursor);
      if (query.limit) params.set("limit", String(query.limit));
      const qs = params.toString();
      return request<BroadcastRecipientListResponse>(
        `/api/tenants/${tenantId}/broadcasts/${broadcastId}/recipients${qs ? `?${qs}` : ""}`,
        { method: "GET" },
      );
    },
    /**
     * GET /api/tenants/:tenantId/broadcasts/:id/ab-results — gema
     * konfigurasi A/B + rincian statistik per varian (Fase 13D,
     * dashboard saja; broadcast tanpa A/B → abTest null).
     */
    abResults(
      tenantId: string,
      broadcastId: string,
    ): Promise<BroadcastAbResultsResponse> {
      return request<BroadcastAbResultsResponse>(
        `/api/tenants/${tenantId}/broadcasts/${broadcastId}/ab-results`,
        { method: "GET" },
      );
    },
  },
  whatsappTemplates: {
    /** GET /api/tenants/:tenantId/whatsapp-templates?channelAccountId= → cermin lokal (Fase 10A). */
    list(
      tenantId: string,
      channelAccountId: string,
    ): Promise<WhatsAppTemplateListResponse> {
      const params = new URLSearchParams({ channelAccountId });
      return request<WhatsAppTemplateListResponse>(
        `/api/tenants/${tenantId}/whatsapp-templates?${params.toString()}`,
        { method: "GET" },
      );
    },
    /** POST /api/tenants/:tenantId/whatsapp-templates/sync → tarik dari Meta (owner/admin). */
    sync(
      tenantId: string,
      channelAccountId: string,
    ): Promise<SyncWhatsAppTemplatesResponse> {
      return request<SyncWhatsAppTemplatesResponse>(
        `/api/tenants/${tenantId}/whatsapp-templates/sync`,
        { method: "POST", body: JSON.stringify({ channelAccountId }) },
      );
    },
    /** POST /api/tenants/:tenantId/whatsapp-templates → buat di Meta + cermin (owner/admin). */
    create(
      tenantId: string,
      input: CreateWhatsAppTemplateRequest,
    ): Promise<WhatsAppTemplateResponse> {
      return request<WhatsAppTemplateResponse>(
        `/api/tenants/${tenantId}/whatsapp-templates`,
        { method: "POST", body: JSON.stringify(input) },
      );
    },
    /** DELETE /api/tenants/:tenantId/whatsapp-templates/:id → hapus di Meta + cermin (owner/admin). */
    async remove(tenantId: string, templateId: string): Promise<void> {
      await request<unknown>(
        `/api/tenants/${tenantId}/whatsapp-templates/${templateId}`,
        { method: "DELETE" },
      );
    },
  },
  flows: {
    /**
     * GET /api/tenants/:tenantId/flows — daftar flow + runCount
     * (Fase 8A; UI daftar & builder Fase 8B).
     */
    list(
      tenantId: string,
      query: { status?: string; cursor?: string; limit?: number } = {},
    ): Promise<FlowListResponse> {
      const params = new URLSearchParams();
      if (query.status) params.set("status", query.status);
      if (query.cursor) params.set("cursor", query.cursor);
      if (query.limit) params.set("limit", String(query.limit));
      const qs = params.toString();
      return request<FlowListResponse>(
        `/api/tenants/${tenantId}/flows${qs ? `?${qs}` : ""}`,
        { method: "GET" },
      );
    },
    /**
     * GET /api/tenants/:tenantId/flows/templates — katalog template flow
     * (Fase 12B): ringkasan dwibahasa via kunci i18n, tanpa graf.
     */
    listTemplates(tenantId: string): Promise<FlowTemplateListResponse> {
      return request<FlowTemplateListResponse>(
        `/api/tenants/${tenantId}/flows/templates`,
        { method: "GET" },
      );
    },
    /**
     * POST /api/tenants/:tenantId/flows/templates/:slug/instantiate —
     * salin template menjadi flow DRAFT (owner/admin); nama bawaan dari
     * nama template sesuai locale bila body tidak mengirim nama.
     */
    instantiateTemplate(
      tenantId: string,
      slug: string,
      input: InstantiateFlowTemplateRequest = {},
    ): Promise<FlowResponse> {
      return request<FlowResponse>(
        `/api/tenants/${tenantId}/flows/templates/${slug}/instantiate`,
        { method: "POST", body: JSON.stringify(input) },
      );
    },
    /** GET /api/tenants/:tenantId/flows/:id → detail flow (graf utuh). */
    get(tenantId: string, flowId: string): Promise<FlowResponse> {
      return request<FlowResponse>(`/api/tenants/${tenantId}/flows/${flowId}`, {
        method: "GET",
      });
    },
    /** POST /api/tenants/:tenantId/flows → 201 draf baru (owner/admin). */
    create(
      tenantId: string,
      input: CreateFlowRequest,
    ): Promise<FlowResponse> {
      return request<FlowResponse>(`/api/tenants/${tenantId}/flows`, {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    /**
     * PATCH /api/tenants/:tenantId/flows/:id → edit draf (owner/admin;
     * flow non-draf → 409 FLOW_INVALID_STATE).
     */
    update(
      tenantId: string,
      flowId: string,
      input: UpdateFlowRequest,
    ): Promise<FlowResponse> {
      return request<FlowResponse>(
        `/api/tenants/${tenantId}/flows/${flowId}`,
        { method: "PATCH", body: JSON.stringify(input) },
      );
    },
    /** DELETE /api/tenants/:tenantId/flows/:id → hapus draf (owner/admin). */
    async remove(tenantId: string, flowId: string): Promise<void> {
      await request<unknown>(`/api/tenants/${tenantId}/flows/${flowId}`, {
        method: "DELETE",
      });
    },
    /**
     * POST /api/tenants/:tenantId/flows/:id/validate {graph} — validasi
     * graf KERING (tidak mengubah status); mengembalikan issues
     * terstruktur yang sama seperti aktivasi.
     */
    validate(
      tenantId: string,
      flowId: string,
      graph: FlowGraph,
    ): Promise<FlowValidationResponse> {
      return request<FlowValidationResponse>(
        `/api/tenants/${tenantId}/flows/${flowId}/validate`,
        { method: "POST", body: JSON.stringify({ graph }) },
      );
    },
    /**
     * POST /api/tenants/:tenantId/flows/:id/activate — aktifkan graf
     * tersimpan. Gagal validasi → 422 FLOW_GRAPH_INVALID dengan
     * `details.issues` (dibaca pemanggil lewat ApiClientError.details);
     * sukses → {flow, warnings}.
     */
    activate(
      tenantId: string,
      flowId: string,
    ): Promise<{ flow: FlowResponse; warnings: FlowGraphIssue[] }> {
      return request<{ flow: FlowResponse; warnings: FlowGraphIssue[] }>(
        `/api/tenants/${tenantId}/flows/${flowId}/activate`,
        { method: "POST", body: JSON.stringify({}) },
      );
    },
    /** POST .../flows/:id/deactivate — aktif → draf (bisa diedit lagi). */
    deactivate(tenantId: string, flowId: string): Promise<FlowResponse> {
      return request<FlowResponse>(
        `/api/tenants/${tenantId}/flows/${flowId}/deactivate`,
        { method: "POST", body: JSON.stringify({}) },
      );
    },
    /** POST .../flows/:id/archive — arsipkan flow. */
    archive(tenantId: string, flowId: string): Promise<FlowResponse> {
      return request<FlowResponse>(
        `/api/tenants/${tenantId}/flows/${flowId}/archive`,
        { method: "POST", body: JSON.stringify({}) },
      );
    },
    /** POST .../flows/:id/unarchive — arsip → draf. */
    unarchive(tenantId: string, flowId: string): Promise<FlowResponse> {
      return request<FlowResponse>(
        `/api/tenants/${tenantId}/flows/${flowId}/unarchive`,
        { method: "POST", body: JSON.stringify({}) },
      );
    },
    /** GET /api/tenants/:tenantId/flows/:id/runs — run milik flow (penampil debugging 8B). */
    listRuns(
      tenantId: string,
      flowId: string,
      query: { status?: string; cursor?: string; limit?: number } = {},
    ): Promise<FlowRunListResponse> {
      const params = new URLSearchParams();
      if (query.status) params.set("status", query.status);
      if (query.cursor) params.set("cursor", query.cursor);
      if (query.limit) params.set("limit", String(query.limit));
      const qs = params.toString();
      return request<FlowRunListResponse>(
        `/api/tenants/${tenantId}/flows/${flowId}/runs${qs ? `?${qs}` : ""}`,
        { method: "GET" },
      );
    },
    /** GET /api/tenants/:tenantId/flows/runs/:runId/steps — langkah satu run, kronologis. */
    listRunSteps(
      tenantId: string,
      runId: string,
      query: { cursor?: string; limit?: number } = {},
    ): Promise<FlowRunStepListResponse> {
      const params = new URLSearchParams();
      if (query.cursor) params.set("cursor", query.cursor);
      if (query.limit) params.set("limit", String(query.limit));
      const qs = params.toString();
      return request<FlowRunStepListResponse>(
        `/api/tenants/${tenantId}/flows/runs/${runId}/steps${qs ? `?${qs}` : ""}`,
        { method: "GET" },
      );
    },
    /**
     * GET /api/tenants/:tenantId/flows/:id/experiments — hasil
     * eksperimen A/B per node split (Fase 13D, dashboard saja):
     * penugasan, run, konversi + putusan z-test dari server.
     */
    experiments(
      tenantId: string,
      flowId: string,
    ): Promise<FlowExperimentsResponse> {
      return request<FlowExperimentsResponse>(
        `/api/tenants/${tenantId}/flows/${flowId}/experiments`,
        { method: "GET" },
      );
    },
  },
  audit: {
    /**
     * GET /api/tenants/:tenantId/audit — penelusur log audit workspace
     * (Fase 7B.4; owner/admin saja, anggota biasa 403). Query dibangun
     * dari filter yang terisi saja. `meta` ikut di respons daftar
     * (kecil — id referensi), jadi tidak ada endpoint detail terpisah.
     */
    list(
      tenantId: string,
      query: {
        actorType?: string;
        category?: string;
        q?: string;
        from?: string;
        to?: string;
        cursor?: string;
        limit?: number;
      } = {},
    ): Promise<AuditLogListResponse> {
      const params = new URLSearchParams();
      if (query.actorType) params.set("actorType", query.actorType);
      if (query.category) params.set("category", query.category);
      if (query.q) params.set("q", query.q);
      if (query.from) params.set("from", query.from);
      if (query.to) params.set("to", query.to);
      if (query.cursor) params.set("cursor", query.cursor);
      if (query.limit) params.set("limit", String(query.limit));
      const qs = params.toString();
      return request<AuditLogListResponse>(
        `/api/tenants/${tenantId}/audit${qs ? `?${qs}` : ""}`,
        { method: "GET" },
      );
    },
    /**
     * GET /api/audit/platform — baris audit tingkat platform (tenant
     * NULL) untuk sesi platform admin; sesi biasa menerima 404.
     */
    listPlatform(
      query: {
        actorType?: string;
        category?: string;
        q?: string;
        from?: string;
        to?: string;
        cursor?: string;
        limit?: number;
      } = {},
    ): Promise<AuditLogListResponse> {
      const params = new URLSearchParams();
      if (query.actorType) params.set("actorType", query.actorType);
      if (query.category) params.set("category", query.category);
      if (query.q) params.set("q", query.q);
      if (query.from) params.set("from", query.from);
      if (query.to) params.set("to", query.to);
      if (query.cursor) params.set("cursor", query.cursor);
      if (query.limit) params.set("limit", String(query.limit));
      const qs = params.toString();
      return request<AuditLogListResponse>(
        `/api/audit/platform${qs ? `?${qs}` : ""}`,
        { method: "GET" },
      );
    },
  },
  failures: {
    /**
     * GET /api/tenants/:tenantId/failed-messages — pusat pesan keluar
     * `failed` lintas provider (Fase 7B.2; owner/admin saja).
     */
    list(
      tenantId: string,
      query: { provider?: string; cursor?: string; limit?: number } = {},
    ): Promise<FailedMessageListResponse> {
      const params = new URLSearchParams();
      if (query.provider) params.set("provider", query.provider);
      if (query.cursor) params.set("cursor", query.cursor);
      if (query.limit) params.set("limit", String(query.limit));
      const qs = params.toString();
      return request<FailedMessageListResponse>(
        `/api/tenants/${tenantId}/failed-messages${qs ? `?${qs}` : ""}`,
        { method: "GET" },
      );
    },
    /**
     * POST /api/tenants/:tenantId/failed-messages/:messageId/retry —
     * antrekan ulang pesan failed → queued; pengiriman sungguhan oleh
     * poller pada siklus berikutnya.
     */
    retry(
      tenantId: string,
      messageId: string,
    ): Promise<FailedMessageRetryResponse> {
      return request<FailedMessageRetryResponse>(
        `/api/tenants/${tenantId}/failed-messages/${messageId}/retry`,
        { method: "POST", body: JSON.stringify({}) },
      );
    },
  },
  analytics: {
    /** GET /api/tenants/:tenantId/analytics/ai-usage?days= → laporan pemakaian AI (Fase 9B). */
    aiUsage(
      tenantId: string,
      days?: number,
    ): Promise<AiUsageReportResponse> {
      const qs = days !== undefined ? `?days=${days}` : "";
      return request<AiUsageReportResponse>(
        `/api/tenants/${tenantId}/analytics/ai-usage${qs}`,
        { method: "GET" },
      );
    },
  },
  growthLinks: {
    /** GET /api/tenants/:tenantId/growth-links → tautan + statistik (Fase 13B). */
    list(tenantId: string): Promise<GrowthLinkListResponse> {
      return request<GrowthLinkListResponse>(
        `/api/tenants/${tenantId}/growth-links`,
        { method: "GET" },
      );
    },
    /** POST /api/tenants/:tenantId/growth-links → 201 tautan baru (owner/admin). */
    create(
      tenantId: string,
      input: CreateGrowthLinkRequest,
    ): Promise<GrowthLinkResponse> {
      return request<GrowthLinkResponse>(
        `/api/tenants/${tenantId}/growth-links`,
        { method: "POST", body: JSON.stringify(input) },
      );
    },
    /** PATCH /api/tenants/:tenantId/growth-links/:id → edit parsial (owner/admin). */
    update(
      tenantId: string,
      linkId: string,
      input: UpdateGrowthLinkRequest,
    ): Promise<GrowthLinkResponse> {
      return request<GrowthLinkResponse>(
        `/api/tenants/${tenantId}/growth-links/${linkId}`,
        { method: "PATCH", body: JSON.stringify(input) },
      );
    },
    /** DELETE /api/tenants/:tenantId/growth-links/:id → hapus + riwayat eventnya (owner/admin). */
    async remove(tenantId: string, linkId: string): Promise<void> {
      await request<unknown>(
        `/api/tenants/${tenantId}/growth-links/${linkId}`,
        { method: "DELETE" },
      );
    },
    /** GET /api/tenants/:tenantId/growth-links/:id/contacts → kontak teratribusi terakhir. */
    attributedContacts(
      tenantId: string,
      linkId: string,
    ): Promise<GrowthLinkAttributedContactsResponse> {
      return request<GrowthLinkAttributedContactsResponse>(
        `/api/tenants/${tenantId}/growth-links/${linkId}/contacts`,
        { method: "GET" },
      );
    },
  },
  segments: {
    /** GET /api/tenants/:tenantId/segments → definisi segmen (Fase 13C). */
    list(tenantId: string): Promise<SegmentListResponse> {
      return request<SegmentListResponse>(
        `/api/tenants/${tenantId}/segments`,
        { method: "GET" },
      );
    },
    /** POST /api/tenants/:tenantId/segments → 201 segmen baru (owner/admin). */
    create(
      tenantId: string,
      input: CreateSegmentRequest,
    ): Promise<SegmentResponse> {
      return request<SegmentResponse>(`/api/tenants/${tenantId}/segments`, {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    /** PATCH /api/tenants/:tenantId/segments/:id → edit (owner/admin). */
    update(
      tenantId: string,
      segmentId: string,
      input: UpdateSegmentRequest,
    ): Promise<SegmentResponse> {
      return request<SegmentResponse>(
        `/api/tenants/${tenantId}/segments/${segmentId}`,
        { method: "PATCH", body: JSON.stringify(input) },
      );
    },
    /** DELETE /api/tenants/:tenantId/segments/:id → hapus (owner/admin). */
    async remove(tenantId: string, segmentId: string): Promise<void> {
      await request<unknown>(
        `/api/tenants/${tenantId}/segments/${segmentId}`,
        { method: "DELETE" },
      );
    },
    /** POST /api/tenants/:tenantId/segments/preview → hitungan anggota definisi. */
    preview(
      tenantId: string,
      definition: SegmentDefinition,
    ): Promise<SegmentPreviewResponse> {
      return request<SegmentPreviewResponse>(
        `/api/tenants/${tenantId}/segments/preview`,
        { method: "POST", body: JSON.stringify({ definition }) },
      );
    },
  },
  savedReplies: {
    /** GET /api/tenants/:tenantId/saved-replies → pustaka macro workspace (Fase 9A). */
    list(tenantId: string): Promise<SavedReplyListResponse> {
      return request<SavedReplyListResponse>(
        `/api/tenants/${tenantId}/saved-replies`,
        { method: "GET" },
      );
    },
    /** POST /api/tenants/:tenantId/saved-replies → 201 macro baru (semua member). */
    create(
      tenantId: string,
      input: CreateSavedReplyRequest,
    ): Promise<SavedReplyResponse> {
      return request<SavedReplyResponse>(
        `/api/tenants/${tenantId}/saved-replies`,
        { method: "POST", body: JSON.stringify(input) },
      );
    },
    /** PATCH /api/tenants/:tenantId/saved-replies/:id → edit (pembuat/owner/admin). */
    update(
      tenantId: string,
      replyId: string,
      input: UpdateSavedReplyRequest,
    ): Promise<SavedReplyResponse> {
      return request<SavedReplyResponse>(
        `/api/tenants/${tenantId}/saved-replies/${replyId}`,
        { method: "PATCH", body: JSON.stringify(input) },
      );
    },
    /** DELETE /api/tenants/:tenantId/saved-replies/:id → hapus (pembuat/owner/admin). */
    async remove(tenantId: string, replyId: string): Promise<void> {
      await request<unknown>(
        `/api/tenants/${tenantId}/saved-replies/${replyId}`,
        { method: "DELETE" },
      );
    },
  },
  pay: {
    /** GET /api/pay/:code → ringkasan publik tautan bayar (tanpa sesi). */
    getPublic(code: string): Promise<PublicPaymentResponse> {
      return request<PublicPaymentResponse>(`/api/pay/${code}`, {
        method: "GET",
      });
    },
    /** POST /api/pay/:code/simulate-pay → SIMULASI pembayaran (bukan uang sungguhan). */
    simulatePay(code: string): Promise<PublicPaymentResponse> {
      return request<PublicPaymentResponse>(`/api/pay/${code}/simulate-pay`, {
        method: "POST",
        body: JSON.stringify({}),
      });
    },
  },
  paymentSettings: {
    /** GET /api/tenants/:tenantId/payment-settings → konfigurasi gerbang (tanpa nilai kunci). */
    get(tenantId: string): Promise<PaymentSettingsResponse> {
      return request<PaymentSettingsResponse>(
        `/api/tenants/${tenantId}/payment-settings`,
        { method: "GET" },
      );
    },
    /** PUT /api/tenants/:tenantId/payment-settings → simpan (kunci dienkripsi server). */
    update(
      tenantId: string,
      input: UpdatePaymentSettingsRequest,
    ): Promise<PaymentSettingsResponse> {
      return request<PaymentSettingsResponse>(
        `/api/tenants/${tenantId}/payment-settings`,
        { method: "PUT", body: JSON.stringify(input) },
      );
    },
    /** POST /api/tenants/:tenantId/payment-settings/test → uji koneksi provider aktif. */
    test(tenantId: string): Promise<PaymentSettingsTestResponse> {
      return request<PaymentSettingsTestResponse>(
        `/api/tenants/${tenantId}/payment-settings/test`,
        { method: "POST", body: JSON.stringify({}) },
      );
    },
  },
  team: {
    /** GET /api/tenants/:tenantId/team/members → member + peran (Fase 9C). */
    async listMembers(tenantId: string): Promise<TeamMemberResponse[]> {
      const body = await request<TeamMemberListResponse>(
        `/api/tenants/${tenantId}/team/members`,
        { method: "GET" },
      );
      return body.members;
    },
    /** GET /api/tenants/:tenantId/team/invitations → daftar undangan (owner/admin). */
    async listInvitations(tenantId: string): Promise<InvitationResponse[]> {
      const body = await request<InvitationListResponse>(
        `/api/tenants/${tenantId}/team/invitations`,
        { method: "GET" },
      );
      return body.invitations;
    },
    /**
     * POST /api/tenants/:tenantId/team/invitations {email, role} → 201
     * undangan + inviteUrl SEKALI LIHAT (server hanya menyimpan hash
     * tokennya; tautan tidak bisa ditampilkan ulang).
     */
    invite(
      tenantId: string,
      email: string,
      role: InvitableRole,
    ): Promise<InvitationResponse> {
      return request<InvitationResponse>(
        `/api/tenants/${tenantId}/team/invitations`,
        { method: "POST", body: JSON.stringify({ email, role }) },
      );
    },
    /** DELETE /api/tenants/:tenantId/team/invitations/:id → cabut undangan pending. */
    async revokeInvitation(tenantId: string, invitationId: string): Promise<void> {
      await request<unknown>(
        `/api/tenants/${tenantId}/team/invitations/${invitationId}`,
        { method: "DELETE" },
      );
    },
    /** PATCH /api/tenants/:tenantId/team/members/:userId {role} → member terbarui. */
    updateMemberRole(
      tenantId: string,
      userId: string,
      role: InvitableRole,
    ): Promise<TeamMemberResponse> {
      return request<TeamMemberResponse>(
        `/api/tenants/${tenantId}/team/members/${userId}`,
        { method: "PATCH", body: JSON.stringify({ role }) },
      );
    },
    /** DELETE /api/tenants/:tenantId/team/members/:userId → keluarkan member. */
    async removeMember(tenantId: string, userId: string): Promise<void> {
      await request<unknown>(
        `/api/tenants/${tenantId}/team/members/${userId}`,
        { method: "DELETE" },
      );
    },
  },
  invitations: {
    /** GET /api/invitations/:token → pratinjau undangan untuk sesi login. */
    preview(token: string): Promise<InvitationPreviewResponse> {
      return request<InvitationPreviewResponse>(
        `/api/invitations/${encodeURIComponent(token)}`,
        { method: "GET" },
      );
    },
    /** POST /api/invitations/:token/accept → bergabung ke workspace undangan. */
    accept(token: string): Promise<AcceptInvitationResponse> {
      return request<AcceptInvitationResponse>(
        `/api/invitations/${encodeURIComponent(token)}/accept`,
        { method: "POST", body: JSON.stringify({}) },
      );
    },
  },
};
