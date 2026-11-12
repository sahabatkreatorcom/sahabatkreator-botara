import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import {
  auditLogs,
  conversations,
  messages,
  usageLedger,
  type Agent,
  type Database,
} from "@sahabat-kreator/db";
import type { LlmProvider } from "@sahabat-kreator/ai";
import { withTenantDb } from "./tx";
import { createAgentConversationNote } from "./conversation-notes";

/**
 * Pengaman AI pelengkap (Gelombang G6, Tier 1 butir 7 program adopsi).
 *
 * Pengaman yang SUDAH ada dan TIDAK dibangun ulang di sini: cap
 * harian per tenant (200 respons/hari dari usage_ledger, di
 * agent-runtime.ts), batching anti-burst (Fase 9A), dan tool
 * `handoff_to_human`. Modul ini menutup dua celah yang tersisa:
 *
 * 1. CAP BALASAN AI PER PERCAKAPAN — satu percakapan yang berputar
 *    (kontak yang terus menulis / loop balasan) tidak lagi bisa
 *    menghabiskan jatah tenant atau membombardir satu pelanggan.
 *    Model: jendela BERGULIR 24 jam per percakapan (sejajar semangat
 *    cap harian tenant, tetapi bergulir dan per percakapan), batas
 *    dari `agents.config.maxConversationReplies` (bawaan 20; 0 =
 *    nonaktif). Penegakan ATOMIK: klaim slot adalah SATU UPDATE
 *    kondisional ber-RETURNING pada baris `conversations` (kolom
 *    jendela migrasi 0031) — kunci baris Postgres menserialkan klaim
 *    bersamaan, jadi balapan dua balasan tidak bisa menembus cap.
 *    Slot diklaim SEBELUM panggilan LLM (cap sekaligus membatasi
 *    belanja token per percakapan) dan DILEPAS bila generasi gagal
 *    (provider error / respons kosong) — kegagalan tidak membakar
 *    jatah pelanggan. Saat cap tercapai runtime TIDAK diam: ia
 *    menyerahkan percakapan ke manusia lewat jalur handoff yang sama
 *    (lihat butir 2) — jalan keluar, bukan kebuntuan senyap.
 *
 * 2. RINGKASAN HANDOFF OTOMATIS — setiap handoff (tool
 *    `handoff_to_human` maupun pemicu cap di atas) menghasilkan
 *    ringkasan percakapan singkat lewat jalur LLM yang ada dan
 *    menempelkannya sebagai CATATAN INTERNAL pada percakapan (tabel
 *    `conversation_notes` yang sama dengan catatan tim — bukan tabel
 *    kedua; penulisnya agent, `author_user_id` NULL). GAGAL-AMAN
 *    mutlak: ringkasan dibuat SESUDAH handoff tercatat; kegagalan
 *    LLM/timeout/provider mock tidak pernah membatalkan atau
 *    menggagalkan handoff — hasilnya cukup jejak audit
 *    `agent.handoff_summary` berstatus 'unavailable'. Token ringkasan
 *    tercatat di usage_ledger dengan refType tersendiri
 *    (`agent_handoff_summary`) agar tidak mengonsumsi cap harian
 *    respons dan tidak tercampur agregat analytics respons.
 */

/** Batas balasan AI per percakapan per jendela bila config agent kosong. */
export const AGENT_CONVERSATION_REPLY_CAP = 20;
/** Panjang jendela bergulir cap per percakapan (jam). */
export const AGENT_CONVERSATION_REPLY_WINDOW_HOURS = 24;
/** refType usage_ledger untuk SATU panggilan ringkasan handoff. */
export const AGENT_HANDOFF_SUMMARY_REF_TYPE = "agent_handoff_summary";

const SUMMARY_HISTORY_LIMIT = 30;
const SUMMARY_MAX_CHARS = 2_000;

/**
 * Batas efektif untuk satu agent: angka dari config, bawaan bila
 * kosong, dan `null` = cap NONAKTIF (config 0 — pilihan sadar pemilik
 * agent, bukan keadaan rusak).
 */
