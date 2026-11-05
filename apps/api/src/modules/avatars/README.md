# Modul `avatars`

Penyajian foto profil (Fase 6D, `routes.ts`):

- `GET /tenants/:tenantId/avatars/channels/:channelAccountId` — foto bot/akun channel
- `GET /tenants/:tenantId/avatars/contacts/:contactId` — foto profil kontak

Byte foto dibaca dari tabel `profile_photos` (DB, bytea) — BUKAN redirect
ke provider: URL file Telegram menyematkan token bot dan tidak pernah
boleh diedarkan ke klien. Wajib sesi + membership workspace (non-member →
404 `TENANT_NOT_FOUND`; foto tidak ada / milik tenant lain → 404
`NOT_FOUND`). Respons membawa `ETag` (SHA-256 byte foto) +
`Cache-Control: private, max-age=3600`; `If-None-Match` yang cocok → 304.

Pengambilan fotonya sendiri hidup di `@sahabat-kreator/core`
(`avatars.ts`): dipicu saat connect Telegram, saat pengirim Telegram
pertama kali terlihat (webhook), dan sebagai backfill malas saat daftar
channel dibaca. Modul ini murni menyajikan.
