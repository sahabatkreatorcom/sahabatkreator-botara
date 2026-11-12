import { and, asc, desc, eq, ilike, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  auditLogs,
  channelAccounts,
  contacts,
  conversations,
  media,
  messages,
  tenantMembers,
  users,
  whatsappTemplates,
  type Conversation,
  type Database,
  type Message,
} from "@sahabat-kreator/db";
import type { TenantContext } from "./tenant";
import { withTenantDb, type DbTx } from "./tx";
import { outboundClaimStale } from "./outbound-claim";
import {
  computeMessagingWindow,
  type MessagingWindowState,
} from "./messaging-window";
import {
  deriveTemplateParamSpec,
  renderTemplateContent,
} from "./whatsapp-template-params";

/**
 * Service domain percakapan & pesan inbox (Fase 1D, RANCANGAN §5.1 & §6).
 * Transport-agnostic; semua query dalam konteks RLS tenant.
 *
 * Pengiriman outbound dimulai sebagai antrean: pesan dibuat dengan status
 * `queued` + catatan audit `message.queued`. Sejak Fase 1F, lapisan
 * transport (API) mencoba mengirim pesan `queued` untuk channel yang sudah
 * hidup (webchat lewat hub WebSocket) dan menandainya `sent` lewat
 * `markOutboundMessageSent`; channel lain tetap `queued` sampai adapter
 * channel-nya tiba di fase masing-masing.
 */

// ---------------------------------------------------------------------------
// Kutipan balasan / reply quote (Fase 7B.5)
// ---------------------------------------------------------------------------

/** Batas cuplikan teks pesan target pada ringkasan kutipan. */
export const REPLY_TO_PREVIEW_CHARS = 140;

/**
 * Ringkasan pesan yang dikutip — bentuk yang sama persis dengan kontrak
 * API (`MessageReplyToSchema`); resolusi dilakukan di sini, server-side,
 * agar semua permukaan (inbox, API publik v1, webchat) konsisten.
 */
export interface MessageReplyToSummary {
  id: string;
  direction: Message["direction"];
  senderType: Message["senderType"];
  type: Message["type"];
  /** Nama pengirim target bila diketahui; null → UI memakai label cadangan per arah. */
  authorLabel: string | null;
  /** Teks target terpotong; null untuk non-teks tanpa caption. */
  contentPreview: string | null;
}

/** Baris pesan + ringkasan kutipannya yang sudah teresolusi. */
export interface MessageWithReplyTo extends Message {
  replyTo: MessageReplyToSummary | null;
}

/**
 * Menerjemahkan kolom `reply_to_message_id` sekumpulan baris pesan
 * menjadi ringkasan kutipan, dalam transaksi tenant yang sedang berjalan
 * (RLS menegakkan isolasi — target milik tenant lain tidak akan pernah
 * terbaca di sini). Satu query batch untuk semua target + nama kontak
 * (pesan masuk) dan nama user (pesan keluar dari dashboard) seperlunya.
 * Target yang tidak ditemukan (sudah terhapus → FK SET NULL sebenarnya
 * sudah men-null-kan kolomnya; ini jaring pengaman) menghasilkan null.
 */
async function attachReplyToSummaries(
  tx: DbTx,
  tenantId: string,
  rows: Message[],
): Promise<MessageWithReplyTo[]> {
  const targetIds = [
    ...new Set(
      rows
        .map((r) => r.replyToMessageId)
        .filter((v): v is string => v !== null),
    ),
  ];
  if (targetIds.length === 0) {
    return rows.map((r) => ({ ...r, replyTo: null }));
  }
  const targets = await tx
    .select({
      id: messages.id,
      conversationId: messages.conversationId,
      direction: messages.direction,
      senderType: messages.senderType,
      senderName: messages.senderName,
      type: messages.type,
      contentText: messages.contentText,
      sentByUserId: messages.sentByUserId,
    })
    .from(messages)
    .where(
      and(eq(messages.tenantId, tenantId), inArray(messages.id, targetIds)),
    );

  // Label penulis: sender_name (grup) menang; pesan masuk lain → nama
  // kontak percakapan target; pesan keluar dashboard → nama user
  // pengirim (jatuh ke email bila nama kosong, pola audit-log 7B.4).
  const contactConvIds = [
    ...new Set(
      targets
        .filter((t) => t.direction === "inbound" && !t.senderName)
        .map((t) => t.conversationId),
    ),
  ];
  const contactNameByConversation = new Map<string, string>();
  if (contactConvIds.length > 0) {
    const convRows = await tx
      .select({ id: conversations.id, contactName: contacts.name })
      .from(conversations)
      .innerJoin(contacts, eq(conversations.contactId, contacts.id))
      .where(
        and(
          eq(conversations.tenantId, tenantId),
          inArray(conversations.id, contactConvIds),
        ),
      );
    for (const r of convRows) {
      contactNameByConversation.set(r.id, r.contactName);
    }
  }
  const senderUserIds = [
    ...new Set(
      targets
        .map((t) => t.sentByUserId)
        .filter((v): v is string => v !== null),
    ),
  ];
  const userLabelById = new Map<string, string>();
  if (senderUserIds.length > 0) {
    const userRows = await tx
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(inArray(users.id, senderUserIds));
    for (const u of userRows) {
      userLabelById.set(u.id, u.name?.trim() ? u.name : u.email);
    }
  }

  const targetById = new Map(targets.map((t) => [t.id, t]));
  return rows.map((r) => {
    const target = r.replyToMessageId
      ? targetById.get(r.replyToMessageId)
      : undefined;
    if (!target) return { ...r, replyTo: null };
    const authorLabel =
      target.senderName ??
      (target.direction === "inbound"
        ? (contactNameByConversation.get(target.conversationId) ?? null)
        : target.sentByUserId
          ? (userLabelById.get(target.sentByUserId) ?? null)
          : null);
    return {
      ...r,
      replyTo: {
        id: target.id,
        direction: target.direction,
        senderType: target.senderType,
        type: target.type,
        authorLabel,
        contentPreview: target.contentText
          ? target.contentText.slice(0, REPLY_TO_PREVIEW_CHARS)
          : null,
      },
    };
  });
}

/**
 * Varian publik `attachReplyToSummaries` untuk pemanggil yang memegang
 * baris pesan di luar transaksi daftar (mis. sesi webchat yang membaca
 * riwayatnya sendiri di core webchat.ts): membuka transaksi tenant
 * sendiri. Baris dari tenant lain tidak akan teresolusi (RLS).
 */
export async function withReplyToSummaries(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  rows: Message[],
): Promise<MessageWithReplyTo[]> {
  if (rows.length === 0) return [];
  return withTenantDb(db, ctx.tenantId, (tx) =>
    attachReplyToSummaries(tx, ctx.tenantId, rows),
  );
}

/**
 * `provider_message_id` satu pesan dalam konteks tenant pemiliknya —
 * dipakai poller pengiriman untuk MENURUNKAN id provider pesan yang
 * dikutip dari baris targetnya saat kirim (Fase 7B.5: id provider
 * kutipan tidak pernah disimpan duplikat). Null bila pesan tak ada.
 */
export async function getMessageProviderMessageId(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  messageId: string,
): Promise<string | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select({ providerMessageId: messages.providerMessageId })
      .from(messages)
      .where(
        and(eq(messages.tenantId, ctx.tenantId), eq(messages.id, messageId)),
      )
      .limit(1);
    return row?.providerMessageId ?? null;
  });
}

/**
 * Resolusi target kutipan PESAN MASUK (Fase 7B.5): dari id majemuk
 * provider pesan yang dikutip, temukan barisnya DI PERCAKAPAN YANG SAMA.
 * Dipakai jalur pencatatan masuk telegram/meta/whatsapp di dalam
 * transaksi tenant mereka. Target tak ditemukan (belum tercatat, milik
 * percakapan lain, atau kutipan ke pesan yang sudah terhapus) → null:
 * pesan masuk TETAP tercatat tanpa tautan — kutipan asing tidak boleh
 * menggagalkan webhook.
 */
export async function resolveInboundReplyTargetId(
  tx: DbTx,
  conversationId: string,
  compositeProviderMessageId: string,
): Promise<string | null> {
  const [target] = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.providerMessageId, compositeProviderMessageId),
        eq(messages.conversationId, conversationId),
      ),
    )
    .limit(1);
  return target?.id ?? null;
}

