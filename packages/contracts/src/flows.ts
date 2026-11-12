import { z } from "zod";

// ---------------------------------------------------------------------------
// Fase 8A — Flow Engine
// ---------------------------------------------------------------------------

/**
 * FORMAT GRAF FLOW — kontrak sumber kebenaran (dipakai API, eksekutor
 * worker, dan Flow Builder UI Fase 8B):
 *
 *   graph = { nodes: FlowNode[], edges: FlowEdge[] }
 *   FlowNode = { id: string, type: FlowNodeType, config: object,
 *                position?: { x: number, y: number } }
 *   FlowEdge = { from: nodeId, to: nodeId,
 *                branch?: "yes" | "no" | "a" | "b" | "replied" |
 *                         "timeout" | "completed" | "invalid" }
 *
 * `position` adalah metadata TAMPILAN milik builder (Fase 8B): disimpan
 * apa adanya di graf yang sama (satu sumber kebenaran), diterima
 * validasi bentuk, dan DIABAIKAN eksekutor — flow 8A tanpa position
 * tetap sah dan berjalan persis sama.
 *
 * Tepat SATU node `trigger` per flow; eksekusi mulai dari node yang
 * ditunjuk edge keluar trigger. Node tanpa edge keluar = akhir run
 * (node `end` adalah penanda eksplisit untuk hal yang sama). Edge
 * `branch` hanya sah keluar dari node bercabang, dan himpunan cabang
 * yang wajib lengkap ditegakkan saat aktivasi (bukan di skema bentuk):
 * `condition` → "yes"+"no", `ab_split` → "a"+"b",
 * `wait_reply` → "replied"+"timeout",
 * `questionnaire` → "completed"+"invalid"+"timeout",
 * `show_catalog` → "added"+"invalid"+"timeout",
 * `cart_checkout` → "checked_out"+"empty_cart",
 * `book_appointment` → "booked"+"invalid"+"timeout"+"slot_taken". Node lain tidak
 * boleh membawa branch.
 *
 * Tipe node v1 dan config-nya:
 * - trigger       { kind: "keyword", keywords: string[], match:
 *                   "exact"|"contains" } | { kind: "any_message" }
 *                   | { kind: "postback", payloads: string[] }
 *                   | { kind: "quick_reply", payloads: string[] }
 *                   | { kind: "welcome" } — G5: payload dicocokkan
 *                   PERSIS ke sinyal pesan (trigger_signal); welcome
 *                   menyala untuk pesan masuk pertama kontak. Urutan
 *                   prioritas antar kelas pemicu hidup di
 *                   packages/core/src/trigger-priority.ts.
 *                   | { kind: "webhook", channelAccountId } — G17:
 *                   pemicu LUAR pita (bukan pesan masuk): sistem luar
 *                   memanggil POST /api/webhooks/flow/<endpointId>
 *                   dengan token rahasia (hash-only di
 *                   flow_webhook_endpoints); payload JSON menentukan
 *                   kontak sasaran (contactId | externalId | phone |
 *                   email) pada akun channel config ini, run lahir
 *                   TANPA pesan pemicu (trigger_message_id null) dan
 *                   payload-nya hidup di context.webhook run —
 *                   tersedia bagi templat mesin lewat
 *                   {{payload:<path>}} (perluasan keluarga sintaks
 *                   {{field:<key>}} yang sama, BUKAN bahasa variabel
 *                   kedua). Kelas prioritasnya didokumentasikan di
 *                   trigger-priority.ts: ia tidak bersaing memperebutkan
 *                   pesan masuk, jadi tidak menempati kelas 0–6; gerbang
 *                   keselamatannya yang setara adalah autentikasi token
 *                   + gerbang opt-out kontak di titik mulai run.
 * - send_message  { text } — teks keluar `queued`, variabel {name}.
 * - condition     { predicate: "has_tag", tag }
 *                 | { predicate: "stage_equals", stage }
 *                 | { predicate: "field_equals", field:
 *                   "name"|"phone"|"email", value }
 *                 | { predicate: "message_contains", text } — memakai
 *                   teks pesan pemicu run.
 * - delay         { amount: int ≥ 0, unit: "seconds"|"minutes"|"hours",
 *                   random?: { min: int, max: int } } — Smart Delay
 *                   (Fase 9A): bila `random` ada, durasi dipilih acak
 *                   bilangan bulat dalam [min, max] pada satuan node
 *                   yang sama dan `amount` diabaikan; min ≥ 1,
 *                   min ≤ max (ditegakkan validasi aktivasi).
 * - add_tag       { tag }    remove_tag { tag }    set_stage { stage }
 * - enroll_sequence { automationId } — sequence AKTIF milik tenant
 *                   yang sama (divalidasi saat aktivasi & eksekusi).
 * - create_deal   { title, value?, dealStageId, assigneeUserId? } —
 *                   (G12) buat deal untuk kontak run di tahap tujuan
 *                   (pipeline mengikuti tahap); judul dirender seperti
 *                   send_message ({name} + spintax); mata uang =
 *                   bawaan tenant (pola wacrm create_deal). Tahap
 *                   hilang saat eksekusi → langkah dilewati beralasan
 *                   (deal_stage_unavailable), run lanjut.
 * - move_deal_stage { dealStageId } — (G12) pindahkan deal OPEN
 *                   TERBARU kontak run ke tahap tujuan (riwayat +
 *                   status terminal mengikuti perpindahan, persis
 *                   jalur UI). Kontak tanpa deal open → langkah
 *                   dilewati beralasan (no_open_deal), BUKAN kegagalan
 *                   run — tercatat di detail langkah.
 * - ai_response   {} — memanggil jalur agent.respond yang ada.
 * - handoff       {} — agent_enabled=false pada percakapan + audit.
 * - end           {}
 *
 * Tipe node tambahan (Fase 12A):
 * - set_field     { field, value } — field: "name"|"phone"|"email"|
 *                   "custom:<key>"; value dirender persis seperti
 *                   send_message ({name} + spintax) lalu ditulis ke
 *                   kontak run (kolom atau custom_fields); terlihat
 *                   oleh condition field_equals pada langkah berikutnya.
 * - http_request  { method: "GET"|"POST"|"PUT"|"PATCH"|"DELETE", url,
 *                   headers?: { [nama]: nilai }, body?: string,
 *                   saveToField?: "custom:<key>" } — permintaan HTTP
 *                   dari worker dengan timeout 10 detik. Substitusi
 *                   variabel pada url/headers/body SENGAJA SEMPIT dan
 *                   TANPA spintax: hanya `{name}` (nama kontak) dan
 *                   `{{field:<key>}}` (nilai contacts.custom_fields).
 *                   Status + potongan respons dicatat di detail
 *                   langkah; saveToField menyimpan body respons
 *                   (terpotong 2000 char) HANYA bila status 2xx.
 *                   Kegagalan jaringan/non-2xx tercatat sebagai langkah
 *                   gagal di detail tetapi RUN TERUS ke node berikutnya
 *                   (keputusan desain 12A — webhook pihak ketiga yang
 *                   mati tidak boleh membunuh percakapan).
 * - goto_flow     { flowId } — memulai run BARU pada flow tujuan
 *                   (harus ACTIVE, tenant sama; flow itu sendiri sah
 *                   sebagai tujuan) untuk kontak/percakapan yang sama;
 *                   run asal selesai `completed` dengan detail goto.
 *                   Kedalaman rantai dibawa di context run
 *                   (`gotoDepth`, mulai 0); goto yang akan membuat
 *                   kedalaman > 5 GAGAL: langkah `goto_depth_exceeded`,
 *                   run asal `failed`. Run goto TIDAK lahir dari pesan
 *                   masuk sehingga `triggerMessageId`-nya null (konteks
 *                   menyimpan `rootTriggerMessageId` untuk node yang
 *                   membutuhkannya, mis. ai_response).
 * - ab_split      { percentA: int 1..99 } — cabang edge "a"/"b";
 *                   pilihan acak per run dicatat di detail langkah.
 *                   Mode EKSPERIMEN (Fase 13D): config tambahan
 *                   opsional { experiment: true, experimentLabel?,
 *                   conversionNodeId? } — penugasan menjadi
 *                   DETERMINISTIK per (flow, node, kontak) dari hash
 *                   stabil yang dibucket oleh percentA dan dicatat
 *                   SATU KALI di flow_experiment_assignments
 *                   (penugasan pertama menang selamanya, jadi kontak
 *                   selalu masuk varian yang sama di semua run).
 *                   conversionNodeId menamai SATU node lain di graf
 *                   yang sama sebagai titik konversi: run yang
 *                   langkahnya melewati node itu (langkah sukses
 *                   SESUDAH langkah split) terhitung terkonversi
 *                   untuk variannya. Tanpa experiment:true perilaku
 *                   tetap persis acak per run (12A). Hasil eksperimen
 *                   (per varian + uji dua-proporsi) hanya permukaan
 *                   dashboard — tidak ada rute v1/SDK/MCP.
 * - send_payment_link { productId } — memakai layanan payment link
 *                   yang sama dengan tool agent (link SIMULASI
 *                   berlabel) lalu mengirimkannya sebagai pesan keluar
 *                   pada percakapan run. Produk tak ditemukan/arsip:
 *                   langkah gagal tercatat, run `failed`
 *                   (payment_product_unavailable) — kegagalan keras,
 *                   karena mengirim link yang salah/ tidak ada lebih
 *                   buruk daripada menghentikan run.
 * - wait_reply    { amount: int ≥ 0, unit } — run parkir `waiting`
 *                   PADA node ini (seperti delay, tetapi menunggu
 *                   balasan): pesan masuk berikutnya dari kontak pada
 *                   percakapan itu melanjutkan run lewat branch
 *                   "replied"; tenggat lewat tanpa balasan → job
 *                   resume menjalankan branch "timeout". Pesan yang
 *                   melanjutkan wait_reply TETAP diproses pemicu lain
 *                   seperti biasa (keyword/sequence/flow lain boleh
 *                   ikut menembak — tidak ada penekanan ganda selain
 *                   bahwa run yang sama tidak dilanjutkan dua kali).
 *                   Satu pesan masuk melanjutkan SEMUA run wait_reply
 *                   yang parkir di percakapan itu. Opt-out membatalkan
 *                   run parkir seperti delay.
 *
 * Tipe node tambahan (Fase 13E):
 * - questionnaire { questions: [{ id, prompt, answerType:
 *                   "text"|"number"|"email"|"phone"|"choice",
 *                   target, required, options? }], amount, unit,
 *                   maxInvalidAttempts, invalidPrompt?, completionTag? }
 *                   — kuesioner penangkap lead: daftar pertanyaan
 *                   BERURUTAN di dalam SATU node, dijalankan memakai
 *                   mesin parkir wait_reply yang sama (context.wait +
 *                   tenggat per pertanyaan; balasan yang melanjutkan
 *                   kuesioner dihitung tertangani flow — tidak bocor ke
 *                   agent). `target` = "name"|"email"|"phone"|
 *                   "custom:<key>"; kunci custom harus SUDAH dikenal
 *                   tenant (dibawa ≥ 1 kontak tenant) — ditegakkan
 *                   validasi aktivasi (QUESTIONNAIRE_TARGET_UNKNOWN)
 *                   karena produk tidak punya registri definisi field
 *                   terpisah: himpunan kunci pada kontak adalah
 *                   definisinya. Pertanyaan choice wajib ≥ 2 options.
 *                   Setiap balasan divalidasi menurut answerType
 *                   (email: bentuk alamat; phone: normalisasi digit
 *                   yang sama seperti dedup kontak; number: parse
 *                   numerik, koma desimal diterima; choice: cocok
 *                   teks opsi case-insensitive ATAU nomor urut 1..n;
 *                   text: non-kosong sesudah trim) dan jawaban sah
 *                   LANGSUNG ditulis ke field target — progres parsial
 *                   selamat dari pengabaian. Jawaban tidak sah memicu
 *                   prompt ulang (invalidPrompt, atau bawaan produk
 *                   dwibahasa QUESTIONNAIRE_DEFAULT_INVALID_PROMPT)
 *                   sampai maxInvalidAttempts per pertanyaan: sesudah
 *                   itu pertanyaan wajib keluar lewat branch "invalid",
 *                   pertanyaan opsional dilewati. Cabang keluar:
 *                   "completed" (semua pertanyaan selesai;
 *                   completionTag diterapkan bila diisi), "invalid",
 *                   "timeout" (tenggat pertanyaan berjalan lewat).
 *                   Keberadaan target custom diperiksa ulang SETIAP
 *                   pertanyaan hendak dikirim: target wajib yang hilang
 *                   (kunci tidak lagi dibawa kontak mana pun) keluar
 *                   "invalid" dengan langkah outcome `target_missing`;
 *                   target opsional yang hilang dilewati dan tercatat.
 *                   Jawaban yang sudah telanjur dalam perjalanan tetap
 *                   ditulis (penulisannya sendiri memulihkan kunci).
 *                   Transkrip tanya-jawab penuh hidup di
 *                   context.questionnaire run selama parkir dan disalin
 *                   ke detail langkah penutup (completed/timeout/
 *                   attempts_exhausted/target_missing). Render choice:
 *                   daftar teks bernomor di SEMUA channel — lapisan
 *                   keluar flow tidak punya infrastruktur tombol
 *                   quick-reply per channel, jadi tidak ada tombol
 *                   yang dijanjikan; balasan angka/teks diterima.
 *
 * Tipe node tambahan (Fase 13F):
 * - show_catalog  { introText?, showDescription?, amount, unit,
 *                   maxInvalidAttempts, invalidPrompt?, addedMessage? }
 *                   — katalog belanja: mengirim daftar produk AKTIF
 *                   tenant sebagai daftar teks BERNOMOR (nama + harga
 *                   Rupiah terformat; deskripsi ikut bila
 *                   showDescription) lalu PARKIR memakai mesin parkir
 *                   wait_reply yang sama (context.wait + keadaan di
 *                   context.catalog; tenggat per parkir). Balasan sah:
 *                   "N" (nomor produk, qty 1) atau "NxM" (nomor N
 *                   sebanyak M, 1..999) — item masuk keranjang kontak
 *                   dengan SNAPSHOT harga saat penambahan (baris yang
 *                   sudah ada mempertahankan snapshot pertamanya;
 *                   hanya qty yang bertambah). Sesudah penambahan,
 *                   node mengirim ringkasan keranjang (baris + total,
 *                   dirender server) + `addedMessage` opsional, lalu
 *                   keluar branch "added" — kelanjutannya (katalog
 *                   lagi / checkout) adalah komposisi graf. Balasan
 *                   tidak sah (bukan nomor, di luar rentang, produk
 *                   sudah nonaktif/terhapus sejak daftar dikirim)
 *                   memicu prompt ulang (invalidPrompt atau bawaan
 *                   dwibahasa CATALOG_DEFAULT_INVALID_PROMPT) sampai
 *                   maxInvalidAttempts → branch "invalid". Tenggat
 *                   lewat → branch "timeout". Produk yang dinonaktifkan
 *                   SETELAH daftar terkirim tidak bisa ditambahkan
 *                   (percobaan tidak sah beralasan product_inactive).
 * - cart_checkout { emptyMessage? } — checkout keranjang: TANPA
 *                   parkir. Keranjang terbuka kontak dirender sebagai
 *                   ringkasan (item, qty, total baris, total besar dari
 *                   snapshot), order dibuat dengan total yang dihitung
 *                   SERVER dari snapshot itu, SATU tautan bayar dibuat
 *                   untuk totalnya lewat mesin tautan yang sama
 *                   (provider 'simulation' berlabel, sama seperti
 *                   tautan produk), keranjang ditandai checked_out
 *                   (keranjang terbuka berikutnya lahir malas), dan
 *                   ringkasan + tautan dikirim sebagai pesan keluar.
 *                   Keluar branch "checked_out". Keranjang kosong/
 *                   tidak ada → branch "empty_cart" tanpa membuat apa
 *                   pun (emptyMessage opsional dikirim bila diisi).
 *                   Penyelesaian pembayaran tautan order membalik
 *                   order menjadi paid (+ paid_at) lewat hook yang
 *                   sama dengan tautan produk; kedaluwarsa tautan
 *                   membalik order menjadi expired.
 *
 * Tipe node tambahan (Fase 13G):
 * - book_appointment { serviceId, daysAhead, slotsPerMessage, amount,
 *                   unit, maxInvalidAttempts, invalidPrompt?,
 *                   bookedMessage? } — pemesanan janji temu: menghitung
 *                   slot yang bisa dipesan untuk SATU layanan janji
 *                   (mesin slot inti yang sama dengan dashboard:
 *                   jendela ketersediaan mingguan ∩ masa depan + lead
 *                   time − booking terkonfirmasi − kesibukan Google
 *                   Calendar bila terhubung), mengirim N slot berikutnya
 *                   (slotsPerMessage) sebagai daftar teks BERNOMOR
 *                   (tanggal + jam dalam zona waktu janji tenant,
 *                   format dwibahasa), lalu PARKIR memakai mesin parkir
 *                   wait_reply yang sama (context.wait + keadaan di
 *                   context.appointment). Balasan sah: nomor slot →
 *                   booking dibuat (baris + percobaan event Google
 *                   lewat outbox) lalu keluar branch "booked";
 *                   kelanjutan graf (pesan konfirmasi dll.) adalah
 *                   komposisi graf sesudah node ini. Balasan tidak sah
 *                   memicu prompt ulang (invalidPrompt atau bawaan
 *                   dwibahasa APPOINTMENT_DEFAULT_INVALID_PROMPT)
 *                   sampai maxInvalidAttempts → branch "invalid".
 *                   Tenggat lewat → branch "timeout". Bila slot yang
 *                   dipilih keburu diambil booking lain (constraint
 *                   eksklusi DB menolak), daftar slot SEGAR dihitung
 *                   ulang dan ditawarkan kembali dengan pemberitahuan
 *                   (APPOINTMENT_DEFAULT_SLOT_TAKEN_PROMPT); branch
 *                   "slot_taken" hanya keluar bila daftar segar itu
 *                   KOSONG. Bila sejak awal tidak ada slot dalam
 *                   jendela daysAhead, node mengirim pesan bawaan
 *                   dwibahasa APPOINTMENT_DEFAULT_NO_SLOTS_MESSAGE dan
 *                   keluar branch "invalid" beralasan no_slots —
 *                   memarkir daftar kosong akan menggantung kontak.
 *                   Layanan yang hilang/nonaktif saat eksekusi adalah
 *                   kegagalan keras tercatat (appointment_service_
 *                   unavailable), pola show_catalog.
 *
 * Tipe node tambahan (Gelombang G16 — konversi iklan):
 * - send_ad_conversion { platform: "meta"|"google", eventName,
 *                   value?, currency? } — mengirim peristiwa konversi
 *                   ke platform iklan TENANT saat flow mencapai node
 *                   ini. Node TIDAK memanggil API iklan secara sinkron:
 *                   ia menulis baris ledger `ad_conversion_events` +
 *                   event outbox `ad_conversion.requested` di dalam
 *                   transaksi langkah (pola send_message), dan worker
 *                   mengirimnya ke Meta Conversions API / Google Ads
 *                   API; kegagalan pengiriman tercatat di ledger + log
 *                   integrasi dan TIDAK membatalkan run.
 *                   `eventName`: nama peristiwa Meta (standar Lead /
 *                   Purchase / CompleteRegistration / … atau kustom);
 *                   untuk Google ia label tampilan saja — aksi konversi
 *                   tujuan ditentukan koneksi iklan tenant.
 *                   `value`: nilai STATIS opsional (dengan `currency`,
 *                   bawaan mata uang tenant) yang hanya dipakai bila
 *                   konteks nyata tidak menyediakan nilai: prioritas
 *                   nilai = order LUNAS terbaru kontak vs deal terbaru
 *                   kontak (yang lebih segar menang), lalu statis,
 *                   lalu peristiwa terkirim TANPA nilai — tidak ada
 *                   nilai karangan. event_id dedup deterministik dari
 *                   (run, node): langkah yang tereksekusi ulang tidak
 *                   melahirkan konversi kedua. Pengenal yang dikirim
 *                   hanya yang benar-benar dimiliki Botara: hash
 *                   email/telepon kontak (+ external_id untuk Meta);
 *                   fbp/fbc/gclid TIDAK tersedia dari chat dan tidak
 *                   pernah dikarang. Tanpa cabang — satu edge "next".
 */
