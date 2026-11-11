import { z } from "zod";

import { MemberRoleSchema } from "./tenants";

// ---------------------------------------------------------------------------
// Conversations & messages / inbox (Fase 1D)
// ---------------------------------------------------------------------------

export const ChannelProviderSchema = z.enum([
  "whatsapp",
  "instagram",
  "messenger",
  "telegram",
  "webchat",
  /**
   * Threads (Gelombang 1) — provider KHUSUS content schedule.
   * Ia berada di enum bersama agar akun, sasaran post, dan capability
   * memakai satu identitas provider, tetapi ia BUKAN channel inbox:
   * tidak ada webhook pesan, percakapan dua arah, broadcast, atau
   * jalur connect channel generik untuknya. Satu-satunya percakapan
   * yang boleh lahir adalah sasaran sintetis `kind='channel'` untuk
   * linimasa akun itu sendiri.
   */
  "threads",
  /**
   * Bluesky (Gelombang 1.5) — provider KHUSUS content schedule, sama
   * seperti Threads: identitasnya memakai enum bersama agar akun
   * (`external_id` = DID, `public_handle` = handle), sasaran post, dan
   * capability berbagi satu sumber, tetapi ia BUKAN channel inbox:
   * tidak ada webhook pesan, percakapan dua arah, broadcast, atau
   * jalur connect channel generik untuknya. Satu-satunya percakapan
   * yang boleh lahir adalah sasaran sintetis `kind='channel'` untuk
   * linimasa akun itu sendiri.
   */
  "bluesky",
]);
export type ChannelProvider = z.infer<typeof ChannelProviderSchema>;

export const ConversationStatusSchema = z.enum(["open", "pending", "closed"]);
export type ConversationStatus = z.infer<typeof ConversationStatusSchema>;

export const MessageDirectionSchema = z.enum(["inbound", "outbound"]);
export type MessageDirection = z.infer<typeof MessageDirectionSchema>;

export const MessageSenderTypeSchema = z.enum([
  "contact",
  "user",
  "agent",
  "system",
]);
export type MessageSenderType = z.infer<typeof MessageSenderTypeSchema>;

export const MessageTypeSchema = z.enum([
  "text",
  "image",
  "audio",
  "video",
  "document",
  "sticker",
  "template",
  "other",
]);
export type MessageType = z.infer<typeof MessageTypeSchema>;

export const MessageStatusSchema = z.enum([
  "queued",
  "sent",
  "delivered",
  "read",
  "failed",
  "received",
]);
export type MessageStatus = z.infer<typeof MessageStatusSchema>;

/**
 * Jendela pesan bebas (Fase 16C) — keadaan yang menentukan apakah kita
 * boleh mengirim teks biasa ke kontak, atau harus memakai template
 * yang disetujui.
 *
 * `enforced` = provider ini punya aturan jendela (WhatsApp: 24 jam sejak
 * pesan masuk TERAKHIR dari kontak). `open` = boleh kirim teks bebas
 * SEKARANG. Untuk provider tanpa aturan jendela (Telegram, webchat)
 * `enforced` false dan `open` selalu true — UI tidak menampilkan apa pun.
 *
 * Dihitung server dari `messages` (pesan masuk terakhir), bukan dari
 * `conversations.last_message_at` yang bisa berisi pesan keluar.
 */
export const MessagingWindowSchema = z.object({
  enforced: z.boolean(),
  open: z.boolean(),
  /** Waktu pesan MASUK terakhir dari kontak; null bila belum pernah ada. */
  lastInboundAt: z.string().datetime().nullable(),
  /** Saat jendela menutup (`lastInboundAt + 24 jam`); null bila tak ada. */
  expiresAt: z.string().datetime().nullable(),
});
export type MessagingWindow = z.infer<typeof MessagingWindowSchema>;

