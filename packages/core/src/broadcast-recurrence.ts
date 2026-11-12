import {
  and,
  asc,
  desc,
  eq,
  inArray,
  lt,
  or,
  sql,
} from "drizzle-orm";
import {
  auditLogs,
  broadcastRecurrenceOccurrences,
  broadcastRecurrenceRules,
  broadcasts,
  channelAccounts,
  tenants,
  whatsappTemplates,
  type BroadcastRecurrenceOccurrence,
  type BroadcastRecurrenceRule,
  type Database,
} from "@sahabat-kreator/db";
import { withTenantDb, type DbTx } from "./tx";
import {
  isValidTimeZone,
  localDateOf,
  tzOffsetMs,
  weekdayOfDate,
  zonedWallToUtcMs,
} from "./appointments";
import {
  BROADCAST_SUPPORTED_PROVIDERS,
  cancelBroadcast,
  createBroadcast,
  scheduleBroadcast,
  type BroadcastAudienceFilter,
} from "./broadcasts";
import { getSegmentRow } from "./segments";

/**
 * Broadcast Berulang (G9) — lapisan penjadwal DI ATAS mesin broadcast
 * Fase 7C. Modul ini TIDAK mengirim pesan apa pun:
 *
 * - Sebuah ATURAN menyimpan snapshot definisi broadcast (disalin dari
 *   broadcast sumber atau diisi inline — divalidasi dengan gerbang
 *   yang sama seperti pembuatan broadcast) + pola pengulangan.
 * - Penyapu `processBroadcastRecurrences` (worker, berkala) memproses
 *   slot yang jatuh tempo: untuk tiap slot ia memanggil jalur yang
 *   SUDAH ADA — createBroadcast → scheduleBroadcast — sehingga
 *   broadcast anak adalah broadcast biasa (status per penerima,
 *   klaim anti-dobel dispatch, resume, finalisasi reconcile semuanya
 *   berlaku apa adanya).
 * - Setiap slot meninggalkan tepat satu baris LEDGER
 *   (broadcast_recurrence_occurrences, unik (rule_id, slot_at) =
 *   kunci idempotensi): created / skipped / missed + alasan jujur.
 *
 * Keputusan yang mengikat:
 * - Slot basi TIDAK ditembakkan: slot yang pertama kali terlihat
 *   penyapu sudah lewat BROADCAST_RECURRENCE_MAX_LATENESS_MS (1 jam)
 *   dicatat missed `slot_expired`. Klaim materialisasi yang tidak
 *   selesai dalam BROADCAST_RECURRENCE_CLAIM_STALE_MS (10 menit —
 *   proses mati di tengah) diambil alih sebagai missed
 *   `claim_stale`, meniru pengambilalihan klaim basi dispatch.
 * - Aturan JEDA tetap memproses slotnya sebagai skipped
 *   `rule_paused`: slot tidak lahir, tetapi juga tidak hilang
 *   diam-diam — ledger adalah riwayat yang lengkap.
 * - Kondisi berhenti: `endsAt` (slot terakhir yang boleh, inklusif)
 *   dan `maxOccurrences` (menghitung hanya broadcast yang BENAR-BENAR
 *   dibuat — skipped/missed tidak menghabiskan kuota kejadian).
 * - Perhitungan slot murni kalender dalam zona waktu aturan:
 *   jam dinding tetap (dari starts_at), tanggal bulanan melampaui
 *   akhir bulan DIJEPIT ke hari terakhir bulan itu (bukan dilewati).
 * - Akses ditegakkan di lapisan API seperti broadcast: mutasi
 *   owner/admin, baca semua member.
 */

export type BroadcastRecurrenceFrequency = "daily" | "weekly" | "monthly";
export type BroadcastRecurrenceStatus =
  | "active"
  | "paused"
  | "completed"
  | "cancelled";
export type BroadcastRecurrenceOccurrenceStatus =
  | "claimed"
  | "created"
  | "skipped"
  | "missed";

/** Ambang keterlambatan: slot yang lebih tua dari ini saat pertama diproses dicatat missed, bukan ditembakkan. */
export const BROADCAST_RECURRENCE_MAX_LATENESS_MS = 60 * 60 * 1000;
/** Klaim materialisasi yang lebih tua dari ini dianggap basi (proses mati) dan diambil alih. */
export const BROADCAST_RECURRENCE_CLAIM_STALE_MS = 10 * 60 * 1000;
/** Batas aturan yang dipindai per sapuan penyapu. */
export const BROADCAST_RECURRENCE_SWEEP_RULE_LIMIT = 50;
/** Batas slot yang diproses per aturan per sapuan (mengejar ketertinggalan bertahap, bukan meledak). */
export const BROADCAST_RECURRENCE_SWEEP_SLOT_LIMIT = 100;

// ---------------------------------------------------------------------------
// Matematika pola (fungsi murni — diuji unit tanpa DB)
// ---------------------------------------------------------------------------

export interface BroadcastRecurrencePattern {
  frequency: BroadcastRecurrenceFrequency;
  /** Setiap N (hari/minggu/bulan). */
  interval: number;
  /** Weekly: hari aktif 0=Minggu..6=Sabtu; kosong = hari starts_at. */
  daysOfWeek: number[];
  /** Monthly: tanggal 1..31 (dijepit ke akhir bulan); null = tanggal starts_at. */
  dayOfMonth: number | null;
  /** Monthly: hari terakhir bulan (mengalahkan dayOfMonth). */
  lastDayOfMonth: boolean;
  /** Zona waktu IANA. */
  timezone: string;
  /** Jangkar: slot pertama + jam dinding semua slot. */
  startsAt: Date;
  /** Slot terakhir yang boleh (inklusif); null = tanpa batas. */
  endsAt: Date | null;
}

interface CivilDate {
  year: number;
  month: number;
  day: number;
}

/** Hari sejak epoch untuk tanggal kalender (algoritma civil Hinnant). */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z: number): CivilDate {
  const zz = z + 719468;
  const era = Math.floor(zz / 146097);
  const doe = zz - era * 146097;
  const yoe = Math.floor(
    (doe -
      Math.floor(doe / 1460) +
      Math.floor(doe / 36524) -
      Math.floor(doe / 146096)) /
      365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: month <= 2 ? y + 1 : y, month, day };
}

function lastDayOfMonth(year: number, month: number): number {
  const next =
    month === 12
      ? daysFromCivil(year + 1, 1, 1)
      : daysFromCivil(year, month + 1, 1);
  return civilFromDays(next - 1).day;
}

/** Jam dinding (jam:menit) satu instan dalam zona — detik diabaikan (slot selalu :00). */
function wallTimeOf(
  tz: string,
  instantMs: number,
): { hour: number; minute: number } {
  const local = new Date(instantMs + tzOffsetMs(tz, instantMs));
  return { hour: local.getUTCHours(), minute: local.getUTCMinutes() };
}

function anchorDateOf(pattern: BroadcastRecurrencePattern): CivilDate {
  return localDateOf(pattern.timezone, pattern.startsAt.getTime());
}

function effectiveDaysOfWeek(
  pattern: BroadcastRecurrencePattern,
  anchor: CivilDate,
): number[] {
  if (pattern.daysOfWeek.length > 0) {
    return [...new Set(pattern.daysOfWeek)].sort((a, b) => a - b);
  }
  return [weekdayOfDate(anchor.year, anchor.month, anchor.day)];
}