export const FlowStatusSchema = z.enum(["draft", "active", "archived"]);
export type FlowStatus = z.infer<typeof FlowStatusSchema>;

export const FlowRunStatusSchema = z.enum([
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
]);
export type FlowRunStatus = z.infer<typeof FlowRunStatusSchema>;

export const FlowNodeTypeSchema = z.enum([
  "trigger",
  "send_message",
  "condition",
  "delay",
  "add_tag",
  "remove_tag",
  "set_stage",
  "enroll_sequence",
  // G12 — aksi deals (pola wacrm create_deal): buat deal untuk kontak
  // run / pindahkan tahap deal open terbaru kontak run.
  "create_deal",
  "move_deal_stage",
  "ai_response",
  "handoff",
  "end",
  // Fase 12A
  "set_field",
  "http_request",
  "goto_flow",
  "ab_split",
  "send_payment_link",
  "wait_reply",
  // Fase 13E
  "questionnaire",
  // Fase 13F
  "show_catalog",
  "cart_checkout",
  // Fase 13G
  "book_appointment",
  // G16 — kirim peristiwa konversi ke platform iklan tenant.
  "send_ad_conversion",
  // G17 — tambah baris ke Google Sheets tenant (layanan 'sheets').
  "append_sheet_row",
  // G17 — katalog commerce dalam format NATIF kanal (daftar
  // interaktif WhatsApp / template generik Messenger-IG; kanal lain
  // fallback teks bernomor yang sama seperti show_catalog).
  "send_catalog",
  // G17 — rangkuman keranjang aktif kontak + cabang has_items/empty.
  "cart_summary",
  // G17 — gambar dinamis: kartu PNG berisi teks dari konteks run,
  // dirender tanpa dependensi raster (font bitmap tertanam di core).
  "send_dynamic_image",
]);
export type FlowNodeType = z.infer<typeof FlowNodeTypeSchema>;