export const ConversationResponseSchema = z.object({
  id: z.string().uuid(),
  channelAccountId: z.string().uuid(),
  contactId: z.string().uuid(),
  contactName: z.string(),
  /**
   * URL foto profil kontak percakapan ini (Fase 6D) — endpoint avatar
   * kita sendiri, null bila kontak belum punya foto tersimpan (UI jatuh
   * ke inisial berwarna). Untuk percakapan grup/channel ini foto kontak
   * jangkarnya; atribusi per pesan tetap lewat senderName.
   */
  contactAvatarUrl: z.string().nullable(),
  /**
   * Judul percakapan di provider (Fase 6A.1) — judul grup Telegram;
   * null untuk percakapan privat (tampilkan contactName).
   */
  title: z.string().nullable(),
  /** Percakapan grup (banyak anggota) vs privat 1:1 (Fase 6A.1). */
  isGroup: z.boolean(),
  /**
   * Percakapan channel siaran (Fase 6A.2): linimasa postingan satu arah
   * (mis. channel Telegram tempat bot menjadi admin). Bukan percakapan
   * dua arah — postingan masuk tidak memicu automation/agent dan
   * unreadCount-nya selalu 0; membalas di utas ini = memposting ke
   * channel.
   */
  isChannel: z.boolean(),
  provider: ChannelProviderSchema,
  status: ConversationStatusSchema,
  assigneeUserId: z.string().uuid().nullable(),
  /**
   * Nama tampil penerima tugas (Fase 9C): nama user penerima tugas, jatuh
   * ke email bila nama kosong; null bila percakapan belum ditugaskan atau
   * penerimanya sudah tidak bisa diresolusi. UI menampilkan chip penugasan
   * dari dua field ini tanpa query tambahan.
   */
  assigneeName: z.string().nullable(),
  agentEnabled: z.boolean(),
  /**
   * Jendela pesan bebas (Fase 16C). UI memakainya untuk mematikan kotak
   * balasan lebih awal + menjelaskan sebabnya, alih-alih membiarkan
   * pengguna mengetik lalu ditolak server/provider.
   */
  messagingWindow: MessagingWindowSchema,
  unreadCount: z.number().int().nonnegative(),
  lastMessageAt: z.string().datetime().nullable(),
  /** Cuplikan teks pesan terakhir (null bila belum ada pesan). */
  lastMessagePreview: z.string().nullable(),
  lastMessageDirection: MessageDirectionSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ConversationResponse = z.infer<typeof ConversationResponseSchema>;

export const ConversationListResponseSchema = z.object({
  conversations: z.array(ConversationResponseSchema),
});
export type ConversationListResponse = z.infer<
  typeof ConversationListResponseSchema
>;

/**
 * Penugasan percakapan (Fase 9C): tetapkan penerima tugas ke member
 * workspace mana pun, atau lepaskan dengan `assigneeUserId: null`.
 * Penerima yang bukan member ditolak server (422 ASSIGNEE_NOT_MEMBER) —
 * kontrak di sini hanya memeriksa bentuk UUID.
 */
export const AssignConversationRequestSchema = z.object({
  assigneeUserId: z.string().uuid().nullable(),
});
export type AssignConversationRequest = z.infer<
  typeof AssignConversationRequestSchema
>;

/**
 * Ubah status percakapan (Fase 16C). Status hanya label kerja tim —
 * tidak mengubah jalur pengiriman maupun agent. Menutup percakapan
 * TIDAK mematikan AI; sumbu itu milik `agentEnabled` di bawah.
 */
export const UpdateConversationStatusRequestSchema = z.object({
  status: ConversationStatusSchema,
});
export type UpdateConversationStatusRequest = z.infer<
  typeof UpdateConversationStatusRequestSchema
>;

/**
 * Nyalakan/matikan AI untuk satu percakapan (Fase 16C).
 *
 * Sebelum ini `agent_enabled` hanya pernah ditulis `false` (handoff node
 * flow & tool `handoff_to_human` agent) — tidak ada jalan kembali, jadi
 * satu handoff mematikan AI untuk kontak itu selamanya. Endpoint ini
 * menutup lubang tersebut; nilainya idempoten (menyalakan yang sudah
 * menyala tidak berefek).
 */
export const SetAgentEnabledRequestSchema = z.object({
  agentEnabled: z.boolean(),
});
export type SetAgentEnabledRequest = z.infer<
  typeof SetAgentEnabledRequestSchema
>;

/**
 * Catatan internal percakapan (Fase 9C): catatan tim yang TIDAK PERNAH
 * terkirim ke kontak — disimpan di tabel terpisah dari pesan dan tidak
 * punya jalur ke provider mana pun. `authorName` adalah label tampil
 * penulis (nama, jatuh ke email); null bila penulis sudah terhapus
 * (UI memakai label cadangan "mantan anggota").
 */
export const ConversationNoteResponseSchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  authorUserId: z.string().uuid().nullable(),
  authorName: z.string().nullable(),
  body: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ConversationNoteResponse = z.infer<
  typeof ConversationNoteResponseSchema
>;

export const ConversationNoteListResponseSchema = z.object({
  notes: z.array(ConversationNoteResponseSchema),
});
export type ConversationNoteListResponse = z.infer<
  typeof ConversationNoteListResponseSchema
>;

export const CreateConversationNoteRequestSchema = z.object({
  body: z.string().trim().min(1).max(4000),
});
export type CreateConversationNoteRequest = z.infer<
  typeof CreateConversationNoteRequestSchema
>;

/**
 * Tim workspace (Fase 9C): member + undangan. Peran mengikuti
 * MemberRoleSchema yang ada (owner|admin|agent|viewer); peran `owner`
 * TIDAK bisa diberikan lewat undangan maupun perubahan peran — kepemilikan
 * tidak berpindah lewat permukaan ini.
 */
export const InvitableRoleSchema = z.enum(["admin", "agent", "viewer"]);
export type InvitableRole = z.infer<typeof InvitableRoleSchema>;

export const TeamMemberResponseSchema = z.object({
  userId: z.string().uuid(),
  email: z.string(),
  name: z.string().nullable(),
  role: MemberRoleSchema,
  /** Baris ini adalah user sesi yang sedang melihat (UI menandai "Anda"). */
  isSelf: z.boolean(),
  createdAt: z.string().datetime(),
});
export type TeamMemberResponse = z.infer<typeof TeamMemberResponseSchema>;

export const TeamMemberListResponseSchema = z.object({
  members: z.array(TeamMemberResponseSchema),
});
export type TeamMemberListResponse = z.infer<typeof TeamMemberListResponseSchema>;

/** Status turunan undangan — dihitung server dari kolom waktunya. */
export const InvitationStatusSchema = z.enum([
  "pending",
  "accepted",
  "revoked",
  "expired",
]);
export type InvitationStatus = z.infer<typeof InvitationStatusSchema>;

export const InvitationResponseSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  role: InvitableRoleSchema,
  status: InvitationStatusSchema,
  /**
   * Tautan terima utuh — HANYA disertakan pada respons PEMBUATAN
   * undangan (sekali lihat, pola kunci API 5A): yang tersimpan di server
   * hanya HASH tokennya, jadi tautan tidak bisa ditampilkan ulang dari
   * daftar; untuk tautan baru, cabut undangan lama & undang ulang.
   * Null di semua permukaan lain.
   */
  inviteUrl: z.string().nullable(),
  /**
   * Status pengiriman email undangan (Fase 11B) — HANYA bermakna pada
   * respons PEMBUATAN: "queued" = email diantrekan ke job pengiriman
   * (Resend terkonfigurasi), "not_configured" = email platform belum
   * diatur sehingga undangan hanya bisa dibagikan lewat tautan salin.
   * Null pada daftar (keadaan kirim di sana dibaca dari emailSentAt /
   * emailError di bawah).
   */
  emailDelivery: z.enum(["queued", "not_configured"]).nullable(),
  /** Waktu email undangan benar-benar terkirim (Fase 11B); null bila belum. */
  emailSentAt: z.string().datetime().nullable(),
  /**
   * Ringkasan kegagalan kirim terakhir (kode provider + pesan singkat,
   * TANPA token/isi email); null bila belum pernah gagal / sudah terkirim.
   */
  emailError: z.string().nullable(),
  expiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});