export function resolveConversationReplyCap(agent: Agent): number | null {
  const configured = agent.config.maxConversationReplies;
  if (configured === undefined) return AGENT_CONVERSATION_REPLY_CAP;
  if (configured <= 0) return null;
  return configured;
}

export type ConversationReplyClaim =
  | { claimed: true; count: number; windowStartedAt: Date }
  | { claimed: false };

/**
 * Mengklaim SATU slot balasan AI untuk percakapan ini secara atomik.
 * Satu-satunya penulis kolom jendela selain `releaseConversationReplySlot`.
 * Kondisi jendela pada klausa WHERE dievaluasi ulang Postgres sesudah
 * kunci baris diperoleh (READ COMMITTED), jadi dua klaim bersamaan
 * terserialkan: tepat `cap` klaim pertama yang menang.
 */
export async function claimConversationReplySlot(
  db: Database,
  input: { tenantId: string; conversationId: string; cap: number },
): Promise<ConversationReplyClaim> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const windowStarted = conversations.agentReplyWindowStartedAt;
    const windowExpired = sql`(${windowStarted} IS NULL OR ${windowStarted} <= now() - (${AGENT_CONVERSATION_REPLY_WINDOW_HOURS} * interval '1 hour'))`;
    const [row] = await tx
      .update(conversations)
      .set({
        agentReplyWindowCount: sql`CASE WHEN ${windowExpired} THEN 1 ELSE ${conversations.agentReplyWindowCount} + 1 END`,
        agentReplyWindowStartedAt: sql`CASE WHEN ${windowExpired} THEN now() ELSE ${windowStarted} END`,
      })
      .where(
        and(
          eq(conversations.tenantId, input.tenantId),
          eq(conversations.id, input.conversationId),
          or(
            isNull(windowStarted),
            sql`${windowStarted} <= now() - (${AGENT_CONVERSATION_REPLY_WINDOW_HOURS} * interval '1 hour')`,
            lt(conversations.agentReplyWindowCount, input.cap),
          ),
        ),
      )
      .returning({
        count: conversations.agentReplyWindowCount,
        windowStartedAt: conversations.agentReplyWindowStartedAt,
      });
    if (!row || row.windowStartedAt === null) return { claimed: false };
    return {
      claimed: true,
      count: row.count,
      windowStartedAt: row.windowStartedAt,
    };
  });
}

/**
 * Melepas slot yang sudah diklaim bila generasi balasan gagal (provider
 * error / respons kosong) — kegagalan tidak boleh membakar jatah
 * pelanggan. Hanya mengurangi bila jendela belum berganti sejak klaim
 * (windowStartedAt masih sama); balapan pada pelepasan bersifat jinak
 * (lantai 0). Best-effort: pemanggil membungkus dengan catch.
 */
export async function releaseConversationReplySlot(
  db: Database,
  input: {
    tenantId: string;
    conversationId: string;
    windowStartedAt: Date;
  },
): Promise<void> {
  await withTenantDb(db, input.tenantId, async (tx) => {
    await tx
      .update(conversations)
      .set({
        agentReplyWindowCount: sql`GREATEST(${conversations.agentReplyWindowCount} - 1, 0)`,
      })
      .where(
        and(
          eq(conversations.tenantId, input.tenantId),
          eq(conversations.id, input.conversationId),
          eq(
            conversations.agentReplyWindowStartedAt,
            input.windowStartedAt,
          ),
        ),
      );
  });
}

// ---------------------------------------------------------------------------
// Ringkasan handoff
// ---------------------------------------------------------------------------

export type HandoffSummaryOutcome =
  | { status: "created"; noteId: string }
  | { status: "unavailable"; reason: string }
  /** Provider tidak disediakan pemanggil — ringkasan dilewati secara desain. */
  | { status: "skipped" };