/**
 * Segmen mentah id pesan dari `provider_message_id` MAJEMUK kita
 * (`telegram:<botId>:<message_id>`, `meta:<accountId>:<mid|wamid>`):
 * semua sesudah titik dua KEDUA adalah id mentah provider (id mentah
 * sendiri boleh memuat titik dua — pemotongan dibatasi dua segmen
 * pertama). Null bila bentuknya tidak dikenal.
 */
export function extractRawProviderMessageId(
  composite: string | null,
): string | null {
  if (!composite) return null;
  const first = composite.indexOf(":");
  if (first < 0) return null;
  const second = composite.indexOf(":", first + 1);
  if (second < 0) return null;
  const raw = composite.slice(second + 1);
  return raw.length > 0 ? raw : null;
}

/**
 * Escape metakarakter LIKE (`\`, `%`, `_`) pada masukan pengguna.
 *
 * Tanpa ini, mencari "%" akan mencocokkan SEMUA percakapan dan mencari
 * "a_b" akan mencocokkan "axb" — hasil yang salah tanpa pesan apa pun.
 * `ESCAPE '\'` adalah default Postgres, jadi cukup awali dengan backslash.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export interface ConversationWithSummary extends Conversation {
  contactName: string;
  /**
   * Label tampil penerima tugas (Fase 9C): nama user penerima tugas,
   * jatuh ke email bila namanya kosong; null bila belum ditugaskan.
   * Diresolusi di query daftar (left join `users` global) agar UI tidak
   * perlu memetakan assigneeUserId ke daftar member sendiri.
   */
  assigneeName: string | null;
  /**
   * Percakapan grup (Fase 6A.1; sejak 6A.2 diturunkan dari kolom `kind`,
   * bukan lagi kehadiran `title`). UI menampilkan `title ?? contactName`
   * sebagai nama tampilan.
   */
  isGroup: boolean;
  /**
   * Percakapan channel siaran (Fase 6A.2, `kind === 'channel'`):
   * linimasa postingan satu arah. Untuk baris seperti ini `unreadCount`
   * SELALU dilaporkan 0 — postingan channel bukan antrean kerja agen,
   * apa pun nilai kolomnya di DB.
   */
  isChannel: boolean;
  lastMessagePreview: string | null;
  lastMessageDirection: Message["direction"] | null;
  /**
   * Waktu pesan MASUK terakhir dari kontak (Fase 16C) — dasar jendela
   * 24 jam WhatsApp. Sengaja terpisah dari `lastMessageAt` yang bisa
   * berisi pesan KELUAR: balasan kita sendiri tidak membuka jendela.
   * null bila kontak belum pernah menulis.
   */
  lastInboundAt: Date | null;
}

/**
 * `max(created_at)` dikembalikan driver sebagai Date, tetapi PGlite
 * (dipakai `db verify`) dan sebagian build pg mengembalikan string.
 * Normalisasi di satu tempat agar perbandingan jendela tidak pernah
 * diam-diam salah karena tipe.
 */
function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/**
 * Waktu pesan MASUK terakhir di satu percakapan, di dalam transaksi yang
 * sudah berjalan. Dipakai jalur antre (Fase 16C) supaya pemeriksaan
 * jendela dan insert pesan berada di transaksi yang sama — tidak ada
 * jendela balapan di antaranya.
 */
async function lastInboundAtInTx(
  tx: DbTx,
  tenantId: string,
  conversationId: string,
): Promise<Date | null> {
  const [row] = await tx
    .select({
      lastInboundAt: sql<Date | string | null>`max(${messages.createdAt})`,
    })
    .from(messages)
    .where(
      and(
        eq(messages.tenantId, tenantId),
        eq(messages.conversationId, conversationId),
        eq(messages.direction, "inbound"),
      ),
    );
  return toDate(row?.lastInboundAt ?? null);
}

/**
 * Jenis percakapan sebagaimana dimodelkan kolom `kind` (cek DB:
 * `conversations_kind_valid`). `private` = DM satu-lawan-satu, `group` =
 * grup, `channel` = linimasa siaran satu arah milik akun channel
 * (sasaran postingan, BUKAN percakapan pesan).
 */
export type ConversationKind = "private" | "group" | "channel";

/**
 * Himpunan kind PERCAKAPAN PESAN — yang lahir dari ingest pesan (Meta
 * WhatsApp/Messenger/Instagram DM, Telegram, Webchat) dan menjadi isi
 * Inbox. Dipakai permukaan Inbox sebagai saringan `kinds` pada
 * `listConversations`: baris `channel` adalah sasaran linimasa
 * postingan (dikelola dari /posts & Siaran), bukan utas pesan, jadi
 * tidak tampil di Inbox — termasuk baris channel milik akun campuran
 * seperti Instagram (DM-nya tetap tampil; baris channel-nya tidak).
 * Pemanggil non-Inbox (API publik v1) TIDAK meneruskan saringan ini
 * dan mempertahankan perilaku lama persis.
 */
export const MESSAGE_CONVERSATION_KINDS: readonly ConversationKind[] = [
  "private",
  "group",
];

export async function listConversations(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  input: {
    status?: Conversation["status"];
    /**
     * Saringan jenis percakapan: hanya kind yang disebutkan yang
     * dikembalikan. Tanpa opsi ini (atau larik kosong) SEMUA kind
     * dikembalikan — perilaku lama untuk pemanggil non-Inbox (API
     * publik v1). Permukaan Inbox meneruskan
     * `MESSAGE_CONVERSATION_KINDS` agar baris `channel` tidak tampil.
     */
    kinds?: readonly ConversationKind[];
    /**
     * Filter penugasan (Fase 9C): `mine` = hanya yang ditugaskan ke
     * `assignmentUserId` (user sesi — wajib disertakan pemanggil),
     * `unassigned` = hanya yang assignee_user_id-nya NULL. Tanpa filter
     * = semua (perilaku lama).
     */
    assignment?: "mine" | "unassigned";
    assignmentUserId?: string;
    /**
     * Pencarian teks (Fase 16C): nama kontak, nomor telepon, atau judul
     * percakapan (grup/channel). Sebelum ini inbox hanya bisa DIGULIR —
     * tidak ada cara menemukan satu kontak di antara ratusan.
     *
     * Dicocokkan dengan `ILIKE '%q%'` sehingga metakarakter LIKE pada
     * masukan pengguna (`%`, `_`, `\`) di-escape lebih dulu; tanpa itu
     * satu karakter `%` akan mencocokkan semua baris dan hasilnya
     * menyesatkan, bukan sekadar kosong.
     */
    search?: string;
  },
): Promise<ConversationWithSummary[]> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const conditions = [eq(conversations.tenantId, ctx.tenantId)];
    if (input.status) conditions.push(eq(conversations.status, input.status));
    if (input.kinds && input.kinds.length > 0) {
      conditions.push(inArray(conversations.kind, [...input.kinds]));
    }
    if (input.assignment === "mine" && input.assignmentUserId) {
      conditions.push(eq(conversations.assigneeUserId, input.assignmentUserId));
    } else if (input.assignment === "unassigned") {
      conditions.push(isNull(conversations.assigneeUserId));
    }
    const needle = input.search?.trim();
    if (needle) {
      const pattern = `%${escapeLikePattern(needle)}%`;
      const match = or(
        ilike(contacts.name, pattern),
        ilike(contacts.phone, pattern),
        ilike(conversations.title, pattern),
      );
      if (match) conditions.push(match);
    }
    const rows = await tx
      .select({
        conversation: conversations,
        contactName: contacts.name,
        assigneeName: users.name,
        assigneeEmail: users.email,
      })
      .from(conversations)
      .innerJoin(contacts, eq(conversations.contactId, contacts.id))
      // Fase 9C: label penerima tugas — `users` tabel global tanpa RLS,
      // left join agar percakapan tanpa penugasan tetap muncul.
      .leftJoin(users, eq(conversations.assigneeUserId, users.id))
      // Fase 6I: percakapan milik channel yang sedang di Sampah hilang
      // dari inbox (kontaknya sendiri tetap ada di CRM) sampai channel
      // dipulihkan atau di-purge permanen.
      .innerJoin(
        channelAccounts,
        eq(conversations.channelAccountId, channelAccounts.id),
      )
      .where(and(...conditions, isNull(channelAccounts.trashedAt)))
      .orderBy(desc(conversations.lastMessageAt), desc(conversations.createdAt));

    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.conversation.id);

    // Pesan TERAKHIR per percakapan (Fase 16C). Sebelumnya query ini
    // mengambil SELURUH pesan tenant lalu menyaringnya di memori — biaya
    // yang tumbuh seumur workspace pada setiap muat/poll inbox. Window
    // function memindahkan penyaringan ke database: satu baris per
    // percakapan, bukan satu baris per pesan. `id` ikut jadi kunci urut
    // agar pesan bertimestamp sama tidak membuat urutan tak deterministik.
    const ranked = tx
      .select({
        conversationId: messages.conversationId,
        contentText: messages.contentText,
        direction: messages.direction,
        rowNumber:
          sql<number>`row_number() over (partition by ${messages.conversationId} order by ${messages.createdAt} desc, ${messages.id} desc)`.as(
            "row_number",
          ),
      })
      .from(messages)
      .where(
        and(
          eq(messages.tenantId, ctx.tenantId),
          inArray(messages.conversationId, ids),
        ),
      )
      .as("ranked_messages");

    const lastRows = await tx
      .select()
      .from(ranked)
      .where(eq(ranked.rowNumber, 1));
    const lastByConversation = new Map(
      lastRows.map((row) => [row.conversationId, row]),
    );

    // Pesan MASUK terakhir per percakapan (Fase 16C) — dasar jendela 24
    // jam. Satu agregat untuk seluruh halaman, bukan satu query per baris.
    const inboundRows = await tx
      .select({
        conversationId: messages.conversationId,
        lastInboundAt: sql<Date | string | null>`max(${messages.createdAt})`,
      })
      .from(messages)
      .where(
        and(
          eq(messages.tenantId, ctx.tenantId),
          inArray(messages.conversationId, ids),
          eq(messages.direction, "inbound"),
        ),
      )
      .groupBy(messages.conversationId);
    const lastInboundByConversation = new Map(
      inboundRows.map((row) => [row.conversationId, toDate(row.lastInboundAt)]),
    );

    return rows.map((r) => {
      const last = lastByConversation.get(r.conversation.id);
      const isChannel = r.conversation.kind === "channel";
      return {
        ...r.conversation,
        contactName: r.contactName,
        assigneeName:
          r.conversation.assigneeUserId !== null
            ? (r.assigneeName ?? r.assigneeEmail ?? null)
            : null,
        isGroup: r.conversation.kind === "group",
        isChannel,
        // Channel: unread ditegakkan 0 di permukaan API (Fase 6A.2) —
        // jalur ingest channel memang tidak pernah menaikkannya, dan
        // penegakan ini menjaga badge tetap benar apa pun datanya.
        unreadCount: isChannel ? 0 : r.conversation.unreadCount,
        lastMessagePreview: last?.contentText ?? null,
        lastMessageDirection: last?.direction ?? null,
        lastInboundAt: lastInboundByConversation.get(r.conversation.id) ?? null,
      };
    });
  });
}

