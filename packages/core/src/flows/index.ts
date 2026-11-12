/**
 * Flow Engine (Fase 8A) — mesin graf node.
 *
 * Dipecah menurut peran, bukan menurut tipe node semata:
 *
 *   graph.ts          bentuk data graf, normalisasi, navigasi, konteks run
 *   util.ts           helper kecil lintas modul
 *   questionnaire.ts  node questionnaire    (Fase 13E)
 *   catalog.ts        node commerce         (Fase 13F)
 *   appointment.ts    node book_appointment (Fase 13G)
 *   validate.ts       validasi graf saat aktivasi
 *   versions.ts       snapshot versi + resolusi graf ter-pin (G3)
 *   simulate.ts       interpreter kering panel uji (G4) — murni,
 *                     tanpa DB; efek dikumpulkan sebagai data
 *   pagination.ts     util kursor halaman
 *   crud.ts           manajemen flow (sisi API dashboard) + riwayat/
 *                     pemulihan versi
 *   runs.ts           baca run & langkah
 *   evaluate.ts       pemicu + mesin parkir (sisi evaluasi pesan masuk)
 *   execute.ts        eksekusi run (sisi worker, job `flow.step`)
 *
 * Arah dependensi satu arah, tanpa siklus:
 *   util, graph <- questionnaire, catalog, appointment <- validate
 *   validate, pagination <- crud, runs <- evaluate <- execute
 *
 * Berkas INI adalah satu-satunya pintu publiknya: `src/index.ts` hanya
 * meneruskan daftar di bawah. Modul internal WAJIB saling impor
 * langsung (bukan lewat barrel ini) agar tidak ada siklus.
 *
 * === Catatan desain asli (dipertahankan apa adanya) ===
 *
 *
 * FORMAT GRAF adalah kontrak di @sahabat-kreator/contracts (`FlowGraph`):
 * { nodes: [{id, type, config}], edges: [{from, to, branch?}] }, tepat
 * satu node `trigger`. Modul ini punya tiga sisi:
 *
 * 1. MANAJEMEN (API dashboard): CRUD flow + aktivasi dengan validasi
 *    graf menyeluruh (`validateFlowGraph`). Graf draft boleh belum sah;
 *    yang ditegakkan di sini: edit hanya saat draft, transisi status
 *    yang sah, dan aktivasi menolak graf rusak dengan daftar masalah
 *    terstruktur (kode FLOW_GRAPH_INVALID di lapisan API).
 * 2. PEMICU (dipanggil evaluasi pesan masuk di automations.ts SETELAH
 *    pencocokan automation keyword/sequence): flow AKTIF yang
 *    trigger-nya cocok memulai satu run. Idempotensi berlapis: cek run
 *    yang sudah ada + index unik parsial (flow_id, trigger_message_id).
 *    Pesan dari kontak opt-out tidak memulai run baru dan MEMBATALKAN
 *    run `waiting` di percakapan itu (konsisten aturan opt-out
 *    sequence; audit `flow.run_cancelled`).
 * 3. EKSEKUSI (worker, job `flow.step`): `executeFlowStep` menjalankan
 *    node demi node — satu transaksi tenant per node — sampai run
 *    menunggu (node `delay`: status `waiting` + event outbox
 *    `flow.step_due` yang diterjemahkan relay menjadi job tertunda
 *    dengan jobId `flow-<runId>-<seq>`) atau terminal. Setiap node
 *    menulis satu baris `flow_run_steps` (log per langkah). Cap
 *    FLOW_MAX_STEPS langkah per run menahan graf melingkar: run
 *    `failed` beralasan `step_cap_exceeded`, worker tetap sehat.
 *
 * KEPUTUSAN DESAIN v1 (terdokumentasi di DEPLOY-STAGING.md):
 * - Balasan kontak biasa TIDAK membatalkan run flow (berbeda dengan
 *   sequence 2C yang berhenti saat kontak membalas): flow adalah alur
 *   percakapan yang memang mengharapkan balasan di tengah jalan
 *   (mis. sesudah node ai_response). Yang membatalkan run: opt-out
 *   kontak dan cap langkah.
 * - Menonaktifkan/mengarsipkan flow TIDAK membatalkan run yang sedang
 *   berjalan (konsisten sequence: is_active hanya memblokir pemicu
 *   baru).
 * - G3 (versioning, menggantikan keputusan v1 di poin sebelumnya):
 *   setiap aktivasi menulis snapshot graf yang tidak bisa diubah
 *   (`flow_versions`, nomor urut per flow); run MEM-PIN versi yang
 *   memulainya dan eksekutor + mesin parkir membaca graf dari
 *   SNAPSHOT itu (versions.resolveRunGraph) — nonaktifkan→edit→
 *   aktifkan tidak lagi mengubah sisa perjalanan run hidup. Run
 *   warisan tanpa pin (lahir sebelum G3 / flow aktif warisan) membaca
 *   graf live sebagai fallback jujur; tidak ada snapshot retroaktif.
 *   Pemulihan versi lama melahirkan versi BARU (append-only) dan
 *   menolak menimpa draft yang belum diaktifkan (dirty_draft).
 * - Node `ai_response` memanggil jalur agent.respond yang ADA
 *   (`respondToInboundMessage`) untuk pesan pemicu run: mode auto →
 *   balasan terkirim; suggest → saran tercatat; agent tak ada/
 *   nonaktif untuk percakapan → langkah `skipped` beralasan, run
 *   lanjut (BUKAN crash).
 *
 * FASE 12A — enam tipe node baru (kontrak didokumentasikan penuh di
 * packages/contracts): set_field, http_request, goto_flow, ab_split,
 * send_payment_link, wait_reply. Keputusan desain yang mengikat:
 * - http_request TIDAK PERNAH menggagalkan run: kegagalan jaringan/
 *   non-2xx tercatat di detail langkah (`http_error`) dan run lanjut
 *   ke node berikutnya. Timeout 10 detik; substitusi variabel sempit
 *   ({name} + {{field:<key>}}, tanpa spintax).
 * - goto_flow memulai run BARU (trigger_message_id NULL — migrasi
 *   0038) dan menyelesaikan run asal; kedalaman rantai di context
 *   (`gotoDepth`, maks FLOW_GOTO_MAX_DEPTH) menahan siklus A→B→A.
 * - wait_reply parkir PADA nodenya (context.wait {nodeId, deadline,
 *   parkedAt}): balasan kontak melanjutkannya lewat branch "replied"
 *   dari jalur evaluasi pesan masuk (pesan yang sama TETAP diproses
 *   pemicu lain seperti biasa), tenggat lewat → job resume yang sama
 *   menjalankan branch "timeout". Opt-out membatalkan seperti delay.
 *
 * FASE 13E — node `questionnaire` (kontrak didokumentasikan penuh di
 * packages/contracts): daftar pertanyaan berurutan dalam satu node
 * yang MEMAKAI ULANG mesin parkir wait_reply — penanda parkirnya
 * tetap context.wait, keadaan kuesionernya hidup di
 * context.questionnaire {nodeId, qIndex, attempts, answers,
 * startedAt}. Bedanya dari wait_reply: (1) tenggat berlaku PER
 * PERTANYAAN (setiap parkir — pertanyaan baru maupun prompt ulang —
 * memasang tenggat baru, persis semantik per-parkir wait_reply);
 * (2) resolusi balasan BUKAN sekadar memilih branch: balasan
 * divalidasi menurut tipe jawaban, jawaban sah langsung ditulis ke
 * field target kontak, lalu run parkir lagi untuk pertanyaan
 * berikutnya atau keluar lewat branch completed/invalid; (3) target
 * `custom:<key>` harus kunci yang dikenal tenant — produk tidak
 * punya registri definisi field, jadi "definisi" = himpunan kunci
 * custom_fields yang dibawa kontak-kontak tenant (ditegakkan saat
 * aktivasi + diperiksa ulang setiap pertanyaan hendak dikirim).
 *
 * FASE 13F — node commerce `show_catalog` + `cart_checkout` (kontrak
 * didokumentasikan penuh di packages/contracts):
 * - show_catalog MEMAKAI ULANG mesin parkir yang sama (context.wait;
 *   keadaan katalog di context.catalog {nodeId, productIds, attempts,
 *   listedAt} — daftar id produk SESUAI urutan pengiriman, agar nomor
 *   balasan selalu menunjuk produk yang dilihat kontak walau katalog
 *   berubah di tengah parkir). Balasan diparsing parseCatalogSelection
 *   ("N" / "NxM"); produk yang sudah nonaktif/terhapus sejak daftar
 *   dikirim adalah percobaan tidak sah beralasan product_inactive /
 *   product_unavailable (BUKAN penambahan diam-diam). Penambahan sah
 *   menulis ke keranjang lewat commerce.addToCartTx (snapshot harga
 *   saat tambah), mengirim ringkasan keranjang, lalu keluar branch
 *   "added" — node TIDAK parkir ulang sesudah menambah; kelanjutan
 *   belanja adalah komposisi graf (catalog → catalog / checkout).
 * - cart_checkout TIDAK parkir: pola node khusus di executeFlowStep
 *   seperti send_payment_link (butuh deps.publicBaseUrl untuk URL
 *   tautan) — checkout atomik di commerce.checkoutCartTx, pesan
 *   ringkasan + tautan antre, lalu branch checked_out / empty_cart.
 *
 * FASE 13G — node `book_appointment` (kontrak didokumentasikan penuh
 * di packages/contracts): pola node khusus di executeFlowStep seperti
 * ai_response, karena daftar slot dihitung mesin slot inti
 * (appointments.getBookableSlots) yang boleh memotong kesibukan
 * Google (HTTP freebusy) — hitungan itu berjalan DI LUAR transaksi
 * langkah; transaksi hanya menulis baris langkah + pesan daftar +
 * keadaan parkir (context.appointment {nodeId, serviceId,
 * offeredSlots, attempts, listedAt} — slot yang DITAWARKAN dibekukan
 * sebagai instan ISO agar nomor balasan selalu menunjuk slot yang
 * dilihat kontak). Balasan diproses processParkedAppointmentReply di
 * jalur evaluasi: nomor sah → booking dibuat lewat createBooking
 * (transaksinya SENDIRI di luar transaksi evaluasi — pola jalur
 * dashboard; pelanggaran constraint eksklusi = SlotTakenError yang
 * ditangkap bersih tanpa savepoint bersarang)
 * → branch "booked"; slot keburu diambil & daftar segar kosong →
 * branch "slot_taken"; daftar segar masih ada → pemberitahuan +
 * daftar segar ditawarkan ulang (parkir lagi, attempts TIDAK
 * bertambah — balapan bukan kesalahan kontak). Tenggat lewat →
 * branch "timeout" lewat blok parkir eksekutor yang sama.
 */

