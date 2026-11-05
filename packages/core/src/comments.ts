import { and, asc, desc, eq } from "drizzle-orm";
import {
  auditLogs,
  automations,
  channelAccounts,
  channelIdentities,
  comments,
  contacts,
  conversations,
  messages,
  outboxEvents,
  type Automation,
  type ChannelAccount,
  type Comment,
  type CommentActions,
  type Database,
} from "@sahabat-kreator/db";
import type { TenantContext } from "./tenant";
import { withTenantDb, type DbTx } from "./tx";
import { keywordMatches } from "./automations";
import { metaContactFallbackName } from "./meta";
import { renderMessageText } from "./render-text";
import { decryptChannelSecret } from "./channel-secrets";

/**
 * Service domain Komentar Meta (Fase 10B) — comment-to-DM Instagram &
 * Messenger + moderasi komentar dasar.
 *
 * Alur:
 * 1. Webhook (route live + replay memakai proses yang sama)
 *    menormalkan event komentar lalu memanggil `recordMetaComment`:
 *    komentar disimpan ke tabel `comments` dengan dedup index unik
 *    (channel_account_id, provider_comment_id). Hanya baris yang
 *    BENAR-BENAR baru yang menulis event outbox `comment.received` —
 *    pengiriman ulang webhook dan replay log integrasi berhenti di
 *    sini, tanpa aksi ganda.
 * 2. Relay worker menerjemahkan event itu menjadi job
 *    `comment.evaluate`; worker memanggil
 *    `evaluateCommentForAutomations` yang menjalankan aturan komentar
 *    (automation trigger_type='comment', terikat satu akun).
 * 3. Aksi aturan, urutan DM → balasan publik → sembunyikan:
 *    - DM dibuat sebagai pesan `queued` biasa di percakapan penulis
 *      (kontak + percakapan ditemukan/dibuat PERSIS seperti pesan
 *      masuk — identitas channel yang sama, jadi balasan DM penulis
 *      berikutnya mendarat di percakapan yang sama) dengan
 *      `messages.provider_comment_id` terisi; poller API mengirimnya
 *      sebagai private reply Send API. Worker TIDAK mengirim DM
 *      langsung agar status kirim, log integrasi, dan pusat pesan
 *      gagal berlaku seragam seperti pesan keluar lain.
 *    - Balasan publik + sembunyikan adalah panggilan Graph langsung
 *      dari worker lewat interface `CommentGraphActions` (lapisan
 *      pemanggil menyuntikkan MetaGraphClient) — keduanya bukan pesan
 *      percakapan, jadi tidak ada baris `messages` untuknya.
 *    Kegagalan satu aksi dicatat di `comments.actions` dan TIDAK
 *    membatalkan aksi berikutnya; evaluasi menandai dirinya selesai
 *    (`actions.evaluatedAt`) sehingga job yang ter-replay tidak
 *    menembak dua kali.
 * 4. Komentar dari akun itu sendiri (penulis = external_id akun)
 *    dicatat tetapi tidak pernah dievaluasi aksinya (anti-loop:
 *    balasan publik kita sendiri memicu webhook komentar baru).
 */

export interface RecordMetaCommentInput {
  providerCommentId: string;
  mediaId?: string | null;
  postId?: string | null;
  parentId?: string | null;
  authorExternalId: string;
  authorUsername?: string | null;
  text: string;
  providerCreatedAt?: Date | null;
}

export type RecordMetaCommentResult =
  | { status: "recorded"; comment: Comment }
  | { status: "duplicate"; comment: Comment | null };

/**
 * Menyimpan satu komentar webhook. Mengembalikan 'duplicate' (tanpa
 * event outbox baru) bila (akun, provider_comment_id) sudah tercatat —
 * termasuk kembaran milik tenant lain yang tak terlihat RLS: insert
 * ON CONFLICT DO NOTHING menangkapnya dan baris tak kembali.
 */
