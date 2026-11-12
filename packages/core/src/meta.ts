import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  lt,
  or,
  sql,
} from "drizzle-orm";
import {
  auditLogs,
  channelAccounts,
  channelIdentities,
  contacts,
  conversations,
  messages,
  outboxEvents,
  type ChannelAccount,
  type Database,
  type Message,
  type MessageInteractivePayload,
  type MessageTriggerSignal,
} from "@sahabat-kreator/db";
import type { TenantContext } from "./tenant";
import { withTenantDb } from "./tx";
import { storeProfilePhoto } from "./avatars";
import { resolveInboundReplyTargetId } from "./conversations";
import { outboundClaimStale } from "./outbound-claim";

/**
 * Service domain Meta (Fase 7A, RANCANGAN §4 & §12.1) — channel Messenger
 * (Facebook Page) & Instagram (akun IG Professional) lewat Graph API
 * v26.0. Pola mengikuti Telegram (Fase 6A) dengan perbedaan sumber
 * kepercayaan:
 *
 * - Telegram: webhook per akun (id di URL) + secret token per akun.
 * - Meta: SATU webhook platform untuk semua akun. Keaslian dibuktikan
 *   tanda tangan `X-Hub-Signature-256` (HMAC-SHA256 body dengan app
 *   secret platform) di lapisan route; resolusi akun di sini memakai
 *   (provider, external_id) dari `entry.id` payload lewat lengan RLS
 *   `provider_external_lookup` (migrasi 0020, generik — dipakai ulang
 *   apa adanya, tanpa migrasi lengan baru).
 *
 * Model akun:
 * - messenger: external_id = Page ID. Token = Page Access Token.
 * - instagram: external_id = ID akun IG Professional. Token tetap Page
 *   Access Token dari Page Facebook yang terhubung (Graph membolehkan
 *   pengiriman IG lewat endpoint messages akun IG dengan token Page
 *   itu); Page ID hanya diminta saat connect untuk memvalidasi token
 *   memang milik Page yang terhubung — tidak disimpan.
 *
 * Pesan masuk ditulis PERSIS seperti channel lain: baris pesan inbound +
 * unread + event outbox `message.received` dalam satu transaksi tenant —
 * relay worker, automation, sequence, dan agent AI bekerja tanpa
 * tahu-menahu soal Meta. Percakapan Meta v1 selalu privat 1:1 (DM);
 * `provider_chat_id` = id pengirim (PSID/IGSID) sebagai alamat balasan,
 * sejajar semantik chat privat Telegram.
 */

export type MetaProvider = "messenger" | "instagram";

/**
 * Varian token Meta (lifecycle 0010 — lihat channelTokenTypeEnum di
 * skema). Menentukan objek kirim Send API & kelayakan refresh `tbft`.
 */
export type MetaChannelTokenType =
  | "page_access_token"
  | "system_user_token"
  | "business_token";

export interface CreateMetaChannelInput {
  provider: MetaProvider;
  /** Page ID (messenger) / ID akun IG Professional (instagram). */
  accountExternalId: string;
  /** Nama akun dari Graph (`GET /{id}?fields=name`). */
  graphName: string | null;
  /** Username Page / username IG dari Graph; null bila tak ada. */
  publicHandle: string | null;
  /** Nama tampilan pilihan pemilik workspace (menang atas nama Graph). */
  displayName?: string;
  /** Envelope enkripsi Page Access Token — BUKAN token mentah. */
  encryptedAccessToken: string;
  /** Versi Graph API ter-pin untuk akun ini (dari packages/config). */
  graphApiVersion: string;
  /**
   * Konteks induk generik (kolom `parent_external_id`, Fase 7D): untuk
   * Instagram lewat Unified Login ini adalah `client_business_id`
   * (portfolio bisnis klien pemilik SUAT — diperlukan untuk manajemen/
   * refresh token BISU kelak). Jalur manual 7A tidak mengisinya (null).
   * Makna per provider sejajar WhatsApp (WABA ID).
   */
  parentExternalId?: string | null;
  /**
   * Varian token (lifecycle 0010): page_access_token (Facebook Login),
   * system_user_token (SUAT/BISU Unified Login), business_token (OAuth
   * ber-kedaluwarsa). Null = warisan — poller probe `/me` lalu menulis
   * balik varian yang terbaca.
   */
  tokenType?: MetaChannelTokenType | null;
  /**
   * Kedaluwarsa token dari `expires_in` Graph saat connect/exchange;
   * null = token tanpa expiry terdokumentasi (Page token, SUAT manual)
   * — tidak pernah dipindai worker lifecycle.
   */
  tokenExpiresAt?: Date | null;
}

export async function createMetaChannelAccount(
  db: Database,
  ctx: Pick<TenantContext, "tenantId" | "userId"> & { userId: string },
  input: CreateMetaChannelInput,
): Promise<ChannelAccount> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .insert(channelAccounts)
      .values({
        tenantId: ctx.tenantId,
        provider: input.provider,
        externalId: input.accountExternalId,
        displayName: input.displayName ?? input.graphName,
        status: "connected",
        accessTokenEncrypted: input.encryptedAccessToken,
        publicHandle: input.publicHandle,
        parentExternalId: input.parentExternalId ?? null,
        graphApiVersion: input.graphApiVersion,
        // Lifecycle token (0010): varian + jadwal kedaluwarsa tersimpan
        // saat connect; token baru selalu dimulai sehat & bersih.
        tokenType: input.tokenType ?? null,
        tokenExpiresAt: input.tokenExpiresAt ?? null,
        tokenHealth: "ok",
        errorCode: null,
      })
      .returning();

    await tx.insert(auditLogs).values({
      tenantId: ctx.tenantId,
      actorType: "user",
      actorId: ctx.userId,
      action: "channel.created",
      // Metadata aman: nama & handle memang publik; token tidak dicatat.
      meta: {
        channelAccountId: row.id,
        provider: input.provider,
        publicHandle: input.publicHandle,
      },
    });

    return row;
  });
}