export const FlowTriggerConfigSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("keyword"),
    keywords: z.array(z.string().min(1).max(128)).max(20),
    match: z.enum(["exact", "contains"]),
  }),
  z.object({ kind: z.literal("any_message") }),
  // G5: pemicu sinyal — ketukan tombol dicocokkan PERSIS dari payload
  // yang dibawa pesan (messages.trigger_signal). 'postback' = postback
  // Meta / callback Telegram; 'quick_reply' = payload quick reply.
  z.object({
    kind: z.literal("postback"),
    payloads: z.array(z.string().min(1).max(255)).min(1).max(20),
  }),
  z.object({
    kind: z.literal("quick_reply"),
    payloads: z.array(z.string().min(1).max(255)).min(1).max(20),
  }),
  // G5: pemicu pesan pertama kontak (sekali per kontak per flow).
  z.object({ kind: z.literal("welcome") }),
  // G17: pemicu webhook masuk — akun channel tempat run ditempatkan
  // (percakapan sasaran lahir/ditemukan pada akun ini). Keabsahan
  // rinci (akun ada, provider pesan, endpoint sudah diprovision)
  // ditegakkan validasi aktivasi di core.
  z.object({
    kind: z.literal("webhook"),
    channelAccountId: z.string().uuid(),
  }),
]);
export type FlowTriggerConfig = z.infer<typeof FlowTriggerConfigSchema>;

