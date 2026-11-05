import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  ChannelAdapter,
  SendMessageInput,
  SendMessageResult,
  StandardEvent,
  VerifyWebhookInput,
} from "@sahabat-kreator/channel-core";

/**
 * @sahabat-kreator/channel-webchat — channel milik sendiri (Fase 1F).
 *
 * Webchat berbeda dari channel Meta: tidak ada webhook provider dan tidak
 * ada API pihak ketiga untuk mengirim pesan. "Pengiriman" berarti mendorong
 * pesan ke koneksi WebSocket pengunjung yang sedang terbuka di API kita
 * sendiri. Karena adapter channel-core adalah objek murni tanpa koneksi,
 * pembagian kerja yang dipakai:
 *
 * - Paket ini memiliki FORMAT token sesi pengunjung (HMAC) + normalisasi
 *   payload pesan masuk ke StandardEvent (fungsi murni, bisa dites).
 * - Logika sesi/pesan/DB hidup di @sahabat-kreator/core (`webchat.ts`).
 * - Pengiriman realtime dilakukan apps/realtime (Fase 6G — gateway
 *   WebSocket mandiri bertulang-punggung Redis pub/sub; sebelumnya hub
 *   in-memory di apps/api). Ia mem-flush baris pesan DB yang sudah
 *   tersimpan (bukan teks mentah) agar status pesan selalu bersumber
 *   dari DB. Adapter `ChannelAdapter` di paket ini adalah pintu bagi
 *   worker/pengirim berbasis antrean di fase berikutnya: mereka
 *   mendaftarkan fungsi pengirimnya lewat `registerWebchatSender`.
 *   Tanpa pengirim terdaftar, `sendMessage` melempar error dengan jujur.
 */

// ---------------------------------------------------------------------------
// Token sesi pengunjung: base64url(JSON payload) + "." + base64url(HMAC-SHA256)
// Payload: { tid, acc, con, cv, exp } — tenant, channel account, contact,
// conversation, expiry (unix detik). Ditandatangani WEBCHAT_SECRET.
// ---------------------------------------------------------------------------

export interface WebchatVisitorTokenPayload {
  /** tenantId */
  tid: string;
  /** channelAccountId */
  acc: string;
  /** contactId */
  con: string;
  /** conversationId */
  cv: string;
  /** Expiry, unix detik. */
  exp: number;
}

export const WEBCHAT_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 hari

function b64urlEncode(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

export function createWebchatVisitorToken(
  secret: string,
  payload: Omit<WebchatVisitorTokenPayload, "exp"> & { exp?: number },
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const full: WebchatVisitorTokenPayload = {
    ...payload,
    exp: payload.exp ?? nowSeconds + WEBCHAT_TOKEN_TTL_SECONDS,
  };
  const body = b64urlEncode(JSON.stringify(full));
  return `${body}.${sign(secret, body)}`;
}

/** Mengembalikan payload bila signature valid & belum kedaluwarsa; selain itu null. */
export function verifyWebchatVisitorToken(
  secret: string,
  token: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): WebchatVisitorTokenPayload | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = sign(secret, body);
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  let payload: WebchatVisitorTokenPayload;
  try {
    payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as WebchatVisitorTokenPayload;
  } catch {
    return null;
  }
  if (
    typeof payload.tid !== "string" ||
    typeof payload.acc !== "string" ||
    typeof payload.con !== "string" ||
    typeof payload.cv !== "string" ||
    typeof payload.exp !== "number" ||
    payload.exp <= nowSeconds
  ) {
    return null;
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/** Fungsi pengirim yang didaftarkan hub WebSocket API (lihat header file). */
export type WebchatSender = (input: SendMessageInput) => Promise<SendMessageResult>;

let registeredSender: WebchatSender | null = null;

export function registerWebchatSender(sender: WebchatSender | null): void {
  registeredSender = sender;
}

export class WebchatChannelAdapter implements ChannelAdapter {
  readonly provider = "webchat" as const;

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    if (!registeredSender) {
      throw new Error(
        "WebchatChannelAdapter: belum ada pengirim terdaftar — hub WebSocket API belum berjalan",
      );
    }
    return registeredSender(input);
  }

  /**
   * Webchat tidak menerima webhook provider: pengunjung terautentikasi
   * dengan token HMAC di atas, bukan signature webhook. Selalu false agar
   * tidak ada jalur yang menganggap payload webchat sebagai webhook tepercaya.
   */
  verifyWebhookSignature(_input: VerifyWebhookInput): boolean {
    return false;
  }

  /**
   * Normalisasi payload pesan masuk widget ({contentText, conversationId?,
   * visitorId?}) menjadi StandardEvent `message.received`. Payload yang
   * tidak berbentuk pesan teks valid menghasilkan array kosong.
   */
  parseWebhookEvents(payload: unknown): StandardEvent[] {
    if (typeof payload !== "object" || payload === null) return [];
    const record = payload as Record<string, unknown>;
    const text =
      typeof record.contentText === "string" ? record.contentText.trim() : "";
    if (!text) return [];
    return [
      {
        type: "message.received",
        provider: "webchat",
        message: {
          conversationExternalId:
            typeof record.conversationId === "string"
              ? record.conversationId
              : "",
          senderExternalId:
            typeof record.visitorId === "string" ? record.visitorId : "",
          direction: "inbound",
          type: "text",
          text,
          sentAt: new Date().toISOString(),
        },
        raw: payload,
        receivedAt: new Date().toISOString(),
      },
    ];
  }
}
