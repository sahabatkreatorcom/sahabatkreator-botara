import { and, asc, eq, gt, gte, ne, sql } from "drizzle-orm";
import {
  auditLogs,
  agentSuggestions,
  contacts,
  conversations,
  messages,
  outboxEvents,
  usageLedger,
  type Agent,
  type Database,
} from "@sahabat-kreator/db";
import {
  AGENT_TOOLS,
  createLlmProvider,
  isPipelineStage,
  type EmbeddingProvider,
  type LlmChatMessage,
  type LlmChatResult,
  type LlmProvider,
  type LlmToolCall,
} from "@sahabat-kreator/ai";
import type { TenantContext } from "./tenant";
import { withTenantDb, type DbTx } from "./tx";
import { getActiveAgent, getAgent } from "./agents";
import { buildAgentCatalogContext } from "./commerce";
import { listMessages } from "./conversations";
import { searchKbChunks, type KbSearchHit } from "./kb";
import { embedKbQueryText } from "./kb-embeddings";
import {
  resolveOpenRouterConfig,
  type PlatformSettingsOptions,
} from "./platform-settings";
import {
  buildPaymentUrl,
  createPaymentLink,
  matchActiveProductForPayment,
} from "./products";
import type { PaymentDeps } from "./payments";

/**
 * Runtime AI Agent (Fase 3A, RANCANGAN §5.1 langkah 5–9).
 * Transport-agnostic: dipanggil worker lewat job `agent.respond` SETELAH
 * evaluasi automation selesai tanpa tembakan (urutan pasti: keyword dulu,
 * AI kemudian — penegakannya di worker, lihat apps/worker).
 *
 * Alur `respondToInboundMessage`:
 * 1. Muat pemicu + percakapan + kontak dalam konteks RLS tenant. Hanya
 *    pesan inbound dari kontak (sender_type='contact') yang dijawab, dan
 *    hanya bila percakapan masih mengizinkan AI
 *    (`conversations.agent_enabled` — kolom Fase 1D; tool handoff
 *    mematikannya, sesuai catatan di schema/agents.ts).
 * 2. Batching (Fase 9A, hanya bila `yieldToNewerMessage`): ada pesan
 *    masuk kontak yang lebih baru di percakapan yang sama → menyerah
 *    (audit `agent.batched`) agar satu rentetan pesan hanya dijawab
 *    sekali oleh job pesan terbarunya.
 * 3. Cek caps harian tenant (AGENT_DAILY_RESPONSE_CAP respons/hari dari
 *    usage_ledger; lewat → audit `agent.capped`, tidak menjawab).
 * 4. Rakit konteks: prompt sistem agent + riwayat 20 pesan terakhir +
 *    retrieval KB untuk teks pesan pemicu (full-text top 5; HIBRIDA
 *    full-text + vektor sejak Fase 12D bila pemanggil menyerahkan
 *    provider embedding aktif — kegagalan embedding kueri jatuh ke
 *    full-text murni, tidak pernah menggagalkan jawaban).
 * 5. Panggil provider LLM (@sahabat-kreator/ai). Error/timeout provider →
 *    audit `agent.failed`, TIDAK ada pesan keluar, job tidak crash.
 * 6. Catat metering: usage_ledger type='ai_token' (qty = total token;
 *    rincian agent/provider/model/token in-out + biaya aktual provider
 *    bila dilaporkan ada di kolom `meta` sejak Fase 9B) + audit
 *    `agent.responded` dengan rincian yang sama.
 * 7. Mode 'auto': tool dieksekusi, lalu teks balasan menjadi pesan
 *    outbound sender_type='agent' berstatus 'queued' + event outbox
 *    `message.queued` (pengiriman sungguhan oleh poller API seperti
 *    automation — worker tidak menyentuh transport).
 *    Mode 'suggest': teks + tool yang DIUSULKAN disimpan sebagai
 *    agent_suggestions 'pending'; TIDAK ada pesan keluar dan TIDAK ada
 *    tool yang dieksekusi (approve manusia pun hanya mengirim teks —
 *    lihat suggestions.ts).
 */

export const AGENT_DAILY_RESPONSE_CAP = 200;
/** refType pada usage_ledger untuk satu respons agent (dasar hitung caps). */
export const AGENT_USAGE_REF_TYPE = "agent_response";

const HISTORY_LIMIT = 20;
const KB_HIT_LIMIT = 5;

/**
 * Normalisasi tag dari argumen tool `tag_contact` — bentuk kanonis yang
 * benar-benar akan tersimpan di kontak (huruf kecil, spasi → tanda
 * hubung, hanya [a-z0-9-_], maks 64). Dipakai executor sungguhan DAN
 * playground (Fase 12E) agar "niat" yang ditampilkan dashboard persis
 * sama dengan yang akan dieksekusi runtime.
 */
export function normalizeAgentTag(raw: unknown): string {
  const value = typeof raw === "string" ? raw : "";
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-_]/g, "")
    .slice(0, 64);
}

// ---------------------------------------------------------------------------
// Executor tool — diekspor terpisah agar bisa diuji integrasi langsung
// (mis. jalur handoff yang tidak pernah dipicu MockProvider).
// ---------------------------------------------------------------------------

export interface AgentToolContext {
  agentId: string;
  contactId: string;
  conversationId: string;
}

export interface AgentToolOutcome {
  name: string;
  executed: boolean;
  /** Kode hasil stabil: 'tagged', 'tag_already_present', 'stage_moved', 'handoff_done', 'invalid_tag', 'invalid_stage', 'contact_not_found', 'unknown_tool', 'payment_link_sent', 'payment_link_sent_fallback_product', 'no_active_product', ... */
  note: string;
}