/** Apakah pola menembak pada tanggal kalender ini (tanpa memeriksa jam)? */
function patternFiresOnDate(
  pattern: BroadcastRecurrencePattern,
  anchor: CivilDate,
  date: CivilDate,
): boolean {
  const dayNumber = daysFromCivil(date.year, date.month, date.day);
  const anchorDayNumber = daysFromCivil(anchor.year, anchor.month, anchor.day);
  const diffDays = dayNumber - anchorDayNumber;
  if (diffDays < 0) return false;
  if (pattern.frequency === "daily") {
    return diffDays % pattern.interval === 0;
  }
  if (pattern.frequency === "weekly") {
    const weekday = weekdayOfDate(date.year, date.month, date.day);
    if (!effectiveDaysOfWeek(pattern, anchor).includes(weekday)) return false;
    const anchorWeekday = weekdayOfDate(anchor.year, anchor.month, anchor.day);
    const weekDiff = Math.floor((diffDays + anchorWeekday - weekday) / 7);
    return weekDiff % pattern.interval === 0;
  }
  // monthly
  const monthDiff =
    (date.year - anchor.year) * 12 + (date.month - anchor.month);
  if (monthDiff < 0 || monthDiff % pattern.interval !== 0) return false;
  const last = lastDayOfMonth(date.year, date.month);
  const targetDay = pattern.lastDayOfMonth
    ? last
    : Math.min(pattern.dayOfMonth ?? anchor.day, last);
  return date.day === targetDay;
}

function slotInstantOnDate(
  pattern: BroadcastRecurrencePattern,
  wall: { hour: number; minute: number },
  date: CivilDate,
): number {
  return zonedWallToUtcMs(
    pattern.timezone,
    date.year,
    date.month,
    date.day,
    wall.hour,
    wall.minute,
  );
}

/**
 * Slot pertama pada atau sesudah `boundMs` (dan tidak sebelum
 * starts_at). Null hanya bila pola secara internal tidak konsisten
 * (tidak tercapai untuk pola yang lolos validasi).
 *
 * Pemindaian maju per tanggal kalender dari tanggal lokal `bound`
 * (atau tanggal jangkar, mana yang lebih akhir): jendela pindai
 * dijamin memuat tembakan berikutnya untuk pola yang sah — daily
 * ≤ interval hari, weekly ≤ interval minggu + 1 minggu, monthly
 * ≤ (interval+1) bulan + 1 bulan.
 */
export function firstRecurrenceSlotAtOrAfter(
  pattern: BroadcastRecurrencePattern,
  boundMs: number,
): Date | null {
  const tz = pattern.timezone;
  const startsMs = pattern.startsAt.getTime();
  const anchor = anchorDateOf(pattern);
  const wall = wallTimeOf(tz, startsMs);
  const boundLocal = localDateOf(tz, Math.max(boundMs, startsMs));
  const startDayNumber = Math.max(
    daysFromCivil(anchor.year, anchor.month, anchor.day),
    daysFromCivil(boundLocal.year, boundLocal.month, boundLocal.day) - 1,
  );
  const horizonDays =
    pattern.frequency === "daily"
      ? pattern.interval + 3
      : pattern.frequency === "weekly"
        ? pattern.interval * 7 + 8
        : (pattern.interval + 1) * 31 + 32;
  const cap = Math.min(horizonDays + 400, 5000);
  for (let i = 0; i <= cap; i++) {
    const date = civilFromDays(startDayNumber + i);
    if (!patternFiresOnDate(pattern, anchor, date)) continue;
    const instant = slotInstantOnDate(pattern, wall, date);
    if (instant >= boundMs && instant >= startsMs) {
      return new Date(instant);
    }
  }
  return null;
}

/** Slot pertama yang KETAT sesudah `afterMs`. */
export function nextRecurrenceSlotAfter(
  pattern: BroadcastRecurrencePattern,
  afterMs: number,
): Date | null {
  return firstRecurrenceSlotAtOrAfter(pattern, afterMs + 1);
}

/**
 * Pratinjau slot berikutnya (untuk formulir): mulai dari slot
 * pertama pada/sesudah max(from, starts_at), berhenti pada endsAt.
 * maxOccurrences SENGAJA tidak diterapkan — pratinjau pola murni.
 */
export function previewRecurrenceSlots(
  pattern: BroadcastRecurrencePattern,
  input: { count: number; from: Date },
): Date[] {
  const out: Date[] = [];
  let cursor = firstRecurrenceSlotAtOrAfter(
    pattern,
    Math.max(input.from.getTime(), pattern.startsAt.getTime()),
  );
  while (cursor && out.length < input.count) {
    if (pattern.endsAt && cursor.getTime() > pattern.endsAt.getTime()) break;
    out.push(cursor);
    cursor = nextRecurrenceSlotAfter(pattern, cursor.getTime());
  }
  return out;
}

// ---------------------------------------------------------------------------
// Validasi pola + definisi
// ---------------------------------------------------------------------------

export type RecurrenceValidationKind =
  | "invalid_interval"
  | "invalid_timezone"
  | "invalid_days_of_week"
  | "invalid_day_of_month"
  | "invalid_range"
  | "invalid_max_occurrences";

export function validateRecurrencePattern(
  pattern: BroadcastRecurrencePattern,
): RecurrenceValidationKind | null {
  if (
    !Number.isInteger(pattern.interval) ||
    pattern.interval < 1 ||
    pattern.interval > 365
  ) {
    return "invalid_interval";
  }
  if (!isValidTimeZone(pattern.timezone)) return "invalid_timezone";
  if (
    pattern.daysOfWeek.some(
      (d) => !Number.isInteger(d) || d < 0 || d > 6,
    ) ||
    new Set(pattern.daysOfWeek).size !== pattern.daysOfWeek.length
  ) {
    return "invalid_days_of_week";
  }
  if (
    pattern.dayOfMonth !== null &&
    (!Number.isInteger(pattern.dayOfMonth) ||
      pattern.dayOfMonth < 1 ||
      pattern.dayOfMonth > 31)
  ) {
    return "invalid_day_of_month";
  }
  if (pattern.endsAt && pattern.endsAt.getTime() < pattern.startsAt.getTime()) {
    return "invalid_range";
  }
  return null;
}

export interface BroadcastRecurrenceDefinitionInput {
  name?: string;
  channelAccountId?: string;
  messageText?: string;
  whatsappTemplateId?: string | null;
  templateVariableSources?: string[];
  audienceFilter?: BroadcastAudienceFilter;
  requireOptIn?: boolean;
  abSplitPercentB?: number | null;
  variantBMessageText?: string | null;
  variantBWhatsappTemplateId?: string | null;
  variantBTemplateVariableSources?: string[];
}

/** Definisi broadcast yang sudah tuntas (semua gerbang lolos). */
export interface ResolvedBroadcastDefinition {
  name: string;
  channelAccountId: string;
  provider: string;
  messageText: string;
  whatsappTemplateId: string | null;
  templateVariableSources: string[];
  audienceFilter: BroadcastAudienceFilter;
  requireOptIn: boolean;
  abSplitPercentB: number | null;
  variantBMessageText: string | null;
  variantBWhatsappTemplateId: string | null;
  variantBTemplateVariableSources: string[];
}

export type ResolveBroadcastDefinitionResult =
  | { kind: "ok"; definition: ResolvedBroadcastDefinition }
  | { kind: "definition_incomplete" }
  | { kind: "channel_not_found" }
  | { kind: "channel_unsupported"; provider: string }
  | { kind: "template_required" }
  | { kind: "template_not_found" }
  | { kind: "template_not_approved"; status: string }
  | { kind: "segment_not_found" }
  | { kind: "message_required" }
  | { kind: "ab_incomplete" };

function normalizeVariableSources(sources: string[] | undefined): string[] {
  if (!sources) return [];
  return sources.map((s) => s.trim()).slice(0, 25);
}