export type AssignConversationResult =
  | { kind: "assigned"; conversation: Conversation }
  | { kind: "conversation_not_found" }
  | { kind: "assignee_not_member" };

/**
 * Menetapkan / melepas penerima tugas percakapan (Fase 9C).
 *
 * Aturan (ditegakkan DI SINI):
 * - Percakapan harus milik tenant ini (selain itu `conversation_not_found`
 *   → 404 di API; isolation RLS + filter tenant ganda).
 * - Penerima (bila tidak null) harus MEMBER tenant ini — dicek dari
 *   `tenant_members` dalam konteks tenant yang sama; user yang ada tapi
 *   bukan member (atau tidak ada sama sekali) → `assignee_not_member`.
 * - Penugasan TIDAK menyentuh `agent_enabled`: siapa yang menangani dan
 *   apakah AI boleh menjawab adalah dua sumbu terpisah (handoff tetap
 *   milik kolom agent_enabled).
 * Audit `conversation.assigned` / `conversation.unassigned` ditulis dalam
 * transaksi yang sama, meta berisi id saja (tanpa nama/email).
 */
export async function assignConversation(
  db: Database,
  ctx: Pick<TenantContext, "tenantId" | "userId"> & { userId: string },
  conversationId: string,
  assigneeUserId: string | null,
): Promise<AssignConversationResult> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [conv] = await tx
      .select({
        id: conversations.id,
        assigneeUserId: conversations.assigneeUserId,
      })
      .from(conversations)
      .where(
        and(
          eq(conversations.tenantId, ctx.tenantId),
          eq(conversations.id, conversationId),
        ),
      )
      .limit(1);
    if (!conv) return { kind: "conversation_not_found" } as const;

    if (assigneeUserId !== null) {
      const [member] = await tx
        .select({ id: tenantMembers.id })
        .from(tenantMembers)
        .where(
          and(
            eq(tenantMembers.tenantId, ctx.tenantId),
            eq(tenantMembers.userId, assigneeUserId),
          ),
        )
        .limit(1);
      if (!member) return { kind: "assignee_not_member" } as const;
    }

    const [updated] = await tx
      .update(conversations)
      .set({ assigneeUserId, updatedAt: new Date() })
      .where(
        and(
          eq(conversations.tenantId, ctx.tenantId),
          eq(conversations.id, conversationId),
        ),
      )
      .returning();
    await tx.insert(auditLogs).values({
      tenantId: ctx.tenantId,
      actorType: "user",
      actorId: ctx.userId,
      action:
        assigneeUserId === null
          ? "conversation.unassigned"
          : "conversation.assigned",
      meta: {
        conversationId,
        assigneeUserId,
        previousAssigneeUserId: conv.assigneeUserId,
      },
    });
    return { kind: "assigned", conversation: updated } as const;
  });
}

export type UpdateConversationResult =
  | { kind: "updated"; conversation: Conversation }
  | { kind: "conversation_not_found" };

/**
 * Mengubah status kerja percakapan (Fase 16C).
 *
 * Sebelum ini `status` hanya bisa DIBACA: daftar bisa difilter
 * `open|pending|closed`, tetapi tidak ada jalan menutup percakapan —
 * sehingga filter "closed" selalu kosong dan alur "selesai" tidak ada.
 *
 * Status TIDAK menyentuh `agent_enabled`: menutup percakapan bukan
 * mematikan AI, dan membuka kembali bukan menyalakannya. Dua sumbu
 * terpisah, sama seperti penugasan (Fase 9C).
 *
 * Idempoten: menulis status yang sama tidak menghasilkan baris audit
 * palsu — audit hanya ditulis saat nilainya benar-benar berubah.
 */
export async function setConversationStatus(
  db: Database,
  ctx: Pick<TenantContext, "tenantId" | "userId"> & { userId: string },
  conversationId: string,
  status: Conversation["status"],
): Promise<UpdateConversationResult> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [conv] = await tx
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.tenantId, ctx.tenantId),
          eq(conversations.id, conversationId),
        ),
      )
      .limit(1);
    if (!conv) return { kind: "conversation_not_found" } as const;
    if (conv.status === status) {
      return { kind: "updated", conversation: conv } as const;
    }

    const [updated] = await tx
      .update(conversations)
      .set({ status, updatedAt: new Date() })
      .where(
        and(
          eq(conversations.tenantId, ctx.tenantId),
          eq(conversations.id, conversationId),
        ),
      )
      .returning();
    if (!updated) return { kind: "conversation_not_found" } as const;

    await tx.insert(auditLogs).values({
      tenantId: ctx.tenantId,
      actorType: "user",
      actorId: ctx.userId,
      action: "conversation.status_changed",
      meta: { conversationId, from: conv.status, to: status },
    });
    return { kind: "updated", conversation: updated } as const;
  });
}

/**
 * Menyalakan/mematikan AI untuk satu percakapan (Fase 16C).
 *
 * MASALAH YANG DITUTUP: `agent_enabled` sebelumnya hanya pernah ditulis
 * `false` — oleh node `handoff` flow dan tool `handoff_to_human` agent.
 * Tidak ada satu pun jalur yang mengembalikannya ke `true`, jadi satu
 * handoff mematikan AI untuk kontak itu PERMANEN; satu-satunya jalan
 * adalah mengubah baris DB langsung. Endpoint ini menutup lubang itu.
 *
 * Audit mencatat arah perubahan (`conversation.agent_enabled` /
 * `conversation.agent_disabled`) beserta nilai sebelumnya, sehingga
 * "kenapa AI diam?" bisa dijawab dari riwayat — pertanyaan yang sekarang
 * tidak bisa dijawab siapa pun.
 */
