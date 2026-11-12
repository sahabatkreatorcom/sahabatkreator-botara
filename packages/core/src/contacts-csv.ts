import { eq } from "drizzle-orm";
import { contacts, type Database } from "@sahabat-kreator/db";
import type { TenantContext } from "./tenant";
import { withTenantDb } from "./tx";
import {
  createContact,
  normalizeContactEmail,
  normalizeContactPhone,
  setContactConsent,
  type EffectiveOptInStatus,
} from "./contacts";

/**
 * CSV kontak: parser/serializer kecil milik sendiri + orkestrasi
 * impor. Repo tidak punya dependensi CSV (dan kebutuhan di sini
 * sempit), jadi parser ditulis mengikuti RFC 4180 sebatas yang
 * dipakai berkas kontak nyata: pemisah koma, field terkurung kutip
 * ganda (dengan "" sebagai escape), baris CRLF/LF, dan newline di
 * dalam field terkutip.
 */

// ---------------------------------------------------------------------------
// Parser & serializer (murni)
// ---------------------------------------------------------------------------

/** Parse teks CSV menjadi baris-baris field. Baris kosong total dibuang. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };
  const input = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      pushField();
    } else if (ch === "\n") {
      pushRow();
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) pushRow();
  return rows;
}

/** Escape satu nilai untuk CSV: kutip bila memuat koma/kutip/newline. */
export function escapeCsvValue(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export interface ContactExportRow {
  name: string;
  phone: string | null;
  email: string | null;
  tags: string[];
  pipelineStage: string;
  optInEffectiveStatus: EffectiveOptInStatus;
}

/**
 * Serialisasi ekspor kontak. Kolom persis kontrak fitur: nama, phone,
 * email, tags (dipisah "; " di dalam sel), tahap pipeline, status
 * opt-in EFEKTIF. Baris judul selalu ada agar berkas bisa diimpor
 * ulang oleh fitur impor (judulnya dikenali pemeta kolom di bawah).
 */
export function buildContactsCsv(rows: ContactExportRow[]): string {
  const header = "name,phone,email,tags,pipeline_stage,opt_in_status";
  const lines = rows.map((row) =>
    [
      row.name,
      row.phone ?? "",
      row.email ?? "",
      row.tags.join("; "),
      row.pipelineStage,
      row.optInEffectiveStatus,
    ]
      .map(escapeCsvValue)
      .join(","),
  );
  return [header, ...lines].join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------
// Pemetaan kolom impor
// ---------------------------------------------------------------------------

type ImportColumn = "name" | "phone" | "email" | "tags" | "optIn";

/** Alias judul kolom (sudah dinormalisasi: huruf kecil, non-alfanumerik dibuang). */
const HEADER_ALIASES: Record<string, ImportColumn> = {
  name: "name",
  nama: "name",
  fullname: "name",
  namakontak: "name",
  contact: "name",
  phone: "phone",
  phonenumber: "phone",
  telepon: "phone",
  nomortelepon: "phone",
  nohp: "phone",
  nomorhp: "phone",
  hp: "phone",
  whatsapp: "phone",
  wa: "phone",
  mobile: "phone",
  email: "email",
  surel: "email",
  alamatemail: "email",
  tags: "tags",
  tag: "tags",
  label: "tags",
  labels: "tags",
  optin: "optIn",
  optinstatus: "optIn",
  statusoptin: "optIn",
  persetujuan: "optIn",
  consent: "optIn",
};

function normalizeHeaderCell(cell: string): string {
  return cell.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Nilai sel opt-in yang dikenali. Nilai lain (termasuk kosong) TIDAK
 * diperlakukan sebagai perintah apa pun — impor tidak pernah
 * memaksakan persetujuan yang tidak dinyatakan berkas.
 */
const OPT_IN_YES = new Set([
  "opted_in",
  "opt_in",
  "in",
  "yes",
  "ya",
  "true",
  "1",
  "ikut",
  "bersedia",
  "subscribed",
  "subscribe",
]);
const OPT_IN_NO = new Set([
  "opted_out",
  "opt_out",
  "out",
  "no",
  "tidak",
  "false",
  "0",
  "berhenti",
  "menolak",
  "unsubscribe",
  "unsubscribed",
]);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Batas baris data per impor — menjaga satu panggilan tetap wajar. */
export const MAX_IMPORT_ROWS = 5000;

export interface ContactImportIssue {
  /** Nomor baris DATA (1 = baris data pertama; judul tidak dihitung). */
  row: number;
  reason: string;
}

export type ImportContactsResult =
  | {
      kind: "ok";
      imported: number;
      duplicates: ContactImportIssue[];
      invalid: ContactImportIssue[];
    }
  | { kind: "too_many_rows"; rows: number };

interface PreparedRow {
  rowNumber: number;
  name: string;
  phone?: string;
  email?: string;
  tags: string[];
  consent: "opt_in" | "opt_out" | null;
  phoneSignal: string | null;
  emailSignal: string | null;
}

/**
 * Impor kontak dari teks CSV dalam tenant:
 *
 * - Baris pertama diperlakukan sebagai JUDUL bila salah satu selnya
 *   memetakan ke kolom "name"; kolom dipetakan lewat alias id/en di
 *   atas. Tanpa judul yang dikenali, kolom dibaca POSISIONAL:
 *   nama, phone, email, tags (tanpa kolom opt-in).
 * - Validasi mengikuti pola halaman: nama wajib (≤255), email (bila
 *   ada) harus berformat sah (≤320), phone ≤32, tag masing-masing
 *   ≤64 dan maks 50. Baris tidak sah dilaporkan per baris beralasan,
 *   tidak menggagalkan baris lain.
 * - Duplikat memakai sinyal deteksi duplikat yang sudah ada
 *   (telepon/email ternormalisasi): baris yang sinyalnya bertabrakan
 *   dengan kontak lama ATAU baris yang sudah diterima dari berkas
 *   yang sama DILEWATI dan dilaporkan — tidak pernah menimpa.
 * - Opt-in hanya diterapkan bila berkas menyatakannya (kolom opt-in
 *   ada DAN selnya bernilai dikenali), lewat jalur persetujuan yang
 *   sama seperti toggle manual (setContactConsent source "manual").
 */
export async function importContactsFromCsv(
  db: Database,
  ctx: Pick<TenantContext, "tenantId" | "userId">,
  csvText: string,
): Promise<ImportContactsResult> {
  const rawRows = parseCsv(csvText);
  if (rawRows.length === 0) {
    return { kind: "ok", imported: 0, duplicates: [], invalid: [] };
  }

  // Petakan kolom dari judul bila baris pertama memuat kolom nama.
  let columnIndex: Partial<Record<ImportColumn, number>> = {
    name: 0,
    phone: 1,
    email: 2,
    tags: 3,
  };
  let dataStart = 0;
  const headerMap: Partial<Record<ImportColumn, number>> = {};
  rawRows[0]!.forEach((cell, idx) => {
    const mapped = HEADER_ALIASES[normalizeHeaderCell(cell)];
    if (mapped && headerMap[mapped] === undefined) headerMap[mapped] = idx;
  });
  if (headerMap.name !== undefined) {
    columnIndex = headerMap;
    dataStart = 1;
  }
  const dataRows = rawRows.slice(dataStart);
  if (dataRows.length > MAX_IMPORT_ROWS) {
    return { kind: "too_many_rows", rows: dataRows.length };
  }

  const cell = (row: string[], column: ImportColumn): string => {
    const idx = columnIndex[column];
    return idx === undefined ? "" : (row[idx] ?? "").trim();
  };

  const invalid: ContactImportIssue[] = [];
  const prepared: PreparedRow[] = [];
  dataRows.forEach((row, i) => {
    const rowNumber = i + 1;
    const name = cell(row, "name");
    const phone = cell(row, "phone");
    const email = cell(row, "email");
    const tagsRaw = cell(row, "tags");
    const optInRaw = cell(row, "optIn").toLowerCase();
    if (!name && !phone && !email && !tagsRaw) return; // baris kosong
    if (!name) {
      invalid.push({ row: rowNumber, reason: "missing_name" });
      return;
    }
    if (name.length > 255) {
      invalid.push({ row: rowNumber, reason: "name_too_long" });
      return;
    }
    if (email && (email.length > 320 || !EMAIL_PATTERN.test(email))) {
      invalid.push({ row: rowNumber, reason: "invalid_email" });
      return;
    }
    if (phone && phone.length > 32) {
      invalid.push({ row: rowNumber, reason: "phone_too_long" });
      return;
    }
    const tags = [
      ...new Set(
        tagsRaw
          .split(/[;|]/)
          .map((tag) => tag.trim())
          .filter(Boolean),
      ),
    ];
    if (tags.some((tag) => tag.length > 64)) {
      invalid.push({ row: rowNumber, reason: "invalid_tag" });
      return;
    }
    if (tags.length > 50) {
      invalid.push({ row: rowNumber, reason: "too_many_tags" });
      return;
    }
    prepared.push({
      rowNumber,
      name,
      ...(phone ? { phone } : {}),
      ...(email ? { email } : {}),
      tags,
      consent: OPT_IN_YES.has(optInRaw)
        ? "opt_in"
        : OPT_IN_NO.has(optInRaw)
          ? "opt_out"
          : null,
      phoneSignal: normalizeContactPhone(phone || null),
      emailSignal: normalizeContactEmail(email || null),
    });
  });

  // Sinyal duplikat dari kontak lama tenant ini.
  const existingSignals = await withTenantDb(db, ctx.tenantId, async (tx) => {
    const rows = await tx
      .select({ phone: contacts.phone, email: contacts.email })
      .from(contacts)
      .where(eq(contacts.tenantId, ctx.tenantId));
    const phones = new Set<string>();
    const emails = new Set<string>();
    for (const row of rows) {
      const p = normalizeContactPhone(row.phone);
      if (p) phones.add(p);
      const e = normalizeContactEmail(row.email);
      if (e) emails.add(e);
    }
    return { phones, emails };
  });

  const duplicates: ContactImportIssue[] = [];
  let imported = 0;
  for (const row of prepared) {
    if (row.phoneSignal && existingSignals.phones.has(row.phoneSignal)) {
      duplicates.push({ row: row.rowNumber, reason: "duplicate_phone" });
      continue;
    }
    if (row.emailSignal && existingSignals.emails.has(row.emailSignal)) {
      duplicates.push({ row: row.rowNumber, reason: "duplicate_email" });
      continue;
    }
    const contact = await createContact(db, { tenantId: ctx.tenantId }, {
      name: row.name,
      ...(row.phone ? { phone: row.phone } : {}),
      ...(row.email ? { email: row.email } : {}),
      tags: row.tags,
    });
    if (row.phoneSignal) existingSignals.phones.add(row.phoneSignal);
    if (row.emailSignal) existingSignals.emails.add(row.emailSignal);
    imported++;
    if (row.consent) {
      await setContactConsent(db, {
        tenantId: ctx.tenantId,
        contactId: contact.id,
        action: row.consent,
        source: "manual",
        actorUserId: ctx.userId,
      });
    }
  }

  return { kind: "ok", imported, duplicates, invalid };
}
