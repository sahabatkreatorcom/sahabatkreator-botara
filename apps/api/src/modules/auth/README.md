# Modul `auth`

Login/register, sesi, reset password. Fase 0–1.

Status: **Fase 1B terimplementasi** — Better Auth (email + password) terpasang
di `apps/api/src/auth.ts`, handler dilayani pada jalur kanonis
`/api/auth/*` (sign-up, sign-in, sign-out, get-session, ...). Tabel auth
milik Better Auth sendiri (`auth_user`, `auth_session`, `auth_account`,
`auth_verification`); baris `users` kita disinkronkan lewat hook sign-up /
lazy sync (kolom `users.auth_user_id`). Middleware sesi ada di
`session.ts` (`requireAuth` → konteks `appUser`, 401 format kontrak).
Reset password & verifikasi email menyusul (perlu layanan email).