export type InvitationResponse = z.infer<typeof InvitationResponseSchema>;

export const InvitationListResponseSchema = z.object({
  invitations: z.array(InvitationResponseSchema),
});
export type InvitationListResponse = z.infer<typeof InvitationListResponseSchema>;

export const CreateInvitationRequestSchema = z.object({
  email: z.string().trim().email().max(320),
  role: InvitableRoleSchema.default("agent"),
});
export type CreateInvitationRequest = z.infer<
  typeof CreateInvitationRequestSchema
>;

export const UpdateMemberRoleRequestSchema = z.object({
  role: InvitableRoleSchema,
});
export type UpdateMemberRoleRequest = z.infer<
  typeof UpdateMemberRoleRequestSchema
>;

/**
 * Pratinjau undangan untuk halaman terima (/invite/:token): cukup untuk
 * menampilkan "Anda diundang ke workspace X sebagai peran Y" dan apakah
 * email sesi cocok — token tidak pernah dikembalikan lagi.
 */
export const InvitationPreviewResponseSchema = z.object({
  tenantId: z.string().uuid(),
  tenantName: z.string(),
  email: z.string(),
  role: InvitableRoleSchema,
  status: InvitationStatusSchema,
  /** Email user sesi == email undangan (penerimaan hanya boleh olehnya). */
  emailMatches: z.boolean(),
  expiresAt: z.string().datetime(),
});
export type InvitationPreviewResponse = z.infer<
  typeof InvitationPreviewResponseSchema