export interface UpdateMetaCredentialsInput {
  /** Envelope enkripsi token baru; undefined = jangan ubah. */
  encryptedAccessToken?: string;
  /** Konteks induk (Fase 7D: client_business_id untuk IG Unified Login). */
  parentExternalId?: string | null;
  publicHandle?: string | null;
  /** Nama Graph terbaru; undefined = jangan ubah. */
  graphName?: string | null;
  /** Nama tampilan dari form (hanya menimpa bila diisi pemilik). */
  displayName?: string;
  status?: ChannelAccount["status"];
  /** Varian token baru (lifecycle 0010); undefined = jangan ubah. */
  tokenType?: MetaChannelTokenType | null;
  /** Kedaluwarsa token baru; undefined = jangan ubah. */
  tokenExpiresAt?: Date | null;
  /** Waktu refresh token terakhir (worker tbft); undefined = jangan ubah. */
  tokenRefreshedAt?: Date | null;
  /**
   * Kesehatan token eksplisit (worker lifecycle); undefined = otomatis.
   * Token baru (encryptedAccessToken diisi) selalu memulai "ok" kecuali
   * nilai eksplisit diberikan.
   */
  tokenHealth?: ChannelAccount["tokenHealth"];
  /** Kode error koneksi (mis. meta_graph_190); undefined = jangan ubah. */
  errorCode?: string | null;
}

/**
 * Menulis ulang kredensial/status akun Meta yang SUDAH ada di tenant ini
 * — jalur "revive" connect (pola `updateTelegramChannelAccountCredentials`):
 * akun tenant yang sama berstatus 'disconnected'/'error' dihubungkan lagi
 * tanpa baris duplikat (index unik per tenant melarang baris kedua).
 * Menghubungkan lagi selalu mengeluarkan akun dari Sampah (Fase 6I).
 */
export async function updateMetaChannelAccountCredentials(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  channelAccountId: string,
  input: UpdateMetaCredentialsInput,
): Promise<ChannelAccount | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const patch: Partial<ChannelAccount> = { updatedAt: new Date() };
    if (input.encryptedAccessToken !== undefined) {
      patch.accessTokenEncrypted = input.encryptedAccessToken;
      // Kredensial baru = siklus token dimulai ulang: sehat & bersih
      // (nilai tokenHealth eksplisit tetap menang — lihat bawah).
      patch.tokenHealth = "ok";
      patch.errorCode = null;
    }
    if (input.parentExternalId !== undefined) {
      patch.parentExternalId = input.parentExternalId;
    }
    if (input.publicHandle !== undefined) {
      patch.publicHandle = input.publicHandle;
    }
    if (input.tokenType !== undefined) patch.tokenType = input.tokenType;
    if (input.tokenExpiresAt !== undefined) {
      patch.tokenExpiresAt = input.tokenExpiresAt;
    }
    if (input.tokenRefreshedAt !== undefined) {
      patch.tokenRefreshedAt = input.tokenRefreshedAt;
    }
    if (input.tokenHealth !== undefined) patch.tokenHealth = input.tokenHealth;
    if (input.errorCode !== undefined) patch.errorCode = input.errorCode;
    if (input.displayName !== undefined) {
      patch.displayName = input.displayName;
    } else if (input.graphName) {
      // Tanpa nama form: segarkan nama tampilan dari Graph bila baris
      // lama belum punya — jangan menimpa pilihan pemilik sebelumnya.
      const [current] = await tx
        .select({ displayName: channelAccounts.displayName })
        .from(channelAccounts)
        .where(
          and(
            eq(channelAccounts.tenantId, ctx.tenantId),
            eq(channelAccounts.id, channelAccountId),
          ),
        )
        .limit(1);
      if (current && !current.displayName) patch.displayName = input.graphName;
    }
    if (input.status !== undefined) patch.status = input.status;
    if (input.status === "connected") {
      patch.trashedAt = null;
      // Hubungkan ulang = kesalahan koneksi sebelumnya selesai ditangani.
      patch.errorCode = null;
    }

    const [row] = await tx
      .update(channelAccounts)
      .set(patch)
      .where(
        and(
          eq(channelAccounts.tenantId, ctx.tenantId),
          eq(channelAccounts.id, channelAccountId),
        ),
      )
      .returning();
    return row ?? null;
  });
}

// ---------------------------------------------------------------------------
// Lifecycle token Meta (0010): penandaan auth-error, varian, refresh harian
// ---------------------------------------------------------------------------

/**
 * Tandai akun Meta sebagai GAGAL AUTH (token ditolak Graph 190 / setara):
 * status berubah 'error' + error_code tersimpan sehingga inbox menampilkan
 * "hubungkan ulang" alih-alih gagal senyap berulang. Dipanggil runner
 * pengiriman (Graph 190) dan worker lifecycle (refresh ditolak 190).
 * Kode dipetakan dari errorCode poller yang aman (tanpa token).
 */
export async function markChannelAccountAuthError(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  channelAccountId: string,
  errorCode: string,
): Promise<void> {
  await withTenantDb(db, ctx.tenantId, async (tx) => {
    await tx
      .update(channelAccounts)
      .set({ status: "error", errorCode, updatedAt: new Date() })
      .where(
        and(
          eq(channelAccounts.tenantId, ctx.tenantId),
          eq(channelAccounts.id, channelAccountId),
        ),
      );
  });
}

