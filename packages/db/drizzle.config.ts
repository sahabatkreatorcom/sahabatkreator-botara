import { defineConfig } from "drizzle-kit";

/**
 * Konfigurasi drizzle-kit untuk @sahabat-kreator/db.
 * - `generate` hanya membaca skema (tidak butuh DB hidup).
 * - `migrate` memakai DATABASE_URL dari env (jangan commit nilai aslinya).
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/sahabat_kreator",
  },
  strict: true,
  verbose: true,
});
