import { and, asc, eq } from "drizzle-orm";
import {
  contactFieldDefinitions,
  type ContactFieldDefinition,
  type Database,
} from "@sahabat-kreator/db";
import type { TenantContext } from "./tenant";
import { withTenantDb, type DbTx } from "./tx";

/**
 * Skema field kustom BERTIPE kontak (Gelombang G18 butir 1).
 *
 * Model: nilai kontak tetap peta string→string di
 * `contacts.custom_fields` (kontrak Fase 13A tidak berubah). Modul ini
 * adalah SKEMA-nya — definisi per tenant (kunci, label, tipe, opsi,
 * kewajiban) + validasi/normalisasi yang ditegakkan pada jalur
 * penulisan PUBLIK: core `createContact`/`updateContact` (dipakai API
 * dashboard, API publik v1) dan impor CSV. Jalur internal (ingest
 * kanal, node flow `set_field`, merge) menulis langsung ke tabel dan
 * SENGAJA tidak diubah: mereka menulis identitas/field sistem yang
 * tidak boleh gagal hanya karena skema tenant berubah.
 *
 * Semantik yang disengaja:
 * - Kunci TANPA definisi = field bebas, lolos apa adanya (skema
 *   opt-in per kunci; data lama tidak pernah ditulis ulang/ditolak).
 * - Nilai lama yang melanggar definisi yang BARU dibuat/diubah
 *   tipenya tetap tersimpan apa adanya; validasi hanya menilai nilai
 *   yang sedang ditulis. PATCH gabung hanya memvalidasi kunci yang
 *   dikirim, dan `required` hanya ditegakkan saat BUAT (PATCH parsial
 *   tidak bisa dituntut memuat semua field wajib).
 * - Menghapus definisi tidak menghapus nilai: nilai menjadi bebas.
 */

export type ContactFieldType =
  | "text"
  | "number"
  | "date"
  | "select"
  | "boolean";

export interface ContactFieldIssue {
  key: string;
  reason:
    | "invalid_number"
    | "invalid_date"
    | "invalid_boolean"
    | "invalid_option"
    | "required_missing";
}

/** Nilai kontak melanggar skema field tenant — API menjawab 400 CONTACT_FIELD_INVALID. */
export class ContactCustomFieldValidationError extends Error {
  readonly issues: ContactFieldIssue[];
  constructor(issues: ContactFieldIssue[]) {
    super(
      `Custom field values violate the tenant field schema: ${issues
        .map((i) => `${i.key}:${i.reason}`)
        .join(", ")}`,
    );
    this.name = "ContactCustomFieldValidationError";
    this.issues = issues;
  }
}

/** Kunci definisi sudah dipakai definisi lain di tenant ini — API menjawab 409. */
export class ContactFieldDefinitionDuplicateError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`A field definition with key "${key}" already exists`);
    this.name = "ContactFieldDefinitionDuplicateError";
    this.key = key;
  }
}

/** Kombinasi definisi tidak lengkap (select tanpa pilihan) — API menjawab 400. */
export class ContactFieldDefinitionInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContactFieldDefinitionInvalidError";
  }
}

const BOOLEAN_TRUE = new Set(["true", "1", "yes", "ya"]);
const BOOLEAN_FALSE = new Set(["false", "0", "no", "tidak"]);
const NUMBER_PATTERN = /^-?\d+(\.\d+)?$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isRealCalendarDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * Validasi + normalisasi nilai terhadap daftar definisi (fungsi MURNI).
 * Mengembalikan nilai ternormalisasi untuk kunci yang sah; kunci tanpa
 * definisi diteruskan apa adanya. Satu isu per kunci yang melanggar.
 */
export function validateContactCustomFields(
  definitions: Pick<
    ContactFieldDefinition,
    "key" | "type" | "options" | "required"
  >[],
  fields: Record<string, string>,
  opts: { enforceRequired: boolean },
): { issues: ContactFieldIssue[]; normalized: Record<string, string> } {
  const byKey = new Map(definitions.map((d) => [d.key, d]));
  const issues: ContactFieldIssue[] = [];
  const normalized: Record<string, string> = {};
  for (const [key, raw] of Object.entries(fields)) {
    const def = byKey.get(key);
    if (!def) {
      normalized[key] = raw;
      continue;
    }
    const value = raw.trim();
    switch (def.type) {
      case "text":
        normalized[key] = raw;
        break;
      case "number": {
        // Koma desimal ala Indonesia diterima ("1500,5") selama tidak
        // ada titik desimal juga — bentuk ambigu ditolak, bukan ditebak.
        const candidate =
          value.includes(",") && !value.includes(".")
            ? value.replace(",", ".")
            : value;
        if (!NUMBER_PATTERN.test(candidate)) {
          issues.push({ key, reason: "invalid_number" });
        } else {
          normalized[key] = String(Number(candidate));
        }
        break;
      }
      case "date":
        if (!isRealCalendarDate(value)) {
          issues.push({ key, reason: "invalid_date" });
        } else {
          normalized[key] = value;
        }
        break;
      case "boolean": {
        const lowered = value.toLowerCase();
        if (BOOLEAN_TRUE.has(lowered)) normalized[key] = "true";
        else if (BOOLEAN_FALSE.has(lowered)) normalized[key] = "false";
        else issues.push({ key, reason: "invalid_boolean" });
        break;
      }
      case "select":
        if (!(def.options as string[]).includes(raw)) {
          issues.push({ key, reason: "invalid_option" });
        } else {
          normalized[key] = raw;
        }
        break;
      default:
        normalized[key] = raw;
    }
  }
  if (opts.enforceRequired) {
    for (const def of definitions) {
      if (!def.required) continue;
      if (issues.some((i) => i.key === def.key)) continue;
      const present = normalized[def.key];
      if (present === undefined || present.trim() === "") {
        issues.push({ key: def.key, reason: "required_missing" });
      }
    }
  }
  return { issues, normalized };
}