/**
 * Gerbang template WhatsApp untuk definisi aturan — predikat yang
 * sama seperti gateWhatsAppTemplate di broadcasts.ts (cermin lokal
 * pada akun yang sama, status APPROVED). Pemeriksaan ini untuk
 * penolakan DINI saat aturan disimpan; gerbang otoritatif tetap
 * createBroadcast/scheduleBroadcast saat materialisasi.
 */
async function gateDefinitionTemplate(
  tx: DbTx,
  tenantId: string,
  channelAccountId: string,
  templateId: string | null | undefined,
): Promise<
  | { kind: "ok"; template: { id: string; bodyText: string | null; name: string } }
  | { kind: "template_required" }
  | { kind: "template_not_found" }
  | { kind: "template_not_approved"; status: string }
> {
  if (!templateId) return { kind: "template_required" };
  const [template] = await tx
    .select({
      id: whatsappTemplates.id,
      bodyText: whatsappTemplates.bodyText,
      name: whatsappTemplates.name,
      status: whatsappTemplates.status,
    })
    .from(whatsappTemplates)
    .where(
      and(
        eq(whatsappTemplates.tenantId, tenantId),
        eq(whatsappTemplates.id, templateId),
        eq(whatsappTemplates.channelAccountId, channelAccountId),
      ),
    )
    .limit(1);
  if (!template) return { kind: "template_not_found" };
  if (template.status !== "APPROVED") {
    return { kind: "template_not_approved", status: template.status };
  }
  return { kind: "ok", template };
}

/**
 * Menyelesaikan definisi aturan dari (basis opsional + timpaan):
 * basis adalah broadcast sumber (salinan) atau definisi tersimpan
 * aturan (saat edit); timpaan adalah bidang yang dikirim pemanggil.
 * Validasi meniru gerbang createBroadcast agar aturan yang tidak akan
 * pernah bisa lahir ditolak saat disimpan, bukan diam-diam gagal
 * setiap slot.
 */
export async function resolveBroadcastDefinition(
  tx: DbTx,
  input: {
    tenantId: string;
    base: {
      name?: string | null;
      channelAccountId?: string | null;
      messageText?: string | null;
      whatsappTemplateId?: string | null;
      templateVariableSources?: string[] | null;
      audienceFilter?: BroadcastAudienceFilter | null;
      requireOptIn?: boolean | null;
      abSplitPercentB?: number | null;
      variantBMessageText?: string | null;
      variantBWhatsappTemplateId?: string | null;
      variantBTemplateVariableSources?: string[] | null;
    } | null;
    overrides: BroadcastRecurrenceDefinitionInput;
  },
): Promise<ResolveBroadcastDefinitionResult> {
  const { tenantId, base, overrides } = input;
  const channelAccountId =
    overrides.channelAccountId ?? base?.channelAccountId ?? undefined;
  const name = overrides.name ?? base?.name ?? undefined;
  if (!channelAccountId || !name || name.trim() === "") {
    return { kind: "definition_incomplete" };
  }
  const [account] = await tx
    .select({
      id: channelAccounts.id,
      provider: channelAccounts.provider,
      trashedAt: channelAccounts.trashedAt,
    })
    .from(channelAccounts)
    .where(
      and(
        eq(channelAccounts.tenantId, tenantId),
        eq(channelAccounts.id, channelAccountId),
      ),
    )
    .limit(1);
  if (!account || account.trashedAt) return { kind: "channel_not_found" };
  if (!BROADCAST_SUPPORTED_PROVIDERS.has(account.provider)) {
    return { kind: "channel_unsupported", provider: account.provider };
  }
  const provider = account.provider;

  const audienceFilter =
    overrides.audienceFilter ?? base?.audienceFilter ?? {};
  const filterMode =
    audienceFilter.audience ??
    (audienceFilter.segmentId
      ? "segment"
      : (audienceFilter.tags?.length ?? 0) > 0 ||
          (audienceFilter.stages?.length ?? 0) > 0
        ? "tag"
        : "all");
  if (filterMode === "segment") {
    const segment = audienceFilter.segmentId
      ? await getSegmentRow(tx, tenantId, audienceFilter.segmentId)
      : null;
    if (!segment) return { kind: "segment_not_found" };
  }

  let messageText = overrides.messageText ?? base?.messageText ?? undefined;
  let whatsappTemplateId: string | null = null;
  let templateVariableSources: string[] = [];
  if (provider === "whatsapp") {
    const templateId =
      overrides.whatsappTemplateId !== undefined
        ? overrides.whatsappTemplateId
        : (base?.whatsappTemplateId ?? null);
    const gate = await gateDefinitionTemplate(
      tx,
      tenantId,
      channelAccountId,
      templateId,
    );
    if (gate.kind !== "ok") return gate;
    whatsappTemplateId = gate.template.id;
    templateVariableSources = normalizeVariableSources(
      overrides.templateVariableSources ??
        base?.templateVariableSources ??
        undefined,
    );
    // Selaras createBroadcast: teks aturan WA = snapshot BODY template.
    messageText = gate.template.bodyText ?? gate.template.name;
  } else if (!messageText || messageText.trim() === "") {
    return { kind: "message_required" };
  }

  // Konfigurasi A/B — aturan yang sama seperti resolveBroadcastAbConfig.
  const abPercent =
    overrides.abSplitPercentB !== undefined
      ? overrides.abSplitPercentB
      : (base?.abSplitPercentB ?? null);
  let abSplitPercentB: number | null = null;
  let variantBMessageText: string | null = null;
  let variantBWhatsappTemplateId: string | null = null;
  let variantBTemplateVariableSources: string[] = [];
  if (abPercent !== null && abPercent !== undefined) {
    if (!Number.isInteger(abPercent) || abPercent < 1 || abPercent > 99) {
      return { kind: "ab_incomplete" };
    }
    if (provider === "whatsapp") {
      const bId =
        overrides.variantBWhatsappTemplateId !== undefined
          ? overrides.variantBWhatsappTemplateId
          : (base?.variantBWhatsappTemplateId ?? null);
      const bGate = await gateDefinitionTemplate(
        tx,
        tenantId,
        channelAccountId,
        bId,
      );
      if (bGate.kind !== "ok") return bGate;
      abSplitPercentB = abPercent;
      variantBMessageText = bGate.template.bodyText ?? bGate.template.name;
      variantBWhatsappTemplateId = bGate.template.id;
      variantBTemplateVariableSources = normalizeVariableSources(
        overrides.variantBTemplateVariableSources ??
          base?.variantBTemplateVariableSources ??
          undefined,
      );
    } else {
      const bText =
        overrides.variantBMessageText !== undefined
          ? overrides.variantBMessageText
          : (base?.variantBMessageText ?? null);
      if (!bText || bText.trim() === "") return { kind: "ab_incomplete" };
      abSplitPercentB = abPercent;
      variantBMessageText = bText;
    }
  }

  return {
    kind: "ok",
    definition: {
      name,
      channelAccountId,
      provider,
      messageText: messageText!,
      whatsappTemplateId,
      templateVariableSources,
      audienceFilter,
      requireOptIn:
        overrides.requireOptIn ?? base?.requireOptIn ?? provider === "whatsapp",
      abSplitPercentB,
      variantBMessageText,
      variantBWhatsappTemplateId,
      variantBTemplateVariableSources,
    },
  };
}

// ---------------------------------------------------------------------------
// Baca: aturan + ledger
// ---------------------------------------------------------------------------

export interface BroadcastRecurrenceRuleWithChannel
  extends BroadcastRecurrenceRule {
  provider: string;
  channelDisplayName: string | null;
}

interface PageCursor {
  createdAt: string;
  id: string;
}

