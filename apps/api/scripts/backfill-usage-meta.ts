/**
 * Run-once backfill rincian usage AI (Fase 9B): mengisi
 * `usage_ledger.meta` untuk baris `ai_token` warisan (pra-9B, meta '{}')
 * dari meta audit `agent.responded` — sumber yang dicatat pada momen
 * yang sama dengan baris ledger-nya oleh `recordUsageAndAudit`:
 * audit.meta.triggerMessageId == usage_ledger.ref_id, tenant sama.
 *
 * Aturan ketat (idempoten, aman dijalankan berulang):
 * - hanya baris type='ai_token' + ref_type='agent_response' dengan
 *   meta PERSIS '{}' yang menjadi kandidat; baris yang sudah berincian
 *   tidak pernah ditimpa (penjaga di WHERE update juga);
 * - meta yang dibangun: { agentId, provider, model, tokensIn,
 *   tokensOut } dari audit terbaru yang cocok. agentId diambil dari
 *   meta audit; cadangan dari actor_id audit berbentuk 'agent:<uuid>'.
 * - biaya TIDAK di-backfill: audit lama memang tidak mencatat biaya
 *   provider, dan mengarangnya dari tabel harga dilarang oleh desain
 *   9B. Baris hasil backfill tetap tanpa costUsd — dasbor menampilkan
 *   cakupan biaya apa adanya.
 * - baris tanpa audit yang cocok dibiarkan '{}' dan dilaporkan.
 *
 * Koneksi: skrip membaca audit/ledger lintas tenant (pemilik platform
 * mengisi data tenant-tenantnya sendiri) — jalankan dengan
 * `MIGRATION_DATABASE_URL` (role migrasi; pola yang sama seperti
 * backfill:reply-snapshots). Dengan `DATABASE_URL` biasa (sk_app, RLS)
 * skrip hanya akan melaporkan 0 kandidat.
 *
 * Jalankan dari server staging (env dari .env.staging):
 *   set -a; . ./.env.staging; set +a
 *   pnpm --filter @sahabat-kreator/api backfill:usage-meta
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { auditLogs, createDb, usageLedger } from "@sahabat-kreator/db";

const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    "[backfill:usage-meta] MIGRATION_DATABASE_URL (atau DATABASE_URL) wajib diisi",
  );
}
const { db, pool } = createDb(url);

try {
  const candidates = await db
    .select({
      id: usageLedger.id,
      tenantId: usageLedger.tenantId,
      refId: usageLedger.refId,
    })
    .from(usageLedger)
    .where(
      and(
        eq(usageLedger.type, "ai_token"),
        eq(usageLedger.refType, "agent_response"),
        sql`${usageLedger.meta} = '{}'::jsonb`,
      ),
    );

  let filled = 0;
  let noAudit = 0;
  for (const row of candidates) {
    if (!row.refId) {
      noAudit += 1;
      continue;
    }
    const [audit] = await db
      .select({ meta: auditLogs.meta, actorId: auditLogs.actorId })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.tenantId, row.tenantId),
          eq(auditLogs.action, "agent.responded"),
          sql`${auditLogs.meta}->>'triggerMessageId' = ${row.refId}`,
        ),
      )
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);
    if (!audit) {
      noAudit += 1;
      continue;
    }
    const meta = (audit.meta ?? {}) as Record<string, unknown>;
    const built: Record<string, unknown> = {};
    const agentId =
      typeof meta.agentId === "string"
        ? meta.agentId
        : typeof audit.actorId === "string" && audit.actorId.startsWith("agent:")
          ? audit.actorId.slice("agent:".length)
          : null;
    if (agentId) built.agentId = agentId;
    if (typeof meta.provider === "string") built.provider = meta.provider;
    if (typeof meta.model === "string") built.model = meta.model;
    if (typeof meta.tokensIn === "number") built.tokensIn = meta.tokensIn;
    if (typeof meta.tokensOut === "number") built.tokensOut = meta.tokensOut;
    if (Object.keys(built).length === 0) {
      noAudit += 1;
      continue;
    }
    const updated = await db
      .update(usageLedger)
      .set({ meta: built })
      .where(
        and(
          eq(usageLedger.id, row.id),
          sql`${usageLedger.meta} = '{}'::jsonb`,
        ),
      )
      .returning({ id: usageLedger.id });
    if (updated.length > 0) filled += 1;
  }

  console.log(
    `[backfill:usage-meta] kandidat=${candidates.length} terisi=${filled} tanpa-audit-cocok=${noAudit}`,
  );
} finally {
  await pool.end();
}