/**
 * Tulis balik varian token hasil probe `/me` poller (lifecycle 0010):
 * akun warisan (token_type NULL) diberi varian yang terbaca sehingga
 * pengiriman berikutnya tidak pernah men-probe lagi. Probe sukses juga
 * membuktikan token hidup → tokenHealth "ok".
 */
export async function setChannelAccountTokenType(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  channelAccountId: string,
  tokenType: MetaChannelTokenType,
): Promise<void> {
  await withTenantDb(db, ctx.tenantId, async (tx) => {
    await tx
      .update(channelAccounts)
      .set({ tokenType, tokenHealth: "ok", updatedAt: new Date() })
      .where(
        and(
          eq(channelAccounts.tenantId, ctx.tenantId),
          eq(channelAccounts.id, channelAccountId),
        ),
      );
  });
}

/** Ref hasil pemindaian lifecycle token (bentuk minimal worker). */
export interface MetaTokenLifecycleRef {
  tenantId: string;
  channelAccountId: string;
  provider: "messenger" | "instagram" | "whatsapp";
  externalId: string;
  /** Varian token; NULL = warisan (tak bisa di-refresh secara andal). */
  tokenType: MetaChannelTokenType | null;
  tokenExpiresAt: Date;
  tokenRefreshedAt: Date | null;
  /** Envelope token terenkripsi — worker yang mendekripsi. */
  accessTokenEncrypted: string | null;
}

/**
 * Keputusan worker lifecycle untuk SATU akun (fungsi murni — mudah
 * diuji):
 * - token varian refreshable (system_user_token / business_token) dan
 *   konfigurasi refresh lengkap (appId+appSecret) → "refresh";
 * - selain itu → "warn": varian tak refreshable (Page token) atau
 *   konfigurasi kurang — worker hanya menandai kesehatan dan
 *   mencatat peringatan supaya pemilik menghubungkan ulang sebelum
 *   token mati.
 * Kesehatan: sudah lewat jadwal → "expired", mendekati → "expiring".
 */
export function metaTokenLifecycleDecision(input: {
  tokenType: MetaChannelTokenType | null;
  tokenExpiresAt: Date;
  now: Date;
  canRefresh: boolean;
}): { action: "refresh" | "warn"; health: "expiring" | "expired" } {
  const refreshable =
    input.tokenType === "system_user_token" ||
    input.tokenType === "business_token";
  return {
    action: refreshable && input.canRefresh ? "refresh" : "warn",
    health: input.tokenExpiresAt <= input.now ? "expired" : "expiring",
  };
}

/**
 * Pindai akun Meta AKTIF lintas tenant yang tokennya mendekati atau
 * sudah melewati kedaluwarsa (dalam `withinDays` hari ke depan).
 * Memakai lengan RLS `meta_token_lifecycle_scan` (0010) dengan
 * `app.system_relay = 'meta_token_lifecycle'` — baca saja; penulisan
 * hasil lewat konteks tenant masing-masing. Akun yang sudah berstatus
 * 'error' tidak diikutkan (hubungkan ulang dulu).
 */
export async function listExpiringMetaTokens(
  db: Database,
  opts: { withinDays?: number; limit?: number; now?: Date } = {},
): Promise<MetaTokenLifecycleRef[]> {
  const now = opts.now ?? new Date();
  const withinMs = (opts.withinDays ?? 7) * 24 * 60 * 60 * 1000;
  const deadline = new Date(now.getTime() + withinMs);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.system_relay', 'meta_token_lifecycle', true)`,
    );
    const rows = await tx
      .select({
        tenantId: channelAccounts.tenantId,
        channelAccountId: channelAccounts.id,
        provider: channelAccounts.provider,
        externalId: channelAccounts.externalId,
        tokenType: channelAccounts.tokenType,
        tokenExpiresAt: channelAccounts.tokenExpiresAt,
        tokenRefreshedAt: channelAccounts.tokenRefreshedAt,
        accessTokenEncrypted: channelAccounts.accessTokenEncrypted,
      })
      .from(channelAccounts)
      .where(
        and(
          inArray(channelAccounts.provider, [
            "messenger",
            "instagram",
            "whatsapp",
          ]),
          eq(channelAccounts.status, "connected"),
          isNotNull(channelAccounts.tokenExpiresAt),
          lte(channelAccounts.tokenExpiresAt, deadline),
        ),
      )
      .orderBy(asc(channelAccounts.tokenExpiresAt))
      .limit(opts.limit ?? 100);
    return rows.map((r) => ({
      ...r,
      provider: r.provider as MetaTokenLifecycleRef["provider"],
      tokenType: (r.tokenType ?? null) as MetaChannelTokenType | null,
      // Guard tipe: WHERE sudah menjamin tokenExpiresAt tak null.
      tokenExpiresAt: r.tokenExpiresAt as Date,
    }));
  });
}

/**
 * Terapkan hasil satu langkah lifecycle (refresh sukses/gagal, peringatan
 * kedaluwarsa) pada akun Meta di konteks tenant pemiliknya. Envelope
 * token baru (refresh sukses) menimpa kredensial; kesehatan selalu
 * ditulis eksplisit oleh pemanggil (decider worker). Return false bila
 * akun sudah tiada/pindah tenant — worker melewati diam-diam.
 */