const SUMMARY_SYSTEM_PROMPT =
  "Kamu meringkas satu percakapan layanan pelanggan untuk diserahkan ke agen manusia. " +
  "Tulis ringkasan SINGKAT dalam Bahasa Indonesia (maksimal 120 kata) berbentuk poin-poin pendek yang mencakup: " +
  "(1) kebutuhan atau masalah utama pelanggan; " +
  "(2) fakta penting yang sudah diketahui (nama, produk, jumlah, tenggat, nomor pesanan — hanya yang benar-benar muncul di percakapan, jangan mengarang); " +
  "(3) status terakhir dan langkah berikutnya yang perlu dilakukan manusia. " +
  "Jangan menyapa, jangan menawarkan bantuan, keluarkan hanya isi ringkasannya.";

/** Label pembicara transkrip ringkasan — peran dibaca dari arah + pengirim. */
function transcriptLabel(direction: string, senderType: string): string {
  if (direction === "inbound") return "Pelanggan";
  return senderType === "agent" ? "Agen AI" : "Tim";
}

/**
 * Menghasilkan ringkasan handoff dan menempelkannya sebagai catatan
 * internal percakapan. TIDAK PERNAH melempar: setiap kegagalan
 * (riwayat kosong, provider error/timeout, respons kosong, catatan
 * gagal) menjadi outcome 'unavailable' beralasan — handoff pemanggil
 * sudah terjadi dan tidak bergantung pada fungsi ini.
 */
export async function generateHandoffSummary(
  db: Database,
  provider: LlmProvider,
  input: {
    tenantId: string;
    agentId: string;
    /** Model dari konfigurasi agent; kosong = default provider. */
    model?: string;
    conversationId: string;
    reason: string;
  },
): Promise<HandoffSummaryOutcome> {
  try {
    const rows = await withTenantDb(db, input.tenantId, async (tx) => {
      return tx
        .select({
          direction: messages.direction,
          senderType: messages.senderType,
          contentText: messages.contentText,
        })
        .from(messages)
        .where(
          and(
            eq(messages.tenantId, input.tenantId),
            eq(messages.conversationId, input.conversationId),
          ),
        )
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(SUMMARY_HISTORY_LIMIT);
    });
    const lines = rows
      .reverse()
      .filter((m) => (m.contentText ?? "").trim().length > 0)
      .map(
        (m) =>
          `${transcriptLabel(m.direction, m.senderType)}: ${(m.contentText ?? "").trim()}`,
      );
    if (lines.length === 0) {
      return { status: "unavailable", reason: "no_messages" };
    }

    const result = await provider.chat({
      system: SUMMARY_SYSTEM_PROMPT,
      messages: [{ role: "user", content: lines.join("\n") }],
      // Tanpa tool: ringkasan adalah generasi teks murni; tool call
      // apa pun dari provider diabaikan.
      tools: [],
      model: input.model || undefined,
    });
    const summary = result.text.trim().slice(0, SUMMARY_MAX_CHARS);
    if (!summary) return { status: "unavailable", reason: "empty_summary" };

    // Metering jujur dengan refType sendiri: token ringkasan BENAR-
    // BENAR terpakai, tetapi bukan "respons pelanggan" — refType
    // terpisah membuatnya tidak mengonsumsi cap harian dan tidak
    // tercampur agregat analytics respons (pola yang sama seperti
    // playground memisahkan refType-nya).
    await withTenantDb(db, input.tenantId, async (tx) => {
      const meta: Record<string, unknown> = {
        agentId: input.agentId,
        provider: result.provider,
        model: result.model,
        tokensIn: result.usage.tokensIn,
        tokensOut: result.usage.tokensOut,
        kind: "handoff_summary",
        conversationId: input.conversationId,
      };
      if (result.usage.costUsd !== undefined) {
        meta.costUsd = result.usage.costUsd;
        meta.costCurrency = "USD";
      }
      await tx.insert(usageLedger).values({
        tenantId: input.tenantId,
        type: "ai_token",
        qty: String(result.usage.tokensIn + result.usage.tokensOut),
        costModel: "0",
        costProvider: "0",
        currency: "IDR",
        refType: AGENT_HANDOFF_SUMMARY_REF_TYPE,
        refId: input.conversationId,
        meta,
      });
    });

    const note = await createAgentConversationNote(db, {
      tenantId: input.tenantId,
      agentId: input.agentId,
      conversationId: input.conversationId,
      body:
        `Ringkasan handoff otomatis (AI) — percakapan diserahkan ke tim manusia.\n` +
        `Alasan: ${input.reason.trim() ? input.reason.trim() : "—"}\n\n${summary}`,
      via: "agent_handoff_summary",
    });
    if (note.kind !== "created") {
      return { status: "unavailable", reason: note.kind };
    }
    return { status: "created", noteId: note.note.id };
  } catch (err) {
    return {
      status: "unavailable",
      reason: (err instanceof Error ? err.message : String(err)).slice(0, 200),
    };
  }
}

