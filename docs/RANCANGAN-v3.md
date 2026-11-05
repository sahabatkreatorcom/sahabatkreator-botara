# RANCANGAN v3 — Arsitektur Sahabat Kreator

> **Catatan pemulihan.** Dokumen ini dibangun ulang pada 2026-11-05 dari
> kode dan komentar di repo setelah berkas aslinya hilang. Penomoran §
> dipertahankan karena puluhan komentar kode merujuk nomornya (§2, §3,
> §4, §6, §11.1, §12.1, §12.7). Bila isi di sini berbeda dengan niat
> desain asli, **kode adalah kebenarannya** — perbarui dokumen ini,
> bukan kodenya.

---

## §1 Tujuan

Satu platform untuk UMKM Indonesia yang menjalankan percakapan pelanggan
di banyak kanal sekaligus, dengan bantuan otomasi dan agen AI, tanpa
memerlukan tim teknis.

Batasan yang membentuk seluruh desain:

- **Multi-tenant ketat.** Satu instalasi melayani banyak pelanggan yang
  tidak boleh saling melihat data, bahkan bila ada bug di lapisan aplikasi.
- **Kanal beragam, perilaku seragam.** WhatsApp/Instagram/Messenger/
  Telegram/webchat punya format webhook, token, dan kode error berbeda;
  core tidak boleh tahu perbedaan itu.
- **Biaya AI terkendali.** Setiap panggilan LLM tercatat di `usage_ledger`
  dan dibatasi per tenant per hari.

---

## §2 Aturan arsitektur

**Aturan 1 — API adalah adapter.** `apps/api` hanya: memvalidasi input
dengan skema kontrak, memanggil fungsi `packages/core`, dan menyusun
respons. Tidak ada aturan bisnis, tidak ada query langsung ke tabel
domain. Konsekuensinya API bisa diganti (Hono → framework lain) tanpa
menyentuh logika.

**Aturan 2 — Kontrak tunggal.** Semua bentuk data yang melintasi batas
proses didefinisikan sebagai skema zod di `packages/contracts`. API
memvalidasi dengannya, SDK mengonsumsi tipenya, MCP menurunkan schema
tool darinya. `pnpm check:drift` gagal bila SDK menyimpang.

**Aturan 3 — Satu arah dependensi.**

```
apps/*  →  packages/core  →  packages/db, ai, contracts, queue
                          ↘  packages/channels/*
```

`core` tidak boleh mengimpor Hono, BullMQ, atau `apps/*`. `channels`
tidak boleh mengimpor `core` (hanya `channel-core`).

**Aturan 4 — Konteks tenant eksplisit.** Setiap fungsi core menerima
`TenantContext` (`{ tenantId, userId?, role? }`). Tidak ada query
tenant-scoped di luar `withTenant()`.

**Aturan 5 — Efek samping lewat outbox.** Perubahan status yang harus
memicu pekerjaan lain menulis baris `outbox_events` di transaksi yang
sama. Relay di worker menerjemahkannya menjadi job. Tidak ada
"panggil queue setelah commit" yang bisa hilang bila proses mati.

**Aturan 6 — Rahasia tidak pernah menyentuh log.** Token kanal, kunci
provider, dan token undangan disimpan terenkripsi/di-hash. Log hanya
memuat kode error yang stabil (`meta_graph_190`, bukan pesan mentah).

---

## §3 Multi-tenancy dan RLS

Isolasi ditegakkan **di database**, bukan hanya di kode:

- 51 tabel ber-`tenant_id` + `platform_settings` (gerbang admin) memakai
  Row Level Security.
- Policy `tenant_isolation` membaca setting transaksi
  `app.tenant_id` yang dipasang `withTenant()`:
  `set_config('app.tenant_id', $1, true)`.
- Konteks kosong → **nol baris**, bukan error. Bug "lupa konteks"
  muncul sebagai data kosong yang terlihat, bukan kebocoran.