export async function setConversationAgentEnabled(
  db: Database,
  ctx: Pick<TenantContext, "tenantId" | "userId"> & { userId: string },
  conversationId: string,
  agentEnabled: boolean,
): Promise<UpdateConversationResult> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [conv] = await tx
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.tenantId, ctx.tenantId),
          eq(conversations.id, conversationId),
        ),
      )
      .limit(1);
    if (!conv) return { kind: "conversation_not_found" } as const;
    if (conv.agentEnabled === agentEnabled) {
      return { kind: "updated", conversation: conv } as const;
    }

    const [updated] = await tx
      .update(conversations)
      .set({ agentEnabled, updatedAt: new Date() })
      .where(
        and(
          eq(conversations.tenantId, ctx.tenantId),
          eq(conversations.id, conversationId),
        ),
      )
      .returning();
    if (!updated) return { kind: "conversation_not_found" } as const;

    await tx.insert(auditLogs).values({
      tenantId: ctx.tenantId,
      actorType: "user",
      actorId: ctx.userId,
      action: agentEnabled
        ? "conversation.agent_enabled"
        : "conversation.agent_disabled",
      meta: {
        conversationId,
        previousAgentEnabled: conv.agentEnabled,
      },
    });
    return { kind: "updated", conversation: updated } as const;
  });
}

/** Null bila percakapan tidak ada DI tenant ini (API menerjemahkan ke 404). */
export async function getConversation(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  conversationId: string,
): Promise<Conversation | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.tenantId, ctx.tenantId),
          eq(conversations.id, conversationId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

/**
 * Pesan-pesan satu percakapan, kronologis menaik. `limit` mengambil N pesan
 * TERAKHIR lalu mengembalikannya dalam urutan kronologis. Setiap baris
 * membawa ringkasan kutipannya yang sudah teresolusi (Fase 7B.5).
 * Null bila percakapan bukan milik tenant ini.
 */
export type MessagePageResult =
  | { kind: "ok"; messages: MessageWithReplyTo[]; hasMore: boolean }
  | { kind: "conversation_not_found" }
  /**
   * `before` diberikan tetapi bukan pesan di percakapan ini. Dibedakan
   * dari "tidak ada pesan lama" supaya UI tidak diam-diam menampilkan
   * "sudah sampai awal" padahal kursornya salah.
   */
  | { kind: "invalid_cursor" };

/**
 * Satu halaman pesan (Fase 16C) — N pesan TERAKHIR, atau N pesan tepat
 * SEBELUM `before`, kronologis menaik.
 *
 * `hasMore` dihitung dengan mengambil `limit + 1` baris lalu memotongnya:
 * satu query, dan nilainya pasti (bukan tebakan "penuh berarti masih
 * ada" yang memberi positif palsu saat jumlah pesan tepat sama dengan
 * limit).
 */
export async function listMessagesPage(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  conversationId: string,
  input: { limit: number; before?: string },
): Promise<MessagePageResult> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [conv] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.tenantId, ctx.tenantId),
          eq(conversations.id, conversationId),
        ),
      )
      .limit(1);
    if (!conv) return { kind: "conversation_not_found" } as const;

    const conditions = [
      eq(messages.tenantId, ctx.tenantId),
      eq(messages.conversationId, conversationId),
    ];

    if (input.before) {
      // Kursor komposit (created_at, id): Postgres membandingkan baris
      // secara leksikografis. Memakai created_at saja MELEWATKAN pesan
      // yang bertimestamp sama dengan kursor (webhook beruntun & ingest
      // massal memang berbagi timestamp); memakai id saja salah urutan.
      const [cursor] = await tx
        .select({ createdAt: messages.createdAt, id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.tenantId, ctx.tenantId),
            eq(messages.conversationId, conversationId),
            eq(messages.id, input.before),
          ),
        )
        .limit(1);
      if (!cursor) return { kind: "invalid_cursor" } as const;
      conditions.push(
        sql`(${messages.createdAt}, ${messages.id}) < (${cursor.createdAt}, ${cursor.id})`,
      );
    }

    const rows = await tx
      .select()
      .from(messages)
      .where(and(...conditions))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(input.limit + 1);
    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    return {
      kind: "ok",
      messages: await attachReplyToSummaries(tx, ctx.tenantId, page.reverse()),
      hasMore,
    } as const;
  });
}

/**
 * Pesan-pesan satu percakapan, kronologis menaik. `limit` mengambil N pesan
 * TERAKHIR lalu mengembalikannya dalam urutan kronologis. Setiap baris
 * membawa ringkasan kutipannya yang sudah teresolusi (Fase 7B.5).
 * Null bila percakapan bukan milik tenant ini.
 *
 * Pembungkus tipis `listMessagesPage` untuk pemanggil yang hanya butuh
 * larik (agent runtime, webchat, SDK) — perilakunya tidak berubah.
 */
export async function listMessages(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  conversationId: string,
  input: { limit: number },
): Promise<MessageWithReplyTo[] | null> {
  const page = await listMessagesPage(db, ctx, conversationId, input);
  return page.kind === "ok" ? page.messages : null;
}

/**
 * Menandai percakapan sebagai sudah dibaca pemilik (unread_count → 0).
 * Dipanggil lapisan transport saat manusia MEMBUKA utas dari inbox —
 * membuka percakapan adalah tindakan membaca; tanpa ini badge unread
 * tidak pernah bersih (bug QA-1: unread hanya pernah naik dari pesan
 * masuk webchat, tidak pernah turun). Jalur agent (agent-runtime)
 * sengaja TIDAK lewat sini: agent membaca riwayat bukan berarti pemilik
 * sudah membaca. No-op senyap bila percakapan bukan milik tenant ini.
 */
export async function markConversationRead(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  conversationId: string,
): Promise<void> {
  await withTenantDb(db, ctx.tenantId, async (tx) => {
    await tx
      .update(conversations)
      .set({ unreadCount: 0 })
      .where(
        and(
          eq(conversations.tenantId, ctx.tenantId),
          eq(conversations.id, conversationId),
        ),
      );
  });
}

/** Pelaku pembuatan pesan outbound — menentukan jejak audit & kolom pengirim. */
interface OutboundMessageActor {
  /** actor_type audit: 'user' (dashboard) atau 'api_key' (API publik /v1, Fase 5A). */
  auditActorType: "user" | "api_key";
  /** actor_id audit: id user dashboard, atau id baris api_keys. */
  auditActorId: string;
  /** Terisi hanya untuk pesan dari dashboard; pesan API key tidak punya user. */
  sentByUserId: string | null;
  auditMetaExtra?: Record<string, unknown>;
}

/**
 * Hasil antrean pesan outbound (Fase 7B.5 memperluas kembalian null-able
 * lama menjadi union berdiskriminasi agar penolakan target kutipan bisa
 * dibedakan dari percakapan tak ditemukan):
 * - `queued`: pesan terbuat; barisnya membawa ringkasan kutipan teresolusi.
 * - `conversation_not_found`: percakapan bukan milik tenant ini → 404.
 * - `reply_target_invalid`: `replyToMessageId` diberikan tetapi targetnya
 *   tidak ada / milik tenant lain / berada di percakapan LAIN → 422
 *   MESSAGE_REPLY_TARGET_INVALID. TIDAK ada tulisan apa pun.
 * - `messaging_window_closed` (Fase 16C): provider berjendela (WhatsApp)
 *   dan pesan masuk terakhir dari kontak lebih dari 24 jam lalu. Provider
 *   akan menolaknya, jadi kita menolak LEBIH DULU dengan alasan yang bisa
 *   dibaca pengguna. TIDAK ada tulisan apa pun.
 */
export type QueueOutboundMessageResult =
  | { kind: "queued"; message: MessageWithReplyTo }
  | { kind: "conversation_not_found" }
  | { kind: "reply_target_invalid" }
  | { kind: "messaging_window_closed"; window: MessagingWindowState }
  /** Lampiran yang ditunjuk tidak ada di workspace ini (atau milik tenant lain). */
  | { kind: "media_not_found" }
  /** Jenis berkas tidak bisa dikirim sebagai media (mis. text/csv). */
  | { kind: "media_type_unsupported"; mimeType: string | null };

/**
 * Jenis pesan media dari MIME berkas (Fase 18B).
 *
 * Dipetakan ke empat tipe yang dikenal Cloud API — image, audio, video,
 * document. Selain itu jatuh ke `document`, yang memang menerima berkas
 * apa pun; jadi tidak ada unggahan yang "hilang" hanya karena MIME-nya
 * tidak masuk daftar pendek.
 */
