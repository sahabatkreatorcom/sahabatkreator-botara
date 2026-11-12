/**
 * Pemicu webhook MASUK flow (G17 butir 1) — sisi core.
 *
 * Satu flow yang trigger-nya berjenis `webhook` dipanggil dari sistem
 * luar lewat POST /api/webhooks/flow/<endpointId> (modul API publik
 * `flow-webhooks`). Modul ini memegang tiga hal:
 *
 * 1. KREDENSIAL (panel builder, konteks tenant): provision/rotasi/
 *    hapus baris `flow_webhook_endpoints`. Token diterbitkan server
 *    (`fwh_` + 32 byte acak), disimpan HANYA sebagai hash SHA-256
 *    (pola `hashApiKey` api-keys), dan nilai terangnya dikembalikan
 *    SATU KALI oleh provision/rotasi — tidak ada jalur baca ulang.
 *    Rotasi menimpa hash seketika: token lama mati pada pemanggilan
 *    berikutnya.
 * 2. RESOLUSI PUBLIK (tanpa konteks tenant): baris ditemukan lewat
 *    lengan RLS `flow_webhook_lookup` (migrasi 0040) — transaksi
 *    men-set GUC `app.flow_webhook_token_hash` ke hash token yang
 *    disodorkan; hash salah / endpoint tidak ada sama-sama
 *    menghasilkan NOL baris, sehingga lapisan API menjawab 404 yang
 *    identik untuk keduanya (eksistensi flow tidak bocor).
 * 3. MULAI RUN: payload JSON menentukan kontak sasaran pada akun
 *    channel config trigger (contactId → externalId → phone → email;
 *    externalId/phone/email yang belum dikenal MELAHIRKAN kontak —
 *    sistem luar memang mendorong prospek baru — sedangkan contactId
 *    yang tidak dikenal adalah penolakan, bukan tebakan). Percakapan
 *    privat pada akun itu ditemukan (yang terbaru belum tertutup)
 *    atau dibuat. Run lahir TANPA pesan pemicu (trigger_message_id
 *    NULL, pola run goto_flow), ter-pin ke versi terbaru flow, dengan
 *    payload di `context.webhook` — tersedia bagi langkah berikutnya
 *    lewat keluarga templat mesin yang SUDAH ada ({{payload:<path>}}
 *    di renderFlowHttpTemplate, di samping {{field:<key>}}).
 *    Gerbang keselamatan yang setara kelas 0 trigger-priority untuk
 *    jalur luar-pita ini: kontak opt-out TIDAK memulai run.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  channelAccounts,
  channelIdentities,
  contacts,
  conversations,
  flowRuns,
  flowWebhookEndpoints,
  flows,
  outboxEvents,
  type Contact,
  type Database,
  type FlowWebhookEndpoint,
} from "@sahabat-kreator/db";
import { withTenantDb, type DbTx } from "../tx";
import { normalizeContactEmail, normalizeContactPhone } from "../contacts";
import { flowAudit } from "./crud";
import { firstNodeAfterTrigger, normalizeFlowGraph, triggerOf } from "./graph";
import { latestFlowVersion } from "./versions";

/** Batas ukuran payload webhook (byte JSON terserialisasi). */
export const FLOW_WEBHOOK_PAYLOAD_MAX_BYTES = 16_384;

const UUID_LIKE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Hash token webhook — SHA-256 hex, pola hashApiKey (api-keys.ts). */
export function hashFlowWebhookToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function generateFlowWebhookToken(): string {
  return `fwh_${randomBytes(32).toString("base64url")}`;
}

// ---------------------------------------------------------------------------
// Kredensial (konteks tenant — panel builder)
// ---------------------------------------------------------------------------

