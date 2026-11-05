import {
  MessageResponseSchema,
  type MessageReplyTo,
  type MessageResponse,
} from "@sahabat-kreator/contracts";
import type { Message } from "@sahabat-kreator/db";

/**
 * Baris pesan yang bisa diserialkan: baris DB polos, atau baris yang
 * sudah ditempeli ringkasan kutipan teresolusi oleh core (Fase 7B.5 —
 * `MessageWithReplyTo`). Tanpa lampiran, `replyTo` dilaporkan null.
 * `replyToSnapshot` (Hotfix 7B.6) adalah kolom DB biasa — ikut terbawa
 * baris pesan apa adanya, terpisah dari `replyTo` agar klien bisa
 * membedakan kutipan tertaut vs snapshot cadangan.
 */
export type SerializableMessage = Message & {
  replyTo?: MessageReplyTo | null;
};

/** Serialisasi baris `messages` DB ke kontrak API (dipakai inbox & webchat). */
export function serializeMessage(row: SerializableMessage): MessageResponse {
  return MessageResponseSchema.parse({
    id: row.id,
    conversationId: row.conversationId,
    direction: row.direction,
    senderType: row.senderType,
    senderName: row.senderName,
    type: row.type,
    contentText: row.contentText,
    mediaId: row.mediaId,
    providerMessageId: row.providerMessageId,
    status: row.status,
    sentByUserId: row.sentByUserId,
    replyTo: row.replyTo ?? null,
    replyToSnapshot: row.replyToSnapshot ?? null,
    createdAt: row.createdAt.toISOString(),
  });
}