export const FlowConditionConfigSchema = z.discriminatedUnion("predicate", [
  z.object({ predicate: z.literal("has_tag"), tag: z.string().min(1).max(64) }),
  z.object({
    predicate: z.literal("stage_equals"),
    stage: z.string().min(1).max(64),
  }),
  z.object({
    predicate: z.literal("field_equals"),
    field: z.enum(["name", "phone", "email"]),
    value: z.string().min(1).max(255),
  }),
  z.object({
    predicate: z.literal("message_contains"),
    text: z.string().min(1).max(255),
  }),
]);
export type FlowConditionConfig = z.infer<typeof FlowConditionConfigSchema>;

export const FlowNodeConfigSchema = z.union([
  FlowTriggerConfigSchema,
  z.object({ text: z.string().min(1).max(4096) }),
  FlowConditionConfigSchema,
  z.object({
    amount: z.number().int().min(0).max(100_000),
    unit: z.enum(["seconds", "minutes", "hours"]),
    // Smart Delay (Fase 9A): rentang acak opsional dalam satuan yang
    // sama; keabsahan rentang (min ≥ 1, min ≤ max) ditegakkan validasi
    // aktivasi di core, bukan di skema bentuk ini.
    random: z
      .object({
        min: z.number().int(),
        max: z.number().int(),
      })
      .optional(),
  }),
  z.object({ tag: z.string().min(1).max(64) }),
  z.object({ stage: z.string().min(1).max(64) }),
  z.object({ automationId: z.string().uuid() }),
  // G12 — create_deal: bentuk kasar; keabsahan rinci (tahap ada di
  // tenant ini, assignee member tenant, nilai dalam rentang)
  // ditegakkan validasi aktivasi di core. `title` adalah templat teks
  // yang dirender seperti send_message ({name} + spintax).
  z.object({
    title: z.string().min(1).max(1000),
    value: z.number().finite().min(0).max(999_999_999_999).optional(),
    dealStageId: z.string().uuid(),
    assigneeUserId: z.string().uuid().optional(),
  }),
  // G12 — move_deal_stage: pindahkan deal open TERBARU kontak ke
  // tahap tujuan (pipeline mengikuti tahap tujuan).
  z.object({ dealStageId: z.string().uuid() }),
  // Fase 12A — bentuk kasar; keabsahan rinci (rentang persen, rujukan
  // flow/produk aktif, format field) ditegakkan validasi aktivasi.
  z.object({
    field: z.string().min(1).max(128),
    value: z.string().max(4096),
  }),
  z.object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    url: z.string().min(1).max(2048),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.string().max(8192).optional(),
    saveToField: z.string().min(1).max(128).optional(),
  }),
  z.object({ flowId: z.string().uuid() }),
  z.object({
    percentA: z.number().int().min(1).max(99),
    // Fase 13D — mode eksperimen (semua opsional; tanpa
    // experiment:true node berperilaku persis 12A). Keabsahan rinci
    // (conversionNodeId harus menunjuk node yang ada di graf yang
    // sama) ditegakkan validasi aktivasi di core.
    experiment: z.boolean().optional(),
    experimentLabel: z.string().min(1).max(128).optional(),
    conversionNodeId: z.string().min(1).max(128).optional(),
  }),
  z.object({ productId: z.string().uuid() }),
  z.object({
    amount: z.number().int().min(0).max(100_000),
    unit: z.enum(["seconds", "minutes", "hours"]),
  }),
  // Fase 13E — questionnaire: bentuk kasar; keabsahan rinci (target
  // custom harus dikenal tenant, choice ≥ 2 opsi, id pertanyaan unik)
  // ditegakkan validasi aktivasi di core.
  z.object({
    questions: z
      .array(
        z.object({
          id: z.string().min(1).max(64),
          prompt: z.string().min(1).max(1000),
          answerType: z.enum(["text", "number", "email", "phone", "choice"]),
          target: z.string().min(1).max(128),
          required: z.boolean(),
          options: z.array(z.string().min(1).max(200)).max(10).optional(),
        }),
      )
      .min(1)
      .max(20),
    amount: z.number().int().min(0).max(100_000),
    unit: z.enum(["seconds", "minutes", "hours"]),
    maxInvalidAttempts: z.number().int().min(1).max(5),
    invalidPrompt: z.string().min(1).max(1000).optional(),
    completionTag: z.string().min(1).max(64).optional(),
  }),
  // Fase 13F — show_catalog: bentuk kasar; keabsahan rinci (rentang
  // percobaan, batas teks) ditegakkan validasi aktivasi di core.
  z.object({
    introText: z.string().min(1).max(1000).optional(),
    showDescription: z.boolean().optional(),
    amount: z.number().int().min(0).max(100_000),
    unit: z.enum(["seconds", "minutes", "hours"]),
    maxInvalidAttempts: z.number().int().min(1).max(5),
    invalidPrompt: z.string().min(1).max(1000).optional(),
    addedMessage: z.string().min(1).max(1000).optional(),
  }),
  // Fase 13F — cart_checkout: hanya pesan keranjang-kosong opsional.
  // G14 menambah sumber kode diskon opsional: kode statis, ATAU nama
  // field kustom kontak yang memuat kode dari pelanggan (mis. jawaban
  // questionnaire bertarget custom:<field>), + pesan bila kode yang
  // diberikan pelanggan ternyata tidak berlaku.
  z.object({
    emptyMessage: z.string().min(1).max(1000).optional(),
    discountCode: z.string().min(1).max(64).optional(),
    discountCodeField: z.string().min(1).max(128).optional(),
    discountInvalidMessage: z.string().min(1).max(1000).optional(),
  }),
  // Fase 13G — book_appointment: bentuk kasar; keabsahan rinci
  // (layanan ada & aktif, rentang hari/percobaan) ditegakkan validasi
  // aktivasi di core.
  z.object({
    serviceId: z.string().uuid(),
    daysAhead: z.number().int().min(1).max(30),
    slotsPerMessage: z.number().int().min(1).max(10),
    amount: z.number().int().min(0).max(100_000),
    unit: z.enum(["seconds", "minutes", "hours"]),
    maxInvalidAttempts: z.number().int().min(1).max(5),
    invalidPrompt: z.string().min(1).max(1000).optional(),
    bookedMessage: z.string().min(1).max(1000).optional(),
  }),
  // G16 — send_ad_conversion: bentuk kasar; keabsahan rinci (platform
  // sah, nama peristiwa non-kosong, nilai dalam rentang, mata uang
  // ISO 4217) ditegakkan validasi aktivasi di core.
  z.object({
    platform: z.enum(["meta", "google"]),
    eventName: z.string().min(1).max(128),
    value: z.number().finite().min(0).max(999_999_999_999).optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
  }),
  // G17 — send_catalog: bentuk config SAMA PERSIS show_catalog
  // (intro/deskripsi/tenggat parkir/percobaan/prompt/pesan sukses) —
  // yang berbeda hanyalah FORMAT pesan keluar per kanal (natif vs
  // teks) dan keduanya berbagi mesin parkir + pemrosesan balasan
  // katalog yang sama. Keabsahan rinci ditegakkan validasi aktivasi
  // di core seperti show_catalog.
  z.object({
    introText: z.string().min(1).max(1000).optional(),
    showDescription: z.boolean().optional(),
    amount: z.number().int().min(0).max(100_000),
    unit: z.enum(["seconds", "minutes", "hours"]),
    maxInvalidAttempts: z.number().int().min(1).max(5),
    invalidPrompt: z.string().min(1).max(1000).optional(),
    addedMessage: z.string().min(1).max(1000).optional(),
  }),
  // G17 — cart_summary: hanya pesan keranjang-kosong opsional
  // (cabang "empty"); cabang "has_items" mengirim rangkuman
  // renderCartSummaryText dari mesin commerce yang ada.
  z.object({
    emptyMessage: z.string().min(1).max(1000).optional(),
  }),
  // G17 — append_sheet_row: bentuk kasar; keabsahan rinci (id
  // spreadsheet non-kosong, ≥1 kolom ber-header + templat nilai)
  // ditegakkan validasi aktivasi di core. Nilai kolom adalah templat
  // MESIN renderFlowHttpTemplate ({name}, {{field:<key>}},
  // {{payload:<path>}}) — keluarga variabel yang sama dengan
  // http_request, bukan bahasa baru.
  z.object({
    spreadsheetId: z.string().min(1).max(128),
    sheetName: z.string().min(1).max(100).optional(),
    columns: z
      .array(
        z.object({
          header: z.string().min(1).max(128),
          value: z.string().min(1).max(2000),
        }),
      )
      .min(1)
      .max(50),
  }),
  // G17 — send_dynamic_image: templat PESAN renderMessageText
  // ({name} + spintax — keluarga variabel yang sama dengan
  // send_message); warna #RRGGBB divalidasi rinci di core.
  z.object({
    titleTemplate: z.string().min(1).max(200),
    bodyTemplate: z.string().min(1).max(1000).optional(),
    captionTemplate: z.string().min(1).max(1000).optional(),
    backgroundColor: z.string().min(4).max(7).optional(),
    accentColor: z.string().min(4).max(7).optional(),
  }),
  // ai_response / handoff / end: config kosong.
  z.object({}),
]);
export type FlowNodeConfig = z.infer<typeof FlowNodeConfigSchema>;