/** Baris endpoint flow ini (konteks tenant), atau null bila belum diprovision. */
export async function getFlowWebhookEndpoint(
  db: Database,
  tenantId: string,
  flowId: string,
): Promise<FlowWebhookEndpoint | null> {
  return withTenantDb(db, tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(flowWebhookEndpoints)
      .where(
        and(
          eq(flowWebhookEndpoints.tenantId, tenantId),
          eq(flowWebhookEndpoints.flowId, flowId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

/**
 * Provision ATAU rotasi token endpoint flow: baris dibuat bila belum
 * ada, hash-nya ditimpa bila sudah ada (token lama mati seketika).
 * Mengembalikan token TERANG satu kali — pemanggil (API) wajib
 * menampilkannya sekali dan tidak menyimpannya di mana pun.
 */
export async function provisionFlowWebhookEndpoint(
  db: Database,
  tenantId: string,
  flowId: string,
  actorUserId: string,
): Promise<{ endpoint: FlowWebhookEndpoint; token: string } | null> {
  const token = generateFlowWebhookToken();
  const tokenHash = hashFlowWebhookToken(token);
  const tokenPrefix = token.slice(0, 12);
  return withTenantDb(db, tenantId, async (tx) => {
    const [flow] = await tx
      .select({ id: flows.id })
      .from(flows)
      .where(and(eq(flows.tenantId, tenantId), eq(flows.id, flowId)))
      .limit(1);
    if (!flow) return null;
    const [existing] = await tx
      .select({ id: flowWebhookEndpoints.id })
      .from(flowWebhookEndpoints)
      .where(eq(flowWebhookEndpoints.flowId, flowId))
      .limit(1);
    const now = new Date();
    let endpoint: FlowWebhookEndpoint;
    if (existing) {
      const [updated] = await tx
        .update(flowWebhookEndpoints)
        .set({ tokenHash, tokenPrefix, updatedAt: now })
        .where(eq(flowWebhookEndpoints.id, existing.id))
        .returning();
      endpoint = updated;
    } else {
      const [inserted] = await tx
        .insert(flowWebhookEndpoints)
        .values({ tenantId, flowId, tokenHash, tokenPrefix })
        .returning();
      endpoint = inserted;
    }
    await flowAudit(tx, tenantId, {
      actorType: "user",
      actorId: actorUserId,
      action: existing
        ? "flow.webhook_token_rotated"
        : "flow.webhook_token_provisioned",
      flowId,
      meta: { endpointId: endpoint.id, tokenPrefix },
    });
    return { endpoint, token };
  });
}

/** Hapus endpoint flow (pemicu webhook berhenti menerima panggilan). */
export async function deleteFlowWebhookEndpoint(
  db: Database,
  tenantId: string,
  flowId: string,
  actorUserId: string,
): Promise<boolean> {
  return withTenantDb(db, tenantId, async (tx) => {
    const deleted = await tx
      .delete(flowWebhookEndpoints)
      .where(
        and(
          eq(flowWebhookEndpoints.tenantId, tenantId),
          eq(flowWebhookEndpoints.flowId, flowId),
        ),
      )
      .returning({ id: flowWebhookEndpoints.id });
    if (deleted.length === 0) return false;
    await flowAudit(tx, tenantId, {
      actorType: "user",
      actorId: actorUserId,
      action: "flow.webhook_token_deleted",
      flowId,
      meta: { endpointId: deleted[0].id },
    });
    return true;
  });
}

// ---------------------------------------------------------------------------
// Resolusi publik (tanpa konteks tenant — lengan RLS flow_webhook_lookup)
// ---------------------------------------------------------------------------

/**
 * Temukan endpoint dari (endpointId, token terang) TANPA konteks
 * tenant. Hash token yang disodorkan menjadi GUC transaksi; policy
 * `flow_webhook_lookup` hanya membuka baris yang hash-nya sama persis,
 * jadi endpoint tak dikenal dan token salah sama-sama null.
 */
export async function resolveFlowWebhookEndpoint(
  db: Database,
  endpointId: string,
  token: string,
): Promise<FlowWebhookEndpoint | null> {
  if (!UUID_LIKE.test(endpointId) || !token) return null;
  const tokenHash = hashFlowWebhookToken(token);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.flow_webhook_token_hash', ${tokenHash}, true)`,
    );
    const [row] = await tx
      .select()
      .from(flowWebhookEndpoints)
      .where(eq(flowWebhookEndpoints.id, endpointId))
      .limit(1);
    if (!row) return null;
    // Pertahanan berlapis: walau policy berubah kelak, hash tetap
    // dibandingkan konstan-waktu di sini.
    const a = Buffer.from(row.tokenHash, "utf8");
    const b = Buffer.from(tokenHash, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return row;
  });
}

// ---------------------------------------------------------------------------
// Payload + mulai run
// ---------------------------------------------------------------------------

export type FlowWebhookPayloadResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; reason: "not_an_object" | "too_large" };

/**
 * Validasi dasar payload: WAJIB objek JSON (bukan array/skalar) dan
 * tidak melebihi batas ukuran terserialisasi. Payload yang gagal di
 * sini TIDAK melahirkan run (keputusan brief).
 */
export function parseFlowWebhookPayload(
  raw: unknown,
): FlowWebhookPayloadResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "not_an_object" };
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(raw);
  } catch {
    return { ok: false, reason: "not_an_object" };
  }
  if (serialized.length > FLOW_WEBHOOK_PAYLOAD_MAX_BYTES) {
    return { ok: false, reason: "too_large" };
  }
  return { ok: true, payload: raw as Record<string, unknown> };
}