function encodeCursor(row: { createdAt: Date; id: string }): string {
  const raw: PageCursor = {
    createdAt: row.createdAt.toISOString(),
    id: row.id,
  };
  return Buffer.from(JSON.stringify(raw), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): PageCursor | null {
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
    // Kursor rusak → halaman pertama (pola terdokumentasi 7B.1).
  }
  return null;
}

function clampLimit(limit: number | undefined): number {
  if (!limit || Number.isNaN(limit)) return 50;
  return Math.min(100, Math.max(1, Math.floor(limit)));
}

function patternOfRule(
  rule: BroadcastRecurrenceRule,
): BroadcastRecurrencePattern {
  return {
    frequency: rule.frequency,
    interval: rule.interval,
    daysOfWeek: (rule.daysOfWeek as number[] | null) ?? [],
    dayOfMonth: rule.dayOfMonth,
    lastDayOfMonth: rule.lastDayOfMonth,
    timezone: rule.timezone,
    startsAt: rule.startsAt,
    endsAt: rule.endsAt,
  };
}

async function selectRuleWithChannel(
  tx: DbTx,
  tenantId: string,
  ruleId: string,
): Promise<BroadcastRecurrenceRuleWithChannel | null> {
  const [row] = await tx
    .select({
      rule: broadcastRecurrenceRules,
      provider: channelAccounts.provider,
      channelDisplayName: channelAccounts.displayName,
    })
    .from(broadcastRecurrenceRules)
    .innerJoin(
      channelAccounts,
      eq(broadcastRecurrenceRules.channelAccountId, channelAccounts.id),
    )
    .where(
      and(
        eq(broadcastRecurrenceRules.tenantId, tenantId),
        eq(broadcastRecurrenceRules.id, ruleId),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    ...row.rule,
    provider: row.provider,
    channelDisplayName: row.channelDisplayName,
  };
}

export async function getBroadcastRecurrenceRule(
  db: Database,
  input: { tenantId: string; ruleId: string },
): Promise<BroadcastRecurrenceRuleWithChannel | null> {
  return withTenantDb(db, input.tenantId, (tx) =>
    selectRuleWithChannel(tx, input.tenantId, input.ruleId),
  );
}

export async function listBroadcastRecurrenceRules(
  db: Database,
  input: {
    tenantId: string;
    status?: BroadcastRecurrenceStatus;
    cursor?: string;
    limit?: number;
  },
): Promise<{
  rules: BroadcastRecurrenceRuleWithChannel[];
  nextCursor: string | null;
}> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const limit = clampLimit(input.limit);
    const conditions = [eq(broadcastRecurrenceRules.tenantId, input.tenantId)];
    if (input.status) {
      conditions.push(eq(broadcastRecurrenceRules.status, input.status));
    }
    const cursor = decodeCursor(input.cursor);
    if (cursor) {
      const cursorDate = new Date(cursor.createdAt);
      conditions.push(
        or(
          lt(broadcastRecurrenceRules.createdAt, cursorDate),
          and(
            eq(broadcastRecurrenceRules.createdAt, cursorDate),
            lt(broadcastRecurrenceRules.id, cursor.id),
          ),
        )!,
      );
    }
    const rows = await tx
      .select({
        rule: broadcastRecurrenceRules,
        provider: channelAccounts.provider,
        channelDisplayName: channelAccounts.displayName,
      })
      .from(broadcastRecurrenceRules)
      .innerJoin(
        channelAccounts,
        eq(broadcastRecurrenceRules.channelAccountId, channelAccounts.id),
      )
      .where(and(...conditions))
      .orderBy(
        desc(broadcastRecurrenceRules.createdAt),
        desc(broadcastRecurrenceRules.id),
      )
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    return {
      rules: pageRows.map((r) => ({
        ...r.rule,
        provider: r.provider,
        channelDisplayName: r.channelDisplayName,
      })),
      nextCursor: hasMore
        ? encodeCursor(pageRows[pageRows.length - 1].rule)
        : null,
    };
  });
}

export async function listBroadcastRecurrenceOccurrences(
  db: Database,
  input: {
    tenantId: string;
    ruleId: string;
    cursor?: string;
    limit?: number;
  },
): Promise<
  | {
      kind: "ok";
      occurrences: BroadcastRecurrenceOccurrence[];
      nextCursor: string | null;
    }
  | { kind: "not_found" }
> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const rule = await selectRuleWithChannel(tx, input.tenantId, input.ruleId);
    if (!rule) return { kind: "not_found" as const };
    const limit = clampLimit(input.limit);
    const conditions = [
      eq(broadcastRecurrenceOccurrences.tenantId, input.tenantId),
      eq(broadcastRecurrenceOccurrences.ruleId, input.ruleId),
    ];
    const cursor = decodeCursor(input.cursor);
    if (cursor) {
      const cursorDate = new Date(cursor.createdAt);
      conditions.push(
        or(
          lt(broadcastRecurrenceOccurrences.slotAt, cursorDate),
          and(
            eq(broadcastRecurrenceOccurrences.slotAt, cursorDate),
            lt(broadcastRecurrenceOccurrences.id, cursor.id),
          ),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(broadcastRecurrenceOccurrences)
      .where(and(...conditions))
      .orderBy(
        desc(broadcastRecurrenceOccurrences.slotAt),
        desc(broadcastRecurrenceOccurrences.id),
      )
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    return {
      kind: "ok" as const,
      occurrences: pageRows,
      nextCursor: hasMore
        ? encodeCursor({
            createdAt: pageRows[pageRows.length - 1].slotAt,
            id: pageRows[pageRows.length - 1].id,
          })
        : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Tulis: buat / edit / jeda / lanjut / batal
// ---------------------------------------------------------------------------

export type CreateBroadcastRecurrenceResult =
  | { kind: "created"; rule: BroadcastRecurrenceRuleWithChannel }
  | { kind: "source_not_found" }
  | { kind: "invalid_pattern"; reason: RecurrenceValidationKind }
  | Exclude<ResolveBroadcastDefinitionResult, { kind: "ok" }>;

export async function createBroadcastRecurrenceRule(
  db: Database,
  input: {
    tenantId: string;
    userId: string;
    sourceBroadcastId?: string;
    definition: BroadcastRecurrenceDefinitionInput;
    pattern: {
      frequency: BroadcastRecurrenceFrequency;
      interval?: number;
      daysOfWeek?: number[];
      dayOfMonth?: number | null;
      lastDayOfMonth?: boolean;
      timezone?: string;
      startsAt: Date;
      endsAt?: Date | null;
      maxOccurrences?: number | null;
    };
  },
): Promise<CreateBroadcastRecurrenceResult> {
  // Zona waktu bawaan = zona waktu tenant (tabel tenants tidak ber-RLS).
  let timezone = input.pattern.timezone;
  if (!timezone) {
    const [tenant] = await db
      .select({ timezone: tenants.timezone })
      .from(tenants)
      .where(eq(tenants.id, input.tenantId))
      .limit(1);
    timezone = tenant?.timezone ?? "Asia/Jakarta";
  }
  const pattern: BroadcastRecurrencePattern = {
    frequency: input.pattern.frequency,
    interval: input.pattern.interval ?? 1,
    daysOfWeek: input.pattern.daysOfWeek ?? [],
    dayOfMonth: input.pattern.dayOfMonth ?? null,
    lastDayOfMonth: input.pattern.lastDayOfMonth ?? false,
    timezone,
    startsAt: input.pattern.startsAt,
    endsAt: input.pattern.endsAt ?? null,
  };
  const invalid = validateRecurrencePattern(pattern);
  if (invalid) return { kind: "invalid_pattern", reason: invalid };
  if (
    input.pattern.maxOccurrences !== undefined &&
    input.pattern.maxOccurrences !== null &&
    (!Number.isInteger(input.pattern.maxOccurrences) ||
      input.pattern.maxOccurrences < 1)
  ) {
    return { kind: "invalid_pattern", reason: "invalid_max_occurrences" };
  }
  const firstSlot = firstRecurrenceSlotAtOrAfter(
    pattern,
    pattern.startsAt.getTime(),
  );
  if (!firstSlot) return { kind: "invalid_pattern", reason: "invalid_range" };
  if (pattern.endsAt && firstSlot.getTime() > pattern.endsAt.getTime()) {
    // Tidak ada satu slot pun di dalam rentang — menolak lebih jujur
    // daripada menyimpan aturan yang lahir sudah selesai.
    return { kind: "invalid_pattern", reason: "invalid_range" };
  }

  return withTenantDb(db, input.tenantId, async (tx) => {
    let base: Parameters<
      typeof resolveBroadcastDefinition
    >[1]["base"] = null;
    if (input.sourceBroadcastId) {
      const [source] = await tx
        .select()
        .from(broadcasts)
        .where(
          and(
            eq(broadcasts.tenantId, input.tenantId),
            eq(broadcasts.id, input.sourceBroadcastId),
          ),
        )
        .limit(1);
      if (!source) return { kind: "source_not_found" as const };
      base = {
        name: source.name,
        channelAccountId: source.channelAccountId,
        messageText: source.messageText,
        whatsappTemplateId: source.whatsappTemplateId,
        templateVariableSources:
          (source.templateVariableSources as string[] | null) ?? [],
        audienceFilter:
          source.audienceFilter as BroadcastAudienceFilter,
        requireOptIn: source.requireOptIn,
        abSplitPercentB: source.abSplitPercentB,
        variantBMessageText: source.variantBMessageText,
        variantBWhatsappTemplateId: source.variantBWhatsappTemplateId,
        variantBTemplateVariableSources:
          (source.variantBTemplateVariableSources as string[] | null) ?? [],
      };
    }
    const resolved = await resolveBroadcastDefinition(tx, {
      tenantId: input.tenantId,
      base,
      overrides: input.definition,
    });
    if (resolved.kind !== "ok") return resolved;
    const def = resolved.definition;
    const [row] = await tx
      .insert(broadcastRecurrenceRules)
      .values({
        tenantId: input.tenantId,
        channelAccountId: def.channelAccountId,
        sourceBroadcastId: input.sourceBroadcastId ?? null,
        name: def.name,
        messageText: def.messageText,
        whatsappTemplateId: def.whatsappTemplateId,
        templateVariableSources: def.templateVariableSources,
        audienceFilter: def.audienceFilter,
        requireOptIn: def.requireOptIn,
        abSplitPercentB: def.abSplitPercentB,
        variantBMessageText: def.variantBMessageText,
        variantBWhatsappTemplateId: def.variantBWhatsappTemplateId,
        variantBTemplateVariableSources: def.variantBTemplateVariableSources,
        frequency: pattern.frequency,
        interval: pattern.interval,
        daysOfWeek: pattern.daysOfWeek,
        dayOfMonth: pattern.dayOfMonth,
        lastDayOfMonth: pattern.lastDayOfMonth,
        timezone: pattern.timezone,
        startsAt: pattern.startsAt,
        endsAt: pattern.endsAt,
        maxOccurrences: input.pattern.maxOccurrences ?? null,
        status: "active",
        nextRunAt: firstSlot,
        createdByUserId: input.userId,
      })
      .returning();
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "broadcast_recurrence.created",
      meta: {
        ruleId: row.id,
        channelAccountId: def.channelAccountId,
        frequency: pattern.frequency,
        interval: pattern.interval,
        timezone: pattern.timezone,
        firstSlotAt: firstSlot.toISOString(),
        ...(input.sourceBroadcastId
          ? { sourceBroadcastId: input.sourceBroadcastId }
          : {}),
      },
    });
    const rule = await selectRuleWithChannel(tx, input.tenantId, row.id);
    return { kind: "created" as const, rule: rule! };
  });
}

export type UpdateBroadcastRecurrenceResult =
  | { kind: "updated"; rule: BroadcastRecurrenceRuleWithChannel }
  | { kind: "not_found" }
  | { kind: "invalid_state"; status: BroadcastRecurrenceStatus }
  | { kind: "invalid_pattern"; reason: RecurrenceValidationKind }
  | Exclude<ResolveBroadcastDefinitionResult, { kind: "ok" }>;

export async function updateBroadcastRecurrenceRule(
  db: Database,
  input: {
    tenantId: string;
    ruleId: string;
    userId: string;
    definition: BroadcastRecurrenceDefinitionInput;
    pattern: Partial<{
      frequency: BroadcastRecurrenceFrequency;
      interval: number;
      daysOfWeek: number[];
      dayOfMonth: number | null;
      lastDayOfMonth: boolean;
      timezone: string;
      startsAt: Date;
      endsAt: Date | null;
      maxOccurrences: number | null;
    }>;
  },
): Promise<UpdateBroadcastRecurrenceResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const existing = await selectRuleWithChannel(
      tx,
      input.tenantId,
      input.ruleId,
    );
    if (!existing) return { kind: "not_found" as const };
    if (existing.status === "completed" || existing.status === "cancelled") {
      return { kind: "invalid_state" as const, status: existing.status };
    }
    const resolved = await resolveBroadcastDefinition(tx, {
      tenantId: input.tenantId,
      base: {
        name: existing.name,
        channelAccountId: existing.channelAccountId,
        messageText: existing.messageText,
        whatsappTemplateId: existing.whatsappTemplateId,
        templateVariableSources:
          (existing.templateVariableSources as string[] | null) ?? [],
        audienceFilter:
          existing.audienceFilter as BroadcastAudienceFilter,
        requireOptIn: existing.requireOptIn,
        abSplitPercentB: existing.abSplitPercentB,
        variantBMessageText: existing.variantBMessageText,
        variantBWhatsappTemplateId: existing.variantBWhatsappTemplateId,
        variantBTemplateVariableSources:
          (existing.variantBTemplateVariableSources as string[] | null) ?? [],
      },
      overrides: input.definition,
    });
    if (resolved.kind !== "ok") return resolved;
    const def = resolved.definition;

    const p = input.pattern;
    const pattern: BroadcastRecurrencePattern = {
      frequency: p.frequency ?? existing.frequency,
      interval: p.interval ?? existing.interval,
      daysOfWeek: p.daysOfWeek ?? ((existing.daysOfWeek as number[]) ?? []),
      dayOfMonth:
        p.dayOfMonth !== undefined ? p.dayOfMonth : existing.dayOfMonth,
      lastDayOfMonth: p.lastDayOfMonth ?? existing.lastDayOfMonth,
      timezone: p.timezone ?? existing.timezone,
      startsAt: p.startsAt ?? existing.startsAt,
      endsAt: p.endsAt !== undefined ? p.endsAt : existing.endsAt,
    };
    const invalid = validateRecurrencePattern(pattern);
    if (invalid) return { kind: "invalid_pattern", reason: invalid };
    const maxOccurrences =
      p.maxOccurrences !== undefined
        ? p.maxOccurrences
        : existing.maxOccurrences;
    if (
      maxOccurrences !== null &&
      (!Number.isInteger(maxOccurrences) || maxOccurrences < 1)
    ) {
      return { kind: "invalid_pattern", reason: "invalid_max_occurrences" };
    }
    // Slot berikutnya dihitung ulang dari pola BARU (jangkar baru
    // menang). Slot masa lalu yang belum terproses akan dinilai
    // penyapu dengan aturan keterlambatan yang sama seperti biasa.
    const nextRunAt = firstRecurrenceSlotAtOrAfter(
      pattern,
      pattern.startsAt.getTime(),
    );
    if (!nextRunAt) return { kind: "invalid_pattern", reason: "invalid_range" };
    if (pattern.endsAt && nextRunAt.getTime() > pattern.endsAt.getTime()) {
      return { kind: "invalid_pattern", reason: "invalid_range" };
    }
    await tx
      .update(broadcastRecurrenceRules)
      .set({
        channelAccountId: def.channelAccountId,
        name: def.name,
        messageText: def.messageText,
        whatsappTemplateId: def.whatsappTemplateId,
        templateVariableSources: def.templateVariableSources,
        audienceFilter: def.audienceFilter,
        requireOptIn: def.requireOptIn,
        abSplitPercentB: def.abSplitPercentB,
        variantBMessageText: def.variantBMessageText,
        variantBWhatsappTemplateId: def.variantBWhatsappTemplateId,
        variantBTemplateVariableSources: def.variantBTemplateVariableSources,
        frequency: pattern.frequency,
        interval: pattern.interval,
        daysOfWeek: pattern.daysOfWeek,
        dayOfMonth: pattern.dayOfMonth,
        lastDayOfMonth: pattern.lastDayOfMonth,
        timezone: pattern.timezone,
        startsAt: pattern.startsAt,
        endsAt: pattern.endsAt,
        maxOccurrences,
        nextRunAt,
        updatedAt: new Date(),
      })
      .where(eq(broadcastRecurrenceRules.id, input.ruleId));
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "broadcast_recurrence.updated",
      meta: { ruleId: input.ruleId },
    });
    const rule = await selectRuleWithChannel(tx, input.tenantId, input.ruleId);
    return { kind: "updated" as const, rule: rule! };
  });
}