/**
 * Satu pertanyaan node questionnaire (Fase 13E) — bentuk kanonis yang
 * dibaca builder & eksekutor dari config node.
 */
export const FlowQuestionnaireQuestionSchema = z.object({
  id: z.string().min(1).max(64),
  prompt: z.string().min(1).max(1000),
  answerType: z.enum(["text", "number", "email", "phone", "choice"]),
  target: z.string().min(1).max(128),
  required: z.boolean(),
  options: z.array(z.string().min(1).max(200)).max(10).optional(),
});
export type FlowQuestionnaireQuestion = z.infer<
  typeof FlowQuestionnaireQuestionSchema
>;

/**
 * Prompt ulang bawaan produk (dwibahasa dalam satu pesan, pola email
 * undangan 11B) yang dipakai node questionnaire bila config
 * `invalidPrompt` tidak diisi. Teks kanonis tinggal di sini (kontrak)
 * agar worker dan builder tidak menyimpang; cerminannya tampil di
 * builder lewat kunci i18n `flows.questionnaireInvalidPromptDefault`.
 */
export const QUESTIONNAIRE_DEFAULT_INVALID_PROMPT =
  "Sorry, that answer doesn't look right yet. Please try again.\nMaaf, jawaban itu sepertinya belum tepat. Silakan coba lagi.";

