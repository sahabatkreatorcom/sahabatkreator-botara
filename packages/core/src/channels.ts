import { randomBytes } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  auditLogs,
  channelAccounts,
  contacts,
  conversations,
  messages,
  type ChannelAccount,
  type Database,
} from "@sahabat-kreator/db";

/** Provider channel (nilai enum `channel_provider` di skema db). */
export type ChannelProviderName = ChannelAccount["provider"];
import type { TenantContext } from "./tenant";
import { withTenantDb } from "./tx";

/**
 * Service domain akun channel workspace (Fase 1F, RANCANGAN §4 & §6).
 * Transport-agnostic; semua query dalam konteks RLS tenant.
 *
 * Fase ini provider yang bisa benar-benar dibuat hanya `webchat` — channel
 * milik sendiri yang identitas publiknya adalah siteKey acak
 * (`wc_` + 24 karakter) yang dipasang tenant di situsnya. Provider Meta/
 * Telegram dibuat di fase channel masing-masing; pemanggil (API) yang
 * menjawab CHANNEL_NOT_AVAILABLE_YET untuk provider selain webchat.
 */

/** Membuat siteKey publik webchat: `wc_` + 24 karakter base64url (144 bit entropi). */
export function generateWebchatSiteKey(): string {
  return `wc_${randomBytes(18).toString("base64url")}`;
}

/**
 * Audit `channel.connected` (Fase 7D) — jejak METODE penghubungan sebuah
 * akun channel. Fungsi create per provider sudah menulis
 * `channel.created`; jalur OAuth menulis audit tambahan ini agar riwayat
 * membedakan koneksi hasil login Meta dari koneksi form manual, untuk
 * pembuatan baru maupun revive. Meta TIDAK memuat token/secret apa pun —
 * hanya id akun, provider, dan metode.
 */
export async function recordChannelConnectedAudit(
  db: Database,
  ctx: Pick<TenantContext, "tenantId" | "userId"> & { userId: string },
  input: {
    channelAccountId: string;
    provider: ChannelProviderName;
    method: "oauth" | "manual";
  },
): Promise<void> {
  await withTenantDb(db, ctx.tenantId, async (tx) => {
    await tx.insert(auditLogs).values({
      tenantId: ctx.tenantId,
      actorType: "user",
      actorId: ctx.userId,
      action: "channel.connected",
      meta: {
        channelAccountId: input.channelAccountId,
        provider: input.provider,
        method: input.method,
      },
    });
  });
}

export async function createWebchatChannelAccount(
  db: Database,
  ctx: Pick<TenantContext, "tenantId" | "userId"> & { userId: string },
  input: { displayName?: string },
): Promise<ChannelAccount> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .insert(channelAccounts)
      .values({
        tenantId: ctx.tenantId,
        provider: "webchat",
        externalId: generateWebchatSiteKey(),
        displayName: input.displayName ?? null,
        status: "connected",
      })
      .returning();

    await tx.insert(auditLogs).values({
      tenantId: ctx.tenantId,
      actorType: "user",
      actorId: ctx.userId,
      action: "channel.created",
      meta: { channelAccountId: row.id, provider: "webchat" },
    });

    return row;
  });
}

/**
 * Mengubah status akun channel (mis. 'error' bila pendaftaran webhook ke
 * provider gagal sesudah akun dibuat — Fase 6A Telegram).
 */
export async function setChannelAccountStatus(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  channelAccountId: string,
  status: ChannelAccount["status"],
): Promise<void> {
  await withTenantDb(db, ctx.tenantId, async (tx) => {
    await tx
      .update(channelAccounts)
      .set({ status, updatedAt: new Date() })
      .where(
        and(
          eq(channelAccounts.tenantId, ctx.tenantId),
          eq(channelAccounts.id, channelAccountId),
        ),
      );
  });
}

/** Daftar akun channel milik tenant, terlama lebih dulu.
 * Akun di Sampah (Fase 6I) TIDAK ikut — mereka hidup di daftar Sampah. */
export async function listChannelAccounts(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
): Promise<ChannelAccount[]> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    return tx
      .select()
      .from(channelAccounts)
      .where(
        and(
          eq(channelAccounts.tenantId, ctx.tenantId),
          isNull(channelAccounts.trashedAt),
        ),
      )
      .orderBy(asc(channelAccounts.createdAt));
  });
}