export function messageTypeForMime(
  mimeType: string | null,
): "image" | "audio" | "video" | "document" {
  const mime = (mimeType ?? "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "document";
}

async function queueOutboundMessageWithActor(
  db: Database,
  tenantId: string,
  conversationId: string,
  input: {
    contentText: string | null;
    replyToMessageId?: string;
    /** Lampiran (Fase 18B). Bila ada, `contentText` menjadi caption. */
    media?: { id: string; mimeType: string | null };
  },
  actor: OutboundMessageActor,
): Promise<QueueOutboundMessageResult> {
  return withTenantDb(db, tenantId, async (tx) => {
    const [conv] = await tx
      .select({ id: conversations.id, provider: conversations.provider })
      .from(conversations)
      .where(
        and(
          eq(conversations.tenantId, tenantId),
          eq(conversations.id, conversationId),
        ),
      )
      .limit(1);
    if (!conv) return { kind: "conversation_not_found" } as const;

    // Validasi target kutipan (Fase 7B.5): harus ada DI TENANT INI (RLS
    // sudah menyembunyikan milik tenant lain dari SELECT ini) dan di
    // PERCAKAPAN YANG SAMA. Pemeriksaan di dalam transaksi yang sama
    // dengan insert — tidak ada jendela balapan di antaranya.
    if (input.replyToMessageId) {
      const [target] = await tx
        .select({
          id: messages.id,
          conversationId: messages.conversationId,
        })
        .from(messages)
        .where(
          and(
            eq(messages.tenantId, tenantId),
            eq(messages.id, input.replyToMessageId),
          ),
        )
        .limit(1);
      if (!target || target.conversationId !== conversationId) {
        return { kind: "reply_target_invalid" } as const;
      }
    }

    // Jendela pesan bebas (Fase 16C). Ditegakkan SEBELUM insert supaya
    // tidak ada pesan `queued` yang pasti gagal di provider. Berlaku juga
    // untuk jalur API publik: aturannya milik Meta, bukan milik UI.
    const messagingWindow = computeMessagingWindow(
      conv.provider,
      await lastInboundAtInTx(tx, tenantId, conversationId),
    );
    if (!messagingWindow.open) {
      return { kind: "messaging_window_closed", window: messagingWindow } as const;
    }

    // Lampiran harus benar-benar ada di workspace ini. Diperiksa di
    // dalam transaksi yang sama dengan insert: tanpa ini, id media
    // sembarang menghasilkan pesan `queued` yang gagal di poller —
    // kegagalan yang baru terlihat sebagai `failed` tanpa sebab.
    let messageType: Message["type"] = "text";
    if (input.media) {
      const [owned] = await tx
        .select({ id: media.id })
        .from(media)
        .where(and(eq(media.tenantId, tenantId), eq(media.id, input.media.id)))
        .limit(1);
      if (!owned) return { kind: "media_not_found" } as const;
      messageType = messageTypeForMime(input.media.mimeType);
    }

    const [message] = await tx
      .insert(messages)
      .values({
        tenantId,
        conversationId,
        direction: "outbound",
        senderType: "user",
        type: messageType,
        contentText: input.contentText,
        mediaId: input.media?.id ?? null,
        status: "queued",
        sentByUserId: actor.sentByUserId,
        replyToMessageId: input.replyToMessageId ?? null,
      })
      .returning();

    const now = new Date();
    await tx
      .update(conversations)
      .set({ lastMessageAt: now, updatedAt: now })
      .where(eq(conversations.id, conversationId));

    await tx.insert(auditLogs).values({
      tenantId,
      actorType: actor.auditActorType,
      actorId: actor.auditActorId,
      action: "message.queued",
      meta: {
        conversationId,
        messageId: message.id,
        stub: true,
        ...(input.media ? { mediaId: input.media.id } : {}),
        ...(input.replyToMessageId
          ? { replyToMessageId: input.replyToMessageId }
          : {}),
        ...actor.auditMetaExtra,
      },
    });

    const [withReply] = await attachReplyToSummaries(tx, tenantId, [message]);
    return { kind: "queued", message: withReply } as const;
  });
}

/**
 * Membuat pesan outbound manual dari inbox (fondasi balasan manusia):
 * baris `messages` (direction=outbound, sender_type=user, status=queued),
 * memperbarui `conversations.last_message_at`, dan menulis audit
 * `message.queued` — semua dalam SATU transaksi tenant. Hasilnya union
 * `QueueOutboundMessageResult` (Fase 7B.5): lapisan API memetakan
 * `conversation_not_found` → 404 dan `reply_target_invalid` → 422.
 */
export async function queueOutboundMessage(
  db: Database,
  ctx: Pick<TenantContext, "tenantId" | "userId"> & { userId: string },
  conversationId: string,
  input: { contentText: string; replyToMessageId?: string },
): Promise<QueueOutboundMessageResult> {
  return queueOutboundMessageWithActor(db, ctx.tenantId, conversationId, input, {
    auditActorType: "user",
    auditActorId: ctx.userId,
    sentByUserId: ctx.userId,
  });
}

/**
 * Mengantrekan pesan BERLAMPIRAN dari inbox (Fase 18B).
 *
 * Jalur ini menutup sisi lain dari Fase 18A: pelanggan bisa mengirim
 * foto, tetapi agen tidak bisa membalas dengan foto, PDF, atau voice
 * note sama sekali — `sendMessage` di kanal WhatsApp hanya punya
 * `sendTextMessage`.
 *
 * `contentText` menjadi CAPTION, bukan teks terpisah: Cloud API
 * menempelkan caption pada objek media, dan mengirim keduanya sebagai
 * dua pesan akan terlihat sebagai dua gelembung.
 *
 * Jendela 24 jam tetap ditegakkan lewat jalur yang sama dengan teks
 * biasa — media bebas juga pesan bebas, jadi aturan Meta berlaku sama.
 */
export async function queueMediaMessage(
  db: Database,
  ctx: Pick<TenantContext, "tenantId"> & { userId: string },
  conversationId: string,
  input: { mediaId: string; caption?: string; replyToMessageId?: string },
): Promise<QueueOutboundMessageResult> {
  // MIME dibaca dari baris media (bukan dari klien) supaya jenis pesan
  // ditentukan oleh berkas yang benar-benar tersimpan. Transaksi ini
  // DITUTUP sebelum mengantrekan: `queueOutboundMessageWithActor`
  // membuka transaksinya sendiri, dan menyarangkannya di dalam
  // transaksi lain akan memakai koneksi kedua dari pool — mahal dan,
  // pada pool kecil, bisa saling menunggu.
  const mimeType = await withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select({ mimeType: media.mimeType })
      .from(media)
      .where(and(eq(media.tenantId, ctx.tenantId), eq(media.id, input.mediaId)))
      .limit(1);
    return row?.mimeType ?? null;
  });

  return queueOutboundMessageWithActor(
    db,
    ctx.tenantId,
    conversationId,
    {
      contentText: input.caption?.trim() ? input.caption.trim() : null,
      replyToMessageId: input.replyToMessageId,
      media: { id: input.mediaId, mimeType },
    },
    {
      auditActorType: "user",
      auditActorId: ctx.userId,
      sentByUserId: ctx.userId,
    },
  );
}

/**
 * Varian API publik /v1 (Fase 5A): pesan outbound dibuat oleh API KEY tenant
 * (bukan user dashboard) — `sent_by_user_id` kosong, audit tercatat dengan
 * actor_type 'api_key' dan actor_id = id baris api_keys, meta menandai
 * sumber 'public_api'. Alur antrean & pengirimannya identik dengan jalur
 * dashboard (poller API / hub webchat yang sama). Validasi target kutipan
 * Fase 7B.5 berlaku identik (paritas kontrak).
 */
export async function queueOutboundMessageForApiKey(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  conversationId: string,
  input: { contentText: string; replyToMessageId?: string },
  apiKeyId: string,
): Promise<QueueOutboundMessageResult> {
  return queueOutboundMessageWithActor(db, ctx.tenantId, conversationId, input, {
    auditActorType: "api_key",
    auditActorId: apiKeyId,
    sentByUserId: null,
    auditMetaExtra: { source: "public_api", apiKeyId },
  });
}

/**
 * Hasil pengantrean pesan template (Fase 16C).
 *
 * Template adalah SATU-SATUNYA cara menghubungi kontak WhatsApp di luar
 * jendela 24 jam. Karena itu penolakan di sini harus spesifik: "template
 * belum disetujui" adalah tindakan yang berbeda dari "jumlah variabel
 * salah", dan pengguna hanya bisa memperbaiki yang disebutkan.
 */