- RLS di-ENABLE, tidak di-FORCE: pemilik skema (migrasi) dan worker
  sistem yang memang lintas tenant melewatinya secara sadar. Role
  aplikasi (`sk_app`) bukan pemilik, jadi selalu tunduk.
- Lengan lintas-tenant selalu sempit dan bergerbang flag transaksi
  (mis. `app.system_relay='outbox'`, `app.api_key_hash=<hash>`), tidak
  pernah `USING (true)`.

Lihat `packages/db/migrations/0001_rls_tenant_isolation.sql`.

---

## §4 Model kanal

`packages/channels/channel-core` mendefinisikan antarmuka standar:
`ChannelProvider`, `ChannelAccountRef`, tipe pesan ternormalisasi, dan
`GraphHttpClient` bersama untuk Meta.

Adapter per provider hanya menerjemahkan:

| Kanal | Adapter | Catatan |
|---|---|---|
| WhatsApp | `channel-whatsapp` | Cloud API, template resmi |
| Messenger | `channel-messenger` | Page Access Token + Send API |
| Instagram | `channel-messenger` | Jalur Facebook Login (bukan Instagram Login) |
| Telegram | `channel-telegram` | Bot API, webhook per akun |
| Webchat | `channel-webchat` | Widget sendiri, token HMAC pengunjung |

Instagram **tidak** punya adapter terpisah: jalur yang dipakai hari ini
adalah Facebook Login dengan Page Access Token yang sama seperti
Messenger. Jalur "Instagram API with Instagram Login"
(`graph.instagram.com`) belum diimplementasikan dan sengaja tidak
dibuatkan paket kosong.

---

## §5 Permukaan API

- `/v1/*` — API publik, autentikasi API key per tenant (tenant
  ditentukan kunci, bukan URL), scope per kunci.
- `/tenants/:tenantId/*` — dashboard, sesi Better Auth + membership.
- `/webchat/*`, `/pay/:code`, `/go/:slug` — publik tanpa sesi.
- `/meta/webhook`, `/telegram/webhook/:id`, `/payments/webhook/*` —
  webhook provider, diverifikasi kriptografis.
- `/admin/*` — panel admin platform (allowlist email, non-admin 404).

§5.4 mendefinisikan scope API key: `contacts:read`, `messages:write`,
`knowledge:read`, dan seterusnya — disimpan di kolom `scopes text[]`.

---

## §6 Kelompok skema

| Kelompok | Tabel |
|---|---|
| Identity & tenant | `users`, `plans`, `tenants`, `tenant_members`, `invitations`, `api_keys`, `subscriptions` |
| Sistem | `webhook_inbox`, `outbox_events`, `audit_logs`, `usage_ledger`, `integration_log`, `platform_settings` |
| Auth | `auth_user`, `auth_session`, `auth_account`, `auth_verification` |
| Kanal | `channel_accounts`, `channel_identities`, `profile_photos` |
| Inbox | `contacts`, `conversations`, `messages`, `media`, `conversation_notes` |
| Otomasi | `automations`, `automation_runs`, `automation_steps`, `sequence_enrollments` |
| AI | `agents`, `kb_documents`, `kb_chunks`, `kb_source_documents`, `agent_suggestions` |
| Flow | `flows`, `flow_runs`, `flow_run_steps`, `flow_experiment_assignments` |
| Kampanye | `broadcasts`, `broadcast_recipients`, `segments`, `tenant_opt_in_settings` |
| Commerce | `products`, `payment_links`, `carts`, `cart_items`, `orders`, `order_items`, `payment_provider_configs` |
| Pertumbuhan | `growth_links`, `growth_link_events` |
| Janji temu | `appointment_services`, `appointment_settings`, `appointment_availability`, `bookings`, `google_calendar_connections` |
| Lain | `saved_replies`, `whatsapp_templates`, `comments` |