// ---------------------------------------------------------------------------
// Sampah channel (Fase 6I — hapus permanen BERPENJAGA)
// ---------------------------------------------------------------------------

/** Masa tenggang Sampah sebelum purge permanen oleh worker (hari). */
export const CHANNEL_TRASH_GRACE_DAYS = 30;

/** Batas waktu purge sebuah akun Sampah: trashedAt + masa tenggang. */
export function channelPurgeAt(account: ChannelAccount): Date | null {
  if (!account.trashedAt) return null;
  return new Date(
    account.trashedAt.getTime() + CHANNEL_TRASH_GRACE_DAYS * 24 * 3600 * 1000,
  );
}

/**
 * Nama konfirmasi pembuangan: nama yang harus diketik persis oleh pemilik
 * workspace. displayName adalah nama yang tampil di kartu; akun tanpa
 * displayName jatuh ke botUsername (telegram) lalu externalId (siteKey
 * webchat / id provider) — selalu nilai yang memang terlihat di UI,
 * tidak pernah rahasia.
 */
export function channelConfirmationName(
  account: Pick<
    ChannelAccount,
    "displayName" | "botUsername" | "publicHandle" | "externalId"
  >,
): string {
  const display = account.displayName?.trim();
  if (display) return display;
  if (account.botUsername) return account.botUsername;
  if (account.publicHandle) return account.publicHandle;
  return account.externalId;
}

/** Daftar akun di Sampah milik tenant, yang paling lama dibuang lebih dulu. */
export async function listTrashedChannelAccounts(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
): Promise<ChannelAccount[]> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    return tx
      .select()
      .from(channelAccounts)
      .where(
        and(
          eq(channelAccounts.tenantId, ctx.tenantId),
          isNotNull(channelAccounts.trashedAt),
        ),
      )
      .orderBy(asc(channelAccounts.trashedAt));
  });
}

export type TrashChannelOutcome =
  | { outcome: "trashed"; account: ChannelAccount }
  | { outcome: "already_trashed"; account: ChannelAccount }
  | { outcome: "not_found" };

/**
 * Menandai akun sebagai di Sampah (Fase 6I): mengisi `trashed_at` +
 * audit `channel.trashed`. PRASYARAT: akun sudah 'disconnected' —
 * pemanggil (route API) menjalankan semantik disconnect penuh lebih
 * dulu (termasuk pencabutan webhook Telegram) persis seperti endpoint
 * DELETE, lalu memanggil fungsi ini; di sini status dipastikan ulang
 * dengan mengosongkan kredensial secara defensif bila masih ada.
 * Mengembalikan outcome diskriminan agar route menjawab jujur
 * (404 / 409 / 200) tanpa menebak.
 */
export async function markChannelAccountTrashed(
  db: Database,
  ctx: DisconnectChannelContext,
  channelAccountId: string,
): Promise<TrashChannelOutcome> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(channelAccounts)
      .where(
        and(
          eq(channelAccounts.tenantId, ctx.tenantId),
          eq(channelAccounts.id, channelAccountId),
        ),
      )
      .limit(1);
    if (!row) return { outcome: "not_found" } as const;
    if (row.trashedAt) return { outcome: "already_trashed", account: row } as const;

    const now = new Date();
    const [updated] = await tx
      .update(channelAccounts)
      .set({
        trashedAt: now,
        status: "disconnected",
        accessTokenEncrypted: null,
        webhookSecret: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(channelAccounts.tenantId, ctx.tenantId),
          eq(channelAccounts.id, channelAccountId),
        ),
      )
      .returning();

    await tx.insert(auditLogs).values({
      tenantId: ctx.tenantId,
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      action: "channel.trashed",
      meta: {
        channelAccountId: row.id,
        provider: row.provider,
        purgeAt: channelPurgeAt(updated)?.toISOString() ?? null,
      },
    });

    return { outcome: "trashed", account: updated } as const;
  });
}

