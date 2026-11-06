import { auditLogs, type Database } from "@sahabat-kreator/db";
import { withTenantDb } from "./tx";

/**
 * Jejak job BullMQ yang GAGAL PERMANEN (Fase 16E).
 *
 * MASALAH YANG DITUTUP: setiap job punya `attempts: 3` + backoff
 * eksponensial, lalu — bila ketiganya gagal — BullMQ memindahkannya ke
 * himpunan `failed` dan berhenti. Satu-satunya jejak saat itu adalah
 * `console.error` di listener `failed`, yang juga berbunyi pada
 * percobaan ke-1 dan ke-2. Akibatnya:
 * - tidak ada cara membedakan "gagal lalu berhasil" dari "menyerah";
 * - `message.received` yang menyerah berarti automation/AI tidak pernah
 *   menjawab pelanggan, dan tidak ada yang tahu;
 * - job `flow.step` yang menyerah berarti satu pelanggan berhenti di
 *   tengah alur tanpa gejala apa pun.
 *
 * Ditulis ke `audit_logs` (bukan tabel baru) karena audit sudah punya
 * permukaan baca per tenant, RLS, dan retensi — dan karena pertanyaan
 * "kenapa pelanggan ini tidak dibalas?" memang pertanyaan audit.
 *
 * BEST-EFFORT seperti `recordIntegrationLog`: kegagalan menulis jejak
 * tidak boleh menjatuhkan worker yang sedang menangani kegagalan lain.
 * Pemanggil tetap mencatat ke stderr.
 */

/** Action audit untuk job yang menyerah setelah semua percobaan. */
export const JOB_FAILED_ACTION = "job.failed";

/** Panjang maksimum pesan error yang disimpan (bukan tumpukan penuh). */
const ERROR_MAX = 500;

export interface RecordPermanentJobFailureInput {
  tenantId: string;
  /** Nama job BullMQ, mis. `automation.evaluate`, `flow.step`. */
  jobName: string;
  /** Id job BullMQ (bisa dipakai untuk menelusuri di Redis). */
  jobId: string;
  /** Jumlah percobaan yang sudah dilakukan (attemptsMade saat menyerah). */
  attempts: number;
  error: unknown;
}

function describeError(err: unknown): string {
  const raw =
    err instanceof Error
      ? `${err.name}: ${err.message}`
      : typeof err === "string"
        ? err
        : (() => {
            try {
              return JSON.stringify(err);
            } catch {
              return String(err);
            }
          })();
  return raw.length > ERROR_MAX ? `${raw.slice(0, ERROR_MAX)}…` : raw;
}

/**
 * Mencatat satu job yang gagal permanen. Mengembalikan true bila baris
 * audit tersimpan; false bila tidak (dan pemanggil sudah mencatat ke
 * stderr). Tidak pernah melempar.
 */
export async function recordPermanentJobFailure(
  db: Database,
  input: RecordPermanentJobFailureInput,
): Promise<boolean> {
  try {
    await withTenantDb(db, input.tenantId, async (tx) => {
      await tx.insert(auditLogs).values({
        tenantId: input.tenantId,
        actorType: "system",
        // actor_id = nama job: pertanyaan "apa yang menyerah" terjawab
        // tanpa membuka meta.
        actorId: input.jobName.slice(0, 255),
        action: JOB_FAILED_ACTION,
        meta: {
          jobId: input.jobId,
          jobName: input.jobName,
          attempts: input.attempts,
          error: describeError(input.error),
        },
      });
    });
    return true;
  } catch {
    return false;
  }
}