function payloadString(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Resolusi kontak sasaran payload pada akun channel trigger.
 * Urutan: contactId (uuid tenant ini — tak dikenal = null, BUKAN
 * buat baru) → externalId (identitas channel; tak dikenal = kontak
 * baru + identitas) → phone (normalisasi dedup kontak; tak dikenal =
 * kontak baru) → email (sda.). Nama kontak baru dari payload `name`
 * bila ada, selain itu label jujur "Kontak Webhook".
 */
async function resolveWebhookContact(
  tx: DbTx,
  tenantId: string,
  account: { id: string; provider: string },
  payload: Record<string, unknown>,
): Promise<Contact | null> {
  const contactId = payloadString(payload, "contactId");
  if (contactId && UUID_LIKE.test(contactId)) {
    const [contact] = await tx
      .select()
      .from(contacts)
      .where(
        and(eq(contacts.tenantId, tenantId), eq(contacts.id, contactId)),
      )
      .limit(1);
    return contact ?? null;
  }

  const name =
    payloadString(payload, "name")?.slice(0, 255) ?? "Kontak Webhook";
  const phoneRaw = payloadString(payload, "phone");
  const emailNorm = normalizeContactEmail(payloadString(payload, "email"));

  const externalId = payloadString(payload, "externalId");
  if (externalId) {
    const [identity] = await tx
      .select()
      .from(channelIdentities)
      .where(
        and(
          eq(channelIdentities.channelAccountId, account.id),
          eq(channelIdentities.externalUserId, externalId),
        ),
      )
      .limit(1);
    if (identity) {
      const [contact] = await tx
        .select()
        .from(contacts)
        .where(
          and(
            eq(contacts.tenantId, tenantId),
            eq(contacts.id, identity.contactId),
          ),
        )
        .limit(1);
      return contact ?? null;
    }
    const [contact] = await tx
      .insert(contacts)
      .values({
        tenantId,
        name,
        phone: phoneRaw,
        email: emailNorm,
      })
      .returning();
    await tx.insert(channelIdentities).values({
      tenantId,
      contactId: contact.id,
      channelAccountId: account.id,
      provider: account.provider as typeof channelIdentities.$inferInsert.provider,
      externalUserId: externalId,
    });
    return contact;
  }

  const phoneNorm = normalizeContactPhone(phoneRaw);
  if (phoneNorm) {
    // Bandingkan bentuk digit ternormalisasi di sisi SQL: nomor
    // tersimpan bisa berformat bebas ("0812…", "+62 812…"), jadi
    // regexp_replace menyamakan keduanya ke digit murni, lalu aturan
    // 0→62 yang sama seperti normalizeContactPhone diterapkan pemanggil
    // pada kandidat (phoneNorm sudah dalam bentuk 62…).
    const candidates = await tx
      .select()
      .from(contacts)
      .where(
        and(
          eq(contacts.tenantId, tenantId),
          sql`regexp_replace(${contacts.phone}, '\\D', '', 'g') IN (${phoneNorm}, ${phoneNorm.replace(/^62/, "0")})`,
        ),
      )
      .limit(5);
    const matched = candidates.find(
      (cnd) => normalizeContactPhone(cnd.phone) === phoneNorm,
    );
    if (matched) return matched;
    const [contact] = await tx
      .insert(contacts)
      .values({ tenantId, name, phone: phoneRaw, email: emailNorm })
      .returning();
    return contact;
  }

  if (emailNorm) {
    const [existing] = await tx
      .select()
      .from(contacts)
      .where(
        and(
          eq(contacts.tenantId, tenantId),
          sql`lower(${contacts.email}) = ${emailNorm}`,
        ),
      )
      .limit(1);
    if (existing) return existing;
    const [contact] = await tx
      .insert(contacts)
      .values({ tenantId, name, phone: null, email: emailNorm })
      .returning();
    return contact;
  }

  return null;
}

export type StartFlowWebhookRunResult =
  | { kind: "started"; runId: string }
  | { kind: "flow_not_active" }
  | { kind: "trigger_not_webhook" }
  | { kind: "channel_account_missing" }
  | { kind: "contact_unresolved" }
  | { kind: "contact_opted_out" };

/**
 * Mulai run untuk satu panggilan webhook yang SUDAH terautentikasi
 * (endpoint hasil resolveFlowWebhookEndpoint). Seluruhnya satu
 * transaksi tenant: resolusi kontak → percakapan → baris run ter-pin
 * versi terbaru → event outbox flow.step_due → cap last_triggered_at.
 */
export async function startFlowWebhookRun(
  db: Database,
  endpoint: FlowWebhookEndpoint,
  payload: Record<string, unknown>,
): Promise<StartFlowWebhookRunResult> {
  const { tenantId, flowId } = endpoint;
  return withTenantDb(db, tenantId, async (tx) => {
    const [flow] = await tx
      .select()
      .from(flows)
      .where(and(eq(flows.tenantId, tenantId), eq(flows.id, flowId)))
      .limit(1);
    if (!flow) return { kind: "flow_not_active" as const };
    // Graf yang menentukan trigger & node pertama = snapshot versi
    // terbaru (yang sama dengan yang akan dieksekusi run), jatuh ke
    // graf live untuk flow aktif warisan tanpa baris versi — pola
    // resolveRunGraph/goto_flow.
    const latest = await latestFlowVersion(tx, tenantId, flowId);
    const graph = normalizeFlowGraph(latest ? latest.graph : flow.graph);
    const trigger = triggerOf(graph);
    if (!trigger || trigger.config.kind !== "webhook") {
      return { kind: "trigger_not_webhook" as const };
    }
    if (flow.status !== "active") {
      return { kind: "flow_not_active" as const };
    }
    const channelAccountId =
      typeof trigger.config.channelAccountId === "string"
        ? trigger.config.channelAccountId
        : "";
    const [account] = await tx
      .select()
      .from(channelAccounts)
      .where(
        and(
          eq(channelAccounts.tenantId, tenantId),
          eq(channelAccounts.id, channelAccountId),
        ),
      )
      .limit(1);
    if (!account) return { kind: "channel_account_missing" as const };

    const contact = await resolveWebhookContact(
      tx,
      tenantId,
      { id: account.id, provider: account.provider },
      payload,
    );
    if (!contact) return { kind: "contact_unresolved" as const };
    if (contact.optInStatus === "opted_out") {
      return { kind: "contact_opted_out" as const };
    }

    const externalId = payloadString(payload, "externalId");
    const [existingConv] = await tx
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.tenantId, tenantId),
          eq(conversations.channelAccountId, account.id),
          eq(conversations.contactId, contact.id),
        ),
      )
      .orderBy(desc(conversations.createdAt))
      .limit(1);
    let conversationId: string;
    if (existingConv && existingConv.status !== "closed") {
      conversationId = existingConv.id;
    } else {
      const [conv] = await tx
        .insert(conversations)
        .values({
          tenantId,
          channelAccountId: account.id,
          contactId: contact.id,
          provider: account.provider,
          providerChatId:
            externalId ?? normalizeContactPhone(contact.phone) ?? null,
          kind: "private",
          status: "open",
        })
        .returning();
      conversationId = conv.id;
    }

    const firstNodeId = firstNodeAfterTrigger(graph);
    const now = new Date();
    const [run] = await tx
      .insert(flowRuns)
      .values({
        tenantId,
        flowId,
        flowVersionId: latest?.id ?? null,
        flowVersion: latest?.version ?? null,
        conversationId,
        contactId: contact.id,
        // Run webhook tidak dipicu pesan masuk (pola run goto_flow).
        triggerMessageId: null,
        status: firstNodeId ? "running" : "completed",
        currentNodeId: firstNodeId,
        nextStepSeq: 1,
        stepCount: 0,
        context: {
          triggerText: "",
          webhook: { receivedAt: now.toISOString(), payload },
        },
        completedAt: firstNodeId ? null : now,
      })
      .returning();
    await tx
      .update(flowWebhookEndpoints)
      .set({ lastTriggeredAt: now, updatedAt: now })
      .where(eq(flowWebhookEndpoints.id, endpoint.id));
    await flowAudit(tx, tenantId, {
      actorType: "system",
      actorId: `flow:${flowId}`,
      action: "flow.run_started",
      flowId,
      meta: {
        flowRunId: run.id,
        conversationId,
        via: "webhook",
        endpointId: endpoint.id,
        payloadKeys: Object.keys(payload).slice(0, 50),
        flowVersion: latest?.version ?? null,
      },
    });
    if (!firstNodeId) {
      await flowAudit(tx, tenantId, {
        actorType: "system",
        actorId: `flow:${flowId}`,
        action: "flow.run_completed",
        flowId,
        meta: { flowRunId: run.id, conversationId, reason: "empty_flow" },
      });
    } else {
      await tx.insert(outboxEvents).values({
        tenantId,
        type: "flow.step_due",
        payload: {
          runId: run.id,
          stepSeq: 1,
          resumeAt: now.toISOString(),
        },
      });
    }
    return { kind: "started" as const, runId: run.id };
  });
}
