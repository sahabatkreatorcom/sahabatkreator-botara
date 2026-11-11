import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * State OAuth bertanda tangan (HMAC-SHA256) — pola meta-oauth (7D) /
 * google-oauth (13G) / threads-oauth, diekstrak agar modul connect
 * gelombang Semua OAuth (TikTok, LinkedIn, Pinterest) memakainya
 * bersama alih-alih menyalin untuk keempat kalinya. Payload-nya
 * identik antar-modul: tenant + user yang memulai, nonce sekali
 * pakai (diklaim & dikonsumsi atomik lewat oauth-kv oleh modul
 * pemanggil — helper ini MURNI tanda tangan, tanpa penyimpanan),
 * dan kedaluwarsa epoch detik (≤10 menit, ditegakkan pemanggil
 * lewat pilihan TTL-nya).
 *
 * State BUKAN kredensial: ia hanya membuktikan "callback ini
 * menjawab start yang dimulai user ini untuk tenant ini barusan".
 * Token tidak pernah hidup di dalamnya.
 */
export interface OAuthStatePayload {
  v: 1;
  tenantId: string;
  userId: string;
  nonce: string;
  /** Epoch detik kedaluwarsa. */
  exp: number;
}

export function signOAuthState(
  secret: string,
  payload: OAuthStatePayload,
): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  const signature = createHmac("sha256", secret).update(body).digest();
  return `${body}.${signature.toString("base64url")}`;
}

export function verifyOAuthState(
  secret: string,
  state: string,
): OAuthStatePayload | null {
  const dot = state.indexOf(".");
  if (dot <= 0) return null;
  const body = state.slice(0, dot);
  const presented = Buffer.from(state.slice(dot + 1), "base64url");
  const expected = createHmac("sha256", secret).update(body).digest();
  if (presented.length !== expected.length) return null;
  if (!timingSafeEqual(presented, expected)) return null;
  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as OAuthStatePayload;
  } catch {
    return null;
  }
  if (payload.v !== 1) return null;
  if (
    typeof payload.tenantId !== "string" ||
    typeof payload.userId !== "string" ||
    typeof payload.nonce !== "string" ||
    typeof payload.exp !== "number"
  ) {
    return null;
  }
  if (payload.exp * 1000 <= Date.now()) return null;
  return payload;
}
