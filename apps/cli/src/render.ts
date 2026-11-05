/**
 * Perender keluaran CLI `sk` (Fase 14D).
 *
 * Dua mode:
 * - `--json`: respons API dicetak apa adanya sebagai JSON (satu-satunya
 *   mode yang dijanjikan stabil untuk skrip).
 * - manusia (bawaan): ringkas dan terbaca terminal — daftar menjadi
 *   tabel kolom-scalar, objek tunggal menjadi baris kunci: nilai.
 *   Bentuk tabel adalah kenyamanan baca, BUKAN kontrak; skrip harus
 *   memakai --json.
 */

const PREFERRED_COLUMNS = [
  "id",
  "name",
  "title",
  "label",
  "slug",
  "status",
  "provider",
  "kind",
  "stage",
  "pipelineStage",
  "email",
  "phone",
  "totalIdr",
  "startsAt",
  "createdAt",
];
const MAX_COLUMNS = 7;
const MAX_CELL = 42;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return truncate(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return truncate(JSON.stringify(value) ?? "");
}

function truncate(s: string): string {
  const flat = s.replace(/\s+/g, " ");
  return flat.length > MAX_CELL ? `${flat.slice(0, MAX_CELL - 1)}…` : flat;
}

function isScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

export function renderTable(rows: readonly Record<string, unknown>[]): string {
  if (rows.length === 0) return "No results.";
  const present = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (isScalar(row[key])) present.add(key);
    }
  }
  const preferred = PREFERRED_COLUMNS.filter((c) => present.has(c));
  const rest = [...present].filter((c) => !preferred.includes(c));
  const columns = [...preferred, ...rest].slice(0, MAX_COLUMNS);
  if (columns.length === 0) {
    // Baris tanpa field scalar sama sekali (objek bersarang penuh):
    // tampilkan JSON ringkas per baris daripada tabel kosong.
    return rows.map((r) => truncate(JSON.stringify(r))).join("\n");
  }
  const widths = columns.map((col) =>
    Math.min(
      MAX_CELL,
      Math.max(col.length, ...rows.map((r) => cellText(r[col]).length)),
    ),
  );
  const line = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  const out: string[] = [
    line(columns),
    line(widths.map((w) => "-".repeat(w))),
  ];
  for (const row of rows) out.push(line(columns.map((c) => cellText(row[c]))));
  return out.join("\n");
}

export function renderKeyValue(obj: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.length} item${value.length === 1 ? "" : "s"}]`);
    } else if (isPlainObject(value)) {
      lines.push(`${key}: ${truncate(JSON.stringify(value))}`);
    } else {
      lines.push(`${key}: ${cellText(value)}`);
    }
  }
  return lines.join("\n");
}

/**
 * Merender satu hasil panggilan SDK ke stdout.
 * Daftar v1 selalu berbentuk objek amplop ({ contacts: [...], total })
 * atau larik langsung; keduanya dikenali di sini.
 */
export function renderResult(value: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (Array.isArray(value)) {
    process.stdout.write(`${renderTable(value as Record<string, unknown>[])}\n`);
    return;
  }
  if (isPlainObject(value)) {
    const arrayKeys = Object.keys(value).filter((k) => Array.isArray(value[k]));
    if (arrayKeys.length === 1) {
      const key = arrayKeys[0];
      const rows = value[key] as Record<string, unknown>[];
      process.stdout.write(`${renderTable(rows)}\n`);
      const extras: string[] = [];
      if (typeof value.total === "number") {
        extras.push(`total: ${value.total}`);
      }
      if (value.nextCursor !== undefined) {
        extras.push(
          value.nextCursor === null
            ? "next page: (none)"
            : "next page: pass --cursor to continue",
        );
      }
      if (extras.length > 0) process.stdout.write(`${extras.join("  ")}\n`);
      return;
    }
    process.stdout.write(`${renderKeyValue(value)}\n`);
    return;
  }
  process.stdout.write(`${String(value)}\n`);
}
