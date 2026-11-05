# Modul admin — Panel Admin Platform (Fase 6C)

Pengaturan tingkat **platform** (bukan tenant): kredensial provider yang
dikelola pemilik platform lewat UI — usulan user agar kunci tidak lagi
ditempel lewat chat/env secara manual.

- **Gerbang:** sesi Better Auth wajib; email user harus ada di allowlist
  env `PLATFORM_ADMIN_EMAILS` (koma-terpisah, case-insensitive). Non-admin
  → **404** (eksistensi panel tidak dibocorkan, pola non-member 1B).
  Flag `isPlatformAdmin` pada respons get-session (plugin customSession
  di `apps/api/src/auth.ts`) hanya petunjuk tampilan web.
- **Route:** `GET /admin/settings` (status per kunci: isSet + source
  panel/env + updatedAt/By — TIDAK PERNAH nilai), `PUT|DELETE
  /admin/settings/:key`, `POST /admin/settings/:key/test` (OpenRouter:
  GET auth/key; R2: HeadBucket SigV4 ke bucket aktif). Kunci yang
  dikelola: `openrouter_api_key`, `openrouter_model`, `r2_access_key_id`,
  `r2_secret_access_key`.
- **Data:** semua lewat core `platform-settings` — tabel
  `platform_settings` terenkripsi AES-256-GCM (kunci induk env
  `PLATFORM_SETTINGS_SECRET`), RLS fail-closed dengan flag transaksi
  `app.platform_settings='admin'` (migrasi 0022). Resolusi nilai efektif:
  **panel → env → null**, cache ±60 dtk per proses.
- **Audit:** `platform_settings.set|cleared|test` di `audit_logs`
  (tenant_id NULL, actor = user admin) — meta hanya berisi key/hasil,
  tidak pernah nilai.
- **Konsumen:** worker me-resolve provider agent per job lewat resolver
  ini (kunci panel → OpenRouterProvider; tanpa kunci → mock). R2 belum
  punya konsumen sampai fase media/KB — panel + probe-nya fondasi.
