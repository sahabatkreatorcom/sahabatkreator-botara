import { Redis } from "ioredis";
import {
  RealtimeNudgeSchema,
  type RealtimeNudge,
  type RealtimeNudgeInput,
} from "@sahabat-kreator/contracts";

/**
 * Pub/sub realtime (Fase 6G) — jembatan event lintas proses.
 *
 * Penerbit (apps/api & apps/worker) memanggil `publishRealtimeNudge`
 * SETELAH perubahan keadaan ter-commit di Postgres, ke channel Redis
 * per-tenant `rt:tenant:<tenantId>`. apps/realtime berlangganan pola
 * `rt:tenant:*` dan meneruskan nudge ke socket dashboard tenant itu dan
 * ke socket pengunjung webchat pada percakapan yang disebut event.
 *
 * Kontrak kegagalan LEMAH (disengaja): Redis mati / terputus TIDAK BOLEH
 * menggagalkan transaksi atau request utama — nudge hilang begitu saja
 * dan klien menutupinya dengan polling fallback (dashboard ±5 dtk,
 * widget ±4 dtk). Karena itu helper ini:
 * - memakai koneksi ioredis khusus penerbit dengan `enableOfflineQueue:
 *   false` + `maxRetriesPerRequest: 1` (publish saat terputus langsung
 *   gagal, tidak menggantung request), dan
 * - menelan SEMUA error (hanya log peringatan yang di-throttle).
 */

export const REALTIME_TENANT_CHANNEL_PREFIX = "rt:tenant:";
export const REALTIME_TENANT_CHANNEL_PATTERN = "rt:tenant:*";

/** Nama channel Redis untuk nudge satu tenant. */
export function realtimeTenantChannel(tenantId: string): string {
  return `${REALTIME_TENANT_CHANNEL_PREFIX}${tenantId}`;
}

export interface RealtimePublisher {
  /**
   * Terbitkan satu nudge. TIDAK PERNAH melempar — aman di-await di jalur
   * request/job setelah commit; kegagalan hanya tercatat sebagai log.
   */
  publishNudge(input: RealtimeNudgeInput): Promise<void>;
  close(): void;
}

const LOG_THROTTLE_MS = 30_000;

/**
 * Membuat penerbit nudge untuk satu proses. Satu instance per proses
 * sudah cukup (koneksi publish saja, bukan subscribe/blocking).
 */
export function createRealtimePublisher(redisUrl: string): RealtimePublisher {
  const client = new Redis(redisUrl, {
    // Publish saat koneksi putus harus gagal CEPAT (fail-soft), bukan
    // mengantre di memori dan menggantung jalur utama.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    lazyConnect: false,
  });
  let lastErrorLogAt = 0;
  const warn = (what: string, err: unknown) => {
    const now = Date.now();
    if (now - lastErrorLogAt < LOG_THROTTLE_MS) return;
    lastErrorLogAt = now;
    console.warn(
      `[realtime] ${what} — nudge diabaikan (fallback polling menutupi):`,
      err instanceof Error ? err.message : err,
    );
  };
  client.on("error", (err) => warn("koneksi Redis penerbit error", err));

  return {
    async publishNudge(input: RealtimeNudgeInput): Promise<void> {
      try {
        const event: RealtimeNudge = RealtimeNudgeSchema.parse({
          type: "nudge",
          kind: input.kind,
          tenantId: input.tenantId,
          ...(input.conversationId
            ? { conversationId: input.conversationId }
            : {}),
          at: new Date().toISOString(),
        });
        await client.publish(
          realtimeTenantChannel(event.tenantId),
          JSON.stringify(event),
        );
      } catch (err) {
        warn("publish nudge gagal", err);
      }
    },
    close(): void {
      client.disconnect();
    },
  };
}
