/**
 * Verifikasi kontrak `withTenant` dengan DB palsu:
 * - membuka transaksi,
 * - menerbitkan set_config('app.tenant_id', <id>, true) DI DALAM transaksi
 *   dan SEBELUM fn dijalankan,
 * - menolak tenantId kosong.
 * Uji RLS sungguhan terhadap Postgres ada di packages/db (scripts/verify.ts).
 */
import assert from "node:assert/strict";
import { withTenant, type TenantDb } from "../src/index";

const calls: string[] = [];

const fakeDb: TenantDb = {
  transaction: async (fn) => {
    calls.push("begin");
    const tx = {
      execute: async (query: unknown) => {
        const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
        const text = chunks
          .map((c) =>
            typeof c === "string"
              ? c
              : ((c as { value?: unknown }).value ?? ""),
          )
          .join(" ");
        calls.push(`execute:${text.includes("set_config") ? "set_config" : text}`);
        return undefined;
      },
    };
    const result = await fn(tx as never);
    calls.push("commit");
    return result;
  },
};

const out = await withTenant(fakeDb, "11111111-1111-1111-1111-111111111111", async () => {
  calls.push("fn");
  return 42;
});

assert.equal(out, 42);
assert.deepEqual(calls, ["begin", "execute:set_config", "fn", "commit"]);

await assert.rejects(() => withTenant(fakeDb, "", async () => 0), /tenantId wajib/);

console.log("core withTenant verify: OK", calls.join(" -> "));
