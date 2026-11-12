-- 0040_flow_webhook_triggers.sql
--
-- Gelombang G17 butir 1 (Tier 3 — ekstensi flow): PEMICU WEBHOOK MASUK.
-- Flow kini dapat dipicu panggilan HTTP dari sistem luar ke URL unik
-- per flow: POST /api/webhooks/flow/<endpointId> dengan token rahasia
-- (header `x-flow-webhook-token` atau `Authorization: Bearer …`).
--
-- Yang dibangun migrasi ini:
-- - `flow_webhook_endpoints`: SATU baris per flow (unik flow_id)
--   memuat kredensial pemicu: token disimpan HANYA sebagai hash
--   SHA-256 hex (`token_hash`, unik) + `token_prefix` untuk tampilan
--   panel — pola api_keys (hash-only). Nilai terang token ditampilkan
--   SATU KALI saat provision/rotasi dan tidak bisa dibaca kembali.
--   `last_triggered_at` dicap pada setiap pemanggilan sah.
--
-- Keamanan pencarian publik: endpoint HTTP publik tidak punya konteks
-- tenant, jadi resolusi baris berjalan lewat lengan RLS sempit
-- `flow_webhook_lookup` — meniru `public_key_lookup` (api_keys) dari
-- migrasi 0001: transaksi publik men-set `app.flow_webhook_token_hash`
-- ke hash token yang disodorkan dan policy hanya membuka baris yang
-- hash-nya sama persis. Token salah / endpoint tidak ada → nol baris
-- terlihat → API menjawab 404 yang sama untuk keduanya (keberadaan
-- flow TIDAK bocor lewat perbedaan respons).
--
-- Isolasi tenant: pola yang sama dengan seluruh tabel ber-tenant_id
-- (RLS `tenant_isolation` dengan app_tenant_id()) untuk semua akses
-- berkonteks tenant (panel builder, provision, eksekusi run).
-- Satu tabel baru + 2 policy → hitungan db verify naik 82 → 83 tabel,
-- 109 → 111 policy.

-- ---------------------------------------------------------------------------
-- flow_webhook_endpoints (satu baris per flow pemicu webhook)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "flow_webhook_endpoints" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "flow_id" uuid NOT NULL,
  "token_hash" varchar(64) NOT NULL,
  "token_prefix" varchar(16) NOT NULL,
  "last_triggered_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "flow_webhook_endpoints" DROP CONSTRAINT IF EXISTS "flow_webhook_endpoints_tenant_id_tenants_id_fk";
ALTER TABLE "flow_webhook_endpoints" ADD CONSTRAINT "flow_webhook_endpoints_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;

ALTER TABLE "flow_webhook_endpoints" DROP CONSTRAINT IF EXISTS "flow_webhook_endpoints_flow_id_flows_id_fk";
ALTER TABLE "flow_webhook_endpoints" ADD CONSTRAINT "flow_webhook_endpoints_flow_id_flows_id_fk"
  FOREIGN KEY ("flow_id") REFERENCES "flows"("id") ON DELETE cascade;

CREATE UNIQUE INDEX IF NOT EXISTS "flow_webhook_endpoints_flow_unique" ON "flow_webhook_endpoints" ("flow_id");
CREATE UNIQUE INDEX IF NOT EXISTS "flow_webhook_endpoints_token_hash_unique" ON "flow_webhook_endpoints" ("token_hash");
CREATE INDEX IF NOT EXISTS "flow_webhook_endpoints_tenant_id_idx" ON "flow_webhook_endpoints" ("tenant_id");

ALTER TABLE "flow_webhook_endpoints" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "flow_webhook_endpoints";
CREATE POLICY "tenant_isolation" ON "flow_webhook_endpoints"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

-- Lengan pencarian publik: hash token yang disodorkan (di-set pemanggil
-- lewat set_config) adalah satu-satunya kunci yang membuka baris.
DROP POLICY IF EXISTS "flow_webhook_lookup" ON "flow_webhook_endpoints";
CREATE POLICY "flow_webhook_lookup" ON "flow_webhook_endpoints"
  FOR SELECT
  USING ("token_hash" = app_setting('app.flow_webhook_token_hash'));
