/**
 * Regresi konfigurasi pool (2026-11-05).
 *
 * Sebelumnya `createDb` hanya meneruskan `connectionString`, sehingga pool
 * berjalan TANPA `statement_timeout`, `connectionTimeoutMillis`, dan tanpa
 * `application_name`. Dampaknya: satu query menggantung menahan request
 * selamanya, dan koneksi tidak bisa dibedakan per proses di `pg_stat_activity`.
 *
 * Test ini tidak membuka koneksi (Pool bersifat lazy) — hanya mengunci
 * konfigurasi yang dikirim ke driver.
 */
import { describe, expect, it } from "vitest";
import { createDb } from "./client";

const URL = "postgres://user:pass@127.0.0.1:5432/db";

describe("createDb", () => {
  it("memasang batas aman secara default", () => {
    const { pool } = createDb(URL);
    try {
      expect(pool.options.application_name).toBe("sk-app");
      expect(pool.options.statement_timeout).toBe(15_000);
      expect(pool.options.connectionTimeoutMillis).toBe(5_000);
      expect(pool.options.idleTimeoutMillis).toBe(30_000);
      expect(pool.options.max).toBe(10);
    } finally {
      void pool.end();
    }
  });

  it("menghormati applicationName dan timeout dari pemanggil", () => {
    const { pool } = createDb(URL, {
      applicationName: "sk-worker",
      statementTimeoutMs: 60_000,
      max: 4,
    });
    try {
      expect(pool.options.application_name).toBe("sk-worker");
      expect(pool.options.statement_timeout).toBe(60_000);
      expect(pool.options.max).toBe(4);
    } finally {
      void pool.end();
    }
  });

  it("statementTimeoutMs 0 berarti tanpa batas (diteruskan apa adanya)", () => {
    const { pool } = createDb(URL, { statementTimeoutMs: 0 });
    try {
      // pg menerjemahkan 0 menjadi "tanpa batas" di sisi server.
      expect(pool.options.statement_timeout).toBe(0);
    } finally {
      void pool.end();
    }
  });
});