/**
 * Prompt ulang bawaan produk (dwibahasa dalam satu pesan, pola
 * questionnaire 13E) yang dipakai node `show_catalog` (Fase 13F) bila
 * config `invalidPrompt` tidak diisi: balasan bukan pilihan katalog
 * yang sah (bukan nomor / di luar rentang / produk sudah nonaktif).
 */
export const CATALOG_DEFAULT_INVALID_PROMPT =
  "Sorry, that choice isn't on the list. Please reply with a product number.\nMaaf, pilihan itu tidak ada di daftar. Silakan balas dengan nomor produk.";

/**
 * Petunjuk balasan yang selalu menutup daftar katalog node
 * `show_catalog` (dwibahasa, pola yang sama): sintaks "N" / "NxM"
 * adalah kontrak balasan node ini — builder dan eksekutor membaca
 * teks kanonis yang sama dari sini.
 */
export const CATALOG_REPLY_HINT =
  "Reply with a product number to add it to your cart (e.g. \"2\", or \"2x3\" for 3 items).\nBalas nomor produk untuk menambahkannya ke keranjang (mis. \"2\", atau \"2x3\" untuk 3 buah).";

/**
 * Prompt ulang bawaan produk (dwibahasa, pola questionnaire/catalog)
 * yang dipakai node `book_appointment` (Fase 13G) bila config
 * `invalidPrompt` tidak diisi: balasan bukan nomor slot yang sah.
 */
export const APPOINTMENT_DEFAULT_INVALID_PROMPT =
  "Sorry, that choice isn't on the list. Please reply with a slot number.\nMaaf, pilihan itu tidak ada di daftar. Silakan balas dengan nomor slot.";

/**
 * Pemberitahuan bawaan (dwibahasa) saat slot pilihan kontak keburu
 * diambil booking lain: daftar slot SEGAR menyusul dalam pesan yang
 * sama dan run parkir lagi; branch "slot_taken" hanya keluar bila
 * daftar segar kosong.
 */
export const APPOINTMENT_DEFAULT_SLOT_TAKEN_PROMPT =
  "Sorry, that time was just booked by someone else. Here are the latest available times:\nMaaf, waktu itu baru saja dipesan orang lain. Berikut waktu terbaru yang tersedia:";

/**
 * Pesan bawaan (dwibahasa) saat tidak ada slot yang bisa dipesan dalam
 * jendela hari node: node keluar branch "invalid" beralasan no_slots
 * sesudah mengirim pesan ini (tidak memarkir daftar kosong).
 */
export const APPOINTMENT_DEFAULT_NO_SLOTS_MESSAGE =
  "Sorry, there are no available times right now. Please try again later.\nMaaf, saat ini belum ada waktu yang tersedia. Silakan coba lagi nanti.";

/**
 * Petunjuk balasan yang selalu menutup daftar slot node
 * `book_appointment` (dwibahasa, pola katalog): balasan angka adalah
 * kontrak balasan node ini — builder dan eksekutor membaca teks
 * kanonis yang sama dari sini.
 */
export const APPOINTMENT_REPLY_HINT =
  "Reply with a slot number to book it.\nBalas nomor slot untuk memesannya.";

/**
 * Posisi node di canvas builder (Fase 8B) — koordinat piksel relatif
 * kanvas, boleh negatif (pan bebas). Murni metadata tampilan.
 */
export const FlowNodePositionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});
export type FlowNodePosition = z.infer<typeof FlowNodePositionSchema>;

export const FlowNodeSchema = z.object({
  id: z.string().min(1).max(128),
  type: FlowNodeTypeSchema,
  config: z.record(z.string(), z.unknown()).default({}),
  position: FlowNodePositionSchema.optional(),
});
export type FlowNode = z.infer<typeof FlowNodeSchema>;

/**
 * Cabang edge: condition yes/no, ab_split a/b, wait_reply
 * replied/timeout, questionnaire completed/invalid/timeout,
 * show_catalog added/invalid/timeout, cart_checkout
 * checked_out/empty_cart, book_appointment
 * booked/invalid/timeout/slot_taken.
 */
export const FlowEdgeBranchSchema = z.enum([
  "yes",
  "no",
  "a",
  "b",
  "replied",
  "timeout",
  "completed",
  "invalid",
  // Fase 13F
  "added",
  "checked_out",
  "empty_cart",
  // Fase 13G
  "booked",
  "slot_taken",
  // G17 — cart_summary: keranjang kontak berisi / kosong.
  "has_items",
  "empty",
]);
export type FlowEdgeBranch = z.infer<typeof FlowEdgeBranchSchema>;

export const FlowEdgeSchema = z.object({
  from: z.string().min(1).max(128),
  to: z.string().min(1).max(128),
  branch: FlowEdgeBranchSchema.optional(),
});
export type FlowEdge = z.infer<typeof FlowEdgeSchema>;

export const FlowGraphSchema = z.object({
  nodes: z.array(FlowNodeSchema).max(200),
  edges: z.array(FlowEdgeSchema).max(400),
});
export type FlowGraph = z.infer<typeof FlowGraphSchema>;

/** Satu masalah validasi graf (aktivasi) — kode stabil + konteks. */
export const FlowGraphIssueSchema = z.object({
  code: z.string(),
  severity: z.enum(["error", "warning"]),
  nodeId: z.string().nullable(),
  message: z.string(),
});
export type FlowGraphIssue = z.infer<typeof FlowGraphIssueSchema>;

export const FlowResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  status: FlowStatusSchema,
  graph: FlowGraphSchema,
  runCount: z.number().int().nonnegative(),
  createdByUserId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type FlowResponse = z.infer<typeof FlowResponseSchema>;

export const FlowListResponseSchema = z.object({
  flows: z.array(FlowResponseSchema),
  nextCursor: z.string().nullable(),
});
export type FlowListResponse = z.infer<typeof FlowListResponseSchema>;

export const FlowListQuerySchema = z.object({
  status: FlowStatusSchema.optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type FlowListQuery = z.infer<typeof FlowListQuerySchema>;

export const CreateFlowRequestSchema = z.object({
  name: z.string().min(1).max(255),
  graph: FlowGraphSchema.optional(),
});
export type CreateFlowRequest = z.infer<typeof CreateFlowRequestSchema>;

/**
 * Edit hanya sah selama flow masih `draft` (mengubah graf flow aktif
 * di tengah jalan akan mengubah arti run yang sedang berjalan — flow
 * aktif harus dinonaktifkan dulu, yang mengembalikannya ke draft).
 */
export const UpdateFlowRequestSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  graph: FlowGraphSchema.optional(),
});
export type UpdateFlowRequest = z.infer<typeof UpdateFlowRequestSchema>;

