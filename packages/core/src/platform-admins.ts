import { and, desc, eq, ilike, sql } from "drizzle-orm";
import {
  auditLogs,
  backupRuns,
  platformAdmins,
  users,
  type Database,
} from "@sahabat-kreator/db";
import { isPlatformAdminEmail, parsePlatformAdminEmails } from "./platform-settings";
import type { DbTx } from "./tx";

/**
 * Daftar admin platform yang bisa dikelola dari panel (migrasi 0011).
 *
 * Sebelumnya satu-satunya sumber kebenaran adalah `PLATFORM_ADMIN_EMAILS`
 * di .env: menambah admin = ubah file + recreate container + deploy, dan
 * tidak ada cara melihat siapa yang berhak tanpa membaca env. Sekarang env
 * tetap berlaku sebagai BOOTSTRAP/darurat (tidak bisa dicabut dari panel),
 * dan panel menyimpan tambahannya di tabel `platform_admins`.
 *
 * Kenapa env tidak disalin ke tabel: kalau DB rusak atau migrasi belum
 * jalan, pemilik platform tetap punya jalur masuk. Menggabungkan keduanya
 * di satu resolver membuat "pintu darurat" tidak pernah hilang.
 */

/** Normalisasi yang SAMA dipakai env, DB, dan gerbang — jangan drift. */
export function normalizeAdminEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function withConsoleTx<T>(
  db: Database,
  fn: (tx: DbTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    // Diperlukan untuk menulis audit (policy 0010). Tabel platform_admins
    // sendiri tidak ber-RLS, jadi flag ini tidak membuka data tenant.
    await tx.execute(sql`SELECT set_config('app.platform_admin', 'on', true)`);
    return fn(tx as unknown as DbTx);
  });
}

/**
 * Gerbang admin yang sebenarnya: env ATAU panel.
 *
 * Dicari di env lebih dulu supaya admin bootstrap tidak perlu satu query
 * tambahan pada setiap pemeriksaan sesi. Kalau env tidak cocok, baru tabel
 * diperiksa — query ini sengaja TANPA cache: mencabut hak admin harus
 * langsung berlaku pada cookie yang sudah ada, bukan 30 detik kemudian.
 */
export async function isPlatformAdmin(
  db: Database,
  email: string,
  rawAllowlist?: string,
): Promise<boolean> {
  if (isPlatformAdminEmail(email, rawAllowlist)) return true;
  const normalized = normalizeAdminEmail(email);
  if (!normalized) return false;
  const [row] = await db
    .select({ email: platformAdmins.email })
    .from(platformAdmins)
    .where(eq(platformAdmins.email, normalized))
    .limit(1);
  return Boolean(row);
}

export interface PlatformAdminEntry {
  email: string;
  /** 'env' = bootstrap terkunci; 'panel' = bisa dicabut dari UI. */
  source: "env" | "panel";
  removable: boolean;
  registered: boolean;
  addedByEmail: string | null;
  createdAt: string | null;
}

/** Daftar tergabung: env ditampilkan sebagai baris terkunci, panel sisanya. */
export async function listPlatformAdmins(
  db: Database,
  rawAllowlist?: string,
): Promise<PlatformAdminEntry[]> {
  const envEmails = [...parsePlatformAdminEmails(rawAllowlist)].sort();
  const dbRows = await db
    .select({
      email: platformAdmins.email,
      createdAt: platformAdmins.createdAt,
      addedByEmail: users.email,
      registered: sql<boolean>`EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = ${platformAdmins.email})`,
    })
    .from(platformAdmins)
    .leftJoin(users, eq(platformAdmins.addedBy, users.id));

  const envSet = new Set(envEmails);
  const panelRows: PlatformAdminEntry[] = dbRows
    .filter((r) => !envSet.has(r.email))
    .map((r) => ({
      email: r.email,
      source: "panel",
      removable: true,
      registered: Boolean(r.registered),
      addedByEmail: r.addedByEmail,
      createdAt: r.createdAt.toISOString(),
    }));

  const envRows: PlatformAdminEntry[] = await Promise.all(
    envEmails.map(async (email) => {
      const [u] = await db
        .select({ id: users.id })
        .from(users)
        .where(ilike(users.email, email))
        .limit(1);
      return {
        email,
        source: "env" as const,
        removable: false,
        registered: Boolean(u),
        addedByEmail: null,
        createdAt: null,
      };
    }),
  );

  return [...envRows, ...panelRows].sort((a, b) =>
    a.email.localeCompare(b.email),
  );
}

