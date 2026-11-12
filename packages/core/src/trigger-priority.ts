/**
 * =====================================================================
 * SUMBER KEBENARAN TUNGGAL — URUTAN PRIORITAS PEMICU PESAN MASUK (G5)
 * =====================================================================
 *
 * Satu pesan masuk dievaluasi oleh TIGA mesin yang berbagi pesan yang
 * sama: evaluator automation (`automations.ts`), pemicu flow
 * (`flows/evaluate.ts`), dan — bila tak ada yang menembak — agen AI
 * (worker `automation.evaluate` → `agent.respond`). Dokumen ini adalah
 * SATU-SATUNYA tempat urutan prioritas antar kelas pemicu didefinisikan;
 * kedua evaluator dan worker WAJIB mengikutinya, dan
 * `verify:trigger-priority` membuktikannya lewat skenario bertabrakan.
 *
 * URUTAN FINAL (dari paling dulu dievaluasi):
 *
 * 0. LAPISAN KESELAMATAN — selalu, tidak bisa didahului pemicu apa pun:
 *    a. Gerbang persetujuan: kontak yang sudah opt-out tidak memulai
 *       run baru; run parkirnya dibatalkan (`flows/evaluate.ts`).
 *    b. Tangkapan consent: kata opt-in/opt-out PERSIS (pengaturan
 *       tenant) mengubah status persetujuan kontak dan MENGHENTIKAN
 *       evaluasi pesan ini (`automations.ts`, Fase 13C) — kata consent
 *       tidak pernah sekaligus menjadi balasan automation.
 *    c. Aturan berhenti sequence: balasan membatalkan enrollment
 *       sequence yang dibuat sebelum pesan ini.
 *    d. Resume run TERPARKIR (wait_reply / questionnaire / catalog /
 *       appointment): SELALU dieksekusi bila ada run yang menunggu
 *       balasan di percakapan ini. Keputusan desain yang dipertahankan:
 *       resume TIDAK menekan pemicu lain — pesan yang sama tetap
 *       dievaluasi kelas-kelas di bawahnya seperti biasa.
 *
 * 1. POSTBACK — pesan yang membawa sinyal postback
 *    (`messages.trigger_signal.kind = 'postback'`: postback Meta
 *    Messenger/IG, callback_query Telegram) HANYA dicocokkan ke pemicu
 *    postback (automation + flow), dengan payload PERSIS. Payload
 *    adalah data mesin, bukan teks pengguna: pemicu keyword, welcome,
 *    flow teks, dan agen AI TIDAK PERNAH melihatnya. Postback yang
 *    tidak cocok dengan aturan mana pun tetap tercatat di inbox dan
 *    berakhir di sini (tidak diteruskan ke AI) — membuka menu yang
 *    tidak dikenal bukan percakapan.
 *
 * 2. QUICK REPLY — pesan yang membawa sinyal quick reply
 *    (`trigger_signal.kind = 'quick_reply'`: quick reply Meta,
 *    balasan tombol/daftar interaktif WhatsApp). Pemicu quick reply
 *    (payload PERSIS) dievaluasi lebih dulu. Bila ADA pemicu quick
 *    reply yang cocok — automation ATAU flow — pemicu KEYWORD ditekan
 *    untuk pesan ini di kedua mesin: satu ketukan tombol tidak boleh
 *    memicu dua balasan. Bila TIDAK ada pemicu quick reply yang cocok,
 *    pesan TURUN KELAS menjadi teks biasa (judul tombolnya) dan
 *    dievaluasi normal oleh kelas 3–5: pengguna tetap mendapat
 *    jawaban. Teks ketikan biasa TIDAK PERNAH naik kelas: sinyal hanya
 *    lahir dari payload provider, tidak dari isi teks.
 *
 * 3. KEYWORD / SEQUENCE — automation keyword & sequence (teks cocok
 *    exact/contains) dan flow trigger keyword. Multi-fire seperti
 *    sebelumnya: semua aturan yang cocok menembak.
 *
 * 4. WELCOME — pesan ini adalah pesan masuk PERTAMA di percakapannya
 *    (dan, per aturan, kontak belum pernah dipicu aturan itu):
 *    automation welcome + flow trigger welcome. Ditekan bila kelas
 *    1–3 menembak/memulai run untuk pesan ini — sambutan tidak
 *    menumpuk di atas jawaban yang lebih spesifik. Sekali per kontak
 *    per aturan ditegakkan lewat riwayat run (automation_runs /
 *    sequence_enrollments / flow_runs per aturan+kontak), BUKAN hanya
 *    "pesan pertama di percakapan": kontak yang membuka percakapan
 *    baru tidak disambut dua kali oleh aturan yang sama.
 *
 * 5. FLOW UMUM — flow trigger `any_message`: menyala untuk pesan teks
 *    biasa apa pun yang sampai di sini.
 *
 * 6. FALLBACK DEFAULT / AI — worker meneruskan pesan ke agen AI hanya
 *    bila tidak ada satu pun di atas yang menembak/memulai/melanjutkan
 *    run dan tidak ada tindakan consent (kontrak worker yang sudah
 *    ada), dan tidak pernah untuk sinyal postback (kelas 1).
 *
 * PENYIMPANGAN SADAR dari pakem "satu pemenang" (pola rujukan
 * zernflow trigger-matcher adalah first-match tunggal):
 * - Arsitektur Botara SEJAK AWAL multi-fire: banyak automation boleh
 *   menembak untuk satu pesan dan banyak flow boleh mulai. Prioritas
 *   di sini adalah urutan KELAS + aturan penekanan antar-kelas (kelas
 *   sinyal menekan keyword; keyword menekan welcome; postback menutup
 *   semua kelas teks), bukan pemenang tunggal — mengubahnya menjadi
 *   first-match akan merusak perilaku Fase 2/3 yang sudah live.
 * - Welcome vs any_message (kelas 4 vs 5) bersifat ADITIF: flow
 *   welcome dan flow any_message boleh sama-sama mulai untuk pesan
 *   pertama, mengikuti semantik multi-start flow yang ada. Penekanan
 *   welcome ditegakkan terhadap kelas yang lebih SPESIFIK (sinyal &
 *   keyword), sesuai urutan yang diminta.
 */

import type { Message, MessageTriggerSignal } from "@sahabat-kreator/db";

/** Kelas pemicu yang bersaing atas satu pesan masuk (urutan = prioritas). */
export const TRIGGER_CLASS_PRIORITY = [
  "postback",
  "quick_reply",
  "keyword",
  "welcome",
  "any_message",
] as const;

export type TriggerClass = (typeof TRIGGER_CLASS_PRIORITY)[number];

/** Sinyal pemicu pada baris pesan (null = pesan biasa tanpa sinyal). */
export function triggerSignalOf(
  message: Pick<Message, "triggerSignal">,
): MessageTriggerSignal | null {
  const signal = message.triggerSignal;
  if (
    signal &&
    (signal.kind === "postback" || signal.kind === "quick_reply") &&
    typeof signal.payload === "string" &&
    signal.payload.length > 0
  ) {
    return signal;
  }
  return null;
}

/**
 * Pencocokan payload pemicu sinyal: PERSIS dan case-sensitive.
 * Payload adalah string mesin yang dikonfigurasi pengirim tombol —
 * menormalkannya seperti teks manusia (trim/lowercase) akan membuat
 * dua tombol berbeda bertabrakan.
 */
export function triggerPayloadMatches(
  payloads: readonly string[] | undefined,
  payload: string,
): boolean {
  return Array.isArray(payloads) && payloads.includes(payload);
}
