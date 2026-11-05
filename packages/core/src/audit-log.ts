import {
  and,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import {
  agents,
  apiKeys,
  auditLogs,
  users,
  type AuditLog as AuditLogRow,
  type Database,
} from "@sahabat-kreator/db";
import { withTenantDb, type DbTx } from "./tx";

/**
 * Penelusur log audit (Fase 7B.4) — lapisan BACA di atas `audit_logs`.
 * Tabel itu sudah ditulis di mana-mana sejak Fase 1A (aksi user,
 * runtime agent, komponen sistem, API publik, dan aksi platform
 * ber-tenant NULL) tetapi sampai fase ini tidak punya permukaan baca.
 * Modul ini MURNI membaca: tidak ada penulisan audit baru di sini.
 *
 * Taksonomi NYATA (dipetakan dari seluruh pemanggil insert auditLogs
 * di packages/core — bukan karangan):
 * - actor_type: `user` | `agent` | `system` | `api_key` (persis enum
 *   DB). `api_key` hanya muncul pada `message.queued` dari API publik.
 * - action per kategori (awalan sebelum titik pertama): tenant,
 *   channel, message, automation, sequence, agent, contact
 *   (`contact.tagged`/`contact.stage_changed` — aksi TOOL agent,
 *   actor-nya tetap `agent`), payment_link, payment, api_key,
 *   telegram, integration, platform_settings (tenant NULL),
 *   conversation (Fase 9C: assigned/unassigned/note_created/
 *   note_deleted), team (Fase 9C: invited/invitation_revoked/
 *   member_joined/role_changed/member_removed) dan kb_document
 *   (Fase 12C: uploaded/deleted — meta sourceDocumentId menunjuk
 *   berkas lampiran KB di kb_source_documents).
 * - meta: id referensi + fakta berkode per action. Penulis audit secara
 *   eksplisit TIDAK menulis rahasia (token/secret tidak pernah masuk
 *   meta; platform_settings hanya menulis nama kunci). Satu-satunya
 *   nilai yang bersifat pengenal publik: `code` tautan bayar pada
 *   payment_link.created/agent.payment_link — memang URL publik
 *   /pay/:code yang juga tampil di UI Produk.
 *
 * Akses (ditegakkan di lapisan API): daftar tenant = owner/admin saja
 * (selaras log integrasi — meta audit menyangkut operasi workspace);
 * baris platform (tenant_id NULL) hanya lewat transaksi ber-flag
 * `app.platform_settings='admin'` (policy `platform_audit`, pola 0022)
 * untuk sesi admin platform, dan TIDAK pernah tercampur ke daftar
 * tenant mana pun (daftar tenant selalu men-filter tenant_id = tenant).
 */

export type AuditActorType = "user" | "agent" | "system" | "api_key";

export interface AuditLogTarget {
  type: string;
  id: string;
}

export interface AuditLogEntry {
  id: string;
  tenantId: string | null;
  actorType: AuditActorType;
  actorId: string | null;
  actorLabel: string | null;
  action: string;
  category: string;
  target: AuditLogTarget | null;
  meta: Record<string, unknown>;
  createdAt: Date;
}

export interface ListAuditLogsInput {
  actorType?: AuditActorType;
  /** Awalan action (kategori taksonomi); dicocokkan sebagai `kategori.%`. */
  category?: string;
  /** Pencarian substring bebas pada kolom action (wildcard di-escape). */
  q?: string;
  from?: string;
  to?: string;
  /** Kursor opaque dari halaman sebelumnya. */
  cursor?: string;
  /** Default 50, maksimum 100. */
  limit?: number;
}

export interface AuditLogPage {
  entries: AuditLogEntry[];
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Transaksi platform (pola withPlatformLogTx di integration-log.ts)
// ---------------------------------------------------------------------------

async function withPlatformAuditTx<T>(
  db: Database,
  fn: (tx: DbTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.platform_settings', 'admin', true)`,
    );
    return fn(tx as unknown as DbTx);
  });
}

// ---------------------------------------------------------------------------
// Turunan tampilan: kategori + target ringkas dari meta
// ---------------------------------------------------------------------------

/** Kategori = awalan action sebelum titik pertama (`payment_link.created` → `payment_link`). */
export function auditActionCategory(action: string): string {
  const dot = action.indexOf(".");
  return dot > 0 ? action.slice(0, dot) : action;
}

/**
 * Urutan prioritas kunci meta → jenis target. Kunci yang lebih spesifik
 * didahulukan (mis. `paymentLinkId` mengalahkan `conversationId` pada
 * payment_link.created; `enrollmentId` mengalahkan `automationId` pada
 * sequence.*). Hanya nilai string non-kosong yang dipakai.
 */