export type RecurrenceStateChangeResult =
  | { kind: "changed"; rule: BroadcastRecurrenceRuleWithChannel }
  | { kind: "not_found" }
  | { kind: "invalid_state"; status: BroadcastRecurrenceStatus };

async function changeRuleStatus(
  db: Database,
  input: {
    tenantId: string;
    ruleId: string;
    userId: string;
    from: BroadcastRecurrenceStatus[];
    to: BroadcastRecurrenceStatus;
    action: string;
    clearNextRun?: boolean;
  },
): Promise<RecurrenceStateChangeResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const existing = await selectRuleWithChannel(
      tx,
      input.tenantId,
      input.ruleId,
    );
    if (!existing) return { kind: "not_found" as const };
    if (!input.from.includes(existing.status)) {
      return { kind: "invalid_state" as const, status: existing.status };
    }
    await tx
      .update(broadcastRecurrenceRules)
      .set({
        status: input.to,
        ...(input.clearNextRun ? { nextRunAt: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(broadcastRecurrenceRules.id, input.ruleId));
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: input.action,
      meta: { ruleId: input.ruleId, fromStatus: existing.status },
    });
    const rule = await selectRuleWithChannel(tx, input.tenantId, input.ruleId);
    return { kind: "changed" as const, rule: rule! };
  });
}

export function pauseBroadcastRecurrenceRule(
  db: Database,
  input: { tenantId: string; ruleId: string; userId: string },
): Promise<RecurrenceStateChangeResult> {
  return changeRuleStatus(db, {
    ...input,
    from: ["active"],
    to: "paused",
    action: "broadcast_recurrence.paused",
  });
}

export function resumeBroadcastRecurrenceRule(
  db: Database,
  input: { tenantId: string; ruleId: string; userId: string },
): Promise<RecurrenceStateChangeResult> {
  return changeRuleStatus(db, {
    ...input,
    from: ["paused"],
    to: "active",
    action: "broadcast_recurrence.resumed",
  });
}

export function cancelBroadcastRecurrenceRule(
  db: Database,
  input: { tenantId: string; ruleId: string; userId: string },
): Promise<RecurrenceStateChangeResult> {
  return changeRuleStatus(db, {
    ...input,
    from: ["active", "paused"],
    to: "cancelled",
    action: "broadcast_recurrence.cancelled",
    clearNextRun: true,
  });
}

// ---------------------------------------------------------------------------
// Penyapu materialisasi (sisi worker, berkala)
// ---------------------------------------------------------------------------

export interface ProcessBroadcastRecurrencesResult {
  rulesScanned: number;
  created: number;
  skipped: number;
  missed: number;
  completed: number;
}

type SlotDecision =
  | { kind: "materialize" }
  | { kind: "skip"; status: "skipped" | "missed"; reason: string };

/**
 * Satu sapuan materialisasi lintas tenant:
 * 1. Temukan aturan active/paused yang next_run_at-nya jatuh tempo
 *    lewat lengan baca `system_broadcast_recurrence_scan`
 *    (flag app.broadcast_recurrence='scan' — migrasi 0033).
 * 2. Per aturan, dalam konteks tenant pemiliknya, proses slot jatuh
 *    tempo satu per satu (maks BROADCAST_RECURRENCE_SWEEP_SLOT_LIMIT):
 *    klaim ledger → materialisasi lewat jalur broadcast yang ada →
 *    finalisasi ledger → majukan next_run_at / tutup aturan.
 * Mengembalikan ringkasan untuk log worker.
 */
export async function processBroadcastRecurrences(
  db: Database,
  now: Date = new Date(),
): Promise<ProcessBroadcastRecurrencesResult> {
  const targets = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.broadcast_recurrence', 'scan', true)`,
    );
    return tx
      .select({
        id: broadcastRecurrenceRules.id,
        tenantId: broadcastRecurrenceRules.tenantId,
      })
      .from(broadcastRecurrenceRules)
      .where(
        and(
          inArray(broadcastRecurrenceRules.status, ["active", "paused"]),
          sql`${broadcastRecurrenceRules.nextRunAt} IS NOT NULL`,
          sql`${broadcastRecurrenceRules.nextRunAt} <= ${now}`,
        ),
      )
      .orderBy(asc(broadcastRecurrenceRules.nextRunAt))
      .limit(BROADCAST_RECURRENCE_SWEEP_RULE_LIMIT);
  });

  const totals: ProcessBroadcastRecurrencesResult = {
    rulesScanned: targets.length,
    created: 0,
    skipped: 0,
    missed: 0,
    completed: 0,
  };
  for (const target of targets) {
    const result = await processRecurrenceRule(db, target.tenantId, target.id, now);
    totals.created += result.created;
    totals.skipped += result.skipped;
    totals.missed += result.missed;
    totals.completed += result.completed;
  }
  return totals;
}

async function processRecurrenceRule(
  db: Database,
  tenantId: string,
  ruleId: string,
  now: Date,
): Promise<{ created: number; skipped: number; missed: number; completed: number }> {
  const counts = { created: 0, skipped: 0, missed: 0, completed: 0 };
  for (let i = 0; i < BROADCAST_RECURRENCE_SWEEP_SLOT_LIMIT; i++) {
    const step = await processOneSlot(db, tenantId, ruleId, now, counts);
    if (step === "done") break;
  }
  return counts;
}

/**
 * Memproses SATU slot aturan (slot di next_run_at). Mengembalikan
 * "continue" bila masih mungkin ada slot jatuh tempo berikutnya,
 * "done" bila aturan tidak lagi punya slot yang harus diproses
 * sapuan ini (belum jatuh tempo / terminal / diklaim proses lain).
 */
