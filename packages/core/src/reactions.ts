import { and, eq, inArray, ne } from "drizzle-orm";
import {
  channelIdentities,
  conversations,
  messageReactions,
  messages,
  type Database,
} from "@sahabat-kreator/db";
import type { TenantContext } from "./tenant";
import { withTenantDb, type DbTx } from "./tx";

/**
 * Reaksi emoji pada pesan (G13 butir 11) — penyimpanan + ringkasan.
 *
 * Semantik yang ditegakkan di sini (meniru semantik provider):
 * - Satu aktor punya PALING BANYAK satu reaksi aktif per pesan:
 *   mengganti emoji menghapus baris emoji lamanya; menetapkan emoji
 *   yang sama lagi = menghapus (toggle); emoji kosong/null = hapus.
 * - Aktor tim: actor_key `user:<userId>`; aktor kontak:
 *   `contact:<externalUserId>` (identitas provider pengirim reaksi).
 *
 * Modul ini MURNI data. Pengiriman keluar ke provider (WhatsApp
 * `type:"reaction"`, Telegram `setMessageReaction`) adalah tanggung
 * jawab lapisan API yang memanggil `applyUserReaction` — core tidak
 * tahu token channel. Urutan di API: kirim ke provider DULU, simpan
 * sesudah berhasil, agar baris lokal tidak pernah menjanjikan reaksi
 * yang tidak terkirim.
 */

export interface MessageReactionSummary {
  emoji: string;
  count: number;
  mine: boolean;
  byContact: boolean;
  byTeam: boolean;
}

export function userActorKey(userId: string): string {
  return `user:${userId}`;
}

export function contactActorKey(externalUserId: string): string {
  return `contact:${externalUserId}`;
}

/** Agregat baris reaksi mentah → ringkasan per pesan. */
function summarizeRows(
  rows: Array<{
    messageId: string;
    emoji: string;
    actorType: string;
    actorKey: string;
  }>,
  viewerUserId: string | null,
): Map<string, MessageReactionSummary[]> {
  const byMessage = new Map<
    string,
    Map<string, MessageReactionSummary & { firstSeen: number }>
  >();
  let seq = 0;
  for (const row of rows) {
    let perEmoji = byMessage.get(row.messageId);
    if (!perEmoji) {
      perEmoji = new Map();
      byMessage.set(row.messageId, perEmoji);
    }
    let entry = perEmoji.get(row.emoji);
    if (!entry) {
      entry = {
        emoji: row.emoji,
        count: 0,
        mine: false,
        byContact: false,
        byTeam: false,
        firstSeen: seq,
      };
      seq += 1;
      perEmoji.set(row.emoji, entry);
    }
    entry.count += 1;
    if (viewerUserId && row.actorKey === userActorKey(viewerUserId)) {
      entry.mine = true;
    }
    if (row.actorType === "contact") entry.byContact = true;
    if (row.actorType === "user") entry.byTeam = true;
  }
  const out = new Map<string, MessageReactionSummary[]>();
  for (const [messageId, perEmoji] of byMessage) {
    const list = [...perEmoji.values()]
      .sort((a, b) => b.count - a.count || a.firstSeen - b.firstSeen)
      .map(({ firstSeen: _ignored, ...summary }) => summary);
    out.set(messageId, list);
  }
  return out;
}

/**
 * Ringkasan reaksi untuk banyak pesan sekaligus (SATU kueri — dipakai
 * serializer daftar pesan inbox agar tidak N+1).
 */
export async function summarizeMessageReactions(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  messageIds: string[],
  viewerUserId: string | null,
): Promise<Map<string, MessageReactionSummary[]>> {
  if (messageIds.length === 0) return new Map();
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const rows = await tx
      .select({
        messageId: messageReactions.messageId,
        emoji: messageReactions.emoji,
        actorType: messageReactions.actorType,
        actorKey: messageReactions.actorKey,
      })
      .from(messageReactions)
      .where(
        and(
          eq(messageReactions.tenantId, ctx.tenantId),
          inArray(messageReactions.messageId, messageIds),
        ),
      );
    return summarizeRows(rows, viewerUserId);
  });
}

/**
 * Satu transaksi penetapan reaksi satu aktor pada satu pesan:
 * `emoji` null/kosong = hapus reaksi aktor; emoji lain = ganti
 * (baris emoji lain milik aktor yang sama pada pesan itu dihapus).
 */
async function setActorReactionTx(
  tx: DbTx,
  tenantId: string,
  input: {
    messageId: string;
    conversationId: string;
    actorType: "user" | "contact";
    actorUserId: string | null;
    actorKey: string;
    emoji: string | null;
  },
): Promise<void> {
  await tx
    .delete(messageReactions)
    .where(
      and(
        eq(messageReactions.tenantId, tenantId),
        eq(messageReactions.messageId, input.messageId),
        eq(messageReactions.actorKey, input.actorKey),
        ...(input.emoji
          ? [ne(messageReactions.emoji, input.emoji)]
          : []),
      ),
    );
  if (!input.emoji) return;
  await tx
    .insert(messageReactions)
    .values({
      tenantId,
      messageId: input.messageId,
      conversationId: input.conversationId,
      actorType: input.actorType,
      actorUserId: input.actorUserId,
      actorKey: input.actorKey,
      emoji: input.emoji,
    })
    .onConflictDoNothing();
}