export async function applyMetaTokenLifecycleUpdate(
  db: Database,
  ref: Pick<MetaTokenLifecycleRef, "tenantId" | "channelAccountId">,
  update: {
    /** Envelope token hasil refresh — BUKAN token mentah. */
    encryptedAccessToken?: string;
    /**
     * Envelope refresh token hasil rotasi (gelombang Semua OAuth:
     * TikTok/Pinterest menerbitkan refresh token BARU pada grant
     * refresh; yang lama harus diganti atomik bersama access token).
     * undefined = jangan ubah (Meta/Threads me-refresh dari access
     * token itu sendiri dan tidak punya kolom ini terisi).
     */
    encryptedRefreshToken?: string;
    tokenExpiresAt?: Date | null;
    tokenRefreshedAt?: Date | null;
    tokenHealth: ChannelAccount["tokenHealth"];
  },
): Promise<boolean> {
  return withTenantDb(db, ref.tenantId, async (tx) => {
    const patch: Partial<ChannelAccount> = {
      tokenHealth: update.tokenHealth,
      updatedAt: new Date(),
    };
    if (update.encryptedAccessToken !== undefined) {
      patch.accessTokenEncrypted = update.encryptedAccessToken;
    }
    if (update.encryptedRefreshToken !== undefined) {
      patch.refreshTokenEncrypted = update.encryptedRefreshToken;
    }
    if (update.tokenExpiresAt !== undefined) {
      patch.tokenExpiresAt = update.tokenExpiresAt;
    }
    if (update.tokenRefreshedAt !== undefined) {
      patch.tokenRefreshedAt = update.tokenRefreshedAt;
    }
    const rows = await tx
      .update(channelAccounts)
      .set(patch)
      .where(
        and(
          eq(channelAccounts.tenantId, ref.tenantId),
          eq(channelAccounts.id, ref.channelAccountId),
        ),
      )
      .returning({ id: channelAccounts.id });
    return rows.length > 0;
  });
}

export type MetaAccountRef = Pick<
  ChannelAccount,
  | "id"
  | "tenantId"
  | "provider"
  | "externalId"
  | "displayName"
  | "status"
  | "accessTokenEncrypted"
  | "publicHandle"
>;

/**
 * Resolusi akun Meta dari (provider, external_id) payload webhook TANPA
 * konteks tenant: transaksi men-set `app.channel_provider` +
 * `app.channel_external_id` dan policy `provider_external_lookup` (0020)
 * hanya membuka baris pasangan itu. external_id di sini berasal dari
 * payload yang SUDAH lolos verifikasi tanda tangan app secret di route —
 * bukan dari sumber tak tepercaya. Null bila tak dikenal.
 */
export async function resolveMetaAccountByExternalId(
  db: Database,
  provider: MetaProvider,
  externalId: string,
): Promise<MetaAccountRef | null> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.channel_provider', ${provider}, true)`,
    );
    await tx.execute(
      sql`SELECT set_config('app.channel_external_id', ${externalId}, true)`,
    );
    const [row] = await tx
      .select({
        id: channelAccounts.id,
        tenantId: channelAccounts.tenantId,
        provider: channelAccounts.provider,
        externalId: channelAccounts.externalId,
        displayName: channelAccounts.displayName,
        status: channelAccounts.status,
        accessTokenEncrypted: channelAccounts.accessTokenEncrypted,
        publicHandle: channelAccounts.publicHandle,
      })
      .from(channelAccounts)
      .where(
        and(
          eq(channelAccounts.provider, provider),
          eq(channelAccounts.externalId, externalId),
        ),
      )
      // Fase 7C (temuan rantai): external_id yang sama BOLEH hidup di
      // beberapa tenant sebagai baris disconnected (penjaga 0020 hanya
      // melarang >1 yang connected). Tanpa urutan ini resolver bisa
      // memungut baris disconnected tenant lain dan webhook tenant
      // pemilik koneksi aktif ter-abaikan sebagai ignored_disconnected.
      // Penjaga menjamin maks. satu connected → dahulukan dia; bila
      // tidak ada, ambil yang terbaru agar log tetap bermakna.
      .orderBy(
        sql`case when ${channelAccounts.status} = 'connected' then 0 else 1 end`,
        desc(channelAccounts.createdAt),
      )
      .limit(1);
    return row ?? null;
  });
}

/**
 * Nama cadangan kontak Meta sebelum profil Graph tiba: webhook Meta
 * TIDAK menyertakan nama pengirim, jadi kontak pertama kali dibuat
 * dengan label generik per provider — lalu route webhook mengambil
 * profil Graph (nama + foto) best-effort dan fungsi
 * `applyMetaContactProfile` mengganti label ini dengan nama asli.
 */
export function metaContactFallbackName(provider: MetaProvider): string {
  return provider === "instagram" ? "Instagram user" : "Messenger user";
}

export interface RecordMetaInboundResult {
  message: Message;
  contactId: string;
  identityCreated: boolean;
  /** Fase 7B.1: true bila mid ini kembaran yang sudah tercatat. */
  duplicate: boolean;
}

export interface RecordMetaInboundInput {
  /** PSID (messenger) / IGSID (instagram) pengirim — identitas kontak. */
  senderExternalId: string;
  /** Id pesan Meta (`message.mid`) untuk dedup; disimpan majemuk. */
  providerMessageId: string;
  /**
   * Mid pesan yang dikutip pesan ini (`message.reply_to.mid`, Fase
   * 7B.5) dalam satuan mentah yang sama seperti providerMessageId —
   * ditautkan ke baris target bila ditemukan di percakapan yang sama;
   * selain itu pesan tetap tercatat tanpa tautan.
   */
  replyToProviderMessageId?: string | null;
  text: string;
  /**
   * Sinyal pemicu ketukan tombol (G5): postback Meta / payload quick
   * reply pada pesan ini, dinormalkan parser channel. Ditulis apa
   * adanya ke messages.trigger_signal; evaluator yang menafsirkannya
   * (trigger-priority.ts). Undefined = pesan biasa.
   */
  triggerSignal?: MessageTriggerSignal | null;
}