export interface AgentToolOptions {
  /**
   * Base URL publik aplikasi (env BETTER_AUTH_URL, diteruskan worker) —
   * dipakai tool `send_payment_link` untuk merangkai URL /pay/:code yang
   * dikirim ke lawan bicara. Kosong → URL relatif (fallback jujur).
   */
  publicBaseUrl?: string;
  /**
   * Dependensi gerbang pembayaran (Fase 14A) untuk tool
   * `send_payment_link`: secret enkripsi + override base URL provider.
   * Tanpa ini tool hanya berhasil bila provider tenant 'simulation'.
   */
  payments?: PaymentDeps;
}

async function insertAgentAudit(
  tx: DbTx,
  tenantId: string,
  agentId: string,
  action: string,
  meta: Record<string, unknown>,
): Promise<void> {
  await tx.insert(auditLogs).values({
    tenantId,
    actorType: "agent",
    actorId: `agent:${agentId}`,
    action,
    meta,
  });
}

/**
 * Mengeksekusi SATU tool call agent terhadap data tenant (RLS aktif).
 * Tidak pernah melempar untuk input tool yang buruk — hasil buruk dicatat
 * sebagai outcome executed=false agar loop tetap berjalan.
 */
export async function executeAgentToolCall(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  toolCtx: AgentToolContext,
  call: LlmToolCall,
  options?: AgentToolOptions,
): Promise<AgentToolOutcome> {
  const { tenantId } = ctx;

  if (call.name === "tag_contact") {
    const tag = normalizeAgentTag(call.arguments.tag);
    if (!tag) return { name: call.name, executed: false, note: "invalid_tag" };
    return withTenantDb(db, tenantId, async (tx) => {
      const [contact] = await tx
        .select()
        .from(contacts)
        .where(
          and(
            eq(contacts.tenantId, tenantId),
            eq(contacts.id, toolCtx.contactId),
          ),
        )
        .limit(1);
      if (!contact) {
        return { name: call.name, executed: false, note: "contact_not_found" };
      }
      if (contact.tags.includes(tag)) {
        return {
          name: call.name,
          executed: false,
          note: "tag_already_present",
        };
      }
      await tx
        .update(contacts)
        .set({ tags: [...contact.tags, tag], updatedAt: new Date() })
        .where(eq(contacts.id, contact.id));
      await insertAgentAudit(tx, tenantId, toolCtx.agentId, "contact.tagged", {
        tag,
        contactId: contact.id,
        conversationId: toolCtx.conversationId,
        via: "agent_tool",
      });
      return { name: call.name, executed: true, note: "tagged" };
    });
  }

  if (call.name === "move_pipeline_stage") {
    const stage = call.arguments.stage;
    if (!isPipelineStage(stage)) {
      return { name: call.name, executed: false, note: "invalid_stage" };
    }
    return withTenantDb(db, tenantId, async (tx) => {
      const [contact] = await tx
        .select()
        .from(contacts)
        .where(
          and(
            eq(contacts.tenantId, tenantId),
            eq(contacts.id, toolCtx.contactId),
          ),
        )
        .limit(1);
      if (!contact) {
        return { name: call.name, executed: false, note: "contact_not_found" };
      }
      const from = contact.pipelineStage;
      await tx
        .update(contacts)
        .set({ pipelineStage: stage, updatedAt: new Date() })
        .where(eq(contacts.id, contact.id));
      await insertAgentAudit(
        tx,
        tenantId,
        toolCtx.agentId,
        "contact.stage_changed",
        {
          from,
          to: stage,
          contactId: contact.id,
          conversationId: toolCtx.conversationId,
          via: "agent_tool",
        },
      );
      return { name: call.name, executed: true, note: "stage_moved" };
    });
  }

  if (call.name === "handoff_to_human") {
    const reason =
      typeof call.arguments.reason === "string"
        ? call.arguments.reason.slice(0, 500)
        : "";
    return withTenantDb(db, tenantId, async (tx) => {
      const [updated] = await tx
        .update(conversations)
        .set({ agentEnabled: false, updatedAt: new Date() })
        .where(
          and(
            eq(conversations.tenantId, tenantId),
            eq(conversations.id, toolCtx.conversationId),
          ),
        )
        .returning({ id: conversations.id });
      if (!updated) {
        return {
          name: call.name,
          executed: false,
          note: "conversation_not_found",
        };
      }
      await insertAgentAudit(tx, tenantId, toolCtx.agentId, "agent.handoff", {
        reason,
        contactId: toolCtx.contactId,
        conversationId: toolCtx.conversationId,
        via: "agent_tool",
      });
      return { name: call.name, executed: true, note: "handoff_done" };
    });
  }

  if (call.name === "send_payment_link") {
    // Fase 4A: buat tautan bayar (snapshot harga produk) lalu kirim sebagai
    // pesan outbound agent TERPISAH dari teks balasan utama — tautan adalah
    // artefak yang harus bisa dilacak status bayarnya sendiri.
    // CATATAN JUJUR: provider tautan fase ini 'simulation' — belum ada
    // gerbang pembayaran sungguhan; halaman /pay berlabel simulasi.
    const query =
      typeof call.arguments.productName === "string"
        ? call.arguments.productName
        : undefined;
    const match = await matchActiveProductForPayment(db, ctx, query);
    if (!match) {
      return { name: call.name, executed: false, note: "no_active_product" };
    }
    const created = await createPaymentLink(
      db,
      ctx,
      {
        productId: match.product.id,
        contactId: toolCtx.contactId,
        conversationId: toolCtx.conversationId,
      },
      { actorType: "agent", actorId: `agent:${toolCtx.agentId}` },
      {
        ...options?.payments,
        publicBaseUrl: options?.payments?.publicBaseUrl ?? options?.publicBaseUrl,
      },
    );
    if (created.kind !== "ok") {
      return { name: call.name, executed: false, note: created.kind };
    }
    const url = buildPaymentUrl(options?.publicBaseUrl, created.link.code);
    const text = `Link pembayaran ${match.product.name}: ${url} (berlaku 7 hari)`;
    const sent = await withTenantDb(db, tenantId, async (tx) => {
      const [conversation] = await tx
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.tenantId, tenantId),
            eq(conversations.id, toolCtx.conversationId),
          ),
        )
        .limit(1);
      if (!conversation) return false;
      const [outbound] = await tx
        .insert(messages)
        .values({
          tenantId,
          conversationId: toolCtx.conversationId,
          direction: "outbound",
          senderType: "agent",
          type: "text",
          contentText: text,
          status: "queued",
        })
        .returning();
      const now = new Date();
      await tx
        .update(conversations)
        .set({ lastMessageAt: now, updatedAt: now })
        .where(eq(conversations.id, toolCtx.conversationId));
      await tx.insert(outboxEvents).values({
        tenantId,
        type: "message.queued",
        payload: {
          provider: conversation.provider,
          conversationId: toolCtx.conversationId,
          messageId: outbound.id,
          via: "agent_tool",
          tool: "send_payment_link",
          agentId: toolCtx.agentId,
          paymentLinkId: created.link.id,
        },
      });
      // Jejak eksplisit pilihan produk agent (termasuk jalur fallback ke
      // produk aktif pertama) — di luar audit payment_link.created generik.
      await insertAgentAudit(tx, tenantId, toolCtx.agentId, "agent.payment_link", {
        paymentLinkId: created.link.id,
        code: created.link.code,
        productId: match.product.id,
        productName: match.product.name,
        matchedByName: match.matchedByName,
        query: query ?? null,
        contactId: toolCtx.contactId,
        conversationId: toolCtx.conversationId,
        via: "agent_tool",
      });
      return true;
    });
    if (!sent) {
      return { name: call.name, executed: false, note: "conversation_not_found" };
    }
    return {
      name: call.name,
      executed: true,
      note: match.matchedByName
        ? "payment_link_sent"
        : "payment_link_sent_fallback_product",
    };
  }

  return { name: call.name, executed: false, note: "unknown_tool" };
}