/** Muat definisi tenant di dalam transaksi pemanggil (dipakai contacts.ts). */
export async function loadContactFieldDefinitionsTx(
  tx: DbTx,
  tenantId: string,
): Promise<ContactFieldDefinition[]> {
  return tx
    .select()
    .from(contactFieldDefinitions)
    .where(eq(contactFieldDefinitions.tenantId, tenantId))
    .orderBy(asc(contactFieldDefinitions.key));
}

/**
 * Validasi nilai yang akan ditulis di dalam transaksi pemanggil;
 * melempar ContactCustomFieldValidationError bila ada pelanggaran,
 * mengembalikan peta ternormalisasi bila bersih. Tenant tanpa
 * definisi apa pun = jalur cepat (perilaku lama persis).
 */
export async function normalizeContactFieldsForWriteTx(
  tx: DbTx,
  tenantId: string,
  fields: Record<string, string>,
  opts: { enforceRequired: boolean },
): Promise<Record<string, string>> {
  const definitions = await loadContactFieldDefinitionsTx(tx, tenantId);
  if (definitions.length === 0) return fields;
  const { issues, normalized } = validateContactCustomFields(
    definitions,
    fields,
    opts,
  );
  if (issues.length > 0) {
    throw new ContactCustomFieldValidationError(issues);
  }
  return normalized;
}

export async function listContactFieldDefinitions(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
): Promise<ContactFieldDefinition[]> {
  return withTenantDb(db, ctx.tenantId, async (tx) =>
    loadContactFieldDefinitionsTx(tx, ctx.tenantId),
  );
}

export interface CreateContactFieldDefinitionInput {
  key: string;
  label: string;
  type: ContactFieldType;
  options?: string[];
  required?: boolean;
}

export async function createContactFieldDefinition(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  input: CreateContactFieldDefinitionInput,
): Promise<ContactFieldDefinition> {
  if (input.type === "select" && (input.options ?? []).length === 0) {
    throw new ContactFieldDefinitionInvalidError(
      "Select fields require at least one option",
    );
  }
  if (input.type !== "select" && (input.options ?? []).length > 0) {
    throw new ContactFieldDefinitionInvalidError(
      "Options only apply to select fields",
    );
  }
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [existing] = await tx
      .select({ id: contactFieldDefinitions.id })
      .from(contactFieldDefinitions)
      .where(
        and(
          eq(contactFieldDefinitions.tenantId, ctx.tenantId),
          eq(contactFieldDefinitions.key, input.key),
        ),
      )
      .limit(1);
    if (existing) {
      throw new ContactFieldDefinitionDuplicateError(input.key);
    }
    const [row] = await tx
      .insert(contactFieldDefinitions)
      .values({
        tenantId: ctx.tenantId,
        key: input.key,
        label: input.label,
        type: input.type,
        options: input.type === "select" ? (input.options ?? []) : [],
        required: input.required ?? false,
      })
      .returning();
    return row;
  });
}

export interface UpdateContactFieldDefinitionInput {
  label?: string;
  type?: ContactFieldType;
  options?: string[];
  required?: boolean;
}

/** Null bila definisi tidak ada di tenant ini (API menerjemahkan ke 404). */
export async function updateContactFieldDefinition(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  definitionId: string,
  input: UpdateContactFieldDefinitionInput,
): Promise<ContactFieldDefinition | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(contactFieldDefinitions)
      .where(
        and(
          eq(contactFieldDefinitions.tenantId, ctx.tenantId),
          eq(contactFieldDefinitions.id, definitionId),
        ),
      )
      .limit(1);
    if (!existing) return null;
    const effectiveType = input.type ?? (existing.type as ContactFieldType);
    const patch: Partial<ContactFieldDefinition> = { updatedAt: new Date() };
    if (input.label !== undefined) patch.label = input.label;
    if (input.type !== undefined) patch.type = input.type;
    if (input.required !== undefined) patch.required = input.required;
    // Pilihan hanya bermakna untuk select. Select EFEKTIF tanpa
    // pilihan apa pun (dari kiriman maupun simpanan) adalah definisi
    // yang tidak akan pernah bisa divalidasi nilai apa pun → ditolak
    // di sini juga, bukan hanya di kontrak buat. Beralih DARI select
    // membersihkan pilihan agar tak ada sisa opsi yatim di tipe lain.
    if (effectiveType === "select") {
      const effectiveOptions = input.options ?? (existing.options as string[]);
      if (effectiveOptions.length === 0) {
        throw new ContactFieldDefinitionInvalidError(
          "Select fields require at least one option",
        );
      }
      if (input.options !== undefined) patch.options = input.options;
    } else {
      if (input.options !== undefined && input.options.length > 0) {
        throw new ContactFieldDefinitionInvalidError(
          "Options only apply to select fields",
        );
      }
      patch.options = [];
    }
    const [row] = await tx
      .update(contactFieldDefinitions)
      .set(patch)
      .where(eq(contactFieldDefinitions.id, definitionId))
      .returning();
    return row ?? null;
  });
}

/** false bila definisi tidak ada di tenant ini. Nilai kontak TIDAK ikut terhapus. */
export async function deleteContactFieldDefinition(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  definitionId: string,
): Promise<boolean> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const deleted = await tx
      .delete(contactFieldDefinitions)
      .where(
        and(
          eq(contactFieldDefinitions.tenantId, ctx.tenantId),
          eq(contactFieldDefinitions.id, definitionId),
        ),
      )
      .returning({ id: contactFieldDefinitions.id });
    return deleted.length > 0;
  });
}
