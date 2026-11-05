/**
 * Provisioning & audit DB nyata untuk @sahabat-kreator/db.
 *
 * Tiga mode, satu berkas — semuanya memakai MIGRATION_DATABASE_URL
 * (role migrasi/pemilik skema):
 *
 *   tsx scripts/provision.ts doctor        audit baca-saja; exit 1 bila ada yang salah
 *   tsx scripts/provision.ts grant         beri ulang hak role aplikasi (idempoten)
 *   tsx scripts/provision.ts reset --yes   JATUHKAN skema lalu migrasi dari nol
 *
 * MENGAPA SKRIP, BUKAN LANGKAH DI DOKUMEN
 * Langkah "GRANT … TO sk_app" pernah hidup sebagai prosa di
 * docs/PRODUCTION.md §7. Reset skema menghapus seluruh hak role aplikasi,
 * API tetap hidup, dan setiap query gagal "permission denied" — tanpa ada
 * yang memeriksa. Sekarang langkah itu (a) ikut rantai migrasi lewat
 * `0009_app_role_grants.sql` untuk kasus normal, (b) tersedia sebagai
 * perintah `grant` untuk kasus restore-dari-dump (dump dibuat
 * --no-privileges), dan (c) DIPERIKSA otomatis oleh `doctor`.
 *
 * `doctor` sengaja dibuat ketat: ia gagal bila role aplikasi tidak bisa
 * membaca tabel inti, bila RLS mati di salah satu tabel, atau bila ada
 * migrasi yang belum diterapkan. Itulah gerbang yang menangkap keadaan
 * "DB hidup tapi tidak bisa dipakai" sebelum pengguna menemukannya.
 */
import path from "node:path";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(here, "..", "migrations");

/** Role aplikasi: env APP_DB_ROLE, default sk_app (sama dengan migrasi 0009). */
const APP_ROLE = process.env.APP_DB_ROLE?.trim() || "sk_app";

function requireMigrationUrl(): string {
  const url = process.env.MIGRATION_DATABASE_URL?.trim();
  if (!url) {
    console.error(
      "MIGRATION_DATABASE_URL wajib diisi (role migrasi/pemilik skema).",
    );
    process.exit(1);
  }
  return url;
}

async function connect(url: string): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

interface Finding {
  label: string;
  ok: boolean;
  detail: string;
}

async function collectFindings(client: Client): Promise<Finding[]> {
  const one = async (sql: string, params: unknown[] = []): Promise<number> => {
    const res = await client.query<{ n: string }>(sql, params);
    return Number(res.rows[0]?.n ?? 0);
  };

  const tables = await one(
    `SELECT count(*)::text AS n FROM information_schema.tables
      WHERE table_schema='public' AND table_type='BASE TABLE'`,
  );
  const policies = await one(
    `SELECT count(*)::text AS n FROM pg_policies WHERE schemaname='public'`,
  );
  const rlsTables = await one(
    `SELECT count(*)::text AS n FROM pg_class c
       JOIN pg_namespace ns ON ns.oid=c.relnamespace
      WHERE ns.nspname='public' AND c.relkind='r' AND c.relrowsecurity`,
  );
  const applied = await client
    .query<{ n: string }>(
      `SELECT count(*)::text AS n FROM drizzle.__drizzle_migrations`,
    )
    .then((r) => Number(r.rows[0]?.n ?? 0))
    .catch(() => -1);
  // Jumlah migrasi di disk = sumber kebenaran "seharusnya berapa".
  const onDisk = (await readdir(migrationsFolder)).filter((f) =>
    f.endsWith(".sql"),
  ).length;

  const findings: Finding[] = [];
  findings.push({
    label: "tabel public",
    ok: tables > 0,
    detail: String(tables),
  });
  findings.push({
    label: "policy RLS",
    ok: policies > 0,
    detail: String(policies),
  });
  findings.push({
    label: "tabel ber-RLS",
    ok: rlsTables > 0 && rlsTables <= tables,
    detail: `${rlsTables} dari ${tables} tabel`,
  });
  findings.push({
    label: "migrasi terapan",
    ok: applied === onDisk,
    detail:
      applied < 0
        ? "skema drizzle tidak ada — DB belum dimigrasi"
        : `${applied} dari ${onDisk} di disk`,
  });

  // Role aplikasi harus ada, non-superuser, dan TIDAK bypass RLS.
  const roleRes = await client.query<{
    rolsuper: boolean;
    rolbypassrls: boolean;
    rolcanlogin: boolean;
  }>(
    `SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname=$1`,
    [APP_ROLE],
  );
  if (roleRes.rowCount === 0) {
    findings.push({
      label: `role ${APP_ROLE}`,
      ok: false,
      detail: "TIDAK ADA — aplikasi tidak bisa terhubung",
    });
  } else {
    const r = roleRes.rows[0]!;
    findings.push({
      label: `role ${APP_ROLE}`,
      ok: r.rolcanlogin && !r.rolsuper && !r.rolbypassrls,
      detail: `login=${r.rolcanlogin} super=${r.rolsuper} bypassrls=${r.rolbypassrls}`,
    });
  }

  // Hak DML nyata pada tabel inti — inilah yang hilang saat reset skema.
  const grants = await one(
    `SELECT count(*)::text AS n FROM information_schema.table_privileges
      WHERE grantee=$1 AND table_schema='public'`,
    [APP_ROLE],
  );
  findings.push({
    label: "grant tabel role aplikasi",
    ok: grants > 0,
    detail:
      grants === 0
        ? "0 — jalankan `pnpm --filter @sahabat-kreator/db db:grant`"
        : String(grants),
  });

  const probes = ["tenants", "contacts", "messages"] as const;
  for (const table of probes) {
    const res = await client
      .query<{ sel: boolean; ins: boolean }>(
        `SELECT has_table_privilege($1, $2, 'SELECT') AS sel,
                has_table_privilege($1, $2, 'INSERT') AS ins`,
        [APP_ROLE, `public.${table}`],
      )
      .catch(() => ({ rows: [{ sel: false, ins: false }] }));
    const row = res.rows[0]!;
    findings.push({
      label: `${table}: SELECT+INSERT`,
      ok: row.sel && row.ins,
      detail: `select=${row.sel} insert=${row.ins}`,
    });
  }

  // Default privileges: tanpa ini, tabel migrasi berikutnya lahir tanpa grant.
  const defaultAcl = await one(
    `SELECT count(*)::text AS n FROM pg_default_acl d
       JOIN pg_roles r ON r.oid = d.defaclrole
       JOIN pg_namespace ns ON ns.oid = d.defaclnamespace
      WHERE r.rolname = current_user AND ns.nspname = 'public'
        AND d.defaclobjtype IN ('r','S')`,
  );
  findings.push({
    label: "default privileges",
    ok: defaultAcl > 0,
    detail:
      defaultAcl === 0
        ? "0 — migrasi berikutnya akan lahir tanpa grant"
        : String(defaultAcl),
  });

  return findings;
}

