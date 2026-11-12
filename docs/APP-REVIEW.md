# Meta App Review — catatan

## §0 Jangan minta scope engagement sebelum disetujui

`META_ENGAGEMENT_SCOPES` **default mati (0)**. Ini bukan kehati-hatian
berlebihan: tiga scope berikut butuh *Advanced Access* dari App Review.

| Scope | Kegunaan |
|---|---|
| `pages_read_engagement` | membaca komentar & interaksi Page |
| `pages_read_user_content` | membaca konten buatan pengguna di Page |
| `pages_manage_engagement` | menyembunyikan/menghapus komentar |

Bila diminta sebelum disetujui, dialog Facebook Login menjawab
**"Invalid Scopes"** dan onboarding Messenger mati total untuk semua
pengguna baru. Gejalanya membingungkan karena tidak ada error di server —
hanya dialog yang gagal.

Tanpa ketiga scope itu, moderasi komentar **tetap berjalan di mode dev**
untuk Page milik sendiri, tetapi ditolak Graph untuk Page hasil OAuth
biasa.

## §1 Scope minimum yang dipakai sekarang

- Messenger: `pages_messaging`, `pages_show_list`, `pages_manage_metadata`
- Instagram (via Facebook Login): scope Page yang sama + `instagram_basic`,
  `instagram_manage_messages`

## §2 Verifikasi webhook

- Satu endpoint untuk Messenger + Instagram: `POST /api/webhooks/meta`
  (path kanonis sejak penyeragaman URL 2026-11-12; path lama tidak
  lagi terdaftar).
- Handshake `GET` memakai `META_WEBHOOK_VERIFY_TOKEN`.
- Payload diverifikasi HMAC-SHA256 dengan **App Secret**. Tanpa secret,
  endpoint menjawab `503 META_NOT_CONFIGURED` (fail closed) — bukan
  menerima payload tanpa verifikasi.

## §3 Kredensial

App Secret dan identifier publik dikelola di Panel Admin
(`platform_settings`, terenkripsi AES-256-GCM). Env hanya fallback.

- App ID aktif: `1141276711971314` ("Botara").
- App lama "Botara Dev" (`2356364001779420`) sudah dihapus — jangan
  dipakai lagi.
- Redirect URI OAuth bersifat tunggal dan ditampilkan read-only di panel:
  `${BETTER_AUTH_URL}/api/oauth/meta/callback`.

## §4 Checklist pengajuan

- [ ] Kebijakan privasi & syarat layanan dapat diakses publik
      (`/legal/privacy`, `/legal/terms`)
- [ ] Video demonstrasi: hubungkan Page → terima pesan → balas dari inbox
- [ ] Penjelasan penggunaan tiap scope
- [ ] Uji dengan akun tester sebelum submit
- [ ] `META_ENGAGEMENT_SCOPES` tetap `0` sampai disetujui

## §5 Setelah disetujui

1. Nyalakan `META_ENGAGEMENT_SCOPES=1`.
2. Hubungkan ulang Page yang sudah terhubung (token lama tidak membawa
   scope baru).
3. Verifikasi moderasi komentar berjalan untuk Page hasil OAuth.
