# Modul `channels`

Manajemen akun channel workspace: `POST/GET /tenants/:tenantId/channels`
(sesi + membership).

Status: **Fase 1F aktif untuk Webchat** — POST `{provider:"webchat",
displayName}` membuat `channel_accounts` + siteKey publik (`wc_...` di
`externalId`) dan menjawab 201. Provider lain (whatsapp, instagram,
messenger, telegram) menjawab `422 CHANNEL_NOT_AVAILABLE_YET` dengan jujur
sampai fase channel-nya tiba. Koneksi OAuth Meta & token terenkripsi
menyusul di fase channel Meta.
