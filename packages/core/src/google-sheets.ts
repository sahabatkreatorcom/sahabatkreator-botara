/**
 * Google Sheets API untuk node flow `append_sheet_row` (G17 butir 2).
 *
 * Layanan Google-nya adalah layanan PER LAYANAN baru `sheets`
 * (migrasi 0041; pola 0023 + G16 'ads'): consent tenant sendiri
 * dengan scope `https://www.googleapis.com/auth/spreadsheets`, klien
 * OAuth `google_sheets_client_id/secret` di Panel Admin dengan
 * fallback pasangan bersama, callback kanonis
 * `/api/oauth/google_sheets/callback`. Token diambil lewat
 * `getValidGoogleServiceAccess(..., "sheets", ...)` — TIDAK menumpang
 * token/scope layanan lain.
 *
 * Kegagalan adalah HASIL, bukan pengecualian (pola node eksternal
 * flow): tidak terhubung / HTTP error / jaringan putus dikembalikan
 * sebagai union berkode agar executor mencatatnya di detail langkah
 * dan MELANJUTKAN run.
 */
import type { Database } from "@sahabat-kreator/db";
import {
  getValidGoogleServiceAccess,
  GOOGLE_DEFAULT_API_BASE,
  type GoogleDeps,
} from "./google-calendar";

const SHEETS_TIMEOUT_MS = 15_000;

export type AppendSheetRowResult =
  | {
      kind: "appended";
      /** Rentang yang benar-benar ditulis Google (dari respons API). */
      updatedRange: string | null;
      updatedRows: number | null;
    }
  | {
      kind: "error";
      /**
       * Kode stabil untuk detail langkah: `sheets_not_connected`
       * (tenant belum consent / token tak bisa dipakai),
       * `sheets_http_<status>`, `sheets_unreachable`.
       */
      code: string;
      /** Pesan ringkas aman-tampil (tanpa isi spreadsheet). */
      message: string;
    };

export interface AppendSheetRowInput {
  /** Id dokumen spreadsheet (dari URL dokumen), bukan judul. */
  spreadsheetId: string;
  /**
   * Nama tab/lembar tujuan; kosong = lembar pertama (range `A1` —
   * append menempel sesudah tabel yang terdeteksi Google di lembar
   * itu). Nama di-quote otomatis sesuai sintaks A1 bila perlu.
   */
  sheetName?: string | null;
  /** Nilai sel SATU baris, urut kolom sesuai konfigurasi node. */
  values: string[];
}

/** Quote nama lembar untuk notasi A1 bila mengandung karakter khusus. */
export function sheetsRangeOf(sheetName?: string | null): string {
  const name = (sheetName ?? "").trim();
  if (!name) return "A1";
  return `'${name.replace(/'/g, "''")}'!A1`;
}

/**
 * Tambah SATU baris ke spreadsheet tenant lewat Sheets API
 * (values.append, USER_ENTERED + INSERT_ROWS: nilai ditafsirkan
 * seperti diketik pengguna — angka/tanggal menjadi nilai sel asli —
 * dan baris disisipkan tanpa menimpa data di bawah tabel).
 */
export async function appendGoogleSheetRow(
  db: Database,
  tenantId: string,
  deps: GoogleDeps,
  input: AppendSheetRowInput,
): Promise<AppendSheetRowResult> {
  const access = await getValidGoogleServiceAccess(
    db,
    tenantId,
    "sheets",
    deps,
  );
  if (!access) {
    return {
      kind: "error",
      code: "sheets_not_connected",
      message:
        "Google Sheets belum terhubung untuk workspace ini (consent layanan Sheets belum ada atau token tidak bisa dipakai)",
    };
  }
  const apiBase = (deps.bases?.apiBase ?? GOOGLE_DEFAULT_API_BASE).replace(
    /\/+$/,
    "",
  );
  const range = sheetsRangeOf(input.sheetName);
  const url =
    `${apiBase}/v4/spreadsheets/${encodeURIComponent(input.spreadsheetId)}` +
    `/values/${encodeURIComponent(range)}:append` +
    `?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(SHEETS_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${access.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        range,
        majorDimension: "ROWS",
        values: [input.values],
      }),
    });
  } catch {
    return {
      kind: "error",
      code: "sheets_unreachable",
      message: "Google Sheets API tidak terjangkau (jaringan/timeout)",
    };
  }
  if (!res.ok) {
    return {
      kind: "error",
      code: `sheets_http_${res.status}`,
      message: `Google Sheets API menjawab HTTP ${res.status}`,
    };
  }
  const body = (await res.json().catch(() => null)) as {
    updates?: { updatedRange?: unknown; updatedRows?: unknown };
  } | null;
  const updates = body?.updates;
  return {
    kind: "appended",
    updatedRange:
      typeof updates?.updatedRange === "string" ? updates.updatedRange : null,
    updatedRows:
      typeof updates?.updatedRows === "number" ? updates.updatedRows : null,
  };
}
