/**
 * Util kursor halaman (pola sama dengan modul broadcasts) — kursor
 * base64url `{createdAt, id}` agar daftar flow/run tetap stabil saat
 * baris baru masuk di antara dua permintaan.
 */
import {
  and,
  eq,
  lt,
  or,
} from "drizzle-orm";
import { flows } from "@sahabat-kreator/db";

// ---------------------------------------------------------------------------
// Util kursor (pola broadcasts 7C — base64url {createdAt, id})
// ---------------------------------------------------------------------------

interface PageCursor {
  createdAt: string;
  id: string;
}

export function encodeCursor(row: { createdAt: Date; id: string }): string {
  const raw: PageCursor = { createdAt: row.createdAt.toISOString(), id: row.id };
  return Buffer.from(JSON.stringify(raw), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined): PageCursor | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Partial<PageCursor>;
    if (
      typeof parsed.createdAt === "string" &&
      typeof parsed.id === "string" &&
      !Number.isNaN(Date.parse(parsed.createdAt))
    ) {
      return { createdAt: parsed.createdAt, id: parsed.id };
    }
  } catch {
    // Kursor rusak → halaman pertama (pola terdokumentasi).
  }
  return null;
}

export function clampLimit(limit: number | undefined, fallback = 50, max = 100): number {
  if (!limit || Number.isNaN(limit)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(limit)));
}

export function cursorCondition(
  cursor: PageCursor | null,
  createdAtCol: unknown,
  idCol: unknown,
) {
  if (!cursor) return undefined;
  // Kolom (created_at, id) dari tabel mana pun (flows / flow_runs) —
  // bentuk kursornya identik; casting lokal agar helper bisa dipakai
  // ulang tanpa duplikasi.
  const createdAt = createdAtCol as typeof flows.createdAt;
  const id = idCol as typeof flows.id;
  const cursorDate = new Date(cursor.createdAt);
  return or(
    lt(createdAt, cursorDate),
    and(eq(createdAt, cursorDate), lt(id, cursor.id)),
  );
}