Total 59 tabel. `usage_ledger` **append-only** (tanpa `updated_at`).

---

## §7 Alur pesan masuk

```
webhook provider
  → verifikasi tanda tangan (HMAC app secret / secret token)
  → webhook_inbox (dedup provider + provider_event_id)
  → transaksi tenant: contact, conversation, message, outbox_events
  → relay (worker, ±2s, FOR UPDATE SKIP LOCKED)
  → job automation.evaluate
      ├─ automation keyword cocok  → balas, selesai
      ├─ sequence terdaftar        → selesai
      ├─ flow cocok                → run flow
      ├─ consent opt-in/out        → selesai
      └─ tidak ada yang menang     → job agent.respond (delay batch)
  → pesan outbound `queued`
  → poller pengiriman → provider API → status sent/failed
```

Urutan **keyword → sequence → flow → consent → agent** bersifat
mengikat; setiap tahap memeriksa ulang kelayakannya sendiri.

---

## §8 Flow engine

Graf `{ nodes, edges }` dengan tepat satu node `trigger`. Eksekusi satu
node per transaksi tenant, maksimal `FLOW_MAX_STEPS` (100) langkah per
run untuk menahan graf melingkar.

Node yang "parkir" (`wait_reply`, `questionnaire`, `show_catalog`,
`book_appointment`) menyimpan keadaannya di `flow_runs.context` dan
dilanjutkan oleh pesan balasan kontak atau oleh job resume saat tenggat.
Node `http_request` tidak pernah menggagalkan run.

---

## §9 Antrean dan idempotensi

Satu antrean (`MAIN_QUEUE_NAME`) dengan enam jenis job:

`automation.evaluate`, `agent.respond`, `sequence.step`,
`broadcast.dispatch`, `flow.step`, `team.invitation_email`.

Setiap jobId deterministik dari sumbernya
(`agent-respond-<messageId>`, `flow-<runId>-<seq>`), sehingga relay
yang berjalan dua kali tidak menggandakan efek. Klaim baris
menggunakan `FOR UPDATE SKIP LOCKED` agar dua replika tidak mengirim
pesan yang sama.

---

## §10 AI

`packages/ai` menyediakan antarmuka provider dengan dua implementasi:
`mock` (deterministik, tanpa biaya — default) dan `openrouter`.
Mode agen: `auto` (langsung membalas) dan `suggest` (draf untuk
disetujui manusia). Setiap respons menulis `usage_ledger` dan dibatasi
kuota harian per tenant.

Retrieval KB memakai `kb_chunks.search_vector` (tsvector) dan opsional
`embedding vector(1536)` (pgvector) bila provider embedding aktif.

---

## §11 Aturan antarmuka

**§11.1 — Tidak ada teks UI literal.** Semua string yang dilihat
pengguna lewat `t('kunci')` dari `@sahabat-kreator/i18n`. Error API
membawa **kode**, bukan kalimat; terjemahan dilakukan klien.

Penegakan: ESLint `no-restricted-syntax` pada `JSXText` (saat ini
**warning** — 20 pelanggaran tersisa, target: nol lalu naikkan jadi
error).

---

## §12 Integrasi eksternal

**§12.1 — Versi Graph API ter-pin.** `META_GRAPH_API_VERSION`
(default `v26.0`) tidak boleh berubah tanpa membaca changelog Meta.

**§12.7 — Batas Instagram.** Lihat §4: jalur Instagram Login belum ada.

Provider lain: Telegram Bot API, Midtrans & Xendit (pembayaran),
Google Calendar (janji temu), Resend (email), Cloudflare R2 (media).

---

## §13 Konfigurasi

`packages/config` memvalidasi env saat boot. Di `NODE_ENV=production`,
API **menolak start** bila kunci bertanda `[wajib-produksi]` kosong.
Sumber utama kredensial adalah Panel Admin (`platform_settings`
terenkripsi); env hanya fallback per kunci.