/**
 * Menyimpan pesan DM masuk Meta: temukan/buat kontak pengirim + percakapan
 * privat terbuka, lalu baris pesan + unread + event outbox
 * `message.received` dalam SATU transaksi tenant (pola telegram/webchat).
 * Idempoten terhadap pengiriman ulang webhook Meta: mid yang sama
 * mengembalikan pesan yang sudah ada. Mengembalikan NULL hanya bila
 * kembaran pesan itu dimiliki tenant/akun lain (akun sama terhubung
 * ganda warisan) — pemanggil cukup mengakui webhook (200).
 */
export async function recordMetaInboundMessage(
  db: Database,
  account: Pick<MetaAccountRef, "id" | "tenantId" | "provider" | "externalId">,
  input: RecordMetaInboundInput,
): Promise<RecordMetaInboundResult | null> {
  const provider = account.provider as MetaProvider;
  // Index unik provider_message_id bersifat global → sematkan id akun
  // provider seperti pola telegram (`telegram:<botId>:<message_id>`).
  const compositeId = `meta:${account.externalId}:${input.providerMessageId}`;
  return withTenantDb(db, account.tenantId, async (tx) => {
    const [identity] = await tx
      .select()
      .from(channelIdentities)
      .where(
        and(
          eq(channelIdentities.channelAccountId, account.id),
          eq(channelIdentities.externalUserId, input.senderExternalId),
        ),
      )
      .limit(1);

    let contactId: string;
    let identityCreated = false;
    if (identity) {
      contactId = identity.contactId;
    } else {
      const [contact] = await tx
        .insert(contacts)
        .values({
          tenantId: account.tenantId,
          name: metaContactFallbackName(provider),
        })
        .returning();
      contactId = contact.id;
      identityCreated = true;
      await tx.insert(channelIdentities).values({
        tenantId: account.tenantId,
        contactId,
        channelAccountId: account.id,
        provider,
        externalUserId: input.senderExternalId,
      });
    }

    const [existingConv] = await tx
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.tenantId, account.tenantId),
          eq(conversations.channelAccountId, account.id),
          eq(conversations.contactId, contactId),
        ),
      )
      .orderBy(desc(conversations.createdAt))
      .limit(1);

    let conversationId: string;
    if (existingConv && existingConv.status !== "closed") {
      conversationId = existingConv.id;
      if (existingConv.providerChatId !== input.senderExternalId) {
        await tx
          .update(conversations)
          .set({ providerChatId: input.senderExternalId })
          .where(eq(conversations.id, existingConv.id));
      }
    } else {
      const [conv] = await tx
        .insert(conversations)
        .values({
          tenantId: account.tenantId,
          channelAccountId: account.id,
          contactId,
          provider,
          providerChatId: input.senderExternalId,
          kind: "private",
          status: "open",
        })
        .returning();
      conversationId = conv.id;
    }

    // Dedup webhook retry: mid yang sama tidak boleh ganda. Identitas
    // untuk kembaran ini pasti sudah ada dari upaya pertama, jadi
    // identityCreated dilaporkan false (profil tidak diambil ulang).
    const [dupe] = await tx
      .select()
      .from(messages)
      .where(eq(messages.providerMessageId, compositeId))
      .limit(1);
    if (dupe)
      return { message: dupe, contactId, identityCreated: false, duplicate: true };

    // Fase 7B.5: tautkan kutipan (reply_to.mid) bila targetnya ada di
    // percakapan ini — id majemuk target disusun dengan pola yang sama.
    const replyToMessageId = input.replyToProviderMessageId
      ? await resolveInboundReplyTargetId(
          tx,
          conversationId,
          `meta:${account.externalId}:${input.replyToProviderMessageId}`,
        )
      : null;

    // ON CONFLICT DO NOTHING: SELECT dedup berjalan dalam konteks RLS
    // tenant ini sedangkan index-nya GLOBAL — kembaran milik tenant lain
    // tak terlihat oleh SELECT tetapi ditolak index; tanpa penjaga ini
    // insert melempar 23505 → webhook 500 → Meta me-retry selamanya
    // (pelajaran 6A.1, pola yang sama).
    const [message] = await tx
      .insert(messages)
      .values({
        tenantId: account.tenantId,
        conversationId,
        direction: "inbound",
        senderType: "contact",
        type: "text",
        contentText: input.text,
        providerMessageId: compositeId,
        replyToMessageId,
        triggerSignal: input.triggerSignal ?? null,
        status: "received",
      })
      .onConflictDoNothing()
      .returning();
    if (!message) return null;

    const now = new Date();
    await tx
      .update(conversations)
      .set({
        unreadCount: sql`${conversations.unreadCount} + 1`,
        lastMessageAt: now,
        updatedAt: now,
      })
      .where(eq(conversations.id, conversationId));

    await tx.insert(outboxEvents).values({
      tenantId: account.tenantId,
      type: "message.received",
      payload: {
        provider,
        channelAccountId: account.id,
        conversationId,
        messageId: message.id,
      },
    });

    return { message, contactId, identityCreated, duplicate: false };
  });
}

export interface RecordMetaReferralResult {
  contactId: string;
  conversationId: string;
  /** True bila identitas channel kontak ini baru dibuat oleh referral ini. */
  identityCreated: boolean;
}