async function processOneSlot(
  db: Database,
  tenantId: string,
  ruleId: string,
  now: Date,
  counts: { created: number; skipped: number; missed: number; completed: number },
): Promise<"continue" | "done"> {
  // --- Fase A (transaksi tenant): baca keadaan, klaim slot, putuskan ---
  const phaseA = await withTenantDb(db, tenantId, async (tx) => {
    const [rule] = await tx
      .select()
      .from(broadcastRecurrenceRules)
      .where(
        and(
          eq(broadcastRecurrenceRules.tenantId, tenantId),
          eq(broadcastRecurrenceRules.id, ruleId),
        ),
      )
      .limit(1);
    if (!rule) return { kind: "done" as const };
    if (rule.status !== "active" && rule.status !== "paused") {
      return { kind: "done" as const };
    }
    const slot = rule.nextRunAt;
    if (!slot || slot.getTime() > now.getTime()) return { kind: "done" as const };

    // Kondisi berhenti diperiksa SEBELUM slot menjadi kejadian:
    // slot di luar rentang bukan kejadian aturan ini sama sekali.
    if (rule.endsAt && slot.getTime() > rule.endsAt.getTime()) {
      await completeRule(tx, tenantId, rule, "ends_at");
      return { kind: "completed" as const };
    }
    if (
      rule.maxOccurrences !== null &&
      rule.occurrencesCreated >= rule.maxOccurrences
    ) {
      await completeRule(tx, tenantId, rule, "max_occurrences");
      return { kind: "completed" as const };
    }

    const [existing] = await tx
      .select()
      .from(broadcastRecurrenceOccurrences)
      .where(
        and(
          eq(broadcastRecurrenceOccurrences.ruleId, ruleId),
          eq(broadcastRecurrenceOccurrences.slotAt, slot),
        ),
      )
      .limit(1);
    if (existing) {
      if (existing.status === "claimed") {
        if (
          now.getTime() - existing.updatedAt.getTime() >
          BROADCAST_RECURRENCE_CLAIM_STALE_MS
        ) {
          // Pengambilalihan klaim basi: proses yang mengklaim mati
          // di tengah — slot tidak ditembakkan ulang (broadcast anak
          // mungkin sudah lahir), dicatat missed dengan jujur.
          await finalizeOccurrence(tx, tenantId, existing.id, {
            status: "missed",
            reason: "claim_stale",
            broadcastId: null,
          });
          const advanced = await advanceRule(tx, tenantId, rule, slot);
          if (advanced === "completed") return { kind: "completed" as const };
          return {
            kind: "counted" as const,
            outcome: "missed" as const,
            completedToo: false,
          };
        }
        // Klaim segar milik proses lain — jangan diganggu.
        return { kind: "done" as const };
      }
      // Sudah final (sapuan sebelumnya memajukan next_run_at tidak
      // sempat tersimpan, atau edit aturan mengembalikan jangkar):
      // cukup majukan penunjuk.
      const advanced = await advanceRule(tx, tenantId, rule, slot);
      if (advanced === "completed") return { kind: "completed" as const };
      return { kind: "advance_only" as const };
    }

    const decision: SlotDecision =
      rule.status === "paused"
        ? { kind: "skip", status: "skipped", reason: "rule_paused" }
        : now.getTime() - slot.getTime() > BROADCAST_RECURRENCE_MAX_LATENESS_MS
          ? { kind: "skip", status: "missed", reason: "slot_expired" }
          : await precheckMaterialization(tx, tenantId, rule);

    if (decision.kind === "skip") {
      const [claimed] = await tx
        .insert(broadcastRecurrenceOccurrences)
        .values({
          tenantId,
          ruleId,
          slotAt: slot,
          status: decision.status,
          reason: decision.reason,
        })
        .onConflictDoNothing()
        .returning();
      if (!claimed) return { kind: "done" as const }; // balapan — sapuan lain memiliki slot ini
      await writeOccurrenceAudit(tx, tenantId, rule, slot, decision.status, decision.reason, null);
      const advanced = await advanceRule(tx, tenantId, rule, slot);
      return {
        kind: "counted" as const,
        outcome: decision.status === "missed" ? ("missed" as const) : ("skipped" as const),
        completedToo: advanced === "completed",
      };
    }

    // Materialisasi: klaim dulu, buat di luar transaksi ini.
    const [claimed] = await tx
      .insert(broadcastRecurrenceOccurrences)
      .values({ tenantId, ruleId, slotAt: slot, status: "claimed" })
      .onConflictDoNothing()
      .returning();
    if (!claimed) return { kind: "done" as const };
    return {
      kind: "materialize" as const,
      rule,
      slot,
      occurrenceId: claimed.id,
    };
  });

  if (phaseA.kind === "completed") {
    counts.completed += 1;
    return "done";
  }
  if (phaseA.kind === "counted") {
    counts[phaseA.outcome] += 1;
    if (phaseA.completedToo) {
      counts.completed += 1;
      return "done";
    }
    return "continue";
  }
  if (phaseA.kind === "advance_only") return "continue";
  if (phaseA.kind === "done") return "done";

  // --- Fase B: buat + jadwalkan broadcast anak lewat jalur yang ada ---
  const { rule, slot, occurrenceId } = phaseA;
  const actor = {
    actorType: "system" as const,
    actorId: `broadcast-recurrence:${ruleId}`,
    meta: { recurrenceRuleId: ruleId, recurrenceSlotAt: slot.toISOString() },
  };
  const slotDate = localDateOf(rule.timezone, slot.getTime());
  const childName = `${rule.name} · ${slotDate.year}-${String(slotDate.month).padStart(2, "0")}-${String(slotDate.day).padStart(2, "0")}`;
  let broadcastId: string | null = null;
  let failureReason: string | null = null;

  const created = await createBroadcast(db, {
    tenantId,
    userId: rule.createdByUserId,
    auditActor: actor,
    name: childName,
    channelAccountId: rule.channelAccountId,
    messageText: rule.messageText,
    whatsappTemplateId: rule.whatsappTemplateId,
    templateVariableSources:
      (rule.templateVariableSources as string[] | null) ?? [],
    filter: rule.audienceFilter as BroadcastAudienceFilter,
    requireOptIn: rule.requireOptIn,
    abSplitPercentB: rule.abSplitPercentB,
    variantBMessageText: rule.variantBMessageText,
    variantBWhatsappTemplateId: rule.variantBWhatsappTemplateId,
    variantBTemplateVariableSources:
      (rule.variantBTemplateVariableSources as string[] | null) ?? [],
  });
  if (created.kind !== "created") {
    failureReason = created.kind;
  } else {
    broadcastId = created.broadcast.id;
    const scheduled = await scheduleBroadcast(db, {
      tenantId,
      broadcastId,
      userId: rule.createdByUserId,
      auditActor: actor,
      scheduledAt: null,
    });
    if (scheduled.kind !== "scheduled") {
      failureReason = scheduled.kind;
      // Anak sudah lahir sebagai draft tetapi gagal dijadwalkan
      // (balapan gerbang sesudah pemeriksaan awal, mis. channel baru
      // saja diputus): batalkan agar tidak menjadi draft yatim yang
      // bisa terkirim manual dan menggandakan slot berikutnya.
      await cancelBroadcast(db, {
        tenantId,
        broadcastId,
        userId: rule.createdByUserId,
        auditActor: actor,
      }).catch(() => undefined);
    }
  }

  // --- Fase C (transaksi tenant): finalisasi ledger + majukan aturan ---
  await withTenantDb(db, tenantId, async (tx) => {
    const [fresh] = await tx
      .select()
      .from(broadcastRecurrenceRules)
      .where(eq(broadcastRecurrenceRules.id, ruleId))
      .limit(1);
    if (!fresh) return;
    if (failureReason === null && broadcastId) {
      const finalized = await finalizeOccurrence(tx, tenantId, occurrenceId, {
        status: "created",
        reason: null,
        broadcastId,
      });
      if (!finalized) {
        // Klaim sudah diambil alih sapuan lain sebagai claim_stale
        // selagi materialisasi berjalan — sapuan itu yang memajukan
        // aturan; broadcast anak ini tetap sah (sudah terjadwal) dan
        // jejaknya ada di audit broadcast.created, tetapi ledger
        // tidak ditulis dua kali.
        return;
      }
      await tx
        .update(broadcastRecurrenceRules)
        .set({
          occurrencesCreated: fresh.occurrencesCreated + 1,
          updatedAt: new Date(),
        })
        .where(eq(broadcastRecurrenceRules.id, ruleId));
      await writeOccurrenceAudit(tx, tenantId, fresh, slot, "created", null, broadcastId);
      const advanced = await advanceRule(tx, tenantId, { ...fresh, occurrencesCreated: fresh.occurrencesCreated + 1 }, slot);
      if (advanced === "completed") counts.completed += 1;
      counts.created += 1;
    } else {
      const finalized = await finalizeOccurrence(tx, tenantId, occurrenceId, {
        status: "skipped",
        reason: failureReason ?? "channel_not_found",
        broadcastId: null,
      });
      if (!finalized) return;
      await writeOccurrenceAudit(
        tx,
        tenantId,
        fresh,
        slot,
        "skipped",
        failureReason ?? "channel_not_found",
        null,
      );
      const advanced = await advanceRule(tx, tenantId, fresh, slot);
      if (advanced === "completed") counts.completed += 1;
      counts.skipped += 1;
    }
  });
  return "continue";
}