export interface AddPlatformAdminInput {
  email: string;
  actorUserId: string;
}

/**
 * Tambah admin. Email boleh belum terdaftar — pemilik platform sering
 * menyiapkan akses sebelum orang itu membuat akun. Panel menandainya
 * "belum terdaftar" supaya tidak dikira akunnya sudah aktif.
 */
export async function addPlatformAdmin(
  db: Database,
  input: AddPlatformAdminInput,
): Promise<{ email: string; created: boolean }> {
  const email = normalizeAdminEmail(input.email);
  return withConsoleTx(db, async (tx) => {
    const inserted = await tx
      .insert(platformAdmins)
      .values({ email, addedBy: input.actorUserId })
      .onConflictDoNothing()
      .returning({ email: platformAdmins.email });

    await tx.insert(auditLogs).values({
      tenantId: null,
      actorType: "user",
      actorId: input.actorUserId,
      action: "platform.admin.added",
      meta: { email, created: inserted.length > 0 },
    });

    return { email, created: inserted.length > 0 };
  });
}

export interface RemovePlatformAdminInput {
  email: string;
  actorUserId: string;
  /** Email sesi yang sedang melakukan aksi — untuk mencegah lockout. */
  actorEmail: string;
  rawAllowlist?: string;
}

export type RemoveAdminResult =
  | { removed: false; reason: "not_found" | "env_locked" | "self" | "last_admin" }
  | { removed: true; email: string };

/**
 * Cabut admin panel. Empat penjaga, semuanya mencegah keadaan yang tidak
 * bisa diperbaiki lewat UI:
 *  - baris env tidak bisa dicabut (harus lewat .env + deploy);
 *  - tidak bisa mencabut diri sendiri (kalau itu admin terakhir, panel
 *    akan langsung menolak akses di request berikutnya);
 *  - tidak bisa mengosongkan daftar admin bila env juga kosong.
 */
export async function removePlatformAdmin(
  db: Database,
  input: RemovePlatformAdminInput,
): Promise<RemoveAdminResult> {
  const email = normalizeAdminEmail(input.email);
  const envSet = parsePlatformAdminEmails(input.rawAllowlist);
  if (envSet.has(email)) return { removed: false, reason: "env_locked" };
  if (email === normalizeAdminEmail(input.actorEmail)) {
    return { removed: false, reason: "self" };
  }

  return withConsoleTx(db, async (tx) => {
    const [row] = await tx
      .select({ id: platformAdmins.id })
      .from(platformAdmins)
      .where(eq(platformAdmins.email, email))
      .limit(1);
    if (!row) return { removed: false, reason: "not_found" };

    const remaining = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(platformAdmins);
    if ((remaining[0]?.n ?? 0) <= 1 && envSet.size === 0) {
      return { removed: false, reason: "last_admin" };
    }

    await tx.delete(platformAdmins).where(eq(platformAdmins.id, row.id));
    await tx.insert(auditLogs).values({
      tenantId: null,
      actorType: "user",
      actorId: input.actorUserId,
      action: "platform.admin.removed",
      meta: { email },
    });
    return { removed: true, email };
  });
}

export interface BackupRunEntry {
  id: string;
  kind: string;
  status: string;
  sizeBytes: number | null;
  detail: string | null;
  createdAt: string;
}

/** Riwayat eksekusi backup + drill, terbaru dulu. */
export async function listBackupRuns(
  db: Database,
  limit = 12,
): Promise<BackupRunEntry[]> {
  const rows = await db
    .select()
    .from(backupRuns)
    .orderBy(desc(backupRuns.createdAt))
    .limit(Math.min(Math.max(limit, 1), 50));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    sizeBytes: r.sizeBytes,
    detail: r.detail,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** Ringkasan yang dipakai tab Sistem: backup harian & drill terakhir. */
export async function getBackupStatus(
  db: Database,
): Promise<{ lastDaily: string | null; lastDrill: string | null }> {
  const rows = await db
    .select({ kind: backupRuns.kind, createdAt: backupRuns.createdAt })
    .from(backupRuns)
    .where(and(eq(backupRuns.status, "ok")))
    .orderBy(desc(backupRuns.createdAt))
    .limit(20);
  return {
    lastDaily: rows.find((r) => r.kind === "daily")?.createdAt.toISOString() ?? null,
    lastDrill: rows.find((r) => r.kind === "drill")?.createdAt.toISOString() ?? null,
  };
}