export async function recordMetaComment(
  db: Database,
  account: Pick<ChannelAccount, "id" | "tenantId" | "provider" | "externalId">,
  input: RecordMetaCommentInput,
): Promise<RecordMetaCommentResult> {
  return withTenantDb(db, account.tenantId, async (tx) => {
    // Tautkan penulis yang sudah dikenal: identitas channel yang sama
    // seperti pesan masuk — komentar dari kontak lama langsung
    // menunjuk kontak + percakapan DM-nya.
    const [identity] = await tx
      .select()
      .from(channelIdentities)
      .where(
        and(
          eq(channelIdentities.channelAccountId, account.id),
          eq(channelIdentities.externalUserId, input.authorExternalId),
        ),
      )
      .limit(1);
    let contactId: string | null = null;
    let conversationId: string | null = null;
    if (identity) {
      contactId = identity.contactId;
      const [conv] = await tx
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.tenantId, account.tenantId),
            eq(conversations.channelAccountId, account.id),
            eq(conversations.contactId, identity.contactId),
          ),
        )
        .orderBy(desc(conversations.createdAt))
        .limit(1);
      conversationId = conv?.id ?? null;
    }

    const [comment] = await tx
      .insert(comments)
      .values({
        tenantId: account.tenantId,
        channelAccountId: account.id,
        provider: account.provider,
        providerCommentId: input.providerCommentId,
        mediaId: input.mediaId ?? null,
        postId: input.postId ?? null,
        parentId: input.parentId ?? null,
        authorExternalId: input.authorExternalId,
        authorUsername: input.authorUsername ?? null,
        text: input.text,
        providerCreatedAt: input.providerCreatedAt ?? null,
        contactId,
        conversationId,
      })
      .onConflictDoNothing()
      .returning();
    if (!comment) {
      const [existing] = await tx
        .select()
        .from(comments)
        .where(
          and(
            eq(comments.channelAccountId, account.id),
            eq(comments.providerCommentId, input.providerCommentId),
          ),
        )
        .limit(1);
      return { status: "duplicate" as const, comment: existing ?? null };
    }

    await tx.insert(outboxEvents).values({
      tenantId: account.tenantId,
      type: "comment.received",
      payload: {
        provider: account.provider,
        channelAccountId: account.id,
        commentId: comment.id,
      },
    });
    return { status: "recorded" as const, comment };
  });
}

/** Aksi Graph langsung untuk evaluasi aturan (disuntikkan pemanggil). */
export interface CommentGraphActions {
  replyToComment(input: {
    provider: "instagram" | "messenger";
    commentId: string;
    text: string;
    /** Token akun pemilik komentar (sudah didekripsi core). */
    accessToken: string;
  }): Promise<{ replyId: string | null }>;
  setCommentHidden(input: {
    provider: "instagram" | "messenger";
    commentId: string;
    hidden: boolean;
    /** Token akun pemilik komentar (sudah didekripsi core). */
    accessToken: string;
  }): Promise<void>;
}

export interface EvaluateCommentResult {
  evaluated: boolean;
  /** Komentar ditulis akun sendiri — dicatat, tidak dievaluasi. */
  skippedOwnComment?: boolean;
  matchedAutomationId?: string | null;
  actions?: CommentActions;
  /** Percakapan DM penulis (untuk nudge realtime pemanggil). */
  conversationId?: string | null;
}

/** Kode aman dari error Graph (angka saja; pesan mentah tidak disimpan). */
function graphErrorCode(err: unknown): string {
  if (
    typeof err === "object" &&
    err !== null &&
    "graphCode" in err &&
    typeof (err as { graphCode: unknown }).graphCode === "number"
  ) {
    return `meta_graph_${(err as { graphCode: number }).graphCode}`;
  }
  return "meta_graph_error";
}

