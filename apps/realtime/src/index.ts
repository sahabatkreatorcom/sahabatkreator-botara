import { createServer, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { loadEnv } from "@sahabat-kreator/config";
import {
  RealtimeNudgeSchema,
  type RealtimeNudge,
} from "@sahabat-kreator/contracts";
import {
  flushQueuedWebchatMessages,
  getWebchatChannelAccountStatus,
} from "@sahabat-kreator/core";
import {
  createRealtimePublisher,
  createRedisConnection,
  realtimeTenantChannel,
  REALTIME_TENANT_CHANNEL_PATTERN,
  type RealtimePublisher,
} from "@sahabat-kreator/queue";
import { verifyWebchatVisitorToken } from "@sahabat-kreator/channel-webchat";
import {
  createRealtimeAuthBundle,
  resolveDashboardSocketIdentity,
  type RealtimeAuthBundle,
} from "./auth";

/**
 * apps/realtime (Fase 6G) — gateway WebSocket mandiri Sahabat Kreator.
 *
 * Mengambil alih hub WebSocket in-memory yang dulu hidup di apps/api
 * (Fase 1F–6A.2) dan menjadi SATU-SATUNYA pemilik koneksi socket:
 *
 * - Dashboard agen: `GET /realtime/dashboard?tenantId=<uuid>` — auth
 *   cookie sesi Better Auth + membership tenant (lihat ./auth.ts).
 *   Socket hanya menerima nudge tenant itu.
 * - Pengunjung webchat: `GET /realtime/webchat?token=<token HMAC>` —
 *   token pengunjung yang sama seperti endpoint REST webchat; socket
 *   terikat pada SATU percakapan dari payload token. Sejak hotfix
 *   Disconnect Gate, upgrade juga menolak (403) bila akun channel
 *   pemilik token tidak sedang 'connected' — sejajar gerbang REST.
 *
 * Tulang punggungnya Redis pub/sub: penerbit (api/worker) mem-publish
 * nudge kecil (kontrak @sahabat-kreator/contracts) ke channel per-tenant
 * `rt:tenant:<id>` SETELAH perubahan ter-commit; gateway ini
 * berlangganan pola `rt:tenant:*` dan meneruskan nudge apa adanya.
 * Nudge BUKAN muatan: klien memuat ulang lewat REST (sumber kebenaran).
 *
 * Peran pengiriman webchat pindah ke sini: saat nudge `message.queued`
 * tiba untuk percakapan yang pengunjungnya sedang terhubung (atau saat
 * pengunjung baru connect), gateway mem-flush pesan `queued` percakapan
 * itu lewat core (`flushQueuedWebchatMessages` → status `sent`), lalu
 * mendorong nudge ke socket pengunjung dan menerbitkan `message.sent`
 * balik ke Redis agar dashboard ikut menyegar. Pengunjung offline:
 * pesan tetap `queued`, ter-flush saat reconnect — semantik Fase 1F
 * dipertahankan, hanya pemilik hub-nya yang pindah proses.
 *
 * Ketahanan: Redis/pub-sub adalah jalur CEPAT, bukan satu-satunya —
 * klien mempertahankan polling fallback, jadi gateway (atau Redis)
 * yang mati hanya menurunkan kesegaran ke level polling, bukan
 * menghentikan layanan.
 */

const env = loadEnv();
const startedAt = Date.now();

let authBundle: RealtimeAuthBundle | null = null;
if (env.DATABASE_URL && env.BETTER_AUTH_SECRET) {
  authBundle = createRealtimeAuthBundle({
    databaseUrl: env.DATABASE_URL,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL ?? `http://localhost:${env.API_PORT}`,
  });
} else {
  console.warn(
    "[realtime] DATABASE_URL/BETTER_AUTH_SECRET belum diatur — socket dashboard akan ditolak; socket webchat tetap bisa (butuh WEBCHAT_SECRET)",
  );
}

const publisher: RealtimePublisher | null = env.REDIS_URL
  ? createRealtimePublisher(env.REDIS_URL)
  : null;
if (!publisher) {
  console.warn("[realtime] REDIS_URL belum diatur — nudge message.sent dari flush webchat tidak diterbitkan");
}

// ---------------------------------------------------------------------------
// Registri koneksi
// ---------------------------------------------------------------------------

/** Socket dashboard per tenant (satu user bisa punya beberapa tab). */
const dashboardSockets = new Map<string, Set<WebSocket>>();

interface VisitorSocket {
  socket: WebSocket;
  tenantId: string;
}
/** Socket pengunjung per conversationId (satu percakapan, bisa >1 tab). */
const visitorSockets = new Map<string, Set<VisitorSocket>>();

function trackSocket<T extends Map<string, Set<U>>, U>(
  map: T,
  key: string,
  value: U & { socket: WebSocket },
): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(value);
  const cleanup = () => {
    set.delete(value);
    if (set.size === 0) map.delete(key);
  };
  value.socket.once("close", cleanup);
  value.socket.once("error", cleanup);
}