export {
  FLOW_MAX_STEPS,
  FLOW_GOTO_MAX_DEPTH,
  FLOW_HTTP_TIMEOUT_MS,
  FLOW_WEBHOOK_MESSAGING_PROVIDERS,
  flowPayloadPathValue,
  normalizeFlowGraph,
  renderFlowHttpTemplate,
  type FlowGraphData,
  type FlowGraphNode,
  type FlowGraphEdge,
  type FlowBranch,
  type FlowRunContextData,
  type QuestionnaireAnswerRecord,
  type QuestionnaireRunState,
  type CatalogRunState,
  type FlowStatus,
  type FlowRunStatus,
} from "./graph";
export {
  questionnaireConfigOf,
  validateQuestionnaireAnswer,
  type QuestionnaireQuestion,
  type QuestionnaireConfig,
  type QuestionnaireAnswerType,
  type QuestionnaireAnswerValidation,
} from "./questionnaire";
export {
  catalogConfigOf,
  cartCheckoutConfigOf,
  type CatalogConfig,
} from "./catalog";
export {
  validateFlowGraph,
  validateFlowNodeConfig,
  tenantCustomFieldKeys,
  type FlowGraphIssue,
} from "./validate";
export {
  copyFlowGraph,
  flowGraphsEqual,
  getFlowVersion,
  latestFlowVersion,
  resolveRunGraph,
  snapshotFlowVersion,
  type ResolvedRunGraph,
} from "./versions";
export {
  simulateFlow,
  simulateFlowRun,
  type FlowSimContactState,
  type FlowSimEffect,
  type FlowSimEffectKind,
  type FlowSimStatus,
  type FlowSimStep,
  type FlowSimulateOptions,
  type FlowSimulateResult,
  type SimulateFlowInput,
} from "./simulate";
export {
  createFlow,
  instantiateFlowTemplate,
  listFlows,
  getFlow,
  updateFlow,
  activateFlow,
  deactivateFlow,
  setFlowArchived,
  deleteFlow,
  listFlowVersions,
  restoreFlowVersion,
  type FlowWithRunCount,
  type InstantiateFlowTemplateResult,
  type UpdateFlowResult,
  type ActivateFlowResult,
  type FlowStatusActionResult,
  type DeleteFlowResult,
  type FlowVersionSummary,
  type ListFlowVersionsResult,
  type RestoreFlowVersionResult,
} from "./crud";
export {
  listFlowRuns,
  listFlowRunSteps,
  type FlowRunWithContact,
} from "./runs";
export {
  startFlowRunsForInboundMessage,
  previewFlowTriggerClasses,
  classifyFlowTrigger,
  type FlowEvaluationOutcome,
  type FlowTriggerMatchContext,
} from "./evaluate";
export {
  executeFlowStep,
  type FlowStepDeps,
  type ExecuteFlowStepResult,
} from "./execute";
export {
  FLOW_WEBHOOK_PAYLOAD_MAX_BYTES,
  deleteFlowWebhookEndpoint,
  getFlowWebhookEndpoint,
  hashFlowWebhookToken,
  parseFlowWebhookPayload,
  provisionFlowWebhookEndpoint,
  resolveFlowWebhookEndpoint,
  startFlowWebhookRun,
  type FlowWebhookPayloadResult,
  type StartFlowWebhookRunResult,
} from "./webhook-trigger";