const TARGET_KEYS: ReadonlyArray<readonly [string, string]> = [
  // Fase 12C: kb_document.* menargetkan berkas sumbernya.
  ["sourceDocumentId", "kb_document"],
  // whatsappTemplateId didahulukan: meta whatsapp_template.* membawa
  // juga channelAccountId, dan target utamanya adalah templatenya.
  ["whatsappTemplateId", "whatsapp_template"],
  // flowRunId/flowId didahulukan: meta flow.* membawa keduanya
  // (run_started/run_completed/run_failed/run_cancelled → target run;
  // created/updated/activated/deactivated hanya membawa flowId).
  ["flowRunId", "flow_run"],
  ["flowId", "flow"],
  ["savedReplyId", "saved_reply"],
  // Fase 9C: aksi tim menargetkan undangan/member; noteId sebelum
  // conversationId agar aksi catatan menargetkan catatannya sendiri.
  ["invitationId", "invitation"],
  ["memberUserId", "member"],
  ["noteId", "conversation_note"],
  // broadcastId didahulukan dari channelAccountId: meta broadcast.*
  // membawa keduanya, dan target utamanya adalah broadcast-nya.
  ["broadcastId", "broadcast"],
  ["channelAccountId", "channel_account"],
  ["paymentLinkId", "payment_link"],
  ["apiKeyId", "api_key"],
  ["suggestionId", "agent_suggestion"],
  ["enrollmentId", "sequence_enrollment"],
  ["automationId", "automation"],
  ["agentId", "agent"],
  ["messageId", "message"],
  ["conversationId", "conversation"],
  ["productId", "product"],
  ["contactId", "contact"],
  ["sourceLogId", "integration_log"],
  ["key", "platform_setting"],
];

export function deriveAuditTarget(
  meta: Record<string, unknown>,
): AuditLogTarget | null {
  for (const [metaKey, type] of TARGET_KEYS) {
    const value = meta[metaKey];
    if (typeof value === "string" && value.length > 0) {
      return { type, id: value };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Resolusi actor → label tampil
// ---------------------------------------------------------------------------

/**
 * Resolve label actor untuk SATU halaman baris, per jenis, dalam
 * transaksi yang sama (satu query per jenis — bukan N+1):
 * - user → nama (fallback email) dari tabel users global;
 * - api_key → `nama kunci · prefix` dari api_keys tenant ini;
 * - agent → nama agent dari actorId berbentuk `agent:<uuid>`;
 * - system → actorId itu sendiri (nama komponen yang jujur:
 *   `whatsapp-webhook`, `channel-purge`, `pay-page-simulation`, …).
 * Yang tidak ter-resolve (user/agent/kunci sudah terhapus) → null;
 * pemanggil menampilkan actorId mentah apa adanya.
 */
async function resolveActorLabels(
  tx: DbTx,
  rows: AuditLogRow[],
): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  const userIds = new Set<string>();
  const apiKeyIds = new Set<string>();
  const agentIds = new Set<string>();
  for (const row of rows) {
    if (!row.actorId) continue;
    if (row.actorType === "user") userIds.add(row.actorId);
    else if (row.actorType === "api_key") apiKeyIds.add(row.actorId);
    else if (row.actorType === "agent" && row.actorId.startsWith("agent:")) {
      agentIds.add(row.actorId.slice("agent:".length));
    } else if (row.actorType === "system") {
      labels.set(`system:${row.actorId}`, row.actorId);
    }
  }
  if (userIds.size > 0) {
    const found = await tx
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(inArray(users.id, [...userIds]));
    for (const u of found) {
      labels.set(
        `user:${u.id}`,
        u.name && u.name.trim().length > 0 ? u.name : u.email,
      );
    }
  }
  if (apiKeyIds.size > 0) {
    const found = await tx
      .select({ id: apiKeys.id, name: apiKeys.name, keyPrefix: apiKeys.keyPrefix })
      .from(apiKeys)
      .where(inArray(apiKeys.id, [...apiKeyIds]));
    for (const k of found) {
      labels.set(
        `api_key:${k.id}`,
        k.keyPrefix ? `${k.name} · ${k.keyPrefix}` : k.name,
      );
    }
  }
  if (agentIds.size > 0) {
    const found = await tx
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(inArray(agents.id, [...agentIds]));
    for (const a of found) {
      labels.set(`agent:agent:${a.id}`, a.name);
    }
  }
  return labels;
}

// ---------------------------------------------------------------------------
// Kueri halaman (kursor (createdAt, id) menurun — pola log integrasi)
// ---------------------------------------------------------------------------

interface AuditCursor {
  createdAt: string;
  id: string;
}

function encodeAuditCursor(row: AuditLogRow): string {
  const raw: AuditCursor = {
    createdAt: row.createdAt.toISOString(),
    id: row.id,
  };
  return Buffer.from(JSON.stringify(raw), "utf8").toString("base64url");
}

function decodeAuditCursor(cursor: string | undefined): AuditCursor | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Partial<AuditCursor>;
    if (
      typeof parsed.createdAt === "string" &&
      typeof parsed.id === "string" &&
      !Number.isNaN(Date.parse(parsed.createdAt))
    ) {
      return { createdAt: parsed.createdAt, id: parsed.id };
    }
  } catch {
    // Kursor rusak → diperlakukan sebagai halaman pertama (pola logs).
  }
  return null;
}