// ---------------------------------------------------------------------------
// Handoff bersama: matikan AI + audit + ringkasan gagal-aman
// ---------------------------------------------------------------------------

export interface HandoffToHumanResult {
  handedOff: boolean;
  summary: HandoffSummaryOutcome;
}

/**
 * SATU-SATUNYA jalur handoff agent: mematikan AI pada percakapan
 * (`conversations.agent_enabled=false`, saklar yang sama sejak Fase
 * 1D) + audit `agent.handoff`, lalu — bila pemanggil menyediakan
 * provider — membuat ringkasan otomatis gagal-aman dan mencatat
 * hasilnya sebagai audit `agent.handoff_summary`. Dipakai tool
 * `handoff_to_human` (via 'agent_tool') dan pemicu cap per percakapan
 * (via 'conversation_cap') agar semantik handoff tidak pernah
 * menyimpang antar pemicu. Ringkasan berjalan SESUDAH handoff
 * tercatat dan tidak bisa membatalkannya.
 */
export async function handoffConversationToHuman(
  db: Database,
  provider: LlmProvider | null,
  input: {
    tenantId: string;
    agentId: string;
    /** Model dari konfigurasi agent (untuk panggilan ringkasan). */
    model?: string;
    conversationId: string;
    contactId: string;
    reason: string;
    via: string;
  },
): Promise<HandoffToHumanResult> {
  const handedOff = await withTenantDb(db, input.tenantId, async (tx) => {
    const [row] = await tx
      .update(conversations)
      .set({ agentEnabled: false, updatedAt: new Date() })
      .where(
        and(
          eq(conversations.tenantId, input.tenantId),
          eq(conversations.id, input.conversationId),
        ),
      )
      .returning({ id: conversations.id });
    if (!row) return false;
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "agent",
      actorId: `agent:${input.agentId}`,
      action: "agent.handoff",
      meta: {
        reason: input.reason,
        contactId: input.contactId,
        conversationId: input.conversationId,
        via: input.via,
      },
    });
    return true;
  });
  if (!handedOff) return { handedOff: false, summary: { status: "skipped" } };
  if (!provider) return { handedOff: true, summary: { status: "skipped" } };

  const summary = await generateHandoffSummary(db, provider, {
    tenantId: input.tenantId,
    agentId: input.agentId,
    model: input.model,
    conversationId: input.conversationId,
    reason: input.reason,
  });
  // Jejak hasil ringkasan (best-effort: kegagalan menulis audit ini
  // tidak mengubah hasil handoff maupun ringkasan).
  await withTenantDb(db, input.tenantId, async (tx) => {
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "agent",
      actorId: `agent:${input.agentId}`,
      action: "agent.handoff_summary",
      meta: {
        conversationId: input.conversationId,
        contactId: input.contactId,
        via: input.via,
        ...(summary.status === "created"
          ? { status: "created", noteId: summary.noteId }
          : summary.status === "unavailable"
            ? { status: "unavailable", reason: summary.reason }
            : { status: "skipped" }),
      },
    });
  }).catch(() => undefined);
  return { handedOff: true, summary };
}
