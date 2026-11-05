# @sahabat-kreator/realtime — Gateway WebSocket (Fase 6G)

Service mandiri (systemd `sahabat-kreator-realtime`, port `REALTIME_PORT`
default 3103, bind 127.0.0.1) yang mendorong **nudge** real-time ke dua
jenis klien. Menggantikan hub WebSocket in-memory yang dulu tinggal di
dalam apps/api (endpoint lama `/api/webchat/ws` sudah pensiun).

## Prinsip: nudge, bukan muatan

Event yang mengalir hanyalah sinyal kecil dari `packages/contracts`
(`RealtimeNudgeSchema`): `{ type: 'nudge', kind, tenantId, conversationId?,
at }`. Isi pesan TIDAK PERNAH lewat socket — klien yang menerima nudge
melakukan refetch lewat REST yang sudah ada (sumber kebenaran tetap REST;
otorisasi tidak diduplikasi). Bila service ini mati, dashboard & widget
tetap segar lewat polling 5 detik (fallback sejak Hotfix Dashboard
Realtime) — tidak ada data yang hilang, hanya kembali tidak seketika.

## Tulang punggung: Redis pub/sub

- Penerbit (apps/api + apps/worker, helper `createRealtimePublisher` di
  `packages/queue`) menerbitkan nudge SETELAH perubahan keadaan commit,
  ke channel per tenant `rt:tenant:<tenantId>`. Penerbitan fail-soft:
  Redis mati → nudge hilang, transaksi utama tidak pernah gagal.
- Gateway berlangganan pola `rt:tenant:*` (psubscribe) dengan satu
  koneksi khusus, lalu merutekan nudge ke socket lokal yang cocok:
  socket dashboard tenant itu, dan socket pengunjung dari percakapan itu.

Titik penerbit: pesan masuk webchat/telegram (API), balasan manual agen
(API inbox + API publik v1), hasil worker (automation keyword, langkah
sequence, respons/saran AI agent), perubahan status terkirim/gagal
(poller telegram), dan hasil flush webchat (gateway ini sendiri,
`message.sent`).

## Dua jenis koneksi (auth saat handshake; gagal → upgrade ditolak 401)

- **Dashboard** — `GET /realtime/dashboard?tenantId=<uuid>`: cookie sesi
  Better Auth divalidasi terhadap DB yang sama seperti API (instance
  Better Auth lokal di service ini), lalu keanggotaan tenant diverifikasi
  lewat core. Socket hanya menerima nudge tenant itu.
- **Pengunjung webchat** — `GET /realtime/webchat?token=<token>`: token
  pengunjung HMAC yang sama seperti endpoint REST webchat, diverifikasi
  lewat `packages/channels/channel-webchat`. Socket terikat pada satu
  percakapan pengunjung itu.

## Pengiriman webchat tinggal di sini

Balasan untuk pengunjung webchat tidak lagi dikirim poller API. Gateway
yang mem-flush: saat nudge `message.queued` tiba untuk percakapan yang
pengunjungnya sedang terhubung (atau saat pengunjung baru terhubung),
pesan antrean ditandai `sent` lewat fungsi core yang sama seperti
sebelumnya (pengunjung daring menerimanya; semantik antrean luring Fase
1F dipertahankan), lalu nudge diteruskan ke socket pengunjung dan
`message.sent` diterbitkan balik untuk dashboard.

## Jalur publik

Di staging, satu-satunya origin adalah preview web (:5180), jadi Vite
preview mem-proxy `/realtime` (ws:true) ke service ini dan klien memakai
`wss://botara.my.id/realtime/...`. Di produksi jalur ini pindah ke
edge/reverse-proxy (dokumentasi di `docs/DEPLOY-STAGING.md`).

Health: `GET /health` (atau `/realtime/health`) → status + jumlah socket.