>;

export const AcceptInvitationResponseSchema = z.object({
  tenantId: z.string().uuid(),
  role: MemberRoleSchema,
});
export type AcceptInvitationResponse = z.infer<
  typeof AcceptInvitationResponseSchema
>;

/**
 * Ringkasan pesan yang dikutip (Fase 7B.5): resolusi server-side dari
 * `messages.reply_to_message_id` — klien TIDAK pernah menerima tautan
 * mentahnya, hanya ringkasan siap tampil ini. `contentPreview` adalah
 * teks target yang terpotong wajar; null untuk pesan non-teks tanpa
 * caption (UI menampilkan label tipe dwibahasanya sendiri dari `type`).
 * `authorLabel`: nama pengirim target bila diketahui (nama kontak /
 * nama anggota grup dari sender_name / nama user pengirim); null bila
 * tidak ada — UI memakai label cadangannya sendiri per arah.
 */
export const MessageReplyToSchema = z.object({
  id: z.string().uuid(),
  direction: MessageDirectionSchema,
  senderType: MessageSenderTypeSchema,
  type: MessageTypeSchema,
  authorLabel: z.string().nullable(),
  contentPreview: z.string().nullable(),
});
export type MessageReplyTo = z.infer<typeof MessageReplyToSchema>;

/**
 * Snapshot kutipan cadangan (Hotfix 7B.6): isi pesan yang dikutip
 * sebagaimana dikirim provider di payload webhook (Telegram menyertakan
 * teks + penulis pesan asal pada `reply_to_message`), disimpan di
 * `messages.reply_to_snapshot` saat ingest. Berbeda dari `replyTo` di
 * atas: ini BUKAN tautan ke baris kita — tidak ada `id`, tidak bisa
 * dilompati — hanya cadangan tampil untuk kutipan yang targetnya tidak
 * tertaut (mis. pesan pra-stamping provider-id) atau sudah terhapus.
 * Klien mendahulukan `replyTo` bila tidak null dan hanya memakai ini
 * bila `replyTo` null. Selalu null untuk WhatsApp & Meta (payload
 * kutipan mereka hanya membawa id, tanpa teks) dan untuk pesan yang
 * tidak mengutip.
 */
export const MessageReplyToSnapshotSchema = z.object({
  authorLabel: z.string().nullable(),
  contentPreview: z.string().nullable(),
});
export type MessageReplyToSnapshot = z.infer<
  typeof MessageReplyToSnapshotSchema
>;

export const MessageResponseSchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  direction: MessageDirectionSchema,
  senderType: MessageSenderTypeSchema,
  /** Nama anggota pengirim — hanya terisi pada pesan masuk grup (Fase 6A.1). */
  senderName: z.string().nullable(),
  type: MessageTypeSchema,
  contentText: z.string().nullable(),
  mediaId: z.string().uuid().nullable(),
  providerMessageId: z.string().nullable(),
  status: MessageStatusSchema,
  sentByUserId: z.string().uuid().nullable(),
  /**
   * Pesan yang dikutip pesan ini (Fase 7B.5), atau null. Null juga bila
   * targetnya sudah terhapus (FK SET NULL) — kutipan lepas dengan anggun.
   */
  replyTo: MessageReplyToSchema.nullable(),
  /**
   * Snapshot kutipan cadangan (Hotfix 7B.6), terpisah dari `replyTo`
   * agar klien membedakan "tertaut" vs "cadangan": isi bila pesan ini
   * mengutip dan provider mengirim isi pesan asalnya (Telegram), apa
   * pun status tautannya; klien hanya menampilkannya bila `replyTo`
   * null.
   */
  replyToSnapshot: MessageReplyToSnapshotSchema.nullable(),
  createdAt: z.string().datetime(),
});
export type MessageResponse = z.infer<typeof MessageResponseSchema>;

export const MessageListResponseSchema = z.object({
  messages: z.array(MessageResponseSchema),
  /**
   * Masih ada pesan yang LEBIH TUA dari yang dikembalikan (Fase 16C).
   * Diminta lewat `?before=<messageId>`; UI menampilkan tombol "muat
   * pesan lama" selama ini true.
   */
  hasMore: z.boolean(),
});
export type MessageListResponse = z.infer<typeof MessageListResponseSchema>;