export type RestoreChannelOutcome =
  | { outcome: "restored"; account: ChannelAccount }
  | { outcome: "not_trashed"; account: ChannelAccount }
  | { outcome: "not_found" };

/**
 * Memulihkan akun dari Sampah (Fase 6I): membersihkan `trashed_at`.
 * Status TETAP 'disconnected' — restore tidak pernah menghubungkan
 * ulang secara diam-diam; pemilik menghubungkan lagi secara eksplisit
 * (Telegram: revive lewat form connect; Webchat: channel baru).
 */
export async function restoreChannelAccount(
  db: Database,
  ctx: DisconnectChannelContext,
  channelAccountId: string,
): Promise<RestoreChannelOutcome> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(channelAccounts)
      .where(
        and(
          eq(channelAccounts.tenantId, ctx.tenantId),
          eq(channelAccounts.id, channelAccountId),
        ),
      )
      .limit(1);
    if (!row) return { outcome: "not_found" } as const;
    if (!row.trashedAt) return { outcome: "not_trashed", account: row } as const;

    const [updated] = await tx
      .update(channelAccounts)
      .set({ trashedAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(channelAccounts.tenantId, ctx.tenantId),
          eq(channelAccounts.id, channelAccountId),
        ),
      )
      .returning();

    await tx.insert(auditLogs).values({
      tenantId: ctx.tenantId,
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      action: "channel.restored",
      meta: { channelAccountId: row.id, provider: row.provider },
    });

    return { outcome: "restored", account: updated } as const;
  });
}

export interface ChannelExport {
  format: "sahabat-kreator/channel-export@1";
  exportedAt: string;
  channel: {
    id: string;
    provider: ChannelAccount["provider"];
    externalId: string;
    displayName: string | null;
    botUsername: string | null;
    status: ChannelAccount["status"];
    trashedAt: string | null;
    createdAt: string;
  };
  counts: { conversations: number; messages: number };
  conversations: Array<{
    id: string;
    kind: string;
    title: string | null;
    status: string;
    providerChatId: string | null;
    contact: {
      id: string;
      name: string;
      email: string | null;
      phone: string | null;
    } | null;
    createdAt: string;
    messages: Array<{
      id: string;
      direction: string;
      senderType: string;
      senderName: string | null;
      type: string;
      contentText: string | null;
      providerMessageId: string | null;
      status: string;
      createdAt: string;
    }>;
  }>;
}

/**
 * Ekspor riwayat satu channel (Fase 6I): metadata akun + SEMUA
 * percakapannya + pesan-pesannya (kronologis menaik per percakapan,
 * dengan nama kontak lawan bicara). Berlaku untuk akun aktif maupun di
 * Sampah — inilah jalan keluar data sebelum purge permanen. Menulis
 * audit `channel.exported` dengan meta HITUNGAN saja (isi pesan tidak
 * pernah masuk audit/log). Null bila akun tak ditemukan di tenant ini.
 */