export type QueueTemplateMessageResult =
  | { kind: "queued"; message: MessageWithReplyTo }
  | { kind: "conversation_not_found" }
  /** Provider percakapan ini tidak memakai template (Telegram/webchat). */
  | { kind: "provider_unsupported" }
  /** Id template tidak ada di akun WhatsApp percakapan ini. */
  | { kind: "template_not_found" }
  | { kind: "template_not_approved"; status: string }
  /**
   * Template memakai header MEDIA (gambar/video/dokumen) tetapi tidak ada
   * lampiran yang disertakan (Fase 18C). Sebelumnya keadaan ini ditolak
   * sebagai "belum didukung"; sekarang pengirimnya cukup memilih berkas.
   */
  | { kind: "template_media_header_required"; format: string }
  /**
   * Lampiran tidak cocok dengan format header template — mis. template
   * ber-header IMAGE dikirimi PDF. Meta akan menolaknya, jadi ditolak di
   * sini dengan alasan yang bisa ditindaklanjuti.
   */
  | { kind: "template_media_header_mismatch"; format: string; mimeType: string | null }
  /** Lampiran header tidak ada di workspace ini (atau milik tenant lain). */
  | { kind: "media_not_found" }
  /**
   * Jumlah parameter tidak cocok. Sejak Fase 17 `component` menyebutkan
   * KOMPONEN mana yang salah (header/body/button): "isi semua variabel"
   * tanpa menyebut komponennya membuat pengguna menebak, karena jumlah
   * total bisa benar sementara pembagiannya salah.
   */
  | {
      kind: "template_params_invalid";
      component: "header" | "body" | "button";
      expected: number;
      received: number;
    };

/**
 * Mengantrekan pesan template WhatsApp ke satu percakapan (Fase 16C).
 *
 * MASALAH YANG DITUTUP: `MESSAGING_WINDOW_CLOSED` menonaktifkan kotak
 * balasan dan menyuruh pengguna "pakai template", tetapi TIDAK ADA satu
 * pun jalur di inbox yang bisa mengirim template — banner itu berujung
 * jalan buntu. Broadcast bisa mengirim template, tetapi hanya ke audiens,
 * bukan ke satu orang yang sedang dibalas.
 *
 * Jendela 24 jam SENGAJA tidak diperiksa di sini: template justru
 * dikecualikan dari aturan itu. Yang diperiksa adalah hal-hal yang
 * membuat Meta menolak kiriman: provider bukan WhatsApp, template bukan
 * milik akun ini, status belum APPROVED, dan jumlah parameter tidak sama
 * dengan `variableCount`.
 *
 * `bodyParams` diterima sudah terisi (bukan sumber seperti broadcast):
 * inbox adalah pengiriman satu penerima, jadi nilainya diketik/dikonfirmasi
 * manusia untuk kontak itu — bukan dipetakan dari custom_fields.
 */
export async function queueTemplateMessage(
  db: Database,
  ctx: Pick<TenantContext, "tenantId" | "userId"> & { userId: string },
  conversationId: string,
  input: {
    templateId: string;
    bodyParams?: string[];
    headerParams?: string[];
    buttonParams?: Array<{ index: number; text: string }>;
    /**
     * Lampiran untuk header media (Fase 18C). Wajib bila template
     * ber-header IMAGE/VIDEO/DOCUMENT; diabaikan untuk header teks.
     */
    headerMediaId?: string;
  },
): Promise<QueueTemplateMessageResult> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [conv] = await tx
      .select({
        id: conversations.id,
        provider: conversations.provider,
        channelAccountId: conversations.channelAccountId,
      })
      .from(conversations)
      .where(
        and(
          eq(conversations.tenantId, ctx.tenantId),
          eq(conversations.id, conversationId),
        ),
      )
      .limit(1);
    if (!conv) return { kind: "conversation_not_found" } as const;
    if (conv.provider !== "whatsapp") {
      return { kind: "provider_unsupported" } as const;
    }

    // Template dicari DI AKUN yang sama dengan percakapan: template milik
    // WABA lain tidak bisa dikirim lewat nomor ini, dan RLS saja tidak
    // menangkapnya (keduanya milik tenant yang sama).
    const [template] = await tx
      .select({
        name: whatsappTemplates.name,
        language: whatsappTemplates.language,
        status: whatsappTemplates.status,
        // Fase 17: spesifikasi parameter diturunkan dari komponen asli,
        // bukan dari `variable_count` — kolom itu hanya menghitung BODY,
        // sehingga header/tombol ber-variabel tidak pernah ikut diperiksa.
        components: whatsappTemplates.components,
      })
      .from(whatsappTemplates)
      .where(
        and(
          eq(whatsappTemplates.tenantId, ctx.tenantId),
          eq(whatsappTemplates.channelAccountId, conv.channelAccountId),
          eq(whatsappTemplates.id, input.templateId),
        ),
      )
      .limit(1);
    if (!template) return { kind: "template_not_found" } as const;
    if (template.status !== "APPROVED") {
      return { kind: "template_not_approved", status: template.status } as const;
    }

    // Fase 17: validasi PER KOMPONEN. Sebelumnya hanya BODY yang
    // diperiksa, sehingga template ber-header `{{1}}` lolos validasi lalu
    // ditolak Meta saat dikirim — pesan menjadi `failed` tanpa pengguna
    // punya cara mengisi variabel yang kurang.
    const spec = deriveTemplateParamSpec(template.components);
    // Fase 18C: header media tidak lagi ditolak — cukup divalidasi.
    // Yang dijaga: format header menentukan jenis berkas, dan Meta
    // menolak pasangan yang salah (mis. PDF untuk header IMAGE) dengan
    // kode yang tidak menjelaskan apa pun ke pengguna.
    let headerMediaId: string | null = null;
    const headerFormat = spec.header.format;
    if (headerFormat !== null && headerFormat !== "TEXT") {
      if (!input.headerMediaId) {
        return {
          kind: "template_media_header_required",
          format: headerFormat,
        } as const;
      }
      const [attachment] = await tx
        .select({ id: media.id, mimeType: media.mimeType })
        .from(media)
        .where(
          and(
            eq(media.tenantId, ctx.tenantId),
            eq(media.id, input.headerMediaId),
          ),
        )
        .limit(1);
      if (!attachment) {
        return { kind: "media_not_found" } as const;
      }
      const mime = (attachment.mimeType ?? "").toLowerCase();
      const matches =
        headerFormat === "IMAGE"
          ? mime.startsWith("image/")
          : headerFormat === "VIDEO"
            ? mime.startsWith("video/")
            : // DOCUMENT menerima hampir semua berkas, TETAPI Cloud API
              // tidak punya header AUDIO sama sekali: berkas audio akan
              // ditolak Meta dengan kode yang tidak menjelaskan apa pun.
              // Lebih baik ditolak di sini dengan alasan yang terbaca.
              !mime.startsWith("audio/");
      if (!matches) {
        return {
          kind: "template_media_header_mismatch",
          format: headerFormat,
          mimeType: attachment.mimeType,
        } as const;
      }
      headerMediaId = attachment.id;
    }
    const headerParams = (input.headerParams ?? []).map((value) => value.trim());
    const bodyParams = (input.bodyParams ?? []).map((value) => value.trim());
    const buttonParams = (input.buttonParams ?? []).map((button) => ({
      index: button.index,
      text: button.text.trim(),
    }));

    if (
      headerParams.length !== spec.header.variableCount ||
      headerParams.some((value) => value === "")
    ) {
      return {
        kind: "template_params_invalid",
        component: "header",
        expected: spec.header.variableCount,
        received: headerParams.length,
      } as const;
    }
    if (
      bodyParams.length !== spec.body.variableCount ||
      bodyParams.some((value) => value === "")
    ) {
      return {
        kind: "template_params_invalid",
        component: "body",
        expected: spec.body.variableCount,
        received: bodyParams.length,
      } as const;
    }
    // Tombol dicocokkan per INDEX, bukan per jumlah: template dengan dua
    // tombol URL yang hanya satu ber-variabel akan lolos pemeriksaan
    // jumlah bila pengguna mengisi tombol yang salah.
    const expectedButtonIndexes = spec.urlButtons.map((b) => b.index);
    const receivedButtonIndexes = buttonParams.map((b) => b.index);
    if (
      receivedButtonIndexes.length !== expectedButtonIndexes.length ||
      expectedButtonIndexes.some((index) => !receivedButtonIndexes.includes(index)) ||
      buttonParams.some((button) => button.text === "")
    ) {
      return {
        kind: "template_params_invalid",
        component: "button",
        expected: expectedButtonIndexes.length,
        received: receivedButtonIndexes.length,
      } as const;
    }

    const [message] = await tx
      .insert(messages)
      .values({
        tenantId: ctx.tenantId,
        conversationId,
        direction: "outbound",
        senderType: "user",
        type: "template",
        // Header ikut dirender: inbox menampilkan kolom ini apa adanya,
        // dan pelanggan menerima header + body. Tanpa header, agen
        // membaca balasan yang berbeda dari yang sebenarnya terkirim.
        contentText: renderTemplateContent(spec, { headerParams, bodyParams }),
        templatePayload: {
          name: template.name,
          languageCode: template.language,
          bodyParams,
          ...(headerParams.length > 0 ? { headerParams } : {}),
          ...(buttonParams.length > 0 ? { buttonParams } : {}),
          ...(headerMediaId ? { headerMediaId } : {}),
        },
        status: "queued",
        sentByUserId: ctx.userId,
      })
      .returning();

    const now = new Date();
    await tx
      .update(conversations)
      .set({ lastMessageAt: now, updatedAt: now })
      .where(eq(conversations.id, conversationId));

    await tx.insert(auditLogs).values({
      tenantId: ctx.tenantId,
      actorType: "user",
      actorId: ctx.userId,
      action: "message.queued",
      meta: {
        conversationId,
        messageId: message.id,
        template: template.name,
        languageCode: template.language,
        stub: true,
      },
    });

    const [withReply] = await attachReplyToSummaries(tx, ctx.tenantId, [message]);
    return { kind: "queued", message: withReply } as const;
  });
}