export const SendMessageRequestSchema = z.object({
  contentText: z.string().trim().min(1).max(4096),
  /**
   * Fase 7B.5: id pesan yang dikutip balasan ini (opsional). Server
   * memvalidasi target ada, milik tenant yang sama, dan berada di
   * PERCAKAPAN YANG SAMA — selain itu 422 MESSAGE_REPLY_TARGET_INVALID.
   */
  replyToMessageId: z.string().uuid().optional(),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

/**
 * Kirim template WhatsApp dari inbox (Fase 16C).
 *
 * Template adalah satu-satunya pesan yang boleh keluar setelah jendela
 * 24 jam tertutup, jadi endpoint ini adalah pasangan dari
 * `MESSAGING_WINDOW_CLOSED` — tanpa ia, kotak balasan yang dimatikan
 * meninggalkan pengguna tanpa jalan keluar.
 *
 * `templateId` menunjuk baris cermin di akun WhatsApp percakapan itu
 * (bukan nama+bahasa: nama bisa sama pada bahasa berbeda). `bodyParams`
 * diisi manusia untuk satu penerima ini — panjangnya harus sama dengan
 * `variableCount` template, dan tidak boleh ada nilai kosong.
 */
export const SendTemplateMessageRequestSchema = z.object({
  templateId: z.string().uuid(),
  bodyParams: z.array(z.string().trim().max(1024)).max(20).default([]),
  /**
   * Variabel HEADER teks (Fase 17) — Meta membatasi satu (`{{1}}`).
   * Tanpa ini, template ber-header `{{1}}` ditolak Meta meski body-nya
   * sudah lengkap, dan inbox tidak punya tempat mengisinya.
   */
  headerParams: z.array(z.string().trim().max(1024)).max(1).default([]),
  /**
   * Variabel tombol URL (Fase 17). `index` = posisi tombol pada template
   * (0-based) — bukan urutan di antara tombol URL saja.
   */
  buttonParams: z
    .array(
      z.object({
        index: z.number().int().min(0).max(9),
        text: z.string().trim().max(1024),
      }),
    )
    .max(3)
    .default([]),
  /**
   * Lampiran header media (Fase 18C) — id baris `media` yang sudah
   * diunggah lewat `POST /tenants/:tenantId/media`. Wajib bila template
   * ber-header IMAGE/VIDEO/DOCUMENT.
   */
  headerMediaId: z.string().uuid().optional(),
});
export type SendTemplateMessageRequest = z.infer<
  typeof SendTemplateMessageRequestSchema
>;

/**
 * Kirim pesan berlampiran dari inbox (Fase 18B).
 *
 * `mediaId` menunjuk baris `media` yang SUDAH diunggah lewat
 * `POST /tenants/:tenantId/media` — bukan URL, dan bukan byte inline.
 * Jenis pesan (image/audio/video/document) diturunkan server dari MIME
 * baris itu, bukan dari klien: klien yang menentukan jenis bisa
 * mengirim `image` untuk PDF dan membuat Meta menolak pesannya.
 */
export const SendMediaMessageRequestSchema = z.object({
  mediaId: z.string().uuid(),
  /** Caption; diabaikan untuk audio (Cloud API tidak punya caption audio). */
  caption: z.string().trim().max(1024).optional(),
  replyToMessageId: z.string().uuid().optional(),
});
export type SendMediaMessageRequest = z.infer<
  typeof SendMediaMessageRequestSchema
>;

/**
 * Unggah lampiran (Fase 18B).
 *
 * Batas 25 MB sama dengan batas unduhan media masuk: satu angka untuk
 * satu arah perjalanan berkas, supaya tidak ada berkas yang bisa masuk
 * tetapi tidak bisa dikirim (atau sebaliknya).
 */
export const MEDIA_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Tipe yang boleh diunggah. Daftar putih, bukan daftar hitam: berkas
 * ini nantinya dirender atau diunduh dari origin dashboard, jadi
 * `text/html` dan `image/svg+xml` sengaja TIDAK termasuk — keduanya
 * bisa membawa skrip yang berjalan di sesi pengguna.
 */
export const MEDIA_UPLOAD_ALLOWED_MIME = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/3gpp",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/amr",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/zip",
  "text/plain",
  "text/csv",
] as const;

export const MediaUploadResponseSchema = z.object({
  mediaId: z.string().uuid(),
  fileName: z.string().nullable(),
  mimeType: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative(),
});
export type MediaUploadResponse = z.infer<typeof MediaUploadResponseSchema>;