// ---------------------------------------------------------------------------
// Jalur bersama: rakit draft balasan (prompt + retrieval + provider)
// ---------------------------------------------------------------------------

/**
 * Prompt sistem agent — SATU-SATUNYA tempat string ini dirakit. Dipakai
 * loop runtime (`respondToInboundMessage`) dan playground (Fase 12E)
 * lewat `generateAgentDraft`, supaya uji kering di dashboard tidak
 * pernah menyimpang dari perilaku produksi (risiko drift prompt).
 */
export function buildAgentSystemPrompt(agent: Agent): string {
  const languageLine = agent.config.language
    ? `\nBahasa balasan: ${agent.config.language}.`
    : "\nJawab mengikuti bahasa lawan bicara.";
  return (
    `${agent.systemPrompt.trim()}${languageLine}\n` +
    "Kamu adalah agent layanan pelanggan. Jawab ringkas dan hanya berdasarkan fakta dari basis pengetahuan bila tersedia; jangan mengarang harga/fakta. " +
    "Kamu boleh memakai tool tag_contact, move_pipeline_stage, send_payment_link (bila kontak ingin membeli), dan handoff_to_human bila relevan."
  );
}

export interface AgentDraft {
  /** Teks balasan final (trim + dipotong config.maxReplyChars; boleh kosong). */
  text: string;
  /** Tool call yang diusulkan model — BELUM dieksekusi di sini. */
  toolCalls: LlmToolCall[];
  /** Potongan KB yang dipakai sebagai konteks (sudah terpotong top-N). */
  hits: KbSearchHit[];
  /** Mode retrieval yang benar-benar terjadi: 'hybrid' hanya bila vektor kueri berhasil dibuat. */
  retrieval: "hybrid" | "fts";
  /** Hasil mentah provider (provider/model/usage final untuk metering). */
  result: LlmChatResult;
}

/**
 * Menghasilkan SATU draft balasan agent: retrieval KB untuk teks pemicu
 * (hibrida full-text + vektor bila provider embedding aktif — kegagalan
 * embedding kueri jatuh ke full-text murni, tidak pernah menggagalkan),
 * rakit prompt, panggil provider LLM. TIDAK menulis apa pun selain usage
 * panggilan embedding kueri (baris `kb_embedding` lewat embedKbQueryText)
 * dan TIDAK mengeksekusi tool — keputusan eksekusi/pengiriman adalah
 * milik pemanggil (runtime mengeksekusi & mengantrekan pesan; playground
 * hanya melaporkan niat). Error provider DILEMPAR ke pemanggil.
 */
