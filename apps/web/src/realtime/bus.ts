/**
 * Bus nudge realtime dashboard (Fase 6G) — SATU koneksi WebSocket per tab
 * ke apps/realtime (`/realtime/dashboard?tenantId=...`, auth cookie sesi
 * yang sama dengan REST), dibagikan semua konsumen lewat langganan
 * callback sederhana.
 *
 * Frame yang tiba adalah NUDGE (bukan data): konsumen yang berlangganan
 * cukup menjalankan penyegaran REST senyapnya yang sudah ada (pola
 * hooks/usePolling). Bila socket putus, bus menyambung ulang dengan
 * backoff 1s→15s dan — yang terpenting — polling tetap berjalan sebagai
 * fallback, jadi putusnya socket hanya menurunkan kesegaran ke ±5 dtk,
 * tidak pernah menghentikan pembaruan.
 */

type NudgeListener = () => void;

const listeners = new Set<NudgeListener>();

let currentTenantId: string | null = null;
let socket: WebSocket | null = null;
let reconnectTimer: number | null = null;
let reconnectStep = 0;

const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 15_000];

function clearReconnectTimer(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(): void {
  if (!currentTenantId || reconnectTimer !== null) return;
  const base =
    RECONNECT_DELAYS_MS[Math.min(reconnectStep, RECONNECT_DELAYS_MS.length - 1)];
  reconnectStep += 1;
  // Jitter ±30%: setelah server restart, semua tab tidak menyambung ulang
  // pada milidetik yang sama (thundering herd ke gateway realtime).
  const delay = Math.round(base * (0.7 + Math.random() * 0.6));
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function connect(): void {
  if (!currentTenantId) return;
  const tenantId = currentTenantId;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  let ws: WebSocket;
  try {
    ws = new WebSocket(
      `${proto}//${window.location.host}/realtime/dashboard?tenantId=${encodeURIComponent(tenantId)}`,
    );
  } catch {
    scheduleReconnect();
    return;
  }
  socket = ws;
  ws.onopen = () => {
    reconnectStep = 0;
  };
  ws.onmessage = (event) => {
    try {
      const frame = JSON.parse(String(event.data)) as { type?: string };
      if (frame.type !== "nudge") return;
    } catch {
      return; // frame tidak dikenal — abaikan
    }
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* satu konsumen gagal tidak boleh menjatuhkan konsumen lain */
      }
    }
  };
  ws.onclose = () => {
    if (socket === ws) {
      socket = null;
      scheduleReconnect();
    }
  };
  ws.onerror = () => {
    // onclose menyusul dan menjadwalkan reconnect; cukup tutup rapi.
    try {
      ws.close();
    } catch {
      /* abaikan */
    }
  };
}

/**
 * Tetapkan tenant aktif untuk koneksi bus (dipanggil provider yang tahu
 * workspace aktif). Berganti tenant → socket lama ditutup, socket baru
 * dibuka. Null (logout / belum ada workspace) → socket ditutup.
 */
export function setRealtimeTenantId(tenantId: string | null): void {
  if (currentTenantId === tenantId) return;
  currentTenantId = tenantId;
  reconnectStep = 0;
  clearReconnectTimer();
  if (socket) {
    const old = socket;
    socket = null;
    old.onclose = null;
    try {
      old.close();
    } catch {
      /* abaikan */
    }
  }
  if (tenantId) connect();
}

/** Berlangganan nudge tenant aktif; kembalikan fungsi berhenti langganan. */
export function subscribeNudge(listener: NudgeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Kembali online → bila socket sedang putus, coba sambung SEGERA tanpa
// menunggu sisa backoff (pola pemulihan yang sama seperti widget).
if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    if (currentTenantId && !socket) {
      reconnectStep = 0;
      clearReconnectTimer();
      connect();
    }
  });
}