/**
 * Mencatat kedatangan REFERRAL Meta (Fase 13B): pengguna membuka
 * percakapan lewat tautan m.me/ig.me berparameter ref. Tidak ada
 * pesan — jadi fungsi ini hanya find-or-create identitas + kontak +
 * percakapan privat terbuka MENGIKUTI POLA PERSIS recordMetaInboundMessage,
 * TANPA baris pesan, TANPA unread, TANPA outbox `message.received`
 * (tidak ada yang perlu dijawab/di-otomatisasi). Atribusi growth link
 * dilakukan pemanggil lewat `attributeContactToGrowthLink` dengan ref
 * sebagai slug — referral yang ref-nya bukan slug dikenal adalah
 * no-op di lapis itu. Idempoten: referral berulang menemukan
 * identitas/percakapan yang sama.
 */
export async function recordMetaReferralContact(
  db: Database,
  account: Pick<MetaAccountRef, "id" | "tenantId" | "provider" | "externalId">,
  input: { senderExternalId: string },
): Promise<RecordMetaReferralResult> {
  const provider = account.provider as MetaProvider;
  return withTenantDb(db, account.tenantId, async (tx) => {
    const [identity] = await tx
      .select()
      .from(channelIdentities)
      .where(
        and(
          eq(channelIdentities.channelAccountId, account.id),
          eq(channelIdentities.externalUserId, input.senderExternalId),
        ),
      )
      .limit(1);

    let contactId: string;
    let identityCreated = false;
    if (identity) {
      contactId = identity.contactId;
    } else {
      const [contact] = await tx
        .insert(contacts)
        .values({
          tenantId: account.tenantId,
          name: metaContactFallbackName(provider),
        })
        .returning();
      contactId = contact.id;
      identityCreated = true;
      await tx.insert(channelIdentities).values({
        tenantId: account.tenantId,
        contactId,
        channelAccountId: account.id,
        provider,
        externalUserId: input.senderExternalId,
      });
    }

    const [existingConv] = await tx
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.tenantId, account.tenantId),
          eq(conversations.channelAccountId, account.id),
          eq(conversations.contactId, contactId),
        ),
      )
      .orderBy(desc(conversations.createdAt))
      .limit(1);

    let conversationId: string;
    if (existingConv && existingConv.status !== "closed") {
      conversationId = existingConv.id;
      if (existingConv.providerChatId !== input.senderExternalId) {
        await tx
          .update(conversations)
          .set({ providerChatId: input.senderExternalId })
          .where(eq(conversations.id, existingConv.id));
      }
    } else {
      const [conv] = await tx
        .insert(conversations)
        .values({
          tenantId: account.tenantId,
          channelAccountId: account.id,
          contactId,
          provider,
          providerChatId: input.senderExternalId,
          kind: "private",
          status: "open",
        })
        .returning();
      conversationId = conv.id;
    }

    return { contactId, conversationId, identityCreated };
  });
}

// ---------------------------------------------------------------------------
// Profil kontak dari Graph (nama + foto) — best-effort, pola Fase 6D
// ---------------------------------------------------------------------------

const DEFAULT_META_API_BASE = "https://graph.facebook.com";
/** Batas keras ukuran unduhan foto profil (sanity, pola avatars.ts). */
const META_PHOTO_MAX_BYTES = 5 * 1024 * 1024;

/** Field profil pengirim per provider Graph (objek user dari PSID/IGSID). */
function metaSenderProfileFields(provider: MetaProvider): string {
  return provider === "instagram"
    ? "name,username,profile_picture_url"
    : "first_name,last_name,profile_pic";
}

export interface FetchMetaContactProfileInput {
  tenantId: string;
  /** Page Access Token MENTAH — pemanggil yang mendekripsi. */
  accessToken: string;
  /** Base URL Graph API (env META_API_BASE; default graph.facebook.com). */
  metaApiBase?: string;
  /** Versi Graph ter-pin (dari packages/config lewat pemanggil). */
  graphApiVersion: string;
  provider: MetaProvider;
  /** PSID/IGSID pengirim. */
  senderExternalId: string;
  contactId: string;
  timeoutMs?: number;
}

/**
 * Mengambil profil pengirim Meta dari Graph untuk kontak yang BARU
 * pertama kali terlihat: nama asli (menggantikan label cadangan HANYA
 * bila kontak masih berlabel cadangan — nama yang sudah disunting
 * pemilik workspace tidak pernah ditimpa) + foto profil (diunduh dari
 * URL CDN Graph, disimpan lewat `storeProfilePhoto` Fase 6D).
 *
 * Mengembalikan true bila ada yang tersimpan/terbarui. TIDAK PERNAH
 * melempar — semua pemicunya best-effort (jalur webhook). Token dikirim
 * sebagai header Authorization (tidak di URL) dan tidak pernah dicatat;
 * pesan error fetch bisa memuat URL bertanda tangan CDN, jadi kegagalan
 * hanya dicatat sebagai label tahap.
 */