export async function generateAgentDraft(
  db: Database,
  provider: LlmProvider,
  input: {
    tenantId: string;
    agent: Agent;
    /** Riwayat kronologis siap kirim (role sudah dipetakan); pesan terakhir = pemicu. */
    messages: LlmChatMessage[];
    /** Teks acuan retrieval KB + embedding kueri (biasanya isi pesan pemicu). */
    retrievalText: string;
    /** Provider embedding aktif proses pemanggil; null/absen = full-text murni. */
    embeddingProvider?: EmbeddingProvider | null;
    /** refId baris usage `kb_embedding` untuk panggilan kueri ini. */
    usageRefId?: string | null;
  },
): Promise<AgentDraft> {
  const { tenantId, agent } = input;
  const ctx = { tenantId };

  // Fase 12D: embed kueri SEKALI bila provider embedding aktif; error
  // provider apa pun (jaringan, model, dimensi) ditelan di sini dan
  // pencarian berjalan full-text murni — retrieval tidak boleh
  // menggagalkan jawaban agent. Usage panggilan kueri dicatat
  // embedKbQueryText sebagai baris kb_embedding (bukan agent_response,
  // jadi tidak menyentuh cap harian).
  let queryEmbedding: number[] | null = null;
  if (input.embeddingProvider && input.retrievalText.trim().length > 0) {
    try {
      queryEmbedding = await embedKbQueryText(db, input.embeddingProvider, {
        tenantId,
        text: input.retrievalText,
        refId: input.usageRefId ?? null,
      });
    } catch {
      queryEmbedding = null;
    }
  }
  const hits = await searchKbChunks(db, ctx, input.retrievalText, KB_HIT_LIMIT, {
    queryEmbedding,
  });

  // Fase 13F: konteks katalog produk aktif disisipkan ke prompt
  // sistem — akses BACA katalog agent. Runtime berjalan satu
  // completion tanpa putaran hasil-tool, jadi tool baca tidak akan
  // pernah dilihat model pada balasan yang sama; konteks prompt
  // adalah jalur baca yang nyata. Kegagalan baca katalog TIDAK boleh
  // menggagalkan balasan (ditelan → tanpa konteks katalog).
  const catalogContext = await buildAgentCatalogContext(db, ctx).catch(
    () => null,
  );

  const result = await provider.chat({
    system:
      buildAgentSystemPrompt(agent) +
      (catalogContext ? `\n${catalogContext}` : ""),
    messages: input.messages,
    tools: AGENT_TOOLS,
    kbChunks: hits.map((h) => h.content),
    model: agent.model || undefined,
  });

  let text = result.text.trim();
  const maxChars = agent.config.maxReplyChars;
  if (maxChars && text.length > maxChars) text = text.slice(0, maxChars);

  return {
    text,
    toolCalls: result.toolCalls,
    hits,
    retrieval: queryEmbedding ? "hybrid" : "fts",
    result,
  };
}

// ---------------------------------------------------------------------------
// Loop utama
// ---------------------------------------------------------------------------

export type AgentSkipReason =
  | "message_not_found"
  | "not_inbound"
  | "not_from_contact"
  | "conversation_not_found"
  | "channel_conversation"
  | "ai_disabled"
  | "no_active_agent"
  | "batched"
  | "capped"
  | "provider_error"
  | "empty_response";

export interface AgentRespondResult {
  responded: boolean;
  reason?: AgentSkipReason;
  mode?: "auto" | "suggest";
  outboundMessageId?: string;
  suggestionId?: string;
  toolOutcomes?: AgentToolOutcome[];
}

async function recordUsageAndAudit(
  db: Database,
  tenantId: string,
  input: {
    agentId: string;
    triggerMessageId: string;
    tokensIn: number;
    tokensOut: number;
    /** Provider & model hasil panggilan (dari LlmChatResult). */
    provider: string;
    model: string;
    /** Biaya aktual USD dari provider — undefined bila tidak dilaporkan. */
    costUsd?: number;
    auditMeta: Record<string, unknown>;
    extra?: (tx: DbTx) => Promise<void>;
  },
): Promise<void> {
  await withTenantDb(db, tenantId, async (tx) => {
    if (input.extra) await input.extra(tx);
    // Rincian metering (Fase 9B, kolom usage_ledger.meta — migrasi 0034):
    // agent/provider/model + token masuk/keluar per respons, agar dasbor
    // /analytics bisa mengagregasi per agent & per hari. `qty` tetap total
    // token (sumber hitung cap harian). Biaya HANYA bila provider
    // melaporkannya (costUsd dari LlmChatResult) — disimpan sebagai
    // meta.costUsd + costCurrency 'USD', TIDAK memakai kolom cost_model
    // yang berdenominasi IDR.
    const usageMeta: Record<string, unknown> = {
      agentId: input.agentId,
      provider: input.provider,
      model: input.model,
      tokensIn: input.tokensIn,
      tokensOut: input.tokensOut,
    };
    if (input.costUsd !== undefined) {
      usageMeta.costUsd = input.costUsd;
      usageMeta.costCurrency = "USD";
    }
    await tx.insert(usageLedger).values({
      tenantId,
      type: "ai_token",
      qty: String(input.tokensIn + input.tokensOut),
      costModel: "0",
      costProvider: "0",
      currency: "IDR",
      refType: AGENT_USAGE_REF_TYPE,
      refId: input.triggerMessageId,
      meta: usageMeta,
    });
    await insertAgentAudit(tx, tenantId, input.agentId, "agent.responded", {
      triggerMessageId: input.triggerMessageId,
      tokensIn: input.tokensIn,
      tokensOut: input.tokensOut,
      ...(input.costUsd !== undefined ? { costUsd: input.costUsd } : {}),
      ...input.auditMeta,
    });
  });
}

