# @sahabat-kreator/db

Drizzle schema, migrasi, dan client PostgreSQL untuk Sahabat Kreator.
Status: **Fase 1A + 1B + 1D terimplementasi** — kelompok Identity & Tenant + Sistem fondasi (RANCANGAN §6), tabel autentikasi Better Auth, dan kelompok Channels & Audience/Inbox. Kelompok Automation / Agent / Campaign menyusul di fase berikutnya (termasuk pgvector untuk `knowledge_chunks`).

## Isi

- `src/schema/identity.ts` — tabel global: `users` (email unik, locale default `en`, theme `system|light|dark`), `plans` (code unik, limits jsonb).
- `src/schema/tenants.ts` — `tenants` (slug unik, default_locale, timezone default `Asia/Jakarta`), `tenant_members` (role enum `owner|admin|agent|viewer`, unik tenant+user), `invitations` (token hash, expires_at, accepted_at), `api_keys` (key hash, scopes text[], last_used_at, revoked_at), `subscriptions` (plan, status enum, current_period_end).
- `src/schema/system.ts` — `outbox_events` (Transactional Outbox, index published_at), `audit_logs` (actor user/agent/system), `usage_ledger` (**append-only** — tanpa `updated_at`; qty + cost_model + cost_provider).
- `src/client.ts` — `createDb(connectionString)` → `{ db, pool }` (drizzle + node-postgres).
- `src/schema/auth.ts` — tabel milik Better Auth (Fase 1B): `auth_user`, `auth_session`, `auth_account`, `auth_verification`. Terpisah dari `users` kita; penghubungnya kolom `users.auth_user_id` (unik, nullable).
- `src/schema/channels.ts` — Fase 1D: `channel_accounts` (provider enum `whatsapp|instagram|messenger|telegram|webchat`, unik tenant+provider+external_id, `access_token_encrypted`, `webhook_secret`, `graph_api_version`, status `connected|disconnected|error`).
- `src/schema/inbox.ts` — Fase 1D: `contacts` (tags text[], custom_fields jsonb, pipeline_stage, opt_in_status, index tenant+phone & tenant+email), `media` (object key Cloudflare R2), `conversations` (fk channel_account + contact, provider denormalisasi, index tenant+status+last_message_at), `messages` (direction/sender_type/type/status enum, `provider_message_id` unik parsial bila tidak NULL, provider_cost), dan `channel_identities` (unik channel_account + external_user_id; didefinisikan di file ini agar tidak ada impor sirkular skema).
- `migrations/` — `0000` skema awal, `0001` custom RLS, `0002` tabel auth (generate), `0003` custom: policy `tenant_members` ditambah lengan `app.user_id` (user boleh membaca baris keanggotaannya sendiri untuk daftar workspace; WITH CHECK tetap hanya konteks tenant), `0004` skema channels/inbox (generate), `0005` custom RLS untuk 6 tabel Fase 1D. **Jangan edit file migrasi yang sudah ter-commit; buat migrasi baru.** (Satu pengecualian tercatat: metadata `id`/`prevId` pada `meta/0003_snapshot.json` diperbaiki di Fase 1D karena duplikat dengan snapshot 0002 membuat `drizzle-kit generate` gagal; isi skema snapshot tidak berubah.)

Semua tabel tenant-scoped punya `tenant_id` + index; semua PK `uuid defaultRandom`; timestamps konsisten (`timestamptz`, default now).

## Cara migrasi

```bash
# dari root monorepo
export DATABASE_URL="postgres://<user>:<pass>@<host>:5432/sahabat_kreator"   # jangan commit nilai asli
pnpm --filter @sahabat-kreator/db db:migrate     # terapkan migrasi ke DB target
pnpm --filter @sahabat-kreator/db db:generate    # setelah mengubah skema: generate migrasi baru
pnpm --filter @sahabat-kreator/db verify         # bukti jalan lokal (PGlite, tanpa server)
```

## Pola Row Level Security (RLS)

Migrasi `0001_rls_tenant_isolation.sql` mengaktifkan RLS pada 8 tabel tenant-scoped (`tenant_members`, `invitations`, `api_keys`, `subscriptions`, `webhook_inbox` — **dihapus di migrasi 0009**, `outbox_events`, `audit_logs`, `usage_ledger`) dengan policy `tenant_isolation`; migrasi `0005_rls_channels_inbox.sql` menambahkan pola yang sama untuk 6 tabel Fase 1D (`channel_accounts`, `channel_identities`, `contacts`, `media`, `conversations`, `messages`) — total 14 tabel ber-RLS:

```sql
tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
```

untuk `USING` maupun `WITH CHECK` (select/insert/update/delete sama-sama terkunci). `users`, `plans`, dan `tenants` sendiri tidak di-RLS pada fase ini.

Konsekuensi wajib untuk kode aplikasi:

1. **API men-set `app.tenant_id` di setiap transaksi** sebelum query tenant mana pun — transaction-local via `set_config('app.tenant_id', $1, true)`. Gunakan helper `withTenant(db, tenantId, fn)` dari `@sahabat-kreator/core`; jangan query tabel tenant-scoped di luar transaksi seperti itu. Satu pengecualian terkontrol (migrasi `0003`): daftar keanggotaan lintas workspace milik user yang login memakai `set_config('app.user_id', <users.id>, true)` — policy `tenant_members` lalu hanya memperlihatkan baris milik user itu sendiri (tulis tetap ditolak dari konteks ini). Lihat `listTenantsForUser` di `@sahabat-kreator/core`.
2. **Role koneksi aplikasi harus non-superuser dan bukan pemilik tabel** — superuser dan pemilik tabel melewati RLS. Role migrasi (pemilik) hanya untuk `db:migrate`; worker sistem yang memang lintas tenant memakai koneksi pemilik secara sadar & terbatas.
3. Konteks yang belum di-set menghasilkan **nol baris** (fail closed), bukan error.

## Verifikasi (scripts/verify.ts)

Karena Docker tidak tersedia di VM pengembangan, verifikasi memakai **PGlite** (Postgres asli dalam WASM) dan membuktikan:

1. Semua file migrasi teraplikasi bersih dari nol (21 tabel, 14 policy RLS).
2. Seed 2 tenant + member + usage/audit/outbox + contacts berhasil.
3. Dedup pesan masuk: `webhook_inbox` sudah tidak ada (migrasi 0009), dan insert pesan dengan `provider_message_id` yang sama **ditolak** unique index `messages_provider_message_id_unique`.
4. Sebagai role non-superuser `app_user` dengan konteks `app.tenant_id = tenant A`: `tenant_members`, `usage_ledger`, `audit_logs`, dan `contacts` hanya mengembalikan baris tenant A, dan insert untuk tenant B ditolak policy (`WITH CHECK`).

Jalur yang sama akan dipakai terhadap Postgres sungguhan (docker-compose / staging) pada fase deploy DB tanpa perubahan skrip berarti — cukup ganti transport-nya.
