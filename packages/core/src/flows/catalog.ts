/**
 * Node commerce `show_catalog` / `cart_checkout` (Fase 13F) — bentuk
 * config kerja.
 *
 * DEFENSIF seperti questionnaireConfigOf: keabsahan ditegakkan validasi
 * aktivasi (`validateFlowNodeConfig`), bukan di sini.
 */
import {
  isNonEmptyString,
  parkTimeoutMsOf,
} from "./util";
import {
  FlowGraphNode,
} from "./graph";
import {
} from "./questionnaire";

// ---------------------------------------------------------------------------
// Katalog commerce (Fase 13F) — bentuk config node show_catalog
// ---------------------------------------------------------------------------

export interface CatalogConfig {
  /** Teks pembuka opsional (dirender seperti send_message). */
  introText: string | null;
  showDescription: boolean;
  timeoutMs: number;
  maxInvalidAttempts: number;
  invalidPrompt: string | null;
  /** Teks tambahan opsional sesudah ringkasan keranjang saat item ditambahkan. */
  addedMessage: string | null;
}


/**
 * Membaca config node show_catalog menjadi bentuk kerja (DEFENSIF —
 * pola questionnaireConfigOf; keabsahan ditegakkan validasi aktivasi).
 */
export function catalogConfigOf(node: FlowGraphNode): CatalogConfig {
  const c = node.config;
  const attempts = c.maxInvalidAttempts;
  return {
    introText: isNonEmptyString(c.introText) ? c.introText : null,
    showDescription: c.showDescription === true,
    timeoutMs: parkTimeoutMsOf(c),
    maxInvalidAttempts:
      typeof attempts === "number" &&
      Number.isInteger(attempts) &&
      attempts >= 1 &&
      attempts <= 5
        ? attempts
        : 2,
    invalidPrompt: isNonEmptyString(c.invalidPrompt) ? c.invalidPrompt : null,
    addedMessage: isNonEmptyString(c.addedMessage) ? c.addedMessage : null,
  };
}

/** Membaca config node cart_checkout (Fase 13F) — DEFENSIF seperti di atas. */
export function cartCheckoutConfigOf(node: FlowGraphNode): {
  emptyMessage: string | null;
} {
  return {
    emptyMessage: isNonEmptyString(node.config.emptyMessage)
      ? node.config.emptyMessage
      : null,
  };
}