export async function respondToInboundMessage(
  db: Database,
  provider: LlmProvider,
  input: {
    tenantId: string;
    conversationId: string;
    messageId: string;
    /**
     * Provider embedding aktif proses pemanggil (Fase 12D; di-resolve
     * worker per job, panel → env). Null/absen = retrieval full-text
     * murni seperti sebelum 12D.
     */
    embeddingProvider?: EmbeddingProvider | null;
    /** Base URL publik untuk tool send_payment_link (dari env worker). */
    publicBaseUrl?: string;
    /** Dependensi gerbang pembayaran (Fase 14A) untuk tool send_payment_link. */
    payments?: PaymentDeps;
    /**
     * Batching balasan AI (Fase 9A): bila true, job ini MENYERAH
     * (audit `agent.batched`, reason 'batched', TANPA memanggil LLM
     * dan TANPA mengonsumsi cap) bila ada pesan masuk kontak yang
     * LEBIH BARU di percakapan yang sama — job milik pesan terbaru
     * yang akan menjawab, dan riwayat dibaca saat eksekusi sehingga
     * jawabannya mencakup seluruh rentetan. Hanya dinyalakan jalur
     * job `agent.respond` (yang memang dijadwalkan worker dengan
     * delay jendela batch); node flow `ai_response` TIDAK menyalakan
     * ini — jalur flow tidak berubah.
     */
    yieldToNewerMessage?: boolean;
  },
): Promise<AgentRespondResult> {
  const { tenantId, conversationId, messageId } = input;
  const ctx = { tenantId };

  // 1. Muat konteks pemicu.
  const loaded = await withTenantDb(db, tenantId, async (tx) => {
    const [message] = await tx
      .select()
      .from(messages)
      .where(and(eq(messages.tenantId, tenantId), eq(messages.id, messageId)))
      .limit(1);
    if (!message) return { kind: "message_not_found" as const };
    if (message.direction !== "inbound") return { kind: "not_inbound" as const };
    if (message.senderType !== "contact") {
      return { kind: "not_from_contact" as const };
    }
    const [conversation] = await tx
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.tenantId, tenantId),
          eq(conversations.id, conversationId),
        ),
      )
      .limit(1);
    if (!conversation) return { kind: "conversation_not_found" as const };
    // PENJAGA CHANNEL (Fase 6A.2): postingan channel siaran bukan pesan
    // percakapan — agent TIDAK PERNAH menjawabnya. Jalur ingest channel
    // tidak menulis event outbox, jadi ini lapis kedua untuk event liar
    // (pasangan penjaga yang sama di evaluateInboundMessageForAutomations).
    if (conversation.kind === "channel") {
      return { kind: "channel_conversation" as const };
    }
    if (!conversation.agentEnabled) return { kind: "ai_disabled" as const };
    return { kind: "ok" as const, message, conversation };
  });
  if (loaded.kind !== "ok") return { responded: false, reason: loaded.kind };
  const { message, conversation } = loaded;

  // 2. Agent aktif tenant (tertua).
  const agent = await getActiveAgent(db, ctx);
  if (!agent) return { responded: false, reason: "no_active_agent" };

  // 2b. Batching (Fase 9A): kontak yang mengirim beberapa pesan
  // beruntun hanya dijawab SEKALI — oleh job pesan terbarunya. Job
  // yang pesannya sudah disusul pesan masuk yang lebih baru di
  // percakapan yang sama menyerah di sini: sebelum cek cap dan
  // sebelum panggilan LLM, jadi cap tidak terhitung ganda dan tidak
  // ada biaya model yang terbuang.
  if (input.yieldToNewerMessage) {
    const supersededBy = await withTenantDb(db, tenantId, async (tx) => {
      const [newer] = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.tenantId, tenantId),
            eq(messages.conversationId, conversationId),
            eq(messages.direction, "inbound"),
            eq(messages.senderType, "contact"),
            // Pesan pemicu sendiri WAJIB dikecualikan: createdAt di
            // Postgres berpresisi mikrodetik sedangkan Date JS hanya
            // milidetik (terpotong saat dibaca), jadi perbandingan
            // `>` polos bisa mencocokkan baris pemicu itu sendiri —
            // job pesan terakhir pun ikut menyerah (bug Fase 9A yang
            // tertangkap rantai staging: supersededBy == trigger).
            ne(messages.id, messageId),
            gt(messages.createdAt, message.createdAt),
          ),
        )
        .orderBy(asc(messages.createdAt))
        .limit(1);
      return newer?.id ?? null;
    });
    if (supersededBy) {
      await withTenantDb(db, tenantId, async (tx) => {
        await insertAgentAudit(tx, tenantId, agent.id, "agent.batched", {
          conversationId,
          triggerMessageId: messageId,
          supersededByMessageId: supersededBy,
        });
      });
      return { responded: false, reason: "batched" };
    }
  }

  // 3. Caps harian (hari berjalan UTC, dari usage_ledger).
  const usedToday = await withTenantDb(db, tenantId, async (tx) => {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(usageLedger)
      .where(
        and(
          eq(usageLedger.tenantId, tenantId),
          eq(usageLedger.type, "ai_token"),
          eq(usageLedger.refType, AGENT_USAGE_REF_TYPE),
          // Cap harian dipatok UTC eksplisit (semua kode ai-usage.ts):
          // date_trunc('day', now()) polos mengikuti TimeZone server
          // Postgres dan diam-diam menggeser jendela cap bila TZ bukan UTC.
          gte(
            usageLedger.createdAt,
            sql`(date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`,
          ),
        ),
      );
    return row?.n ?? 0;
  });
  if (usedToday >= AGENT_DAILY_RESPONSE_CAP) {
    await withTenantDb(db, tenantId, async (tx) => {
      await insertAgentAudit(tx, tenantId, agent.id, "agent.capped", {
        conversationId,
        triggerMessageId: messageId,
        cap: AGENT_DAILY_RESPONSE_CAP,
        usedToday,
      });
    });
    return { responded: false, reason: "capped" };
  }

  // 4+5. Riwayat → draft balasan lewat jalur bersama (retrieval KB dari
  // teks pesan pemicu + prompt + provider). Error provider dicatat
  // sebagai audit `agent.failed`, tidak pernah melempar keluar.
  const history = (await listMessages(db, ctx, conversationId, {
    limit: HISTORY_LIMIT,
  })) ?? [];
  const triggerText = message.contentText ?? "";
  let draft: AgentDraft;
  try {
    draft = await generateAgentDraft(db, provider, {
      tenantId,
      agent,
      messages: history
        .filter((m) => (m.contentText ?? "").trim().length > 0)
        .map((m) => ({
          role:
            m.direction === "inbound"
              ? ("user" as const)
              : ("assistant" as const),
          content: m.contentText ?? "",
        })),
      retrievalText: triggerText,
      embeddingProvider: input.embeddingProvider,
      usageRefId: messageId,
    });
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err);
    await withTenantDb(db, tenantId, async (tx) => {
      await insertAgentAudit(tx, tenantId, agent.id, "agent.failed", {
        conversationId,
        triggerMessageId: messageId,
        provider: provider.name,
        error: errorText.slice(0, 500),
      });
    }).catch(() => undefined);
    return { responded: false, reason: "provider_error" };
  }

  const { result, hits } = draft;
  const text = draft.text;
  const auditMeta = {
    agentId: agent.id,
    provider: result.provider,
    model: result.model,
    conversationId,
    kbChunkIds: hits.map((h) => h.chunkId),
    // Fase 12D: mode retrieval yang benar-benar terjadi pada respons
    // ini ('hybrid' hanya bila vektor kueri berhasil dibuat DAN
    // pencarian memakainya) — jejak jujur untuk debug kualitas KB.
    retrieval: draft.retrieval,
  };

  if (!text && result.toolCalls.length === 0) {
    // Tetap catat metering (token terpakai) tetapi tidak mengirim apa pun.
    await recordUsageAndAudit(db, tenantId, {
      agentId: agent.id,
      triggerMessageId: messageId,
      tokensIn: result.usage.tokensIn,
      tokensOut: result.usage.tokensOut,
      provider: result.provider,
      model: result.model,
      costUsd: result.usage.costUsd,
      auditMeta: { ...auditMeta, mode: agent.mode, emptyResponse: true },
    });
    return { responded: false, reason: "empty_response", mode: agent.mode };
  }

  // 6a. Mode suggest: simpan draf; tool TIDAK dieksekusi.
  if (agent.mode === "suggest") {
    let suggestionId: string | undefined;
    await recordUsageAndAudit(db, tenantId, {
      agentId: agent.id,
      triggerMessageId: messageId,
      tokensIn: result.usage.tokensIn,
      tokensOut: result.usage.tokensOut,
      provider: result.provider,
      model: result.model,
      costUsd: result.usage.costUsd,
      auditMeta: {
        ...auditMeta,
        mode: "suggest",
        proposedToolCalls: result.toolCalls.map((c) => c.name),
      },
      extra: async (tx) => {
        const [row] = await tx
          .insert(agentSuggestions)
          .values({
            tenantId,
            agentId: agent.id,
            conversationId,
            triggerMessageId: messageId,
            contactId: conversation.contactId,
            suggestedText: text,
            status: "pending",
            detail: {
              toolCalls: result.toolCalls,
              provider: result.provider,
              model: result.model,
              tokensIn: result.usage.tokensIn,
              tokensOut: result.usage.tokensOut,
            },
          })
          .returning();
        suggestionId = row.id;
      },
    });
    return { responded: true, mode: "suggest", suggestionId };
  }

  // 6b. Mode auto: eksekusi tool, lalu kirim teks sebagai pesan queued.
  const toolCtx: AgentToolContext = {
    agentId: agent.id,
    contactId: conversation.contactId,
    conversationId,
  };
  const toolOutcomes: AgentToolOutcome[] = [];
  for (const call of result.toolCalls) {
    toolOutcomes.push(
      await executeAgentToolCall(db, ctx, toolCtx, call, {
        publicBaseUrl: input.publicBaseUrl,
        payments: input.payments,
      }),
    );
  }

  let outboundMessageId: string | undefined;
  await recordUsageAndAudit(db, tenantId, {
    agentId: agent.id,
    triggerMessageId: messageId,
    tokensIn: result.usage.tokensIn,
    tokensOut: result.usage.tokensOut,
    provider: result.provider,
    model: result.model,
    costUsd: result.usage.costUsd,
    auditMeta: {
      ...auditMeta,
      mode: "auto",
      toolOutcomes,
    },
    extra: async (tx) => {
      if (!text) return;
      const [outbound] = await tx
        .insert(messages)
        .values({
          tenantId,
          conversationId,
          direction: "outbound",
          senderType: "agent",
          type: "text",
          contentText: text,
          status: "queued",
        })
        .returning();
      outboundMessageId = outbound.id;
      const now = new Date();
      await tx
        .update(conversations)
        .set({ lastMessageAt: now, updatedAt: now })
        .where(eq(conversations.id, conversationId));
      await tx.insert(outboxEvents).values({
        tenantId,
        type: "message.queued",
        payload: {
          provider: conversation.provider,
          conversationId,
          messageId: outbound.id,
          via: "agent",
          agentId: agent.id,
        },
      });
    },
  });

  return {
    responded: true,
    mode: "auto",
    outboundMessageId,
    toolOutcomes,
  };
}