function sendFrame(socket: WebSocket, frame: unknown): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(frame));
  }
}

function broadcastToDashboard(tenantId: string, nudge: RealtimeNudge): void {
  const set = dashboardSockets.get(tenantId);
  if (!set) return;
  for (const socket of set) sendFrame(socket, nudge);
}

function broadcastToVisitors(conversationId: string, nudge: RealtimeNudge): void {
  const set = visitorSockets.get(conversationId);
  if (!set) return;
  for (const entry of set) sendFrame(entry.socket, nudge);
}

function hasVisitor(conversationId: string): boolean {
  const set = visitorSockets.get(conversationId);
  return Boolean(set && set.size > 0);
}

// ---------------------------------------------------------------------------
// Flush pengiriman webchat (pengganti poller + dorongan hub di apps/api)
// ---------------------------------------------------------------------------

/**
 * Flush pesan `queued` satu percakapan webchat (→ `sent`) lalu beri tahu
 * kedua sisi: nudge ke socket pengunjung (agar widget refetch REST) dan
 * nudge `message.sent` ke Redis (agar dashboard menyegar status).
 * Aman dipanggil berulang & bersamaan — core mengunci per baris status.
 */
async function flushWebchatConversation(
  tenantId: string,
  conversationId: string,
): Promise<void> {
  if (!authBundle) return;
  try {
    const flushed = await flushQueuedWebchatMessages(authBundle.db, {
      tenantId,
      conversationId,
    });
    if (flushed.length === 0) return;
    const nudge: RealtimeNudge = {
      type: "nudge",
      kind: "message.sent",
      tenantId,
      conversationId,
      at: new Date().toISOString(),
    };
    broadcastToVisitors(conversationId, nudge);
    if (publisher) {
      await publisher.publishNudge({
        kind: "message.sent",
        tenantId,
        conversationId,
      });
    }
  } catch (err) {
    console.error(
      `[realtime] flush webchat conversation=${conversationId} gagal:`,
      err,
    );
  }
}

// ---------------------------------------------------------------------------
// Langganan Redis pub/sub
// ---------------------------------------------------------------------------

function handleNudge(raw: string): void {
  let parsed: RealtimeNudge;
  try {
    parsed = RealtimeNudgeSchema.parse(JSON.parse(raw));
  } catch {
    console.warn("[realtime] frame pub/sub tidak valid — diabaikan");
    return;
  }
  // Dashboard tenant ini selalu menerima nudgenya.
  broadcastToDashboard(parsed.tenantId, parsed);
  if (!parsed.conversationId) return;
  // Socket pengunjung hanya peduli percakapannya sendiri.
  if (!hasVisitor(parsed.conversationId)) return;
  if (parsed.kind === "message.queued") {
    // Ada balasan menunggu untuk pengunjung yang sedang terhubung:
    // flush (queued → sent) lalu dorong nudge sesudahnya. Nudge
    // `message.queued` TIDAK diteruskan mentah ke pengunjung sebelum
    // flush selesai — widget harus membaca status final dari REST.
    void flushWebchatConversation(parsed.tenantId, parsed.conversationId);
    return;
  }
  broadcastToVisitors(parsed.conversationId, parsed);
}

if (env.REDIS_URL) {
  const subscriber = createRedisConnection(env.REDIS_URL);
  subscriber.on("error", (err) => {
    console.error("[realtime] koneksi Redis subscriber error:", err.message);
  });
  void subscriber
    .psubscribe(REALTIME_TENANT_CHANNEL_PATTERN)
    .then(() => {
      console.log(
        `[realtime] berlangganan pola ${REALTIME_TENANT_CHANNEL_PATTERN} (channel contoh: ${realtimeTenantChannel("<tenantId>")})`,
      );
    })
    .catch((err) => {
      console.error("[realtime] psubscribe gagal:", err);
    });
  subscriber.on("pmessage", (_pattern, _channel, message) => {
    handleNudge(message);
  });
} else {
  console.warn("[realtime] REDIS_URL belum diatur — gateway berjalan tanpa pub/sub (socket hanya menerima ready)");
}

// ---------------------------------------------------------------------------
// Server HTTP + upgrade WebSocket
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });

function rejectUpgrade(socket: Duplex, statusLine: string): void {
  socket.write(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

const uuidSchema = z.string().uuid();

async function handleUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(req.url ?? "", "http://localhost");
  } catch {
    rejectUpgrade(socket, "400 Bad Request");
    return;
  }
  const path = url.pathname.replace(/\/$/, "");

  if (path === "/realtime/dashboard" || path === "/dashboard") {
    const tenantIdRaw = url.searchParams.get("tenantId") ?? "";
    if (!authBundle || !uuidSchema.safeParse(tenantIdRaw).success) {
      rejectUpgrade(socket, "401 Unauthorized");
      return;
    }
    let identity = null;
    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers.set(key, value);
        else if (Array.isArray(value)) headers.set(key, value.join(", "));
      }
      identity = await resolveDashboardSocketIdentity(
        authBundle,
        headers,
        tenantIdRaw,
      );
    } catch (err) {
      console.error("[realtime] validasi sesi dashboard gagal:", err);
      identity = null;
    }
    if (!identity) {
      rejectUpgrade(socket, "401 Unauthorized");
      return;
    }
    const tenantId = identity.tenant.id;
    wss.handleUpgrade(req, socket, head, (ws) => {
      let set = dashboardSockets.get(tenantId);
      if (!set) {
        set = new Set();
        dashboardSockets.set(tenantId, set);
      }
      set.add(ws);
      const cleanup = () => {
        set.delete(ws);
        if (set.size === 0) dashboardSockets.delete(tenantId);
      };
      ws.once("close", cleanup);
      ws.once("error", cleanup);
      sendFrame(ws, { type: "ready", tenantId });
    });
    return;
  }

  if (path === "/realtime/webchat" || path === "/webchat") {
    const token = url.searchParams.get("token");
    const payload =
      token && env.WEBCHAT_SECRET
        ? verifyWebchatVisitorToken(env.WEBCHAT_SECRET, token)
        : null;
    if (!payload) {
      rejectUpgrade(socket, "401 Unauthorized");
      return;
    }
    // Gerbang disconnect (hotfix Webchat Disconnect Gate), sejajar
    // dengan gerbang REST di apps/api: token SAH saja tidak cukup —
    // akun channel pemilik token harus sedang 'connected'. Ditolak
    // dengan 403, BUKAN 401: tokennya sendiri tidak batal (ia berlaku
    // lagi begitu channel dihubungkan kembali), dan klien tidak boleh
    // menafsirkannya sebagai token kedaluwarsa/rusak. Bila bundle DB
    // tidak terkonfigurasi (mode terdegradasi tanpa database), status
    // memang tidak bisa diverifikasi — perilaku lama dipertahankan dan
    // flush pun sudah no-op dalam mode itu.
    if (authBundle) {
      let status: string | null = null;
      try {
        status = await getWebchatChannelAccountStatus(
          authBundle.db,
          { tenantId: payload.tid },
          payload.acc,
        );
      } catch (err) {
        console.error("[realtime] cek status channel webchat gagal:", err);
        status = null;
      }
      if (status !== "connected") {
        rejectUpgrade(socket, "403 Forbidden");
        return;
      }
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      trackSocket(visitorSockets, payload.cv, {
        socket: ws,
        tenantId: payload.tid,
      });
      sendFrame(ws, { type: "ready", conversationId: payload.cv });
      // Jalur offline → online (Fase 1F): balasan yang menunggu selama
      // pengunjung pergi ter-flush menjadi `sent` saat ia kembali.
      void flushWebchatConversation(payload.tid, payload.cv);
    });
    return;
  }

  rejectUpgrade(socket, "404 Not Found");
}

const server = createServer((req, res) => {
  if (req.url === "/health" || req.url === "/realtime/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        service: "realtime",
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        timestamp: new Date().toISOString(),
        dashboardSockets: [...dashboardSockets.values()].reduce(
          (sum, set) => sum + set.size,
          0,
        ),
        visitorSockets: [...visitorSockets.values()].reduce(
          (sum, set) => sum + set.size,
          0,
        ),
      }),
    );
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.on("upgrade", (req, socket, head) => {
  void handleUpgrade(req, socket, head).catch((err) => {
    console.error("[realtime] upgrade gagal:", err);
    rejectUpgrade(socket, "500 Internal Server Error");
  });
});

// Heartbeat: ping berkala; socket yang tidak menjawab pong dianggap mati
// dan diterminasi agar registri tidak memegang koneksi zombie.
const heartbeat = setInterval(() => {
  for (const client of wss.clients) {
    const ws = client as WebSocket & { isAlive?: boolean };
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);
wss.on("connection", (ws: WebSocket & { isAlive?: boolean }) => {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });
});

server.listen(env.REALTIME_PORT, "127.0.0.1", () => {
  console.log(
    `[realtime] Sahabat Kreator realtime gateway listening on http://127.0.0.1:${env.REALTIME_PORT}`,
  );
});

function shutdown(signal: string): void {
  console.log(`[realtime] menerima ${signal}, berhenti...`);
  clearInterval(heartbeat);
  server.close(() => process.exit(0));
  // Jangan menggantung selamanya pada socket yang bandel.
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