/**
 * Pemeriksaan gerbang SEBELUM klaim materialisasi, agar kegagalan
 * yang sudah pasti (channel putus, template dicabut) tercatat
 * skipped TANPA melahirkan broadcast anak yatim. Gerbang
 * otoritatifnya tetap createBroadcast/scheduleBroadcast sesudah ini.
 */
async function precheckMaterialization(
  tx: DbTx,
  tenantId: string,
  rule: BroadcastRecurrenceRule,
): Promise<SlotDecision> {
  const [account] = await tx
    .select({
      status: channelAccounts.status,
      trashedAt: channelAccounts.trashedAt,
      provider: channelAccounts.provider,
    })
    .from(channelAccounts)
    .where(
      and(
        eq(channelAccounts.tenantId, tenantId),
        eq(channelAccounts.id, rule.channelAccountId),
      ),
    )
    .limit(1);
  if (!account || account.trashedAt) {
    return { kind: "skip", status: "skipped", reason: "channel_not_found" };
  }
  if (!BROADCAST_SUPPORTED_PROVIDERS.has(account.provider)) {
    return { kind: "skip", status: "skipped", reason: "channel_unsupported" };
  }
  if (account.status !== "connected") {
    return { kind: "skip", status: "skipped", reason: "channel_disconnected" };
  }
  if (account.provider === "whatsapp") {
    const gate = await gateDefinitionTemplate(
      tx,
      tenantId,
      rule.channelAccountId,
      rule.whatsappTemplateId,
    );
    if (gate.kind === "template_not_approved") {
      return { kind: "skip", status: "skipped", reason: "template_not_approved" };
    }
    if (gate.kind !== "ok") {
      return { kind: "skip", status: "skipped", reason: "template_required" };
    }
    if (rule.abSplitPercentB !== null) {
      const bGate = await gateDefinitionTemplate(
        tx,
        tenantId,
        rule.channelAccountId,
        rule.variantBWhatsappTemplateId,
      );
      if (bGate.kind === "template_not_approved") {
        return {
          kind: "skip",
          status: "skipped",
          reason: "template_not_approved",
        };
      }
      if (bGate.kind !== "ok") {
        return { kind: "skip", status: "skipped", reason: "template_required" };
      }
    }
  }
  const filter = rule.audienceFilter as BroadcastAudienceFilter;
  const filterMode =
    filter.audience ??
    (filter.segmentId
      ? "segment"
      : (filter.tags?.length ?? 0) > 0 || (filter.stages?.length ?? 0) > 0
        ? "tag"
        : "all");
  if (filterMode === "segment") {
    const segment = filter.segmentId
      ? await getSegmentRow(tx, tenantId, filter.segmentId)
      : null;
    if (!segment) {
      return { kind: "skip", status: "skipped", reason: "segment_not_found" };
    }
  }
  return { kind: "materialize" };
}

async function finalizeOccurrence(
  tx: DbTx,
  tenantId: string,
  occurrenceId: string,
  outcome: {
    status: "created" | "skipped" | "missed";
    reason: string | null;
    broadcastId: string | null;
  },
): Promise<boolean> {
  const updated = await tx
    .update(broadcastRecurrenceOccurrences)
    .set({
      status: outcome.status,
      reason: outcome.reason,
      broadcastId: outcome.broadcastId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(broadcastRecurrenceOccurrences.tenantId, tenantId),
        eq(broadcastRecurrenceOccurrences.id, occurrenceId),
        eq(broadcastRecurrenceOccurrences.status, "claimed"),
      ),
    )
    .returning();
  return updated.length > 0;
}

/**
 * Majukan next_run_at sesudah slot `processedSlot`; menutup aturan
 * (completed) bila slot berikutnya tidak ada / melewati endsAt /
 * kuota kejadian tercapai. Mengembalikan keadaan akhir.
 */
async function advanceRule(
  tx: DbTx,
  tenantId: string,
  rule: BroadcastRecurrenceRule,
  processedSlot: Date,
): Promise<"advanced" | "completed"> {
  const pattern = patternOfRule(rule);
  const next = nextRecurrenceSlotAfter(pattern, processedSlot.getTime());
  if (
    !next ||
    (rule.endsAt && next.getTime() > rule.endsAt.getTime()) ||
    (rule.maxOccurrences !== null &&
      rule.occurrencesCreated >= rule.maxOccurrences)
  ) {
    await completeRule(
      tx,
      tenantId,
      rule,
      !next
        ? "pattern_exhausted"
        : rule.maxOccurrences !== null &&
            rule.occurrencesCreated >= rule.maxOccurrences
          ? "max_occurrences"
          : "ends_at",
    );
    return "completed";
  }
  await tx
    .update(broadcastRecurrenceRules)
    .set({ nextRunAt: next, updatedAt: new Date() })
    .where(eq(broadcastRecurrenceRules.id, rule.id));
  return "advanced";
}

async function completeRule(
  tx: DbTx,
  tenantId: string,
  rule: BroadcastRecurrenceRule,
  reason: string,
): Promise<void> {
  const [updated] = await tx
    .update(broadcastRecurrenceRules)
    .set({ status: "completed", nextRunAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(broadcastRecurrenceRules.id, rule.id),
        inArray(broadcastRecurrenceRules.status, ["active", "paused"]),
      ),
    )
    .returning();
  if (!updated) return;
  await tx.insert(auditLogs).values({
    tenantId,
    actorType: "system",
    actorId: `broadcast-recurrence:${rule.id}`,
    action: "broadcast_recurrence.completed",
    meta: { ruleId: rule.id, reason },
  });
}

async function writeOccurrenceAudit(
  tx: DbTx,
  tenantId: string,
  rule: BroadcastRecurrenceRule,
  slot: Date,
  status: "created" | "skipped" | "missed",
  reason: string | null,
  broadcastId: string | null,
): Promise<void> {
  await tx.insert(auditLogs).values({
    tenantId,
    actorType: "system",
    actorId: `broadcast-recurrence:${rule.id}`,
    action:
      status === "created"
        ? "broadcast_recurrence.occurrence_created"
        : status === "missed"
          ? "broadcast_recurrence.occurrence_missed"
          : "broadcast_recurrence.occurrence_skipped",
    meta: {
      ruleId: rule.id,
      slotAt: slot.toISOString(),
      ...(reason ? { reason } : {}),
      ...(broadcastId ? { broadcastId } : {}),
    },
  });
}