// ---------------------------------------------------------------------------
// Resolusi provider LLM agent (dipakai proses API untuk playground)
// ---------------------------------------------------------------------------

export interface AgentLlmResolutionOptions {
  /** Opsi resolver Panel Admin proses ini; absen = tanpa panel (env saja). */
  platform?: PlatformSettingsOptions;
  /** Nilai env LLM_PROVIDER proses ini: 'mock' | 'openrouter' | undefined. */
  providerEnv?: string;
}

/**
 * Provider LLM efektif untuk jalur agent di luar worker — semantik
 * PERSIS resolver worker (Fase 6C): kunci OpenRouter efektif (Panel →
 * env) ada → OpenRouter; tidak ada kunci → provider dari env
 * (bawaan mock); LLM_PROVIDER=openrouter eksplisit tanpa kunci →
 * createLlmProvider MELEMPAR (salah konfigurasi gagal keras, tidak
 * diam-diam jatuh ke mock). Pemanggil API menangkap lemparan itu
 * sebagai 502 AGENT_PROVIDER_ERROR.
 */
export async function resolveAgentLlmProvider(
  db: Database,
  opts: AgentLlmResolutionOptions,
): Promise<LlmProvider> {
  const orConfig = opts.platform
    ? await resolveOpenRouterConfig(db, opts.platform)
    : null;
  return createLlmProvider({
    provider: orConfig ? "openrouter" : opts.providerEnv,
    openrouterApiKey: orConfig?.apiKey,
    openrouterModel: orConfig?.model,
  });
}