/**
 * Pesan outbound yang masih `queued` pada satu percakapan, kronologis
 * menaik. Dipakai poller pengiriman API (Fase 2A) untuk mendorong balasan
 * yang dibuat proses lain (worker automation) lewat hub WebSocket webchat.
 * Mengembalikan array kosong bila percakapan bukan milik tenant ini.
 */
export async function listQueuedOutboundMessages(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  conversationId: string,
): Promise<Message[]> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    return tx
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.tenantId, ctx.tenantId),
          eq(messages.conversationId, conversationId),
          eq(messages.direction, "outbound"),
          eq(messages.status, "queued"),
        ),
      )
      .orderBy(asc(messages.createdAt));
  });
}

export interface ConversationDeliveryTarget {
  provider: Conversation["provider"];
  channelAccountId: string;
  /** external_id akun channel (untuk webchat: siteKey publik). */
  channelExternalId: string;
  contactId: string;
}

/**
 * Target pengiriman satu percakapan: provider + akun channel-nya.
 * Dipakai lapisan transport (API) untuk memutuskan apakah balasan bisa
 * dikirim sungguhan (mis. webchat lewat hub WS) atau tetap `queued`.
 * Null bila percakapan bukan milik tenant ini.
 */
export async function getConversationDeliveryTarget(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  conversationId: string,
): Promise<ConversationDeliveryTarget | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select({
        provider: conversations.provider,
        channelAccountId: conversations.channelAccountId,
        channelExternalId: channelAccounts.externalId,
        contactId: conversations.contactId,
      })
      .from(conversations)
      .innerJoin(
        channelAccounts,
        eq(conversations.channelAccountId, channelAccounts.id),
      )
      .where(
        and(
          eq(conversations.tenantId, ctx.tenantId),
          eq(conversations.id, conversationId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

/**
 * Fase 7C: validasi ulang satu pesan terhadap snapshot batch poller —
 * true hanya bila barisnya masih ada dan masih `queued`. Poller
 * pengiriman memanggil ini tepat sebelum mengirim SETIAP pesan:
 * snapshot batch bisa berumur detik (pengiriman sekuensial + jeda
 * provider), dan pembatalan broadcast MENGHAPUS pesan yang masih
 * queued — pesan yang sudah hilang/berubah status tidak boleh tetap
 * dikirim dari snapshot basi. Sisa balapan yang tak terhindarkan:
 * tepat satu permintaan provider yang sudah terlanjur terbang saat
 * pembatalan tiba (tidak bisa ditarik dari jaringan).
 */
export async function isOutboundMessageQueued(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  messageId: string,
): Promise<boolean> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select({ status: messages.status })
      .from(messages)
      .where(
        and(eq(messages.tenantId, ctx.tenantId), eq(messages.id, messageId)),
      )
      .limit(1);
    return row?.status === "queued";
  });
}

/**
 * Mengklaim satu pesan outbound `queued` untuk SATU pengirim (Hotfix
 * analisis 2026-11-03). Menggantikan pola lama "cek masih queued lalu
 * kirim" yang hanya aman untuk satu proses API: dua replica bisa sama-sama
 * lolos cek dan mengirim duplikat.
 *
 * UPDATE bersyarat ini atomik — pemanggil yang menang (true) satu-satunya
 * yang boleh mengirim. Syaratnya: masih `queued` DAN belum diklaim ATAU
 * klaimnya sudah basi (proses pengirim sebelumnya mati di tengah jalan;
 * lihat OUTBOUND_CLAIM_STALE_MS). Status TIDAK diubah (tetap `queued`)
 * agar reconcile broadcast & UI tidak perlu mengenal keadaan baru.
 */
export async function claimOutboundMessage(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  messageId: string,
): Promise<boolean> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [claimed] = await tx
      .update(messages)
      .set({ claimedAt: sql`now()` })
      .where(
        and(
          eq(messages.tenantId, ctx.tenantId),
          eq(messages.id, messageId),
          eq(messages.status, "queued"),
          or(
            isNull(messages.claimedAt),
            lt(messages.claimedAt, outboundClaimStale),
          ),
        ),
      )
      .returning({ id: messages.id });
    return Boolean(claimed);
  });
}

/**
 * Menandai satu pesan outbound `queued` sebagai `sent` setelah transport
 * sungguhan mengirimnya (Fase 1F: hub WebSocket webchat) + audit
 * `message.sent`. Mengembalikan baris terbaru, atau null bila pesan tidak
 * ada / tidak lagi berstatus queued.
 *
 * `providerMessageId` (opsional, Fase 6A.2): id pesan di sisi provider
 * hasil pengiriman — disimpan ke baris yang sama agar webhook pantulan
 * (khususnya `channel_post` Telegram untuk postingan kita sendiri)
 * ter-dedup terhadap baris ini. Bila penyimpanan id itu menabrak index
 * unik global (balapan: pantulan tiba & tercatat lebih dulu — sangat
 * jarang), pemanggil boleh memanggil ulang TANPA id ini agar penandaan
 * `sent` tetap berhasil; lihat poller Telegram.
 */
export async function markOutboundMessageSent(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  messageId: string,
  via: string,
  providerMessageId?: string,
): Promise<Message | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [updated] = await tx
      .update(messages)
      .set({
        status: "sent",
        ...(providerMessageId ? { providerMessageId } : {}),
      })
      .where(
        and(
          eq(messages.tenantId, ctx.tenantId),
          eq(messages.id, messageId),
          eq(messages.status, "queued"),
        ),
      )
      .returning();
    if (!updated) return null;

    await tx.insert(auditLogs).values({
      tenantId: ctx.tenantId,
      actorType: "system",
      actorId: via,
      action: "message.sent",
      meta: {
        conversationId: updated.conversationId,
        messageId: updated.id,
        via,
      },
    });

    return updated;
  });
}

/**
 * Menandai satu pesan outbound `queued` sebagai `failed` setelah transport
 * sungguhan gagal mengirimnya (Fase 6A: Bot API Telegram menolak/error) +
 * audit `message.failed`. `errorCode` adalah kode aman yang diringkas
 * pemanggil (mis. `telegram_http_400`) — TIDAK BOLEH memuat kredensial
 * atau URL bertoken; disimpan juga ke kolom `messages.error_code`.
 * Mengembalikan baris terbaru, atau null bila pesan tidak ada / tidak
 * lagi berstatus queued.
 */
export async function markOutboundMessageFailed(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  messageId: string,
  via: string,
  errorCode: string,
): Promise<Message | null> {
  const safeCode = errorCode.slice(0, 128);
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [updated] = await tx
      .update(messages)
      .set({ status: "failed", errorCode: safeCode })
      .where(
        and(
          eq(messages.tenantId, ctx.tenantId),
          eq(messages.id, messageId),
          eq(messages.status, "queued"),
        ),
      )
      .returning();
    if (!updated) return null;

    await tx.insert(auditLogs).values({
      tenantId: ctx.tenantId,
      actorType: "system",
      actorId: via,
      action: "message.failed",
      meta: {
        conversationId: updated.conversationId,
        messageId: updated.id,
        via,
        errorCode: safeCode,
      },
    });

    return updated;
  });
}

// ---------------------------------------------------------------------------
// Pusat pesan keluar gagal + retry (Fase 7B.2)
// ---------------------------------------------------------------------------

