/**
 * Tombol aksi flow (G18, node `send_action_buttons`): pesan keluar
 * dengan tombol "salin teks" (copy_text) dan "telepon" (call).
 *
 * Pembagian tanggung jawab sama seperti katalog natif G17:
 * - Kontrak (contracts/flows.ts) memegang skema config + peta
 *   dukungan natif per provider (`ACTION_BUTTON_NATIVE_SUPPORT`).
 * - Modul ini MURNI: membaca config node secara defensif dan
 *   membangun { contentText, interactivePayload, modes } untuk satu
 *   provider. Tombol yang platformnya mendukung secara natif masuk
 *   muatan interaktif; sisanya ditulis sebagai baris teks terbaca
 *   di badan pesan (fallback JUJUR — pelanggan tetap menerima
 *   nomor/kodenya) dan modenya tercatat untuk detail langkah run.
 * - Eksekutor mengantrekan pesan; poller worker membentuk panggilan
 *   API natif dari muatan (keyboard inline Telegram / template
 *   tombol Messenger).
 */
import {
  ACTION_BUTTON_NATIVE_SUPPORT,
  type FlowActionButton,
} from "@sahabat-kreator/contracts";
import type { MessageInteractivePayload } from "@sahabat-kreator/db";
import type { FlowGraphNode } from "./graph";

export interface ActionButtonsConfig {
  text: string;
  buttons: FlowActionButton[];
}

/** Batas label per target natif: template tombol Send API = 20. */
const MESSENGER_LABEL_MAX = 20;
/** Batas teks salin Telegram (copy_text Bot API) = 256. */
const TELEGRAM_COPY_MAX = 256;

/** Pembaca config defensif (pola catalogConfigOf). */
export function actionButtonsConfigOf(node: FlowGraphNode): ActionButtonsConfig {
  const c = (node.config ?? {}) as Record<string, unknown>;
  const text = typeof c.text === "string" ? c.text : "";
  const rawButtons = Array.isArray(c.buttons) ? c.buttons : [];
  const buttons: FlowActionButton[] = [];
  for (const raw of rawButtons.slice(0, 3)) {
    if (!raw || typeof raw !== "object") continue;
    const b = raw as Record<string, unknown>;
    if (b.kind !== "copy_text" && b.kind !== "call") continue;
    if (typeof b.label !== "string" || typeof b.value !== "string") continue;
    buttons.push({ kind: b.kind, label: b.label, value: b.value });
  }
  return { text, buttons };
}

/**
 * Normalisasi nomor untuk tombol telepon: buang spasi/tanda pisah;
 * sah hanya bila tersisa awalan "+" opsional + 5..15 digit. Null
 * bila tidak sah — pemanggil menurunkannya ke fallback teks agar
 * nomor apa adanya tetap sampai ke pelanggan (tidak dibuang).
 */
export function normalizeCallNumber(value: string): string | null {
  const stripped = value.replace(/[\s().-]/g, "");
  return /^\+?\d{5,15}$/.test(stripped) ? stripped : null;
}

export interface ActionButtonDeliveryMode {
  kind: FlowActionButton["kind"];
  mode: "native" | "text_fallback";
}

export interface BuiltActionButtonsDelivery {
  contentText: string;
  interactivePayload: MessageInteractivePayload | null;
  modes: ActionButtonDeliveryMode[];
}

/**
 * Bangun pengiriman tombol aksi untuk SATU provider. `text` dan
 * nilai tombol SUDAH dirender eksekutor (keluarga variabel pesan).
 */
export function buildActionButtonsDelivery(input: {
  provider: string;
  text: string;
  buttons: FlowActionButton[];
}): BuiltActionButtonsDelivery {
  const support = ACTION_BUTTON_NATIVE_SUPPORT[input.provider] ?? {
    copy_text: false,
    call: false,
  };
  const modes: ActionButtonDeliveryMode[] = [];
  const fallbackLines: string[] = [];
  const telegramButtons: Array<{ label: string; copyText?: string; url?: string }> = [];
  const messengerButtons: Array<{
    type: "phone_number";
    title: string;
    payload: string;
  }> = [];

  for (const button of input.buttons) {
    const native = support[button.kind] === true;
    if (native && input.provider === "telegram") {
      if (button.kind === "copy_text") {
        telegramButtons.push({
          label: button.label,
          copyText: button.value.slice(0, TELEGRAM_COPY_MAX),
        });
        modes.push({ kind: button.kind, mode: "native" });
        continue;
      }
      const number = normalizeCallNumber(button.value);
      if (number) {
        telegramButtons.push({ label: button.label, url: `tel:${number}` });
        modes.push({ kind: button.kind, mode: "native" });
        continue;
      }
    }
    if (native && input.provider === "messenger" && button.kind === "call") {
      const number = normalizeCallNumber(button.value);
      if (number) {
        messengerButtons.push({
          type: "phone_number",
          title: button.label.slice(0, MESSENGER_LABEL_MAX),
          payload: number,
        });
        modes.push({ kind: button.kind, mode: "native" });
        continue;
      }
    }
    // Fallback jujur: nilai tombol tampil sebagai baris teks.
    fallbackLines.push(`${button.label}: ${button.value}`);
    modes.push({ kind: button.kind, mode: "text_fallback" });
  }

  const contentText =
    fallbackLines.length > 0
      ? [input.text, ...fallbackLines].filter((s) => s.length > 0).join("\n")
      : input.text;

  let interactivePayload: MessageInteractivePayload | null = null;
  if (telegramButtons.length > 0) {
    interactivePayload = { kind: "telegram_inline_buttons", buttons: telegramButtons };
  } else if (messengerButtons.length > 0) {
    interactivePayload = {
      kind: "messenger_button_template",
      buttons: messengerButtons,
    };
  }
  return { contentText, interactivePayload, modes };
}