/**
 * Temukan/buat kontak + percakapan privat penulis komentar pada akun
 * ini — pola yang sama persis dengan `recordMetaInboundMessage`
 * (identitas by (akun, externalUserId); percakapan non-closed terbaru
 * by (akun, kontak)), agar DM comment-to-DM dan DM biasa berbagi satu
 * percakapan. Nama kontak baru memakai username penulis dari payload
 * komentar bila ada; selain itu label cadangan per provider (profil
 * Graph akan menimpanya saat penulis benar-benar mengirim DM).
 */
async function findOrCreateCommentConversation(
  tx: DbTx,
  input: {
    tenantId: string;
    channelAccountId: string;
    provider: "instagram" | "messenger";
    authorExternalId: string;
    authorUsername: string | null;
  },
): Promise<{ contactId: string; conversationId: string; optedOut: boolean }> {
  const [identity] = await tx
    .select()
    .from(channelIdentities)
    .where(
      and(
        eq(channelIdentities.channelAccountId, input.channelAccountId),
        eq(channelIdentities.externalUserId, input.authorExternalId),
      ),
    )
    .limit(1);

  let contactId: string;
  if (identity) {
    contactId = identity.contactId;
  } else {
    const displayName =
      input.provider === "instagram" && input.authorUsername
        ? `@${input.authorUsername.replace(/^@/, "")}`
        : input.authorUsername || metaContactFallbackName(input.provider);
    const [contact] = await tx
      .insert(contacts)
      .values({ tenantId: input.tenantId, name: displayName })
      .returning();
    contactId = contact.id;
    await tx.insert(channelIdentities).values({
      tenantId: input.tenantId,
      contactId,
      channelAccountId: input.channelAccountId,
      provider: input.provider,
      externalUserId: input.authorExternalId,
    });
  }

  const [contact] = await tx
    .select()
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);

  const [existingConv] = await tx
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.tenantId, input.tenantId),
        eq(conversations.channelAccountId, input.channelAccountId),
        eq(conversations.contactId, contactId),
      ),
    )
    .orderBy(desc(conversations.createdAt))
    .limit(1);

  if (existingConv && existingConv.status !== "closed") {
    return {
      contactId,
      conversationId: existingConv.id,
      optedOut: contact?.optInStatus === "opted_out",
    };
  }
  const [conv] = await tx
    .insert(conversations)
    .values({
      tenantId: input.tenantId,
      channelAccountId: input.channelAccountId,
      contactId,
      provider: input.provider,
      providerChatId: input.authorExternalId,
      kind: "private",
      status: "open",
    })
    .returning();
  return {
    contactId,
    conversationId: conv.id,
    optedOut: contact?.optInStatus === "opted_out",
  };
}

/**
 * Mengevaluasi SATU komentar terhadap aturan komentar aktif akunnya.
 * Dipanggil worker untuk job `comment.evaluate`. Idempoten: komentar
 * yang sudah punya `actions.evaluatedAt` tidak dievaluasi ulang.
 * Aturan dicoba berurutan (created_at menaik) dan kecocokan PERTAMA
 * yang menembak — satu komentar tidak pernah menerima dua DM.
 *
 * Tiga fase: (1) transaksi — muat komentar + akun, jalan pintas
 * idempoten/komentar-sendiri/tak-ada-aturan, antrekan DM; (2) tanpa
 * transaksi — panggilan Graph balasan publik + sembunyikan; (3)
 * transaksi — tulis jejak aksi final + audit `comment.rule_fired`.
 */