/**
 * Provider yang pesan keluarnya BENAR-BENAR bisa berakhir `failed` dan
 * bisa diantrekan ulang ke mekanisme pengiriman yang ada:
 * - telegram/messenger/instagram/whatsapp: ditandai `failed` oleh poller
 *   pengiriman API (atau, khusus WhatsApp, oleh webhook status Meta lewat
 *   `applyWhatsAppMessageStatus`) dan diambil lagi oleh poller yang sama
 *   begitu statusnya kembali `queued`.
 * - webchat SENGAJA tidak ada di sini: pesan keluar webchat tidak pernah
 *   berstatus `failed` — flush gateway realtime hanya menandai `sent`,
 *   dan pesan untuk pengunjung luring tetap `queued` sampai reconnect
 *   (gerbang disconnect Fase 6G juga mempertahankannya `queued`). Jadi
 *   tidak ada antrean gagal webchat untuk ditampilkan/dikirim ulang.
 */
export const RETRYABLE_FAILED_PROVIDERS = [
  "telegram",
  "messenger",
  "instagram",
  "whatsapp",
] as const;

export interface FailedOutboundMessage {
  id: string;
  conversationId: string;
  provider: string;
  channelAccountId: string;
  channelDisplayName: string | null;
  contactId: string;
  contactName: string | null;
  contentPreview: string | null;
  errorCode: string | null;
  createdAt: Date;
}

export interface ListFailedOutboundMessagesInput {
  provider?: string;
  /** Kursor opaque dari halaman sebelumnya. */
  cursor?: string;
  /** Default 50, maksimum 100. */
  limit?: number;
}

export interface FailedOutboundMessagePage {
  messages: FailedOutboundMessage[];
  nextCursor: string | null;
}

interface FailedMessageCursor {
  createdAt: string;
  id: string;
}

function encodeFailedCursor(row: { createdAt: Date; id: string }): string {
  const raw: FailedMessageCursor = {
    createdAt: row.createdAt.toISOString(),
    id: row.id,
  };
  return Buffer.from(JSON.stringify(raw), "utf8").toString("base64url");
}

function decodeFailedCursor(
  cursor: string | undefined,
): FailedMessageCursor | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Partial<FailedMessageCursor>;
    if (
      typeof parsed.createdAt === "string" &&
      typeof parsed.id === "string" &&
      !Number.isNaN(Date.parse(parsed.createdAt))
    ) {
      return { createdAt: parsed.createdAt, id: parsed.id };
    }
  } catch {
    // Kursor rusak → halaman pertama (pola log integrasi 7B.1).
  }
  return null;
}

const FAILED_CONTENT_PREVIEW_CHARS = 280;

/**
 * Daftar pesan keluar `failed` milik tenant (pusat pesan gagal 7B.2),
 * terbaru dulu, paginasi kursor keyset (created_at, id) menurun — pola
 * yang sama seperti daftar log integrasi. Konteks channel & kontak ikut
 * dibaca dalam transaksi tenant yang sama (RLS menegakkan isolasi).
 */
export async function listFailedOutboundMessages(
  db: Database,
  tenantId: string,
  input: ListFailedOutboundMessagesInput = {},
): Promise<FailedOutboundMessagePage> {
  const limit = !input.limit || Number.isNaN(input.limit)
    ? 50
    : Math.min(100, Math.max(1, Math.floor(input.limit)));
  return withTenantDb(db, tenantId, async (tx) => {
    const conditions = [
      eq(messages.tenantId, tenantId),
      eq(messages.direction, "outbound"),
      eq(messages.status, "failed"),
      inArray(conversations.provider, [...RETRYABLE_FAILED_PROVIDERS]),
    ];
    if (input.provider) {
      conditions.push(eq(conversations.provider, input.provider as never));
    }
    const cursor = decodeFailedCursor(input.cursor);
    if (cursor) {
      const cursorDate = new Date(cursor.createdAt);
      conditions.push(
        or(
          lt(messages.createdAt, cursorDate),
          and(eq(messages.createdAt, cursorDate), lt(messages.id, cursor.id)),
        )!,
      );
    }
    const rows = await tx
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
        provider: conversations.provider,
        channelAccountId: conversations.channelAccountId,
        channelDisplayName: channelAccounts.displayName,
        contactId: conversations.contactId,
        contactName: contacts.name,
        contentText: messages.contentText,
        errorCode: messages.errorCode,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .innerJoin(
        conversations,
        eq(messages.conversationId, conversations.id),
      )
      .innerJoin(
        channelAccounts,
        eq(conversations.channelAccountId, channelAccounts.id),
      )
      .leftJoin(contacts, eq(conversations.contactId, contacts.id))
      .where(and(...conditions))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    return {
      messages: pageRows.map((r) => ({
        id: r.id,
        conversationId: r.conversationId,
        provider: r.provider,
        channelAccountId: r.channelAccountId,
        channelDisplayName: r.channelDisplayName,
        contactId: r.contactId,
        contactName: r.contactName,
        contentPreview: r.contentText
          ? r.contentText.slice(0, FAILED_CONTENT_PREVIEW_CHARS)
          : null,
        errorCode: r.errorCode,
        createdAt: r.createdAt,
      })),
      nextCursor: hasMore
        ? encodeFailedCursor(pageRows[pageRows.length - 1])
        : null,
    };
  });
}

export type RetryFailedOutboundMessageResult =
  | { kind: "requeued"; message: Message; provider: string }
  | { kind: "not_found" }
  | { kind: "not_failed" }
  | { kind: "channel_disconnected" }
  | { kind: "unsupported_provider"; provider: string };

/**
 * Mengantrekan ulang SATU pesan keluar `failed` (Fase 7B.2): transisi
 * `failed` → `queued` yang ATOMIK dan kondisional di dalam satu
 * transaksi tenant, agar balapan dengan poller tidak pernah menimpa
 * status yang lebih maju (`sent`/`delivered`/`read`). Isi pesan,
 * percakapan, kontak, dan provider_message_id TIDAK diubah; error_code
 * dibersihkan sebagai bagian transisi (kegagalan lama tetap terbaca di
 * `integration_log` + audit `message.failed`). Penjaga sebelum transisi:
 * akun channel harus ada, tidak di-trash, dan berstatus `connected`;
 * provider harus termasuk yang dilayani poller (webchat tidak pernah
 * `failed` — lihat RETRYABLE_FAILED_PROVIDERS). Berhasil → audit
 * `message.retry` (actor user yang menekan tombol). Pengiriman sungguhan
 * tetap dilakukan poller yang ada pada siklus berikutnya — fungsi ini
 * tidak mengirim apa pun sendiri.
 */
export async function retryFailedOutboundMessage(
  db: Database,
  ctx: Pick<TenantContext, "tenantId" | "userId"> & { userId: string },
  messageId: string,
): Promise<RetryFailedOutboundMessageResult> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select({
        message: messages,
        provider: conversations.provider,
        accountStatus: channelAccounts.status,
        accountTrashedAt: channelAccounts.trashedAt,
      })
      .from(messages)
      .innerJoin(
        conversations,
        eq(messages.conversationId, conversations.id),
      )
      .innerJoin(
        channelAccounts,
        eq(conversations.channelAccountId, channelAccounts.id),
      )
      .where(
        and(
          eq(messages.tenantId, ctx.tenantId),
          eq(messages.id, messageId),
        ),
      )
      .limit(1);
    if (!row) return { kind: "not_found" } as const;
    if (
      row.message.direction !== "outbound" ||
      row.message.status !== "failed"
    ) {
      return { kind: "not_failed" } as const;
    }
    if (
      !(RETRYABLE_FAILED_PROVIDERS as readonly string[]).includes(row.provider)
    ) {
      return { kind: "unsupported_provider", provider: row.provider } as const;
    }
    if (row.accountTrashedAt !== null || row.accountStatus !== "connected") {
      return { kind: "channel_disconnected" } as const;
    }

    const previousErrorCode = row.message.errorCode;
    const [updated] = await tx
      .update(messages)
      .set({ status: "queued", errorCode: null })
      .where(
        and(
          eq(messages.tenantId, ctx.tenantId),
          eq(messages.id, messageId),
          eq(messages.status, "failed"),
        ),
      )
      .returning();
    if (!updated) return { kind: "not_failed" } as const;

    await tx.insert(auditLogs).values({
      tenantId: ctx.tenantId,
      actorType: "user",
      actorId: ctx.userId,
      action: "message.retry",
      meta: {
        conversationId: updated.conversationId,
        messageId: updated.id,
        provider: row.provider,
        previousErrorCode,
      },
    });

    return { kind: "requeued", message: updated, provider: row.provider } as const;
  });
}
