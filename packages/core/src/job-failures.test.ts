import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  JOB_FAILED_ACTION,
  recordPermanentJobFailure,
} from "./job-failures";
import { createTestDb, TEST_TENANT_ID, type TestDb } from "./testing/pglite";

/**
 * Jejak job yang menyerah (Fase 16E), diuji pada Postgres sungguhan.
 *
 * Yang dijaga: kegagalan permanen harus MENINGGALKAN JEJAK yang bisa
 * dibaca per tenant — bukan hanya satu baris stderr yang juga berbunyi
 * pada percobaan yang akhirnya berhasil.
 */

describe("recordPermanentJobFailure", () => {
  let test: TestDb;
  let pglite: PGlite;

  beforeAll(async () => {
    test = await createTestDb();
    pglite = test.pglite;
  }, 120_000);

  afterAll(async () => {
    await test.close();
  });

  it("menulis audit job.failed dengan sebab dan jumlah percobaan", async () => {
    const saved = await recordPermanentJobFailure(test.db, {
      tenantId: TEST_TENANT_ID,
      jobName: "automation.evaluate",
      jobId: "job-123",
      attempts: 3,
      error: new Error("LLM provider menolak permintaan"),
    });
    expect(saved).toBe(true);

    const rows = await pglite.query<{
      actor_type: string;
      actor_id: string;
      action: string;
      meta: {
        jobId: string;
        jobName: string;
        attempts: number;
        error: string;
      };
    }>(
      `SELECT actor_type, actor_id, action, meta
         FROM audit_logs WHERE action = $1`,
      [JOB_FAILED_ACTION],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      actor_type: "system",
      // actor_id = nama job: "apa yang menyerah" terjawab tanpa buka meta.
      actor_id: "automation.evaluate",
      action: "job.failed",
    });
    expect(rows.rows[0]!.meta).toMatchObject({
      jobId: "job-123",
      jobName: "automation.evaluate",
      attempts: 3,
    });
    // Sebabnya ikut tersimpan, bukan hanya "gagal".
    expect(rows.rows[0]!.meta.error).toContain("LLM provider menolak");
  });

  it("memotong pesan error panjang, tidak menyimpan tumpukan penuh", async () => {
    await recordPermanentJobFailure(test.db, {
      tenantId: TEST_TENANT_ID,
      jobName: "flow.step",
      jobId: "job-panjang",
      attempts: 3,
      error: new Error("x".repeat(5_000)),
    });
    const row = await pglite.query<{ error: string }>(
      `SELECT meta->>'error' AS error FROM audit_logs
        WHERE action = $1 AND actor_id = 'flow.step'`,
      [JOB_FAILED_ACTION],
    );
    // 500 karakter + elipsis. Batas ini yang mencegah satu error raksasa
    // menggelembungkan tabel audit.
    expect(row.rows[0]!.error.length).toBeLessThanOrEqual(501);
    expect(row.rows[0]!.error.endsWith("…")).toBe(true);
  });

  it("tidak melempar saat penulisan gagal (tenant tidak ada)", async () => {
    // Best-effort: worker sedang menangani kegagalan lain; kegagalan
    // menulis jejak tidak boleh menjatuhkannya.
    const saved = await recordPermanentJobFailure(test.db, {
      tenantId: "00000000-0000-4000-8000-000000000000",
      jobName: "automation.evaluate",
      jobId: "job-yatim",
      attempts: 3,
      error: new Error("apa saja"),
    });
    expect(saved).toBe(false);
  });
});