export async function exportChannelAccount(
  db: Database,
  ctx: DisconnectChannelContext,
  channelAccountId: string,
): Promise<ChannelExport | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [account] = await tx
      .select()
      .from(channelAccounts)
      .where(
        and(
          eq(channelAccounts.tenantId, ctx.tenantId),
          eq(channelAccounts.id, channelAccountId),
        ),
      )
      .limit(1);
    if (!account) return null;

    const convs = await tx
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.tenantId, ctx.tenantId),
          eq(conversations.channelAccountId, account.id),
        ),
      )
      .orderBy(asc(conversations.createdAt));

    const contactIds = [...new Set(convs.map((cv) => cv.contactId))];
    const contactRows =
      contactIds.length > 0
        ? await tx
            .select()
            .from(contacts)
            .where(
              and(
                eq(contacts.tenantId, ctx.tenantId),
                inArray(contacts.id, contactIds),
              ),
            )
        : [];
    const contactById = new Map(contactRows.map((ct) => [ct.id, ct]));

    const convIds = convs.map((cv) => cv.id);
    const messageRows =
      convIds.length > 0
        ? await tx
            .select()
            .from(messages)
            .where(
              and(
                eq(messages.tenantId, ctx.tenantId),
                inArray(messages.conversationId, convIds),
              ),
            )
            .orderBy(asc(messages.createdAt))
        : [];
    const messagesByConv = new Map<string, typeof messageRows>();
    for (const m of messageRows) {
      const list = messagesByConv.get(m.conversationId) ?? [];
      list.push(m);
      messagesByConv.set(m.conversationId, list);
    }

    await tx.insert(auditLogs).values({
      tenantId: ctx.tenantId,
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      action: "channel.exported",
      meta: {
        channelAccountId: account.id,
        provider: account.provider,
        conversations: convs.length,
        messages: messageRows.length,
      },
    });

    return {
      format: "sahabat-kreator/channel-export@1",
      exportedAt: new Date().toISOString(),
      channel: {
        id: account.id,
        provider: account.provider,
        externalId: account.externalId,
        displayName: account.displayName,
        botUsername: account.botUsername,
        status: account.status,
        trashedAt: account.trashedAt?.toISOString() ?? null,
        createdAt: account.createdAt.toISOString(),
      },
      counts: { conversations: convs.length, messages: messageRows.length },
      conversations: convs.map((cv) => {
        const contact = contactById.get(cv.contactId);
        return {
          id: cv.id,
          kind: cv.kind,
          title: cv.title,
          status: cv.status,
          providerChatId: cv.providerChatId,
          contact: contact
            ? {
                id: contact.id,
                name: contact.name,
                email: contact.email,
                phone: contact.phone,
              }
            : null,
          createdAt: cv.createdAt.toISOString(),
          messages: (messagesByConv.get(cv.id) ?? []).map((m) => ({
            id: m.id,
            direction: m.direction,
            senderType: m.senderType,
            senderName: m.senderName,
            type: m.type,
            contentText: m.contentText,
            providerMessageId: m.providerMessageId,
            status: m.status,
            createdAt: m.createdAt.toISOString(),
          })),
        };
      }),
    };
  });
}

/** Satu akun channel milik tenant ini (baris penuh, termasuk kredensial
 * terenkripsi — hanya untuk pemakaian server internal seperti disconnect;
 * JANGAN pernah diserialisasi ke respons API). Null bila tak ditemukan. */
export async function getChannelAccount(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  channelAccountId: string,
): Promise<ChannelAccount | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(channelAccounts)
      .where(
        and(
          eq(channelAccounts.tenantId, ctx.tenantId),
          eq(channelAccounts.id, channelAccountId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

export type ChannelAccountLookupRef = Pick<
  ChannelAccount,
  "id" | "tenantId" | "provider" | "externalId" | "status"
>;

/**
 * Lookup akun channel berdasarkan (provider, external_id) di SEMUA tenant
 * — fondasi penjaga "satu bot = satu koneksi" (hotfix Telegram): satu bot
 * Telegram hanya punya SATU webhook, jadi bot yang sama tidak boleh aktif
 * di dua workspace sekaligus.
 *
 * Berjalan TANPA konteks tenant: transaksi men-set `app.channel_provider`
 * + `app.channel_external_id`, dan policy RLS `provider_external_lookup`
 * (migrasi 0020) hanya membuka baris yang (provider, external_id)-nya
 * PERSIS pasangan itu. Pemanggil harus sudah mengetahui external_id dari
 * sumber tepercaya (untuk Telegram: hasil `getMe` atas token yang
 * diserahkan pemilik workspace) — yang terbuka pun hanya id/tenant/status
 * baris itu, dan respons API ke pengguna TIDAK pernah menyebut tenant
 * pemiliknya. Mengembalikan SEMUA baris pasangan itu (termasuk yang
 * 'disconnected', yang tidak menghalangi koneksi baru).
 */
export async function lookupChannelAccountsByProviderExternalId(
  db: Database,
  provider: ChannelProviderName,
  externalId: string,
): Promise<ChannelAccountLookupRef[]> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.channel_provider', ${provider}, true)`,
    );
    await tx.execute(
      sql`SELECT set_config('app.channel_external_id', ${externalId}, true)`,
    );
    return tx
      .select({
        id: channelAccounts.id,
        tenantId: channelAccounts.tenantId,
        provider: channelAccounts.provider,
        externalId: channelAccounts.externalId,
        status: channelAccounts.status,
      })
      .from(channelAccounts)
      .where(
        and(
          eq(channelAccounts.provider, provider),
          eq(channelAccounts.externalId, externalId),
        ),
      );
  });
}