// ---------------------------------------------------------------------------
// Playground (Fase 12E) — uji kering agent dari dashboard
// ---------------------------------------------------------------------------

/** refType usage_ledger untuk satu lari playground (TERPISAH dari cap & analytics). */
export const AGENT_PLAYGROUND_USAGE_REF_TYPE = "agent_playground";

/**
 * Niat tool: bentuk terstruktur dari tool call model untuk playground.
 * Ini yang AKAN dilakukan executor sungguhan — tag sudah ternormalisasi
 * dengan fungsi yang sama, dan produk tautan bayar dicocokkan BACA-SAJA
 * dengan pencocokan yang sama — tetapi tidak ada satu pun yang ditulis.
 */
export type AgentPlaygroundIntent =
  | { kind: "add_tag"; tag: string }
  | { kind: "set_stage"; stage: string | null }
  | { kind: "handoff"; reason: string | null }
  | {
      kind: "create_payment_link";
      productId: string | null;
      productName: string | null;
      query: string | null;
    }
  | { kind: "unknown"; toolName: string };

export interface AgentPlaygroundUsageSummary {
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  /** Biaya aktual USD dari provider; undefined bila tidak dilaporkan. */
  costUsd?: number;
}

export type AgentPlaygroundOutcome =
  | {
      kind: "ok";
      agentId: string;
      mode: "auto" | "suggest";
      replyText: string;
      kbHits: KbSearchHit[];
      intents: AgentPlaygroundIntent[];
      retrieval: "hybrid" | "fts";
      usage: AgentPlaygroundUsageSummary;
    }
  | { kind: "agent_not_found" }
  | { kind: "provider_error"; error: string };

/** Satu tool call model → satu niat playground (pencocokan produk = baca-saja). */
async function toPlaygroundIntent(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  call: LlmToolCall,
): Promise<AgentPlaygroundIntent> {
  if (call.name === "tag_contact") {
    const raw = typeof call.arguments.tag === "string" ? call.arguments.tag : "";
    return { kind: "add_tag", tag: normalizeAgentTag(raw) || raw.trim().slice(0, 64) };
  }
  if (call.name === "move_pipeline_stage") {
    return {
      kind: "set_stage",
      stage: typeof call.arguments.stage === "string" ? call.arguments.stage : null,
    };
  }
  if (call.name === "handoff_to_human") {
    return {
      kind: "handoff",
      reason:
        typeof call.arguments.reason === "string"
          ? call.arguments.reason.slice(0, 500)
          : null,
    };
  }
  if (call.name === "send_payment_link") {
    const query =
      typeof call.arguments.productName === "string"
        ? call.arguments.productName
        : null;
    const match = await matchActiveProductForPayment(db, ctx, query ?? undefined);
    return {
      kind: "create_payment_link",
      productId: match?.product.id ?? null,
      productName: match?.product.name ?? null,
      query,
    };
  }
  return { kind: "unknown", toolName: call.name };
}

/**
 * Satu lari PLAYGROUND untuk agent TERTENTU (dipilih pemilik di
 * dashboard — berbeda dari runtime yang selalu memakai agent aktif
 * tertua). Memakai jalur bersama `generateAgentDraft`, jadi prompt,
 * retrieval hibrida, dan pemanggilan provider identik dengan produksi.
 *
 * Jaminan kering (keras):
 * - tool call TIDAK dieksekusi — hanya dipetakan menjadi niat;
 * - tidak ada baris percakapan/pesan/kontak/saran/tautan bayar ditulis;
 * - cap 200 respons/hari TIDAK tersentuh (cap menghitung refType
 *   `agent_response` saja);
 * - pemakaian token TETAP tercatat jujur sebagai baris usage_ledger
 *   refType `agent_playground` (meta.playground=true) — terpisah dari
 *   agregat analytics Fase 9B yang menyaring `agent_response`.
 *
 * Riwayat percakapan berasal dari klien (hanya hidup di browser) dan
 * diperlakukan sebagai konteks uji, bukan data tenant.
 */
/**
 * Ekor bersama playground: menjalankan SATU lari uji kering untuk
 * record agent yang SUDAH dimuat/dibangun pemanggil — dipakai
 * `runAgentPlayground` (agent tersimpan) dan
 * `runAgentPlaygroundDraft` (agent sintetis di memori). Jalur ini
 * tidak pernah mengembalikan `agent_not_found`: keberadaan agent
 * adalah tanggung jawab pemanggil. `draft: true` menandai baris
 * usage lari draf (meta.draft) agar bisa dibedakan dari lari agent
 * tersimpan tanpa mengubah refType playground.
 */