function clampAuditLimit(limit: number | undefined): number {
  if (!limit || Number.isNaN(limit)) return 50;
  return Math.min(100, Math.max(1, Math.floor(limit)));
}

/** Escape wildcard LIKE/ILIKE agar `q` benar-benar substring literal. */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

async function queryAuditPage(
  tx: DbTx,
  input: ListAuditLogsInput,
  scope: { kind: "tenant"; tenantId: string } | { kind: "platform" },
): Promise<AuditLogPage> {
  const limit = clampAuditLimit(input.limit);
  const conditions = [
    scope.kind === "tenant"
      ? eq(auditLogs.tenantId, scope.tenantId)
      : isNull(auditLogs.tenantId),
  ];
  if (input.actorType) {
    conditions.push(eq(auditLogs.actorType, input.actorType));
  }
  if (input.category) {
    // Kategori berasal dari enum kontrak (pola [a-z_]+ terkendali) —
    // aman dirangkai sebagai pola awalan.
    conditions.push(sql`${auditLogs.action} LIKE ${`${input.category}.%`}`);
  }
  if (input.q) {
    conditions.push(
      ilike(auditLogs.action, `%${escapeLikePattern(input.q)}%`),
    );
  }
  if (input.from) {
    const from = new Date(input.from);
    if (!Number.isNaN(from.getTime())) {
      conditions.push(gte(auditLogs.createdAt, from));
    }
  }
  if (input.to) {
    const to = new Date(input.to);
    if (!Number.isNaN(to.getTime())) {
      conditions.push(lte(auditLogs.createdAt, to));
    }
  }
  const cursor = decodeAuditCursor(input.cursor);
  if (cursor) {
    const cursorDate = new Date(cursor.createdAt);
    conditions.push(
      or(
        lt(auditLogs.createdAt, cursorDate),
        and(eq(auditLogs.createdAt, cursorDate), lt(auditLogs.id, cursor.id)),
      )!,
    );
  }
  const rows = await tx
    .select()
    .from(auditLogs)
    .where(and(...conditions))
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const labels = await resolveActorLabels(tx, pageRows);
  return {
    entries: pageRows.map((row) => {
      const meta = (row.meta ?? {}) as Record<string, unknown>;
      return {
        id: row.id,
        tenantId: row.tenantId,
        actorType: row.actorType as AuditActorType,
        actorId: row.actorId,
        actorLabel: row.actorId
          ? (labels.get(`${row.actorType}:${row.actorId}`) ?? null)
          : null,
        action: row.action,
        category: auditActionCategory(row.action),
        target: deriveAuditTarget(meta),
        meta,
        createdAt: row.createdAt,
      };
    }),
    nextCursor: hasMore
      ? encodeAuditCursor(pageRows[pageRows.length - 1])
      : null,
  };
}

/** Daftar audit milik satu tenant (konteks RLS tenant; terbaru dulu). */
export async function listTenantAuditLogs(
  db: Database,
  tenantId: string,
  input: ListAuditLogsInput = {},
): Promise<AuditLogPage> {
  return withTenantDb(db, tenantId, (tx) =>
    queryAuditPage(tx, input, { kind: "tenant", tenantId }),
  );
}

/**
 * Daftar audit tingkat platform (tenant_id NULL — aksi
 * `platform_settings.*` admin platform). Hanya transaksi ber-flag
 * admin; baris bertenant TIDAK pernah ikut (filter IS NULL eksplisit +
 * policy `platform_audit`).
 */
export async function listPlatformAuditLogs(
  db: Database,
  input: ListAuditLogsInput = {},
): Promise<AuditLogPage> {
  return withPlatformAuditTx(db, (tx) =>
    queryAuditPage(tx, input, { kind: "platform" }),
  );
}