export interface DisconnectChannelContext {
  tenantId: string;
  /** Jejak audit: 'user' untuk aksi dari dashboard, 'system' untuk remediasi. */
  actorType: "user" | "system";
  actorId: string;
}

/**
 * Memutuskan koneksi channel (hotfix Telegram — fitur disconnect):
 * status → 'disconnected' dan kredensial provider DIKOSONGKAN (token
 * terenkripsi + hash secret webhook) agar baris yang tertinggal tidak
 * lagi bisa mengirim/menerima apa pun. Percakapan & pesan TIDAK disentuh
 * — disconnect bukan penghapusan data; riwayat tetap terbaca di inbox.
 *
 * Idempoten: akun yang sudah 'disconnected' dikembalikan apa adanya
 * tanpa audit ganda. Pencabutan webhook di sisi provider (Telegram
 * deleteWebhook) adalah urusan pemanggil SEBELUM fungsi ini, karena
 * hanya pemanggil yang tahu apakah akun ini pemilik webhook saat ini.
 * Mengembalikan null bila akun tak ditemukan di tenant ini.
 */
export async function disconnectChannelAccount(
  db: Database,
  ctx: DisconnectChannelContext,
  channelAccountId: string,
  meta: Record<string, unknown> = {},
): Promise<ChannelAccount | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(channelAccounts)
      .where(
        and(
          eq(channelAccounts.tenantId, ctx.tenantId),
          eq(channelAccounts.id, channelAccountId),
        ),
      )
      .limit(1);
    if (!row) return null;
    if (row.status === "disconnected") return row;

    const [updated] = await tx
      .update(channelAccounts)
      .set({
        status: "disconnected",
        accessTokenEncrypted: null,
        webhookSecret: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(channelAccounts.tenantId, ctx.tenantId),
          eq(channelAccounts.id, channelAccountId),
        ),
      )
      .returning();

    await tx.insert(auditLogs).values({
      tenantId: ctx.tenantId,
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      action: "channel.disconnected",
      meta: {
        channelAccountId: row.id,
        provider: row.provider,
        ...meta,
      },
    });

    return updated;
  });
}

export interface UpdateTelegramCredentialsInput {
  /** Envelope enkripsi token bot baru; null = jangan ubah. */
  encryptedBotToken?: string | null;
  /** Hash SHA-256 secret webhook baru; null = jangan ubah. */
  webhookSecretHash?: string | null;
  botUsername?: string | null;
  displayName?: string | null;
  status?: ChannelAccount["status"];
}

/**
 * Menulis ulang kredensial/status akun Telegram yang SUDAH ada di tenant
 * ini — dipakai jalur "revive" saat connect: akun tenant yang sama
 * berstatus 'disconnected'/'error' dihubungkan lagi tanpa membuat baris
 * duplikat (index unik (tenant, provider, external_id) melarang baris
 * kedua), dan untuk rotasi hash secret webhook. Mengembalikan baris
 * terbaru, atau null bila akun tak ditemukan.
 */
export async function updateTelegramChannelAccountCredentials(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  channelAccountId: string,
  input: UpdateTelegramCredentialsInput,
): Promise<ChannelAccount | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const patch: Partial<ChannelAccount> = { updatedAt: new Date() };
    if (input.encryptedBotToken !== undefined) {
      patch.accessTokenEncrypted = input.encryptedBotToken;
    }
    if (input.webhookSecretHash !== undefined) {
      patch.webhookSecret = input.webhookSecretHash;
    }
    if (input.botUsername !== undefined) patch.botUsername = input.botUsername;
    if (input.displayName !== undefined) {
      patch.displayName = input.displayName;
    }
    if (input.status !== undefined) patch.status = input.status;
    // Menghubungkan lagi = menghidupkan lagi (Fase 6I): baris yang sama
    // tidak boleh hidup kembali sambil tetap berstatus Sampah — akun
    // yang berhasil di-connect ulang selalu keluar dari Sampah.
    if (input.status === "connected") patch.trashedAt = null;

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