async function runPlaygroundForAgent(
  db: Database,
  provider: LlmProvider,
  input: {
    tenantId: string;
    agent: Agent;
    message: string;
    history?: Array<{ role: "user" | "assistant"; content: string }>;
    embeddingProvider?: EmbeddingProvider | null;
    draft?: boolean;
  },
): Promise<AgentPlaygroundOutcome> {
  const { tenantId, agent } = input;
  const ctx = { tenantId };

  const runId = crypto.randomUUID();
  const historyMessages: LlmChatMessage[] = (input.history ?? [])
    .filter((m) => m.content.trim().length > 0)
    .slice(-(HISTORY_LIMIT - 1))
    .map((m) => ({ role: m.role, content: m.content }));

  let draft: AgentDraft;
  try {
    draft = await generateAgentDraft(db, provider, {
      tenantId,
      agent,
      messages: [...historyMessages, { role: "user", content: input.message }],
      retrievalText: input.message,
      embeddingProvider: input.embeddingProvider,
      usageRefId: runId,
    });
  } catch (err) {
    return {
      kind: "provider_error",
      error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
    };
  }

  const intents: AgentPlaygroundIntent[] = [];
  for (const call of draft.toolCalls) {
    intents.push(await toPlaygroundIntent(db, ctx, call));
  }

  const { result } = draft;
  const usage: AgentPlaygroundUsageSummary = {
    provider: result.provider,
    model: result.model,
    tokensIn: result.usage.tokensIn,
    tokensOut: result.usage.tokensOut,
    ...(result.usage.costUsd !== undefined
      ? { costUsd: result.usage.costUsd }
      : {}),
  };

  // Metering jujur: token playground benar-benar terpakai di provider,
  // jadi dicatat — dengan refType & penanda sendiri agar tidak pernah
  // tercampur hitungan respons pelanggan (cap & analytics).
  await withTenantDb(db, tenantId, async (tx) => {
    const meta: Record<string, unknown> = {
      agentId: agent.id,
      provider: usage.provider,
      model: usage.model,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      playground: true,
      mode: agent.mode,
      ...(input.draft ? { draft: true } : {}),
    };
    if (usage.costUsd !== undefined) {
      meta.costUsd = usage.costUsd;
      meta.costCurrency = "USD";
    }
    await tx.insert(usageLedger).values({
      tenantId,
      type: "ai_token",
      qty: String(usage.tokensIn + usage.tokensOut),
      costModel: "0",
      costProvider: "0",
      currency: "IDR",
      refType: AGENT_PLAYGROUND_USAGE_REF_TYPE,
      refId: runId,
      meta,
    });
  });

  return {
    kind: "ok",
    agentId: agent.id,
    mode: agent.mode,
    replyText: draft.text,
    kbHits: draft.hits,
    intents,
    retrieval: draft.retrieval,
    usage,
  };
}

export async function runAgentPlayground(
  db: Database,
  provider: LlmProvider,
  input: {
    tenantId: string;
    agentId: string;
    message: string;
    history?: Array<{ role: "user" | "assistant"; content: string }>;
    embeddingProvider?: EmbeddingProvider | null;
  },
): Promise<AgentPlaygroundOutcome> {
  const agent = await getAgent(db, { tenantId: input.tenantId }, input.agentId);
  if (!agent) return { kind: "agent_not_found" };
  return runPlaygroundForAgent(db, provider, {
    tenantId: input.tenantId,
    agent,
    message: input.message,
    history: input.history,
    embeddingProvider: input.embeddingProvider,
  });
}

/**
 * Satu lari PLAYGROUND untuk konfigurasi DRAF (gelombang Templat
 * Instruction): isi formulir buat/edit agent saat ini, sebelum agent
 * tersimpan. Record agent SINTETIS dibangun di memori saja (id acak,
 * tidak aktif, tidak pernah ditulis ke tabel `agents`) lalu dijalankan
 * lewat ekor bersama yang sama persis dengan playground tersimpan —
 * prompt, retrieval, niat tool, dan jaminan keringnya identik.
 * Perbedaannya hanya pada metering: baris usage playground untuk lari
 * draf membawa penanda tambahan `draft: true` di meta. Karena agent
 * sintetis selalu "ada", `agent_not_found` tidak mungkin di jalur ini.
 */
export async function runAgentPlaygroundDraft(
  db: Database,
  provider: LlmProvider,
  input: {
    tenantId: string;
    draft: {
      name?: string;
      systemPrompt: string;
      model?: string;
      mode?: "auto" | "suggest";
      language?: string | null;
    };
    message: string;
    history?: Array<{ role: "user" | "assistant"; content: string }>;
    embeddingProvider?: EmbeddingProvider | null;
  },
): Promise<AgentPlaygroundOutcome> {
  const now = new Date();
  const agent: Agent = {
    id: crypto.randomUUID(),
    tenantId: input.tenantId,
    name: input.draft.name ?? "",
    systemPrompt: input.draft.systemPrompt,
    model: input.draft.model ?? "",
    mode: input.draft.mode ?? "suggest",
    isActive: false,
    config: input.draft.language ? { language: input.draft.language } : {},
    createdAt: now,
    updatedAt: now,
  };
  return runPlaygroundForAgent(db, provider, {
    tenantId: input.tenantId,
    agent,
    message: input.message,
    history: input.history,
    embeddingProvider: input.embeddingProvider,
    draft: true,
  });
}