async function doctor(client: Client): Promise<boolean> {
  const findings = await collectFindings(client);
  let failed = 0;
  for (const f of findings) {
    if (!f.ok) failed += 1;
    console.log(`${f.ok ? "OK  " : "GAGAL"}  ${f.label.padEnd(30)} ${f.detail}`);
  }
  console.log(
    failed === 0
      ? `\ndb doctor: SEMUA OK (role aplikasi ${APP_ROLE})`
      : `\ndb doctor: ${failed} MASALAH — lihat baris GAGAL di atas`,
  );
  return failed === 0;
}

// ---------------------------------------------------------------------------
// grant
// ---------------------------------------------------------------------------

async function grant(client: Client): Promise<boolean> {
  const exists = await client.query(
    `SELECT 1 FROM pg_roles WHERE rolname=$1`,
    [APP_ROLE],
  );
  if (exists.rowCount === 0) {
    console.error(`Role ${APP_ROLE} tidak ada — buat dulu role-nya.`);
    return false;
  }
  const statements = [
    `GRANT USAGE ON SCHEMA public TO "${APP_ROLE}"`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${APP_ROLE}"`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${APP_ROLE}"`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${APP_ROLE}"`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO "${APP_ROLE}"`,
  ];
  for (const sql of statements) {
    await client.query(sql);
    console.log("  ok:", sql);
  }
  return true;
}

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

async function reset(client: Client): Promise<boolean> {
  console.log("Menjatuhkan skema public + drizzle…");
  await client.query("DROP SCHEMA IF EXISTS public CASCADE");
  await client.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await client.query("CREATE SCHEMA public");
  console.log("Skema public dibuat ulang.");

  console.log("Menjalankan seluruh migrasi…");
  const db = drizzle(client);
  await migrate(db, { migrationsFolder });
  console.log("Migrasi selesai (termasuk 0009 grant role aplikasi).");

  // Grant dipanggil ulang secara eksplisit: pada DB yang role-nya baru
  // dibuat sesudah migrasi, atau bila APP_DB_ROLE berbeda dari default,
  // langkah ini memastikan hasil akhirnya tetap benar.
  console.log(`Memastikan hak role ${APP_ROLE}…`);
  return grant(client);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const mode = process.argv[2] ?? "doctor";
// pnpm meneruskan pemisah `--` apa adanya (`pnpm run db:reset -- --yes`),
// jadi saring dulu agar tidak terbaca sebagai argumen bermakna.
const flags = process.argv.slice(3).filter((a) => a !== "--");
const url = requireMigrationUrl();

if (mode === "reset" && !flags.includes("--yes")) {
  console.error(
    "reset MENGHAPUS SELURUH DATA di database tujuan.\n" +
      "Jalankan ulang dengan --yes bila memang itu yang diinginkan:\n" +
      "  tsx scripts/provision.ts reset --yes",
  );
  process.exit(2);
}

const client = await connect(url);
let ok: boolean;
try {
  if (mode === "doctor") ok = await doctor(client);
  else if (mode === "grant") ok = (await grant(client)) && (await doctor(client));
  else if (mode === "reset") ok = (await reset(client)) && (await doctor(client));
  else {
    console.error(`Mode tidak dikenal: ${mode} (pakai: doctor|grant|reset)`);
    ok = false;
  }
} finally {
  await client.end();
}

process.exit(ok ? 0 : 1);