/** Hasil validasi graf (respons aktivasi yang gagal maupun endpoint validasi). */
export const FlowValidationResponseSchema = z.object({
  valid: z.boolean(),
  issues: z.array(FlowGraphIssueSchema),
});
export type FlowValidationResponse = z.infer<
  typeof FlowValidationResponseSchema
>;

export const FlowRunResponseSchema = z.object({
  id: z.string().uuid(),
  flowId: z.string().uuid(),
  conversationId: z.string().uuid(),
  contactId: z.string().uuid(),
  contactName: z.string(),
  // Null untuk run yang lahir dari goto_flow (Fase 12A) — run semacam
  // itu tidak dipicu pesan masuk.
  triggerMessageId: z.string().uuid().nullable(),
  // G3: nomor versi graf yang di-pin run ini (snapshot flow_versions).
  // Null = run warisan tanpa pin — eksekutor membaca graf live.
  flowVersion: z.number().int().positive().nullable(),
  status: FlowRunStatusSchema,
  currentNodeId: z.string().nullable(),
  stepCount: z.number().int().nonnegative(),
  errorCode: z.string().nullable(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type FlowRunResponse = z.infer<typeof FlowRunResponseSchema>;

export const FlowRunListResponseSchema = z.object({
  runs: z.array(FlowRunResponseSchema),
  nextCursor: z.string().nullable(),
});
export type FlowRunListResponse = z.infer<typeof FlowRunListResponseSchema>;

export const FlowRunListQuerySchema = z.object({
  status: FlowRunStatusSchema.optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type FlowRunListQuery = z.infer<typeof FlowRunListQuerySchema>;

export const FlowRunStepResponseSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  seq: z.number().int().positive(),
  nodeId: z.string(),
  nodeType: z.string(),
  detail: z.record(z.string(), z.unknown()),
  error: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type FlowRunStepResponse = z.infer<typeof FlowRunStepResponseSchema>;

export const FlowRunStepListResponseSchema = z.object({
  steps: z.array(FlowRunStepResponseSchema),
  nextCursor: z.string().nullable(),
});
export type FlowRunStepListResponse = z.infer<
  typeof FlowRunStepListResponseSchema
>;

export const FlowRunStepListQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type FlowRunStepListQuery = z.infer<typeof FlowRunStepListQuerySchema>;

/**
 * Satu snapshot versi flow (G3 — tabel `flow_versions`). Snapshot
 * ditulis SETIAP aktivasi dan tidak pernah berubah; graf penuhnya
 * tidak keluar di daftar (yang tampil ringkasan: nomor, nama saat
 * aktivasi, jumlah node/edge). `isCurrent` = versi ini adalah versi
 * terbaru DAN flow sedang aktif (graf live flow sama dengan snapshot
 * ini). `restoredFromVersion` terisi bila versi lahir dari pemulihan.
 */
export const FlowVersionResponseSchema = z.object({
  id: z.string().uuid(),
  flowId: z.string().uuid(),
  version: z.number().int().positive(),
  name: z.string(),
  nodeCount: z.number().int().nonnegative(),
  edgeCount: z.number().int().nonnegative(),
  restoredFromVersion: z.number().int().positive().nullable(),
  activatedByUserId: z.string().uuid().nullable(),
  isCurrent: z.boolean(),
  createdAt: z.string().datetime(),
});
export type FlowVersionResponse = z.infer<typeof FlowVersionResponseSchema>;

export const FlowVersionListResponseSchema = z.object({
  versions: z.array(FlowVersionResponseSchema),
});
export type FlowVersionListResponse = z.infer<
  typeof FlowVersionListResponseSchema
>;

/**
 * Hasil pemulihan versi: flow yang kini aktif dengan isi snapshot
 * lama + baris versi BARU yang melahirkannya (sejarah append-only —
 * pemulihan tidak menulis ulang versi sumber).
 */
export const FlowVersionRestoreResponseSchema = z.object({
  flow: FlowResponseSchema,
  version: FlowVersionResponseSchema,
});
export type FlowVersionRestoreResponse = z.infer<
  typeof FlowVersionRestoreResponseSchema
>;

// ---------------------------------------------------------------------------
// G17 — Pemicu webhook masuk (manajemen endpoint dari Flow Builder)
// ---------------------------------------------------------------------------

/**
 * Keadaan endpoint webhook satu flow (panel pemicu di builder).
 * `endpointId` adalah segmen URL publik — BUKAN rahasia; URL penuhnya
 * `<base publik>/api/webhooks/flow/<endpointId>`. Token TIDAK PERNAH
 * keluar di sini (hash-only di DB): yang tampil hanya `tokenPrefix`
 * untuk mengenali token aktif. `configured: false` = flow belum punya
 * endpoint (provision/rotasi membuatnya).
 */
export const FlowWebhookTriggerResponseSchema = z.object({
  configured: z.boolean(),
  endpointId: z.string().uuid().nullable(),
  tokenPrefix: z.string().nullable(),
  lastTriggeredAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime().nullable(),
});
export type FlowWebhookTriggerResponse = z.infer<
  typeof FlowWebhookTriggerResponseSchema
>;

/**
 * Hasil provision/rotasi: SATU-SATUNYA respons yang memuat token
 * terang — ditampilkan sekali di builder dan tidak bisa dibaca lagi
 * (rotasi menerbitkan token baru dan membatalkan yang lama seketika).
 */
export const FlowWebhookTriggerRotateResponseSchema =
  FlowWebhookTriggerResponseSchema.extend({
    token: z.string(),
  });
export type FlowWebhookTriggerRotateResponse = z.infer<
  typeof FlowWebhookTriggerRotateResponseSchema
>;

// ---------------------------------------------------------------------------
// G4 — Simulator flow (panel uji kering di Flow Builder)
// ---------------------------------------------------------------------------

/**
 * SIMULATOR FLOW — penelusuran graf TANPA efek samping (konsep "efek
 * sebagai data" dari riset zernflow `lib/flow-engine/simulator.ts`).
 *
 * POST /tenants/:tenantId/flows/:id/simulate menjalankan interpreter
 * kering di core (`simulateFlowRun`) atas graf DRAF yang dikirim
 * pemanggil (`graph`), graf tersimpan flow (tanpa `graph`/`version`),
 * atau SNAPSHOT versi tersimpan (`version`) — dengan kontak mock +
 * teks pemicu dari permintaan. Server TIDAK menulis apa pun: tidak
 * ada run/langkah/pesan/outbox/audit yang lahir, tidak ada job yang
 * diantrekan, node `ai_response` TIDAK memanggil LLM, dan node
 * `http_request` TIDAK ditembak. Yang dikembalikan adalah JEJAK
 * langkah (bentuk selaras baris langkah run sungguhan) + daftar EFEK
 * sebagai data (niat yang akan terjadi pada run sungguhan).
 *
 * Kesetiaan per node (ditegakkan interpreter + ditandai `fidelity`
 * pada setiap efek):
 * - "faithful" — disimulasikan setia dari data yang ada: pesan
 *   ter-render ({name} + spintax; pilihan acak dari benih
 *   deterministik per simulasi), kondisi, tag/stage/field pada
 *   kontak mock, delay (dicatat, tidak ditunggu), ab_split
 *   (deterministik: hash lengket mode eksperimen persis eksekutor,
 *   undian berbenih, atau pilihan paksa `splitChoices`).
 * - "recorded" — TIDAK bisa disimulasikan setia, hanya dicatat
 *   sebagai efek: http_request (tidak ada jaringan), ai_response
 *   (tidak ada LLM), enroll_sequence & goto_flow (keadaan DB/eksternal
 *   di luar graf; goto menyelesaikan run asal seperti aslinya tetapi
 *   flow tujuan tidak ditelusuri), tautan pembayaran & checkout
 *   (membuat order/tautan adalah tulisan), penawaran slot janji
 *   (mesin slot + kalender di luar interpreter), send_ad_conversion
 *   (tidak ada panggilan API iklan; nilai & pengenal kontak mock
 *   tidak pernah meninggalkan proses).
 * Node parkir (wait_reply/questionnaire/show_catalog/
 * book_appointment) MENGHENTIKAN simulasi dengan status `parked` +
 * alasan; khusus wait_reply, `replyText` pada permintaan melanjutkan
 * simulasi lewat cabang "replied" (balasan untuk node parkir lain
 * adalah mesin jawaban penuh di jalur evaluasi — di luar cakupan
 * panel uji).
 */

/** Kontak mock untuk satu simulasi. `id` hanya kunci determinisme (penugasan eksperimen A/B); bawaan server "sim-contact". */
export const FlowSimulateContactSchema = z.object({
  id: z.string().min(1).max(128).optional(),
  name: z.string().max(255).optional(),
  phone: z.string().max(64).nullable().optional(),
  email: z.string().max(255).nullable().optional(),
  tags: z.array(z.string().min(1).max(64)).max(50).optional(),
  stage: z.string().min(1).max(64).nullable().optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
  /** Jumlah item keranjang mock — menentukan cabang cart_checkout (0/kosong → "empty_cart"). */
  cartItemCount: z.number().int().min(0).max(100_000).optional(),
});
export type FlowSimulateContact = z.infer<typeof FlowSimulateContactSchema>;

/**
 * Permintaan simulasi. `graph` dan `version` saling eksklusif (400
 * bila keduanya diisi): graph = graf draf dari kanvas builder;
 * version = nomor snapshot tersimpan; keduanya absen = graf
 * tersimpan flow.
 */
export const FlowSimulateRequestSchema = z.object({
  graph: FlowGraphSchema.optional(),
  version: z.number().int().positive().optional(),
  triggerText: z.string().max(4096).optional(),
  contact: FlowSimulateContactSchema.optional(),
  replyText: z.string().max(4096).optional(),
  splitChoices: z
    .record(z.string().min(1).max(128), z.enum(["a", "b"]))
    .optional(),
});
export type FlowSimulateRequest = z.infer<typeof FlowSimulateRequestSchema>;

/** Satu langkah jejak simulasi — bentuk selaras FlowRunStepResponse, tanpa id/runId (tidak ada baris DB). */
export const FlowSimulateStepSchema = z.object({
  seq: z.number().int().positive(),
  nodeId: z.string(),
  nodeType: z.string(),
  detail: z.record(z.string(), z.unknown()),
});
export type FlowSimulateStep = z.infer<typeof FlowSimulateStepSchema>;

export const FlowSimulateEffectKindSchema = z.enum([
  "send_message",
  "delay",
  "add_tag",
  "remove_tag",
  "set_stage",
  "set_field",
  "enroll_sequence",
  "create_deal",
  "move_deal_stage",
  "goto_flow",
  "handoff",
  "ai_response",
  "http_request",
  "payment_link",
  "catalog_message",
  "checkout",
  "appointment_offer",
  // G16: node send_ad_conversion — hanya dicatat (tidak ada panggilan
  // API iklan dari simulator), fidelity "recorded".
  "ad_conversion",
  // G17: node append_sheet_row — hanya dicatat (tidak ada panggilan
  // Sheets API dari simulator), fidelity "recorded".
  "sheet_append",
  "dynamic_image",
  "park",
]);
export type FlowSimulateEffectKind = z.infer<
  typeof FlowSimulateEffectKindSchema
>;

/**
 * Satu efek simulasi: niat yang akan terjadi pada run sungguhan.
 * `fidelity: "recorded"` berarti efeknya hanya dicatat — tidak
 * disimulasikan setia dan tidak dieksekusi (lihat kepala bagian).
 */
export const FlowSimulateEffectSchema = z.object({
  kind: FlowSimulateEffectKindSchema,
  nodeId: z.string(),
  fidelity: z.enum(["faithful", "recorded"]),
  data: z.record(z.string(), z.unknown()),
});
export type FlowSimulateEffect = z.infer<typeof FlowSimulateEffectSchema>;

export const FlowSimulateStatusSchema = z.enum([
  "completed",
  "parked",
  "failed",
  "trigger_not_matched",
]);
export type FlowSimulateStatus = z.infer<typeof FlowSimulateStatusSchema>;

/** Keadaan akhir kontak mock sesudah simulasi (tag/stage/field yang berubah selama penelusuran). */
export const FlowSimulateContactStateSchema = z.object({
  name: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  tags: z.array(z.string()),
  stage: z.string().nullable(),
  customFields: z.record(z.string(), z.unknown()),
});
export type FlowSimulateContactState = z.infer<
  typeof FlowSimulateContactStateSchema
>;

export const FlowSimulateResponseSchema = z.object({
  /** Sumber graf yang disimulasikan: draf kiriman, graf tersimpan, atau snapshot versi. */
  source: z.object({
    kind: z.enum(["draft", "stored", "version"]),
    version: z.number().int().positive().nullable(),
  }),
  triggerMatched: z.boolean(),
  status: FlowSimulateStatusSchema,
  /** Node tempat simulasi parkir (status "parked"); null selain itu. */
  parkedNodeId: z.string().nullable(),
  /** Alasan parkir: waiting_for_reply | waiting_for_questionnaire_answer | waiting_for_catalog_choice | waiting_for_slot_choice. */
  parkReason: z.string().nullable(),
  /** Kode kegagalan (status "failed"), selaras error_code run: step_cap_exceeded, node_missing, goto_depth_exceeded, dst. */
  failReason: z.string().nullable(),
  steps: z.array(FlowSimulateStepSchema),
  effects: z.array(FlowSimulateEffectSchema),
  contact: FlowSimulateContactStateSchema,
  /** Hasil validator graf yang ada atas graf yang disimulasikan (error tidak memblokir simulasi; keduanya dikembalikan). */
  issues: z.array(FlowGraphIssueSchema),
});
export type FlowSimulateResponse = z.infer<typeof FlowSimulateResponseSchema>;