export async function evaluateCommentForAutomations(
  db: Database,
  input: { tenantId: string; commentId: string },
  deps: {
    /** Envelope rahasia channel platform (CHANNEL_TOKEN_SECRET). */
    channelTokenSecret?: string;
    graph: CommentGraphActions;
  },
): Promise<EvaluateCommentResult> {
  const { tenantId, commentId } = input;

  interface Phase1 {
    comment: Comment;
    account: ChannelAccount;
    matched: Automation | null;
    matchedKeyword: string | null;
    actions: CommentActions;
    dmContactId?: string;
    dmConversationId?: string;
    /** true → fase 1 sudah menulis hasil akhir (jalan pintas). */
    done: boolean;
    skippedOwnComment?: boolean;
  }

  const phase1 = await withTenantDb(db, tenantId, async (tx) => {
    const [comment] = await tx
      .select()
      .from(comments)
      .where(and(eq(comments.tenantId, tenantId), eq(comments.id, commentId)))
      .limit(1);
    if (!comment) return null;
    if (comment.actions?.evaluatedAt) return null;

    const [account] = await tx
      .select()
      .from(channelAccounts)
      .where(eq(channelAccounts.id, comment.channelAccountId))
      .limit(1);
    if (!account) return null;
    const provider = comment.provider as "instagram" | "messenger";

    const writeFinal = async (
      actions: CommentActions,
      matchedAutomationId: string | null,
      extra?: { contactId?: string; conversationId?: string },
    ): Promise<CommentActions> => {
      const finalActions: CommentActions = {
        ...actions,
        evaluatedAt: new Date().toISOString(),
      };
      await tx
        .update(comments)
        .set({
          actions: finalActions,
          matchedAutomationId,
          ...(extra?.contactId ? { contactId: extra.contactId } : {}),
          ...(extra?.conversationId
            ? { conversationId: extra.conversationId }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(comments.id, comment.id));
      return finalActions;
    };

    // Anti-loop: komentar dari akun itu sendiri (mis. balasan publik
    // kita yang terpantul sebagai webhook) tidak pernah dievaluasi.
    if (comment.authorExternalId === account.externalId) {
      const finalActions = await writeFinal({ skipped: "own_comment" }, null);
      const out: Phase1 = {
        comment,
        account,
        matched: null,
        matchedKeyword: null,
        actions: finalActions,
        done: true,
        skippedOwnComment: true,
      };
      return out;
    }

    const rules = await tx
      .select()
      .from(automations)
      .where(
        and(
          eq(automations.tenantId, tenantId),
          eq(automations.triggerType, "comment"),
          eq(automations.isActive, true),
        ),
      )
      .orderBy(asc(automations.createdAt));

    let matched: Automation | null = null;
    let matchedKeyword: string | null = null;
    for (const rule of rules) {
      if (rule.triggerConfig.channelAccountId !== account.id) continue;
      for (const keyword of rule.triggerConfig.keywords ?? []) {
        if (keywordMatches(comment.text, keyword, rule.triggerConfig.match)) {
          matched = rule;
          matchedKeyword = keyword;
          break;
        }
      }
      if (matched) break;
    }
    if (!matched) {
      const finalActions = await writeFinal({}, null);
      const out: Phase1 = {
        comment,
        account,
        matched: null,
        matchedKeyword: null,
        actions: finalActions,
        done: true,
      };
      return out;
    }

    // --- Aksi 1: DM privat (queued; poller mengirim private reply) ---
    // Idempoten terhadap retry job: DM yang sudah terantre pada upaya
    // sebelumnya tercatat di comments.actions (ditulis dalam transaksi
    // yang sama di bawah) — upaya ulang membacanya dan tidak
    // mengantrekan DM kedua.
    const actions: CommentActions = {};
    let dmContactId: string | undefined;
    let dmConversationId: string | undefined;
    if (matched.actionConfig.sendDm) {
      if (comment.actions?.dm) {
        actions.dm = comment.actions.dm;
        dmContactId = comment.contactId ?? undefined;
        dmConversationId = comment.conversationId ?? undefined;
      } else {
        const target = await findOrCreateCommentConversation(tx, {
          tenantId,
          channelAccountId: account.id,
          provider,
          authorExternalId: comment.authorExternalId,
          authorUsername: comment.authorUsername,
        });
        dmContactId = target.contactId;
        dmConversationId = target.conversationId;
        if (target.optedOut) {
          actions.dm = { status: "skipped", reason: "opted_out" };
        } else {
          const dmText = renderMessageText(matched.actionConfig.text, {
            name: comment.authorUsername ?? "",
          });
          const [dm] = await tx
            .insert(messages)
            .values({
              tenantId,
              conversationId: target.conversationId,
              direction: "outbound",
              senderType: "system",
              type: "text",
              contentText: dmText,
              providerCommentId: comment.providerCommentId,
              status: "queued",
            })
            .returning();
          await tx.insert(outboxEvents).values({
            tenantId,
            type: "message.queued",
            payload: {
              provider,
              channelAccountId: account.id,
              conversationId: target.conversationId,
              messageId: dm.id,
            },
          });
          const now = new Date();
          await tx
            .update(conversations)
            .set({ lastMessageAt: now, updatedAt: now })
            .where(eq(conversations.id, target.conversationId));
          actions.dm = { status: "queued", messageId: dm.id };
        }
        // Catat hasil DM + tautan kontak/percakapan SEKARANG (transaksi
        // yang sama) sebagai penanda upaya berikutnya.
        await tx
          .update(comments)
          .set({
            actions: { dm: actions.dm },
            contactId: dmContactId,
            conversationId: dmConversationId,
            updatedAt: new Date(),
          })
          .where(eq(comments.id, comment.id));
      }
    }

    const out: Phase1 = {
      comment,
      account,
      matched,
      matchedKeyword,
      actions,
      dmContactId,
      dmConversationId,
      done: false,
    };
    return out;
  });

  if (!phase1) return { evaluated: false };
  if (phase1.done) {
    return {
      evaluated: true,
      skippedOwnComment: phase1.skippedOwnComment,
      matchedAutomationId: phase1.matched?.id ?? null,
      actions: phase1.actions,
      conversationId:
        phase1.dmConversationId ?? phase1.comment.conversationId ?? null,
    };
  }

  const { comment, account, matched } = phase1;
  if (!matched) return { evaluated: false };
  const provider = comment.provider as "instagram" | "messenger";
  const cfg = matched.actionConfig;
  const actions: CommentActions = { ...phase1.actions };

  // --- Fase 2: aksi Graph langsung (di luar transaksi) ---
  let accessToken: string | null = null;
  if (cfg.publicReplyText || cfg.hideComment) {
    accessToken =
      deps.channelTokenSecret && account.accessTokenEncrypted
        ? decryptChannelSecret(
            deps.channelTokenSecret,
            account.accessTokenEncrypted,
          )
        : null;
  }
  if (cfg.publicReplyText) {
    if (!accessToken) {
      actions.publicReply = {
        status: "failed",
        errorCode: "meta_token_unavailable",
      };
    } else {
      try {
        const replyText = renderMessageText(cfg.publicReplyText, {
          name: comment.authorUsername ?? "",
        });
        const { replyId } = await deps.graph.replyToComment({
          provider,
          commentId: comment.providerCommentId,
          text: replyText,
          accessToken,
        });
        actions.publicReply = { status: "sent", replyId };
      } catch (err) {
        actions.publicReply = {
          status: "failed",
          errorCode: graphErrorCode(err),
        };
      }
    }
  }
  let hidden = false;
  if (cfg.hideComment) {
    if (!accessToken) {
      actions.hide = { status: "failed", errorCode: "meta_token_unavailable" };
    } else {
      try {
        await deps.graph.setCommentHidden({
          provider,
          commentId: comment.providerCommentId,
          hidden: true,
          accessToken,
        });
        actions.hide = { status: "hidden" };
        hidden = true;
      } catch (err) {
        actions.hide = {
          status: "failed",
          errorCode: graphErrorCode(err),
        };
      }
    }
  }

  // --- Fase 3: tulis jejak final + audit ---
  const finalActions = await withTenantDb(db, tenantId, async (tx) => {
    const stamped: CommentActions = {
      ...actions,
      evaluatedAt: new Date().toISOString(),
    };
    await tx
      .update(comments)
      .set({
        actions: stamped,
        matchedAutomationId: matched.id,
        ...(phase1.dmContactId ? { contactId: phase1.dmContactId } : {}),
        ...(phase1.dmConversationId
          ? { conversationId: phase1.dmConversationId }
          : {}),
        ...(hidden ? { moderationStatus: "hidden" as const } : {}),
        updatedAt: new Date(),
      })
      .where(eq(comments.id, comment.id));
    await tx.insert(auditLogs).values({
      tenantId,
      actorType: "system",
      actorId: `automation:${matched.id}`,
      action: "comment.rule_fired",
      meta: {
        automationId: matched.id,
        commentId: comment.id,
        channelAccountId: account.id,
        matchedKeyword: phase1.matchedKeyword,
        dm: actions.dm?.status ?? null,
        publicReply: actions.publicReply?.status ?? null,
        hide: actions.hide?.status ?? null,
      },
    });
    return stamped;
  });

  return {
    evaluated: true,
    matchedAutomationId: matched.id,
    actions: finalActions,
    conversationId:
      phase1.dmConversationId ?? comment.conversationId ?? null,
  };
}

/** Satu baris daftar komentar untuk dashboard (dengan nama akun). */
export interface CommentListItem extends Comment {
  channelDisplayName: string | null;
  channelExternalId: string;
}

/** Daftar komentar terbaru tenant (filter akun / aturan opsional). */
export async function listComments(
  db: Database,
  ctx: TenantContext,
  filter?: {
    channelAccountId?: string;
    automationId?: string;
    limit?: number;
  },
): Promise<CommentListItem[]> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const conds = [eq(comments.tenantId, ctx.tenantId)];
    if (filter?.channelAccountId)
      conds.push(eq(comments.channelAccountId, filter.channelAccountId));
    if (filter?.automationId)
      conds.push(eq(comments.matchedAutomationId, filter.automationId));
    const rows = await tx
      .select({
        comment: comments,
        channelDisplayName: channelAccounts.displayName,
        channelExternalId: channelAccounts.externalId,
      })
      .from(comments)
      .innerJoin(
        channelAccounts,
        eq(channelAccounts.id, comments.channelAccountId),
      )
      .where(and(...conds))
      .orderBy(desc(comments.createdAt))
      .limit(Math.min(Math.max(filter?.limit ?? 50, 1), 200));
    return rows.map((r) => ({
      ...r.comment,
      channelDisplayName: r.channelDisplayName,
      channelExternalId: r.channelExternalId,
    }));
  });
}