export interface ReactionTarget {
  messageId: string;
  conversationId: string;
  /** Provider percakapan (whatsapp, telegram, …). */
  provider: string;
  channelAccountId: string;
  /** Id pesan di provider (mentah, sesuai yang disimpan ingest). */
  providerMessageId: string | null;
  /** Alamat chat provider percakapan (Telegram chat.id); null bila tak ada. */
  providerChatId: string | null;
  /**
   * Id eksternal kontak pada akun channel ini (wa_id untuk WhatsApp —
   * alamat `to` reaksi Cloud API); null bila identitas tak ditemukan.
   */
  contactExternalId: string | null;
}

/**
 * Target pengiriman reaksi untuk lapisan API: pesan + percakapan +
 * alamat provider-nya dalam SATU kueri tenant. Null bila pesan bukan
 * milik tenant ini.
 */
export async function getReactionTarget(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  messageId: string,
): Promise<ReactionTarget | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select({
        messageId: messages.id,
        conversationId: messages.conversationId,
        provider: conversations.provider,
        channelAccountId: conversations.channelAccountId,
        providerMessageId: messages.providerMessageId,
        providerChatId: conversations.providerChatId,
        contactId: conversations.contactId,
      })
      .from(messages)
      .innerJoin(
        conversations,
        eq(messages.conversationId, conversations.id),
      )
      .where(
        and(
          eq(messages.tenantId, ctx.tenantId),
          eq(messages.id, messageId),
        ),
      )
      .limit(1);
    if (!row) return null;

    const [identity] = await tx
      .select({ externalUserId: channelIdentities.externalUserId })
      .from(channelIdentities)
      .where(
        and(
          eq(channelIdentities.tenantId, ctx.tenantId),
          eq(channelIdentities.contactId, row.contactId),
          eq(channelIdentities.channelAccountId, row.channelAccountId),
        ),
      )
      .limit(1);

    return {
      messageId: row.messageId,
      conversationId: row.conversationId,
      provider: row.provider,
      channelAccountId: row.channelAccountId,
      providerMessageId: row.providerMessageId,
      providerChatId: row.providerChatId,
      contactExternalId: identity?.externalUserId ?? null,
    };
  });
}

export type ApplyUserReactionResult =
  | { kind: "ok"; reactions: MessageReactionSummary[] }
  | { kind: "message_not_found" };

/**
 * Menetapkan reaksi anggota tim pada satu pesan (sesudah pengiriman
 * provider berhasil di lapisan API) dan mengembalikan ringkasan
 * terbaru pesan itu untuk penampil.
 */
export async function applyUserReaction(
  db: Database,
  ctx: Pick<TenantContext, "tenantId"> & { userId: string },
  input: { messageId: string; emoji: string | null },
): Promise<ApplyUserReactionResult> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [message] = await tx
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
      })
      .from(messages)
      .where(
        and(
          eq(messages.tenantId, ctx.tenantId),
          eq(messages.id, input.messageId),
        ),
      )
      .limit(1);
    if (!message) return { kind: "message_not_found" } as const;

    await setActorReactionTx(tx, ctx.tenantId, {
      messageId: message.id,
      conversationId: message.conversationId,
      actorType: "user",
      actorUserId: ctx.userId,
      actorKey: userActorKey(ctx.userId),
      emoji: input.emoji,
    });

    const rows = await tx
      .select({
        messageId: messageReactions.messageId,
        emoji: messageReactions.emoji,
        actorType: messageReactions.actorType,
        actorKey: messageReactions.actorKey,
      })
      .from(messageReactions)
      .where(
        and(
          eq(messageReactions.tenantId, ctx.tenantId),
          eq(messageReactions.messageId, message.id),
        ),
      );
    const summaries = summarizeRows(rows, ctx.userId);
    return {
      kind: "ok",
      reactions: summaries.get(message.id) ?? [],
    } as const;
  });
}

/**
 * Mencatat reaksi MASUK dari kontak (jalur webhook provider — saat ini
 * WhatsApp `reaction`). Target pesan dicari dari `provider_message_id`
 * di dalam tenant; tidak ketemu (pesan asal di luar jangkauan data
 * kita) → `target_not_found` dan pemanggil mencatatnya sebagai
 * peristiwa terlewat, bukan mengarang baris pesan.
 */
export async function recordContactReaction(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  input: {
    targetProviderMessageId: string;
    senderExternalId: string;
    /** Emoji reaksi; string kosong = kontak mencabut reaksinya. */
    emoji: string;
  },
): Promise<{ kind: "ok" } | { kind: "target_not_found" }> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [message] = await tx
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
      })
      .from(messages)
      .where(
        and(
          eq(messages.tenantId, ctx.tenantId),
          eq(messages.providerMessageId, input.targetProviderMessageId),
        ),
      )
      .limit(1);
    if (!message) return { kind: "target_not_found" } as const;

    await setActorReactionTx(tx, ctx.tenantId, {
      messageId: message.id,
      conversationId: message.conversationId,
      actorType: "contact",
      actorUserId: null,
      actorKey: contactActorKey(input.senderExternalId),
      emoji: input.emoji === "" ? null : input.emoji,
    });
    return { kind: "ok" } as const;
  });
}
