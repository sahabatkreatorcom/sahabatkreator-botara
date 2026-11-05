/**
 * Node `book_appointment` (Fase 13G) — bentuk config kerja.
 *
 * DEFENSIF seperti catalogConfigOf: nilai yang tidak masuk akal jatuh ke
 * default, keabsahan ditegakkan validasi aktivasi.
 */
import {
  isNonEmptyString,
  parkTimeoutMsOf,
} from "./util";
import {
  FlowGraphNode,
} from "./graph";

// ---------------------------------------------------------------------------
// Janji temu (Fase 13G) — bentuk config node book_appointment
// ---------------------------------------------------------------------------

export interface AppointmentNodeConfig {
  /** Layanan janji yang ditawarkan; null bila config rusak (validasi aktivasi menolak). */
  serviceId: string | null;
  /** Jendela penawaran: slot sampai sekarang + sekian hari (1..30). */
  daysAhead: number;
  /** Jumlah slot per daftar yang dikirim (1..10). */
  slotsPerMessage: number;
  timeoutMs: number;
  maxInvalidAttempts: number;
  invalidPrompt: string | null;
  /** Pesan tambahan opsional yang dikirim node tepat sesudah booking tercipta. */
  bookedMessage: string | null;
}

/**
 * Membaca config node book_appointment menjadi bentuk kerja (DEFENSIF —
 * pola catalogConfigOf; keabsahan ditegakkan validasi aktivasi).
 */
export function appointmentConfigOf(node: FlowGraphNode): AppointmentNodeConfig {
  const c = node.config;
  const attempts = c.maxInvalidAttempts;
  const days = c.daysAhead;
  const perMessage = c.slotsPerMessage;
  return {
    serviceId: isNonEmptyString(c.serviceId) ? c.serviceId : null,
    daysAhead:
      typeof days === "number" && Number.isInteger(days) && days >= 1 && days <= 30
        ? days
        : 7,
    slotsPerMessage:
      typeof perMessage === "number" &&
      Number.isInteger(perMessage) &&
      perMessage >= 1 &&
      perMessage <= 10
        ? perMessage
        : 5,
    timeoutMs: parkTimeoutMsOf(c),
    maxInvalidAttempts:
      typeof attempts === "number" &&
      Number.isInteger(attempts) &&
      attempts >= 1 &&
      attempts <= 5
        ? attempts
        : 2,
    invalidPrompt: isNonEmptyString(c.invalidPrompt) ? c.invalidPrompt : null,
    bookedMessage: isNonEmptyString(c.bookedMessage) ? c.bookedMessage : null,
  };
}

/**
 * Himpunan kunci custom_fields yang DIKENAL tenant = union kunci pada
 * custom_fields seluruh kontak tenant. Produk tidak memiliki registri
 * definisi field terpisah (set_field/segment/API v1 semuanya memakai
 * kunci bebas), jadi himpunan inilah "definisi" yang dirujuk kontrak
 * questionnaire. Dipakai validasi aktivasi + pemeriksaan runtime.
 */