/** Ambil satu komentar tenant (untuk moderasi manual); null bila tak ada. */
export async function getComment(
  db: Database,
  ctx: TenantContext,
  commentId: string,
): Promise<Comment | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(comments)
      .where(
        and(eq(comments.tenantId, ctx.tenantId), eq(comments.id, commentId)),
      )
      .limit(1);
    return row ?? null;
  });
}

/**
 * Perbarui status moderasi lokal SESUDAH Graph menerima perubahan
 * (route moderasi manual memanggil Graph lebih dulu; kegagalan Graph
 * berarti fungsi ini tidak dipanggil dan status lokal tidak berubah).
 * `actorType` membedakan jalur dashboard ('user', bawaan) dari jalur
 * API publik v1 ('api_key' — actorId = id kunci, pola Fase 5A).
 */
export async function setCommentModerationStatus(
  db: Database,
  ctx: TenantContext & { userId: string },
  input: {
    commentId: string;
    hidden: boolean;
    actorType?: "user" | "api_key";
  },
): Promise<Comment | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .update(comments)
      .set({
        moderationStatus: input.hidden ? "hidden" : "visible",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(comments.tenantId, ctx.tenantId),
          eq(comments.id, input.commentId),
        ),
      )
      .returning();
    if (!row) return null;
    await tx.insert(auditLogs).values({
      tenantId: ctx.tenantId,
      actorType: input.actorType ?? "user",
      actorId: ctx.userId,
      action: input.hidden ? "comment.hidden" : "comment.unhidden",
      meta: {
        commentId: row.id,
        channelAccountId: row.channelAccountId,
        providerCommentId: row.providerCommentId,
      },
    });
    return row;
  });
}