export async function fetchAndStoreMetaContactProfile(
  db: Database,
  input: FetchMetaContactProfileInput,
): Promise<boolean> {
  const base = (input.metaApiBase ?? DEFAULT_META_API_BASE).replace(/\/+$/, "");
  const timeoutMs = input.timeoutMs ?? 5_000;
  const headers = { authorization: `Bearer ${input.accessToken}` };
  try {
    const profileRes = await fetch(
      `${base}/${input.graphApiVersion}/${encodeURIComponent(input.senderExternalId)}?fields=${metaSenderProfileFields(input.provider)}`,
      { headers, signal: AbortSignal.timeout(timeoutMs) },
    );
    if (!profileRes.ok) {
      // Fase 7A.1: kegagalan Graph TIDAK boleh senyap — tanpa jejak ini,
      // kontak selamanya memakai label cadangan ("Messenger user") dan
      // mustahil didiagnosis. Body error Graph aman dicatat (berisi
      // code/subcode/fbtrace_id, TIDAK pernah memuat token).
      const errBody = await profileRes.text();
      console.error(
        `[meta] profil kontak gagal (provider ${input.provider}, kontak ${input.contactId}) http=${profileRes.status} body=${errBody.slice(0, 300)}`,
      );
      return false;
    }
    const profile = (await profileRes.json()) as {
      first_name?: string;
      last_name?: string;
      name?: string;
      username?: string;
      profile_pic?: string;
      profile_picture_url?: string;
    };

    const fetchedName =
      profile.name?.trim() ||
      [profile.first_name, profile.last_name]
        .filter((part): part is string => Boolean(part?.trim()))
        .join(" ")
        .trim() ||
      null;
    const pictureUrl =
      input.provider === "instagram"
        ? profile.profile_picture_url
        : profile.profile_pic;

    let changed = false;

    if (fetchedName) {
      await withTenantDb(db, input.tenantId, async (tx) => {
        const [identity] = await tx
          .select({ username: channelIdentities.username })
          .from(channelIdentities)
          .where(
            and(
              eq(channelIdentities.tenantId, input.tenantId),
              eq(channelIdentities.contactId, input.contactId),
              eq(channelIdentities.provider, input.provider),
            ),
          )
          .limit(1);
        if (profile.username && identity && identity.username !== profile.username) {
          await tx
            .update(channelIdentities)
            .set({ username: profile.username })
            .where(
              and(
                eq(channelIdentities.tenantId, input.tenantId),
                eq(channelIdentities.contactId, input.contactId),
                eq(channelIdentities.provider, input.provider),
              ),
            );
        }
        const [contact] = await tx
          .select({ name: contacts.name })
          .from(contacts)
          .where(eq(contacts.id, input.contactId))
          .limit(1);
        if (
          contact &&
          contact.name === metaContactFallbackName(input.provider) &&
          fetchedName !== contact.name
        ) {
          await tx
            .update(contacts)
            .set({ name: fetchedName })
            .where(eq(contacts.id, input.contactId));
          changed = true;
        }
      });
    }

    if (pictureUrl) {
      const download = await fetch(pictureUrl, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (download.ok) {
        const bytes = Buffer.from(await download.arrayBuffer());
        if (bytes.length > 0 && bytes.length <= META_PHOTO_MAX_BYTES) {
          await storeProfilePhoto(db, { tenantId: input.tenantId }, {
            ownerType: "contact",
            ownerId: input.contactId,
            contentType:
              download.headers.get("content-type")?.split(";")[0]?.trim() ||
              "image/jpeg",
            data: bytes,
          });
          changed = true;
        }
      }
    }
    return changed;
  } catch {
    console.error(
      `[meta] pengambilan profil kontak gagal (provider ${input.provider}, kontak ${input.contactId})`,
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Antrean pengiriman keluar (poller API)
// ---------------------------------------------------------------------------

/** Provider yang dilayani poller pengiriman Meta (Fase 7B menambah WhatsApp). */
export type MetaDeliveryProvider = MetaProvider | "whatsapp";

export interface MetaQueuedDelivery {
  tenantId: string;
  messageId: string;
  conversationId: string;
  contentText: string | null;
  /**
   * Muatan template WhatsApp (Fase 10A) untuk pesan bertipe template;
   * poller mengirim `type: "template"` bila kolom ini terisi pada
   * pesan provider whatsapp. Null untuk pesan teks biasa.
   */
  templatePayload: {
    name: string;
    languageCode: string;
    bodyParams: string[];
    /** Variabel HEADER teks (Fase 17); absen untuk template tanpa header ber-variabel. */
    headerParams?: string[];
    /** Variabel tombol URL (Fase 17); `index` = posisi tombol 0-based. */
    buttonParams?: Array<{ index: number; text: string }>;
    /**
     * Lampiran header media (Fase 18C) — id baris `media` milik tenant.
     * Poller mengunggahnya ke Meta saat mengirim: Cloud API menuntut
     * media id milik Meta, bukan id penyimpanan kita.
     */
    headerMediaId?: string;
  } | null;
  /**
   * Id baris pesan yang dikutip pesan ini (Fase 7B.5), atau null —
   * poller menurunkan wamid/mid targetnya dari baris itu dalam konteks
   * tenant (pola TelegramQueuedDelivery.replyToMessageId).
   */
  replyToMessageId: string | null;
  /**
   * Fase 10B: id komentar yang menjadi alamat kirim pesan ini (DM
   * private reply comment-to-DM); poller meneruskannya ke sendMessage
   * sebagai `recipient: { comment_id }`. Null untuk pesan biasa.
   */
  providerCommentId: string | null;
  channelAccountId: string;
  provider: MetaDeliveryProvider;
  /** external_id akun: Page ID (messenger) / ID akun IG (instagram) — segmen path endpoint kirim. */
  accountExternalId: string;
  /**
   * Varian token akun (lifecycle 0010): penentu objek kirim Instagram
   * (system_user_token/business_token → id akun IG, page_access_token
   * → `me`). NULL = warisan — poller probe `/me` sekali lalu tulis
   * balik varian yang terbaca ke DB.
   */
  tokenType: MetaChannelTokenType | null;
  /** Envelope enkripsi Page Access Token akun pemilik. */
  encryptedAccessToken: string | null;
  /** PSID/IGSID tujuan: provider_chat_id percakapan, jatuh kembali ke identitas kontak. */
  recipientExternalId: string;
  /**
   * Lampiran pesan ini (Fase 18B), null untuk pesan teks/template.
   *
   * Sengaja HANYA id, bukan object key hasil join ke `media`: pindai
   * ini berjalan lintas tenant di bawah `app.system_delivery`, sedangkan
   * `media` hanya punya policy isolasi tenant. Join ke sana akan
   * mengembalikan nol baris dan pesan berlampiran lenyap dari antrean
   * tanpa satu pun error — persis pola kegagalan senyap Fase 16G.
   * Byte-nya dibaca pengirim di konteks tenant masing-masing.
   */
  mediaId: string | null;
  /**
   * Muatan interaktif natif kanal (G17, node send_catalog): poller
   * membentuk panggilan API natif dari bentuk ini (daftar interaktif
   * WhatsApp / template generik Messenger-IG). Null untuk pesan lain.
   */
  interactivePayload: MessageInteractivePayload | null;
}

/**
 * Pindai antrean pengiriman Meta LINTAS tenant untuk poller API: pesan
 * outbound `queued` pada percakapan messenger/instagram/whatsapp
 * lengkap dengan token terenkripsi akun + alamat penerimanya. Berjalan
 * dalam transaksi yang men-set `app.system_delivery='meta'` — policy
 * `meta_delivery_scan` (0026, diperluas 0027 ke whatsapp) membuka tepat
 * baris-baris ini (baca saja); penandaan sent/failed tetap dalam
 * konteks tenant masing-masing. Pola `listQueuedTelegramDeliveries`.
 */
export async function listQueuedMetaDeliveries(
  db: Database,
  limit = 25,
): Promise<MetaQueuedDelivery[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.system_delivery', 'meta', true)`);
    /**
     * Alamat tujuan: `provider_chat_id` percakapan lebih dulu, identitas
     * kontak sebagai cadangan (Fase 16G).
     *
     * Sebelumnya ini INNER JOIN ke `channel_identities`. Akibatnya
     * percakapan yang SUDAH punya `provider_chat_id` — alamat yang
     * lengkap dan pasti benar — tetap dibuang bila baris identitasnya
     * tidak ada. Baris seperti itu berakhir `queued` selamanya tanpa
     * satu pun error: pesan ada, alamat ada, tetapi pemindai tidak
     * pernah melihatnya.
     *
     * Subquery (bukan LEFT JOIN) dipilih karena `channel_identities`
     * TIDAK punya unique index pada (channel_account_id, contact_id):
     * satu kontak bisa punya lebih dari satu identitas di akun yang
     * sama (mis. nomor WhatsApp berpindah). JOIN akan menggandakan baris
     * pesan dan menghabiskan slot batch — dengan `limit` 25, beberapa
     * kontak saja bisa menahan seluruh antrean. `LIMIT 1` dengan urutan
     * tetap membuat pilihannya deterministik, bukan sembarang baris.
     *
     * `IS NOT NULL` pada WHERE menggantikan fungsi penyaring yang dulu
     * diam-diam dijalankan INNER JOIN: percakapan tanpa alamat sama
     * sekali memang tidak bisa dikirimi, dan tidak boleh menempati slot.
     */
    const recipientExternalId = sql<string>`coalesce(
      ${conversations.providerChatId},
      (
        SELECT ci.external_user_id
          FROM channel_identities ci
         WHERE ci.channel_account_id = ${channelAccounts.id}
           AND ci.contact_id = ${conversations.contactId}
         ORDER BY ci.created_at ASC
         LIMIT 1
      )
    )`;
    const rows = await tx
      .select({
        tenantId: messages.tenantId,
        messageId: messages.id,
        conversationId: messages.conversationId,
        contentText: messages.contentText,
        templatePayload: messages.templatePayload,
        interactivePayload: messages.interactivePayload,
        providerCommentId: messages.providerCommentId,
        replyToMessageId: messages.replyToMessageId,
        mediaId: messages.mediaId,
        channelAccountId: channelAccounts.id,
        provider: channelAccounts.provider,
        accountExternalId: channelAccounts.externalId,
        tokenType: channelAccounts.tokenType,
        encryptedAccessToken: channelAccounts.accessTokenEncrypted,
        recipientExternalId,
      })
      .from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .innerJoin(
        channelAccounts,
        eq(conversations.channelAccountId, channelAccounts.id),
      )
      .where(
        and(
          eq(messages.direction, "outbound"),
          eq(messages.status, "queued"),
          // Hanya baris yang bisa diklaim: belum diklaim, atau klaimnya
          // basi (pengirim sebelumnya mati). Baris yang sedang dikirim
          // poller lain tidak ikut dipindai — cegah kirim ganda.
          or(
            isNull(messages.claimedAt),
            lt(messages.claimedAt, outboundClaimStale),
          ),
          inArray(conversations.provider, ["messenger", "instagram", "whatsapp"]),
          sql`${recipientExternalId} IS NOT NULL`,
        ),
      )
      .orderBy(asc(messages.createdAt))
      .limit(limit);
    return rows.map((r) => ({
      ...r,
      provider: r.provider as MetaDeliveryProvider,
      // Saringan provider di atas menjamin akun Meta — varian token
      // Threads (threads_user_token, migrasi 0021) tidak pernah
      // muncul di antrean ini.
      tokenType: r.tokenType as MetaChannelTokenType | null,
    }));
  });
}
