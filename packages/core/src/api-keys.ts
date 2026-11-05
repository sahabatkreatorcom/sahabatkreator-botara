import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  apiKeys,
  auditLogs,
  tenants,
  type ApiKey,
  type Database,
} from "@sahabat-kreator/db";
import type { TenantContext } from "./tenant";
import { withTenantDb } from "./tx";

/**
 * Service domain API Keys & autentikasi API publik /v1 (Fase 5A,
 * RANCANGAN §5.4 & §7). Transport-agnostic; fondasi bagi SDK (Fase 5B)
 * dan MCP server (auth API Key per tenant + scope).
 *
 * Keputusan yang dijaga di sini:
 * - Format kunci: `sk_live_` + 43 karakter base64url dari 32 byte acak
 *   kriptografis. Yang disimpan HANYA hash SHA-256 (hex) + awalan tampil
 *   (`sk_live_` + 4 char pertama bagian acak). Kunci utuh dikembalikan
 *   SATU KALI dari createApiKey dan tidak pernah bisa dibaca lagi.
 * - Lookup publik by hash meniru pola siteKey webchat (0006) & code bayar
 *   (0012): transaksi men-set `app.api_key_hash` (transaction-local) dan
 *   policy `public_key_lookup` (0016, FOR SELECT) hanya membuka baris yang
 *   hash-nya sama persis. Menyajikan hash yang cocok = membuktikan
 *   kepemilikan kunci mentahnya; tidak ada baris tenant lain yang terbuka.
 * - Sesudah tenant ter-resolve dari baris kunci, SEMUA query berikutnya
 *   berjalan dalam konteks RLS tenant pemilik (withTenantDb) — kunci
 *   tenant A secara konstruksi tidak bisa menyentuh data tenant B.
 * - Revoke bersifat SOFT (revoked_at terisi): kunci yang dicabut langsung
 *   ditolak middleware (401 API_KEY_REVOKED), barisnya tetap ada untuk
 *   audit & daftar dashboard.
 * - last_used_at diperbarui best-effort oleh middleware (tidak memblokir
 *   request bila gagal).
 */

export const API_KEY_DISPLAY_PREFIX = "sk_live_";

/** Scope yang dikenal v1 (selaras ApiKeyScopeSchema di contracts). */
export type ApiKeyScope =
  | "contacts:read"
  | "contacts:write"
  | "conversations:read"
  | "messages:write"
  | "products:read"
  | "comments:read"
  | "comments:write"
  // Fase 15A: scope baca permukaan publik baru (kontrak sumber kebenaran).
  | "broadcasts:read"
  | "flows:read"
  | "automations:read"
  | "agents:read"
  | "channels:read"
  | "whatsapp_templates:read"
  | "knowledge:read"
  // Fase 13B: scope baca growth links.
  | "growth_links:read"
  // Fase 13C: scope baca segmen.
  | "segments:read"
  // Fase 13F: scope baca order commerce.
  | "orders:read"
  // Fase 13G: scope baca janji temu (booking + layanan).
  | "appointments:read";

/** Hash SHA-256 (hex) dari kunci utuh — satu-satunya bentuk yang disimpan/dicari. */
export function hashApiKey(fullKey: string): string {
  return createHash("sha256").update(fullKey, "utf8").digest("hex");
}

export interface GeneratedApiKey {
  /** Kunci utuh — tampilkan SATU KALI ke pembuat, lalu lupakan. */
  fullKey: string;
  keyHash: string;
  /** Awalan tampil untuk daftar dashboard, mis. `sk_live_ab12`. */
  keyPrefix: string;
}

/** Membuat kunci acak baru (belum disimpan). */
export function generateApiKey(): GeneratedApiKey {
  const randomPart = randomBytes(32).toString("base64url");
  const fullKey = `${API_KEY_DISPLAY_PREFIX}${randomPart}`;
  return {
    fullKey,
    keyHash: hashApiKey(fullKey),
    keyPrefix: `${API_KEY_DISPLAY_PREFIX}${randomPart.slice(0, 4)}`,
  };
}

