import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Enkripsi kredensial channel (Fase 6A, RANCANGAN §2 prinsip keamanan).
 *
 * Token provider (bot Telegram; kelak token Meta) adalah kredensial penuh:
 * siapa pun yang memegangnya bisa mengirim pesan sebagai akun tenant.
 * Karena itu token TIDAK PERNAH disimpan mentah:
 *
 * - Enkripsi AES-256-GCM dengan kunci dari env `CHANNEL_TOKEN_SECRET`
 *   (base64 dari 32 byte acak, hanya ada di env server). Envelope disimpan
 *   di kolom `channel_accounts.access_token_encrypted` dengan format
 *   berversi: `v1:<iv>.<authTag>.<ciphertext>` (semua base64url) — versi
 *   eksplisit agar skema bisa berputar kelak tanpa menebak format lama.
 * - Secret webhook per akun (untuk memverifikasi header dari provider)
 *   disimpan sebagai hash SHA-256 hex di `channel_accounts.webhook_secret`:
 *   yang perlu dibuktikan hanya "header sama dengan secret", jadi nilai
 *   aslinya tidak perlu bisa dipulihkan.
 *
 * Nilai token/secret TIDAK PERNAH masuk log, audit, atau respons API —
 * modul ini juga tidak mencatat apa pun.
 */

const ENVELOPE_VERSION = "v1";

/** Menurunkan kunci 32 byte dari material env (base64). Melempar bila format salah. */
function deriveKey(secretMaterial: string): Buffer {
  const decoded = Buffer.from(secretMaterial, "base64");
  if (decoded.length !== 32) {
    throw new Error(
      "CHANNEL_TOKEN_SECRET tidak valid: harus base64 dari tepat 32 byte",
    );
  }
  return decoded;
}

/** Mengenkripsi teks kredensial → envelope `v1:...` untuk disimpan di DB. */
export function encryptChannelSecret(
  secretMaterial: string,
  plaintext: string,
): string {
  const key = deriveKey(secretMaterial);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    ENVELOPE_VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

/**
 * Membuka envelope dari `encryptChannelSecret`. Mengembalikan null bila
 * format asing/rusak atau tag GCM tidak cocok (data diubah / kunci salah) —
 * pemanggil memperlakukan null sebagai "kredensial tidak bisa dipakai",
 * bukan crash.
 */
export function decryptChannelSecret(
  secretMaterial: string,
  stored: string,
): string | null {
  const parts = stored.split(":");
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) return null;
  try {
    const key = deriveKey(secretMaterial);
    const iv = Buffer.from(parts[1], "base64url");
    const tag = Buffer.from(parts[2], "base64url");
    const ciphertext = Buffer.from(parts[3], "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

/** Secret webhook acak untuk satu akun channel (24 byte entropi, base64url). */
export function generateChannelWebhookSecret(): string {
  return randomBytes(24).toString("base64url");
}

/** Hash SHA-256 hex dari secret webhook — bentuk yang disimpan di DB. */
export function hashChannelWebhookSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Verifikasi header secret terhadap hash tersimpan, aman terhadap timing. */
export function verifyChannelWebhookSecret(
  presentedSecret: string,
  storedHash: string | null,
): boolean {
  if (!storedHash) return false;
  const presented = Buffer.from(
    hashChannelWebhookSecret(presentedSecret),
    "utf8",
  );
  const expected = Buffer.from(storedHash, "utf8");
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}