export interface CreateApiKeyInput {
  name: string;
  scopes: ApiKeyScope[];
}

export interface CreatedApiKey {
  row: ApiKey;
  /** Kunci utuh — hanya ada di hasil pembuatan ini. */
  fullKey: string;
}

/** Membuat kunci untuk tenant (konteks dashboard: user pembuat tercatat di audit). */
export async function createApiKey(
  db: Database,
  ctx: Pick<TenantContext, "tenantId" | "userId"> & { userId: string },
  input: CreateApiKeyInput,
): Promise<CreatedApiKey> {
  const generated = generateApiKey();
  const row = await withTenantDb(db, ctx.tenantId, async (tx) => {
    const [inserted] = await tx
      .insert(apiKeys)
      .values({
        tenantId: ctx.tenantId,
        name: input.name,
        keyHash: generated.keyHash,
        keyPrefix: generated.keyPrefix,
        scopes: input.scopes,
      })
      .returning();
    await tx.insert(auditLogs).values({
      tenantId: ctx.tenantId,
      actorType: "user",
      actorId: ctx.userId,
      action: "api_key.created",
      meta: {
        apiKeyId: inserted.id,
        name: inserted.name,
        keyPrefix: inserted.keyPrefix,
        scopes: inserted.scopes,
      },
    });
    return inserted;
  });
  return { row, fullKey: generated.fullKey };
}

/** Daftar kunci tenant (terbaru dulu) — tanpa hash & tanpa kunci utuh. */
export async function listApiKeys(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
): Promise<ApiKey[]> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    return tx
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.tenantId, ctx.tenantId))
      .orderBy(desc(apiKeys.createdAt));
  });
}

/**
 * Mencabut kunci (soft): mengisi revoked_at. Mengembalikan true bila baris
 * milik tenant ini ditemukan & dicabut; false bila tidak ada / sudah dicabut
 * (API menjawab 404 pada false — idempoten tidak diperlukan di sini).
 */
export async function revokeApiKey(
  db: Database,
  ctx: Pick<TenantContext, "tenantId" | "userId"> & { userId: string },
  apiKeyId: string,
): Promise<boolean> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [updated] = await tx
      .update(apiKeys)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(apiKeys.tenantId, ctx.tenantId),
          eq(apiKeys.id, apiKeyId),
          isNull(apiKeys.revokedAt),
        ),
      )
      .returning();
    if (!updated) return false;
    await tx.insert(auditLogs).values({
      tenantId: ctx.tenantId,
      actorType: "user",
      actorId: ctx.userId,
      action: "api_key.revoked",
      meta: { apiKeyId: updated.id, name: updated.name, keyPrefix: updated.keyPrefix },
    });
    return true;
  });
}

/**
 * Resolusi hash → baris api_keys TANPA konteks tenant lebih dulu.
 * Satu-satunya query autentikasi publik: transaksi men-set
 * `app.api_key_hash` dan policy `public_key_lookup` (0016) hanya membuka
 * baris ber-hash itu. Null bila hash tidak dikenal.
 */
export async function resolveApiKeyByHash(
  db: Database,
  keyHash: string,
): Promise<ApiKey | null> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.api_key_hash', ${keyHash}, true)`,
    );
    const [row] = await tx
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, keyHash))
      .limit(1);
    return row ?? null;
  });
}

/**
 * Memperbarui last_used_at (best-effort, dipanggil middleware tanpa
 * memblokir request). Berjalan dalam konteks tenant pemilik kunci.
 */
export async function touchApiKeyLastUsed(
  db: Database,
  tenantId: string,
  apiKeyId: string,
): Promise<void> {
  await withTenantDb(db, tenantId, async (tx) => {
    await tx
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.id, apiKeyId)));
  });
}

/** Nama tenant pemilik (untuk GET /v1/me). Tabel `tenants` sendiri tidak ber-RLS. */
export async function getTenantNameById(
  db: Database,
  tenantId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ name: tenants.name })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return row?.name ?? null;
}
