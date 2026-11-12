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
  channelAccounts,
  conversations,
  media,
  postMedia,
  postRecurrenceOccurrences,
  postRecurrenceRules,
  posts,
  tenants,
  type Database,
  type PostRecurrenceOccurrence,
  type PostRecurrenceRule,
} from "@sahabat-kreator/db";
import {
  POST_MEDIA_MAX,
  type PostPublishOptions,
} from "@sahabat-kreator/contracts";
import { withTenantDb, type DbTx } from "./tx";
import {
  firstRecurrenceSlotAtOrAfter,
  nextRecurrenceSlotAfter,
  validateRecurrencePattern,
  type RecurrencePattern,
  type RecurrenceValidationKind,
} from "./recurrence-pattern";
import {
  PostDomainError,
  cancelPost,
  createPost,
  createPostGroup,
  deletePost,
  schedulePost,
  type PostAuditActor,
} from "./posts";

/**
 * Jadwal Postingan Berulang (Fase Susulan S2) — lapisan penjadwal
 * DI ATAS state machine postingan Fase 23, pola yang sama seperti
 * broadcast berulang G9 di atas broadcast Fase 7C. Modul ini TIDAK
 * menerbitkan apa pun:
 *
 * - Sebuah ATURAN menyimpan snapshot templat postingan (judul,
 *   caption, media, himpunan sasaran — bentuk yang sama seperti
 *   pembuatan grup komposer) + pola pengulangan. Matematika polanya
 *   DIBAGI dengan G9 lewat `recurrence-pattern.ts`; yang berbeda
 *   hanyalah domainnya (di sini tidak ada penerima, template WA,
 *   atau filter audiens).
 * - Penyapu `processPostRecurrences` (worker, berkala) memproses
 *   slot yang jatuh tempo: untuk tiap slot ia memanggil jalur yang
 *   SUDAH ADA — createPost/createPostGroup → schedulePost — sehingga
 *   postingan anak adalah postingan biasa (klaim atomik publikasi,
 *   gerbang capability, dan gerbang persetujuan S1 berlaku apa
 *   adanya).
 * - Setiap slot meninggalkan tepat satu baris LEDGER
 *   (post_recurrence_occurrences, unik (rule_id, slot_at) = kunci
 *   idempotensi): created / skipped / missed + alasan jujur.
 *
 * Keputusan yang mengikat (meniru G9, disesuaikan ke postingan):
 * - Slot basi TIDAK ditembakkan: slot yang pertama kali terlihat
 *   penyapu sudah lewat POST_RECURRENCE_MAX_LATENESS_MS (1 jam)
 *   dicatat missed `slot_expired`. Klaim materialisasi yang tidak
 *   selesai dalam POST_RECURRENCE_CLAIM_STALE_MS (10 menit —
 *   proses mati di tengah) diambil alih sebagai missed
 *   `claim_stale`.
 * - Aturan JEDA tetap memproses slotnya sebagai skipped
 *   `rule_paused`: slot tidak lahir, tetapi juga tidak hilang
 *   diam-diam — ledger adalah riwayat yang lengkap.
 * - Kondisi berhenti: `endsAt` (slot terakhir yang boleh,
 *   inklusif) dan `maxOccurrences` (menghitung hanya postingan
 *   yang BENAR-BENAR dibuat — skipped/missed tidak menghabiskan
 *   kuota kejadian).
 * - Kegagalan materialisasi (gerbang buat/jadwalkan menolak, mis.
 *   sasaran terputus atau opsi platform belum lengkap) membatalkan
 *   SELURUH unit slot itu: postingan yang telanjur lahir dihapus
 *   kembali agar tidak menjadi draft yatim yang bisa terkirim
 *   manual dan menggandakan slot berikutnya; ledger mencatat
 *   skipped dengan kode gerbangnya.
 * - Interaksi persetujuan S1: postingan anak lahir dengan
 *   `approval_status` bawaan `draft` dan terjadwal seperti biasa.
 *   Bila tenant mewajibkan persetujuan, gerbang penerbitan worker
 *   yang menahan mereka di jam tayang — lapisan ini tidak punya
 *   jalur pintas persetujuan apa pun.
 * - Akses ditegakkan di lapisan API seperti posts: mutasi
 *   owner/admin, baca semua member.
 */

export type PostRecurrenceFrequency = "daily" | "weekly" | "monthly";
export type PostRecurrenceStatus =
  | "active"
  | "paused"
  | "completed"
  | "cancelled";
export type PostRecurrenceOccurrenceStatus =
  | "claimed"
  | "created"
  | "skipped"
  | "missed";

/** Pola aturan postingan = pola kalender bersama (recurrence-pattern). */
export type PostRecurrencePattern = RecurrencePattern;
export type { RecurrenceValidationKind };

/** Ambang keterlambatan: slot yang lebih tua dari ini saat pertama diproses dicatat missed, bukan ditembakkan. */
export const POST_RECURRENCE_MAX_LATENESS_MS = 60 * 60 * 1000;
/** Klaim materialisasi yang lebih tua dari ini dianggap basi (proses mati) dan diambil alih. */
export const POST_RECURRENCE_CLAIM_STALE_MS = 10 * 60 * 1000;
/** Batas aturan yang dipindai per sapuan penyapu. */
export const POST_RECURRENCE_SWEEP_RULE_LIMIT = 50;
/** Batas slot yang diproses per aturan per sapuan (mengejar ketertinggalan bertahap, bukan meledak). */
export const POST_RECURRENCE_SWEEP_SLOT_LIMIT = 100;

// ---------------------------------------------------------------------------
// Templat postingan (snapshot aturan)
// ---------------------------------------------------------------------------

/** Satu sasaran templat — bentuk target grup komposer. */
export interface PostTemplateTarget {
  conversationId: string;
  /** Override caption untuk sasaran ini; undefined = caption induk. */
  caption?: string;
  /** Opsi penerbitan milik sasaran ini; null/undefined = belum dipilih. */
  publishOptions?: PostPublishOptions | null;
}

export interface PostTemplateInput {
  title?: string;
  caption?: string;
  mediaIds?: string[];
  targets?: PostTemplateTarget[];
}

/** Templat yang sudah tuntas (semua gerbang simpan lolos). */
export interface ResolvedPostTemplate {
  title: string;
  caption: string;
  mediaIds: string[];
  targets: PostTemplateTarget[];
}

export type ResolvePostTemplateResult =
  | { kind: "ok"; template: ResolvedPostTemplate }
  | { kind: "template_incomplete" }
  | { kind: "target_not_found" }
  | { kind: "target_not_connected" }
  | { kind: "media_not_found" }
  | { kind: "media_too_many" };

/**
 * Pemeriksaan satu sasaran templat — predikat yang sama seperti
 * `resolvePostTarget` di posts.ts (percakapan channel ada + akun
 * masih terhubung). Dipakai saat aturan disimpan DAN sebagai
 * pemeriksaan awal sebelum klaim materialisasi. Gerbang otoritatif
 * tetap createPost/createPostGroup saat materialisasi.
 */
export async function checkTemplateTarget(
  tx: DbTx,
  tenantId: string,
  conversationId: string,
): Promise<"ok" | "target_not_found" | "target_not_connected"> {
  const [target] = await tx
    .select({ status: channelAccounts.status })
    .from(conversations)
    .innerJoin(
      channelAccounts,
      eq(channelAccounts.id, conversations.channelAccountId),
    )
    .where(
      and(
        eq(conversations.tenantId, tenantId),
        eq(conversations.id, conversationId),
        eq(conversations.kind, "channel"),
      ),
    )
    .limit(1);
  if (!target) return "target_not_found";
  if (target.status !== "connected") return "target_not_connected";
  return "ok";
}

/** Pemeriksaan media templat: semua id harus milik tenant ini. */
export async function checkTemplateMedia(
  tx: DbTx,
  tenantId: string,
  mediaIds: string[],
): Promise<"ok" | "media_not_found" | "media_too_many"> {
  const unique = [...new Set(mediaIds)];
  if (unique.length > POST_MEDIA_MAX) return "media_too_many";
  if (unique.length === 0) return "ok";
  const found = await tx
    .select({ id: media.id })
    .from(media)
    .where(and(eq(media.tenantId, tenantId), inArray(media.id, unique)));
  return found.length === unique.length ? "ok" : "media_not_found";
}

/**
 * Menyelesaikan templat aturan dari (basis opsional + timpaan):
 * basis adalah postingan sumber (salinan) atau templat tersimpan
 * aturan (saat edit); timpaan adalah bidang yang dikirim pemanggil.
 * Validasi meniru gerbang pembuatan postingan agar aturan yang
 * tidak akan pernah bisa lahir ditolak saat disimpan, bukan diam-
 * diam gagal setiap slot. (Gerbang ISI per provider — caption
 * kosong, opsi platform wajib — ditegakkan penjadwalan saat
 * materialisasi dan tercatat di ledger, sama seperti postingan
 * manual yang gagal dijadwalkan.)
 */
export async function resolvePostTemplate(
  tx: DbTx,
  input: {
    tenantId: string;
    base: {
      title?: string | null;
      caption?: string | null;
      mediaIds?: string[] | null;
      targets?: PostTemplateTarget[] | null;
    } | null;
    overrides: PostTemplateInput;
  },
): Promise<ResolvePostTemplateResult> {
  const { tenantId, base, overrides } = input;
  const title = overrides.title ?? base?.title ?? undefined;
  if (!title || title.trim() === "") return { kind: "template_incomplete" };
  const rawTargets = overrides.targets ?? base?.targets ?? undefined;
  if (!rawTargets || rawTargets.length === 0) {
    return { kind: "template_incomplete" };
  }
  // Sasaran ganda dibuang — dua baris untuk linimasa yang sama
  // dalam satu kejadian adalah kirim ganda yang direncanakan.
  const targets = [
    ...new Map(rawTargets.map((t) => [t.conversationId, t])).values(),
  ];
  for (const target of targets) {
    const check = await checkTemplateTarget(
      tx,
      tenantId,
      target.conversationId,
    );
    if (check !== "ok") return { kind: check };
  }
  const mediaIds = [
    ...new Set(overrides.mediaIds ?? base?.mediaIds ?? []),
  ];
  const mediaCheck = await checkTemplateMedia(tx, tenantId, mediaIds);
  if (mediaCheck !== "ok") return { kind: mediaCheck };
  return {
    kind: "ok",
    template: {
      title,
      caption: overrides.caption ?? base?.caption ?? "",
      mediaIds,
      targets,
    },
  };
}

/** Bentuk jsonb targets seperti tersimpan di kolom aturan/slot. */
export function templateTargetsToRecord(
  targets: PostTemplateTarget[],
): Array<{
  conversationId: string;
  caption?: string;
  publishOptions?: PostPublishOptions;
}> {
  return targets.map((t) => ({
    conversationId: t.conversationId,
    ...(t.caption !== undefined ? { caption: t.caption } : {}),
    // null dan undefined sama-sama berarti "belum dipilih" — record
    // tersimpan hanya membawa kunci bila ada opsi nyata.
    ...(t.publishOptions != null
      ? { publishOptions: t.publishOptions }
      : {}),
  }));
}

export function templateTargetsFromRecord(
  value: unknown,
): PostTemplateTarget[] {
  if (!Array.isArray(value)) return [];
  const out: PostTemplateTarget[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    if (typeof row.conversationId !== "string") continue;
    out.push({
      conversationId: row.conversationId,
      ...(typeof row.caption === "string" ? { caption: row.caption } : {}),
      ...(row.publishOptions !== undefined
        ? {
            publishOptions:
              (row.publishOptions as PostPublishOptions | null) ?? null,
          }
        : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Baca: aturan + ledger
// ---------------------------------------------------------------------------

/** Sasaran templat + info tampil sasarannya (untuk daftar/detail). */
export interface PostRecurrenceTargetView extends PostTemplateTarget {
  provider: string | null;
  conversationTitle: string | null;
  channelDisplayName: string | null;
}

export interface PostRecurrenceRuleRecord
  extends Omit<PostRecurrenceRule, "targets" | "mediaIds"> {
  mediaIds: string[];
  targets: PostRecurrenceTargetView[];
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

function patternOfRule(rule: PostRecurrenceRule): PostRecurrencePattern {
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

/** Pasang info tampil sasaran pada baris aturan mentah. */
async function attachTargetViews(
  tx: DbTx,
  tenantId: string,
  rules: PostRecurrenceRule[],
): Promise<PostRecurrenceRuleRecord[]> {
  const allTargets = rules.map((rule) =>
    templateTargetsFromRecord(rule.targets),
  );
  const conversationIds = [
    ...new Set(allTargets.flatMap((ts) => ts.map((t) => t.conversationId))),
  ];
  const info = new Map<
    string,
    { provider: string; title: string | null; channelDisplayName: string | null }
  >();
  if (conversationIds.length > 0) {
    const rows = await tx
      .select({
        conversationId: conversations.id,
        provider: conversations.provider,
        title: conversations.title,
        channelDisplayName: channelAccounts.displayName,
      })
      .from(conversations)
      .innerJoin(
        channelAccounts,
        eq(channelAccounts.id, conversations.channelAccountId),
      )
      .where(
        and(
          eq(conversations.tenantId, tenantId),
          inArray(conversations.id, conversationIds),
        ),
      );
    for (const row of rows) {
      info.set(row.conversationId, {
        provider: row.provider,
        title: row.title,
        channelDisplayName: row.channelDisplayName,
      });
    }
  }
  return rules.map((rule, i) => ({
    ...rule,
    mediaIds: (rule.mediaIds as string[] | null) ?? [],
    targets: (allTargets[i] ?? []).map((target) => {
      const found = info.get(target.conversationId);
      return {
        ...target,
        provider: found?.provider ?? null,
        conversationTitle: found?.title ?? null,
        channelDisplayName: found?.channelDisplayName ?? null,
      };
    }),
  }));
}

async function selectRuleRecord(
  tx: DbTx,
  tenantId: string,
  ruleId: string,
): Promise<PostRecurrenceRuleRecord | null> {
  const [row] = await tx
    .select()
    .from(postRecurrenceRules)
    .where(
      and(
        eq(postRecurrenceRules.tenantId, tenantId),
        eq(postRecurrenceRules.id, ruleId),
      ),
    )
    .limit(1);
  if (!row) return null;
  const [record] = await attachTargetViews(tx, tenantId, [row]);
  return record ?? null;
}

export async function getPostRecurrenceRule(
  db: Database,
  input: { tenantId: string; ruleId: string },
): Promise<PostRecurrenceRuleRecord | null> {
  return withTenantDb(db, input.tenantId, (tx) =>
    selectRuleRecord(tx, input.tenantId, input.ruleId),
  );
}

export async function listPostRecurrenceRules(
  db: Database,
  input: {
    tenantId: string;
    status?: PostRecurrenceStatus;
    cursor?: string;
    limit?: number;
  },
): Promise<{
  rules: PostRecurrenceRuleRecord[];
  nextCursor: string | null;
}> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const limit = clampLimit(input.limit);
    const conditions = [eq(postRecurrenceRules.tenantId, input.tenantId)];
    if (input.status) {
      conditions.push(eq(postRecurrenceRules.status, input.status));
    }
    const cursor = decodeCursor(input.cursor);
    if (cursor) {
      const cursorDate = new Date(cursor.createdAt);
      conditions.push(
        or(
          lt(postRecurrenceRules.createdAt, cursorDate),
          and(
            eq(postRecurrenceRules.createdAt, cursorDate),
            lt(postRecurrenceRules.id, cursor.id),
          ),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(postRecurrenceRules)
      .where(and(...conditions))
      .orderBy(desc(postRecurrenceRules.createdAt), desc(postRecurrenceRules.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    return {
      rules: await attachTargetViews(tx, input.tenantId, pageRows),
      nextCursor: hasMore
        ? encodeCursor(pageRows[pageRows.length - 1])
        : null,
    };
  });
}

export async function listPostRecurrenceOccurrences(
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
      occurrences: PostRecurrenceOccurrence[];
      nextCursor: string | null;
    }
  | { kind: "not_found" }
> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const rule = await selectRuleRecord(tx, input.tenantId, input.ruleId);
    if (!rule) return { kind: "not_found" as const };
    const limit = clampLimit(input.limit);
    const conditions = [
      eq(postRecurrenceOccurrences.tenantId, input.tenantId),
      eq(postRecurrenceOccurrences.ruleId, input.ruleId),
    ];
    const cursor = decodeCursor(input.cursor);
    if (cursor) {
      const cursorDate = new Date(cursor.createdAt);
      conditions.push(
        or(
          lt(postRecurrenceOccurrences.slotAt, cursorDate),
          and(
            eq(postRecurrenceOccurrences.slotAt, cursorDate),
            lt(postRecurrenceOccurrences.id, cursor.id),
          ),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(postRecurrenceOccurrences)
      .where(and(...conditions))
      .orderBy(
        desc(postRecurrenceOccurrences.slotAt),
        desc(postRecurrenceOccurrences.id),
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

export type CreatePostRecurrenceResult =
  | { kind: "created"; rule: PostRecurrenceRuleRecord }
  | { kind: "source_not_found" }
  | { kind: "invalid_pattern"; reason: RecurrenceValidationKind }
  | Exclude<ResolvePostTemplateResult, { kind: "ok" }>;

interface PatternInput {
  frequency: PostRecurrenceFrequency;
  interval?: number;
  daysOfWeek?: number[];
  dayOfMonth?: number | null;
  lastDayOfMonth?: boolean;
  timezone?: string;
  startsAt: Date;
  endsAt?: Date | null;
  maxOccurrences?: number | null;
}

/** Snapshot templat dari satu postingan yang ada (jangkar + anggota grupnya). */
async function loadSourceTemplate(
  tx: DbTx,
  tenantId: string,
  sourcePostId: string,
): Promise<{
  name: string;
  title: string;
  caption: string;
  mediaIds: string[];
  targets: PostTemplateTarget[];
} | null> {
  const [anchor] = await tx
    .select({
      id: posts.id,
      groupId: posts.groupId,
      title: posts.title,
      caption: posts.caption,
      conversationId: posts.conversationId,
      publishOptions: posts.publishOptions,
    })
    .from(posts)
    .where(and(eq(posts.tenantId, tenantId), eq(posts.id, sourcePostId)))
    .limit(1);
  if (!anchor) return null;
  let members = [anchor];
  if (anchor.groupId) {
    members = await tx
      .select({
        id: posts.id,
        groupId: posts.groupId,
        title: posts.title,
        caption: posts.caption,
        conversationId: posts.conversationId,
        publishOptions: posts.publishOptions,
      })
      .from(posts)
      .where(
        and(eq(posts.tenantId, tenantId), eq(posts.groupId, anchor.groupId)),
      )
      .orderBy(asc(posts.createdAt));
  }
  const mediaRows = await tx
    .select({ mediaId: postMedia.mediaId })
    .from(postMedia)
    .where(
      and(eq(postMedia.tenantId, tenantId), eq(postMedia.postId, anchor.id)),
    )
    .orderBy(asc(postMedia.position));
  return {
    name: anchor.title,
    title: anchor.title,
    caption: anchor.caption,
    mediaIds: mediaRows.map((row) => row.mediaId),
    targets: members.map((member) => ({
      conversationId: member.conversationId,
      ...(member.caption !== anchor.caption
        ? { caption: member.caption }
        : {}),
      publishOptions:
        (member.publishOptions as PostPublishOptions | null) ?? null,
    })),
  };
}

export async function createPostRecurrenceRule(
  db: Database,
  input: {
    tenantId: string;
    userId: string;
    sourcePostId?: string;
    name?: string;
    template: PostTemplateInput;
    pattern: PatternInput;
  },
): Promise<CreatePostRecurrenceResult> {
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
  const pattern: PostRecurrencePattern = {
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
    let base: {
      name?: string;
      title?: string;
      caption?: string;
      mediaIds?: string[];
      targets?: PostTemplateTarget[];
    } | null = null;
    if (input.sourcePostId) {
      const source = await loadSourceTemplate(
        tx,
        input.tenantId,
        input.sourcePostId,
      );
      if (!source) return { kind: "source_not_found" as const };
      base = source;
    }
    const resolved = await resolvePostTemplate(tx, {
      tenantId: input.tenantId,
      base,
      overrides: input.template,
    });
    if (resolved.kind !== "ok") return resolved;
    const template = resolved.template;
    const name = input.name ?? base?.name ?? template.title;
    const [row] = await tx
      .insert(postRecurrenceRules)
      .values({
        tenantId: input.tenantId,
        name,
        sourcePostId: input.sourcePostId ?? null,
        title: template.title,
        caption: template.caption,
        mediaIds: template.mediaIds,
        targets: templateTargetsToRecord(template.targets),
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
      action: "post_recurrence.created",
      meta: {
        ruleId: row.id,
        frequency: pattern.frequency,
        interval: pattern.interval,
        timezone: pattern.timezone,
        firstSlotAt: firstSlot.toISOString(),
        targetCount: template.targets.length,
        ...(input.sourcePostId
          ? { sourcePostId: input.sourcePostId }
          : {}),
      },
    });
    const rule = await selectRuleRecord(tx, input.tenantId, row.id);
    return { kind: "created" as const, rule: rule! };
  });
}

export type UpdatePostRecurrenceResult =
  | { kind: "updated"; rule: PostRecurrenceRuleRecord }
  | { kind: "not_found" }
  | { kind: "invalid_state"; status: PostRecurrenceStatus }
  | { kind: "invalid_pattern"; reason: RecurrenceValidationKind }
  | Exclude<ResolvePostTemplateResult, { kind: "ok" }>;

export async function updatePostRecurrenceRule(
  db: Database,
  input: {
    tenantId: string;
    ruleId: string;
    userId: string;
    name?: string;
    template: PostTemplateInput;
    pattern: Partial<PatternInput>;
  },
): Promise<UpdatePostRecurrenceResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(postRecurrenceRules)
      .where(
        and(
          eq(postRecurrenceRules.tenantId, input.tenantId),
          eq(postRecurrenceRules.id, input.ruleId),
        ),
      )
      .limit(1);
    if (!existing) return { kind: "not_found" as const };
    if (existing.status === "completed" || existing.status === "cancelled") {
      return { kind: "invalid_state" as const, status: existing.status };
    }
    const resolved = await resolvePostTemplate(tx, {
      tenantId: input.tenantId,
      base: {
        title: existing.title,
        caption: existing.caption,
        mediaIds: (existing.mediaIds as string[] | null) ?? [],
        targets: templateTargetsFromRecord(existing.targets),
      },
      overrides: input.template,
    });
    if (resolved.kind !== "ok") return resolved;
    const template = resolved.template;

    const p = input.pattern;
    const pattern: PostRecurrencePattern = {
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
    // menang) — pola yang sama seperti update aturan G9.
    const nextRunAt = firstRecurrenceSlotAtOrAfter(
      pattern,
      pattern.startsAt.getTime(),
    );
    if (!nextRunAt) return { kind: "invalid_pattern", reason: "invalid_range" };
    if (pattern.endsAt && nextRunAt.getTime() > pattern.endsAt.getTime()) {
      return { kind: "invalid_pattern", reason: "invalid_range" };
    }
    await tx
      .update(postRecurrenceRules)
      .set({
        name: input.name ?? existing.name,
        title: template.title,
        caption: template.caption,
        mediaIds: template.mediaIds,
        targets: templateTargetsToRecord(template.targets),
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
      .where(eq(postRecurrenceRules.id, input.ruleId));
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "post_recurrence.updated",
      meta: { ruleId: input.ruleId },
    });
    const rule = await selectRuleRecord(tx, input.tenantId, input.ruleId);
    return { kind: "updated" as const, rule: rule! };
  });
}

export type PostRecurrenceStateChangeResult =
  | { kind: "changed"; rule: PostRecurrenceRuleRecord }
  | { kind: "not_found" }
  | { kind: "invalid_state"; status: PostRecurrenceStatus };

async function changeRuleStatus(
  db: Database,
  input: {
    tenantId: string;
    ruleId: string;
    userId: string;
    from: PostRecurrenceStatus[];
    to: PostRecurrenceStatus;
    action: string;
    clearNextRun?: boolean;
  },
): Promise<PostRecurrenceStateChangeResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const existing = await selectRuleRecord(tx, input.tenantId, input.ruleId);
    if (!existing) return { kind: "not_found" as const };
    if (!input.from.includes(existing.status)) {
      return { kind: "invalid_state" as const, status: existing.status };
    }
    await tx
      .update(postRecurrenceRules)
      .set({
        status: input.to,
        ...(input.clearNextRun ? { nextRunAt: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(postRecurrenceRules.id, input.ruleId));
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: input.action,
      meta: { ruleId: input.ruleId, fromStatus: existing.status },
    });
    const rule = await selectRuleRecord(tx, input.tenantId, input.ruleId);
    return { kind: "changed" as const, rule: rule! };
  });
}

export function pausePostRecurrenceRule(
  db: Database,
  input: { tenantId: string; ruleId: string; userId: string },
): Promise<PostRecurrenceStateChangeResult> {
  return changeRuleStatus(db, {
    ...input,
    from: ["active"],
    to: "paused",
    action: "post_recurrence.paused",
  });
}

export function resumePostRecurrenceRule(
  db: Database,
  input: { tenantId: string; ruleId: string; userId: string },
): Promise<PostRecurrenceStateChangeResult> {
  return changeRuleStatus(db, {
    ...input,
    from: ["paused"],
    to: "active",
    action: "post_recurrence.resumed",
  });
}

export function cancelPostRecurrenceRule(
  db: Database,
  input: { tenantId: string; ruleId: string; userId: string },
): Promise<PostRecurrenceStateChangeResult> {
  return changeRuleStatus(db, {
    ...input,
    from: ["active", "paused"],
    to: "cancelled",
    action: "post_recurrence.cancelled",
    clearNextRun: true,
  });
}

// ---------------------------------------------------------------------------
// Materialisasi templat (dipakai bersama penyapu aturan + antrean)
// ---------------------------------------------------------------------------

export interface MaterializePostTemplateResult {
  postIds: string[];
  groupId: string | null;
}

/**
 * Lahirkan postingan terjadwal NYATA dari satu templat pada satu
 * instan slot, lewat jalur pembuatan + penjadwalan yang ada persis
 * (createPost untuk satu sasaran, createPostGroup untuk banyak
 * sasaran; lalu schedulePost per anggota pada jam slot).
 *
 * Kegagalan di tengah (gerbang penjadwalan menolak satu anggota)
 * membatalkan SELURUH unit: postingan yang telanjur lahir dihapus
 * kembali — satu kejadian tidak pernah lahir separuh, dan tidak ada
 * draft yatim yang bisa terkirim manual menggandakan slot
 * berikutnya. PostDomainError asal diteruskan ke pemanggil (kode-
 * nya menjadi alasan ledger); galat tak terduga juga diteruskan
 * sesudah pembersihan.
 */
export async function materializePostTemplate(
  db: Database,
  input: {
    tenantId: string;
    /** Pembuat baris postingan (pemilik aturan/slot); null = sistem. */
    userId: string | null;
    auditActor: PostAuditActor;
    template: ResolvedPostTemplate;
    scheduledAt: Date;
  },
): Promise<MaterializePostTemplateResult> {
  const { tenantId, template } = input;
  const createdIds: string[] = [];
  try {
    let groupId: string | null = null;
    if (template.targets.length === 1) {
      const target = template.targets[0]!;
      const post = await createPost(db, {
        tenantId,
        userId: input.userId,
        auditActor: input.auditActor,
        conversationId: target.conversationId,
        title: template.title,
        caption: target.caption ?? template.caption,
        mediaIds: template.mediaIds,
        publishOptions: target.publishOptions ?? undefined,
      });
      createdIds.push(post.id);
    } else {
      const group = await createPostGroup(db, {
        tenantId,
        userId: input.userId,
        auditActor: input.auditActor,
        title: template.title,
        caption: template.caption,
        mediaIds: template.mediaIds,
        targets: template.targets.map((target) => ({
          conversationId: target.conversationId,
          ...(target.caption !== undefined
            ? { caption: target.caption }
            : {}),
          publishOptions: target.publishOptions ?? undefined,
        })),
      });
      groupId = group.groupId;
      for (const post of group.posts) createdIds.push(post.id);
    }
    for (const postId of createdIds) {
      await schedulePost(db, {
        tenantId,
        userId: input.userId,
        auditActor: input.auditActor,
        postId,
        scheduledAt: input.scheduledAt,
      });
    }
    return { postIds: createdIds, groupId };
  } catch (err) {
    // Batalkan unit: hapus yang telanjur lahir (yang sudah sempat
    // terjadwal dibatalkan dulu agar bisa dihapus). Pembersihan
    // bersifat best-effort per baris — kegagalannya tidak menutupi
    // galat asal yang harus tercatat di ledger.
    for (const postId of createdIds) {
      try {
        await deletePost(db, {
          tenantId,
          userId: input.userId,
          auditActor: input.auditActor,
          postId,
        });
      } catch {
        try {
          await cancelPost(db, {
            tenantId,
            userId: input.userId,
            auditActor: input.auditActor,
            postId,
          });
          await deletePost(db, {
            tenantId,
            userId: input.userId,
            auditActor: input.auditActor,
            postId,
          });
        } catch {
          // Baris sisa akan terlihat sebagai draft yatim di kalender —
          // lebih baik daripada menutupi galat materialisasi.
        }
      }
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Penyapu materialisasi (sisi worker, berkala)
// ---------------------------------------------------------------------------

export interface ProcessPostRecurrencesResult {
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
 * Satu sapuan materialisasi aturan postingan lintas tenant:
 * 1. Temukan aturan active/paused yang next_run_at-nya jatuh tempo
 *    lewat lengan baca `system_post_recurrence_scan`
 *    (flag app.post_recurrence='scan' — migrasi 0047).
 * 2. Per aturan, dalam konteks tenant pemiliknya, proses slot jatuh
 *    tempo satu per satu (maks POST_RECURRENCE_SWEEP_SLOT_LIMIT):
 *    klaim ledger → materialisasi lewat jalur postingan yang ada →
 *    finalisasi ledger → majukan next_run_at / tutup aturan.
 * Mengembalikan ringkasan untuk log worker.
 */
export async function processPostRecurrences(
  db: Database,
  now: Date = new Date(),
): Promise<ProcessPostRecurrencesResult> {
  const targets = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.post_recurrence', 'scan', true)`,
    );
    return tx
      .select({
        id: postRecurrenceRules.id,
        tenantId: postRecurrenceRules.tenantId,
      })
      .from(postRecurrenceRules)
      .where(
        and(
          inArray(postRecurrenceRules.status, ["active", "paused"]),
          sql`${postRecurrenceRules.nextRunAt} IS NOT NULL`,
          sql`${postRecurrenceRules.nextRunAt} <= ${now}`,
        ),
      )
      .orderBy(asc(postRecurrenceRules.nextRunAt))
      .limit(POST_RECURRENCE_SWEEP_RULE_LIMIT);
  });

  const totals: ProcessPostRecurrencesResult = {
    rulesScanned: targets.length,
    created: 0,
    skipped: 0,
    missed: 0,
    completed: 0,
  };
  for (const target of targets) {
    const result = await processPostRecurrenceRule(
      db,
      target.tenantId,
      target.id,
      now,
    );
    totals.created += result.created;
    totals.skipped += result.skipped;
    totals.missed += result.missed;
    totals.completed += result.completed;
  }
  return totals;
}

async function processPostRecurrenceRule(
  db: Database,
  tenantId: string,
  ruleId: string,
  now: Date,
): Promise<{ created: number; skipped: number; missed: number; completed: number }> {
  const counts = { created: 0, skipped: 0, missed: 0, completed: 0 };
  for (let i = 0; i < POST_RECURRENCE_SWEEP_SLOT_LIMIT; i++) {
    const step = await processOnePostSlot(db, tenantId, ruleId, now, counts);
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
async function processOnePostSlot(
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
      .from(postRecurrenceRules)
      .where(
        and(
          eq(postRecurrenceRules.tenantId, tenantId),
          eq(postRecurrenceRules.id, ruleId),
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
      await completePostRule(tx, tenantId, rule, "ends_at");
      return { kind: "completed" as const };
    }
    if (
      rule.maxOccurrences !== null &&
      rule.occurrencesCreated >= rule.maxOccurrences
    ) {
      await completePostRule(tx, tenantId, rule, "max_occurrences");
      return { kind: "completed" as const };
    }

    const [existing] = await tx
      .select()
      .from(postRecurrenceOccurrences)
      .where(
        and(
          eq(postRecurrenceOccurrences.ruleId, ruleId),
          eq(postRecurrenceOccurrences.slotAt, slot),
        ),
      )
      .limit(1);
    if (existing) {
      if (existing.status === "claimed") {
        if (
          now.getTime() - existing.updatedAt.getTime() >
          POST_RECURRENCE_CLAIM_STALE_MS
        ) {
          // Pengambilalihan klaim basi: proses yang mengklaim mati
          // di tengah — slot tidak ditembakkan ulang (postingan
          // anak mungkin sudah lahir), dicatat missed dengan jujur.
          await finalizePostOccurrence(tx, tenantId, existing.id, {
            status: "missed",
            reason: "claim_stale",
            postGroupId: null,
            postIds: [],
          });
          const advanced = await advancePostRule(tx, tenantId, rule, slot);
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
      const advanced = await advancePostRule(tx, tenantId, rule, slot);
      if (advanced === "completed") return { kind: "completed" as const };
      return { kind: "advance_only" as const };
    }

    const decision: SlotDecision =
      rule.status === "paused"
        ? { kind: "skip", status: "skipped", reason: "rule_paused" }
        : now.getTime() - slot.getTime() > POST_RECURRENCE_MAX_LATENESS_MS
          ? { kind: "skip", status: "missed", reason: "slot_expired" }
          : await precheckPostMaterialization(tx, tenantId, rule);

    if (decision.kind === "skip") {
      const [claimed] = await tx
        .insert(postRecurrenceOccurrences)
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
      await writePostOccurrenceAudit(tx, tenantId, rule, slot, decision.status, decision.reason, []);
      const advanced = await advancePostRule(tx, tenantId, rule, slot);
      return {
        kind: "counted" as const,
        outcome: decision.status === "missed" ? ("missed" as const) : ("skipped" as const),
        completedToo: advanced === "completed",
      };
    }

    // Materialisasi: klaim dulu, buat di luar transaksi ini.
    const [claimed] = await tx
      .insert(postRecurrenceOccurrences)
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

  // --- Fase B: buat + jadwalkan postingan anak lewat jalur yang ada ---
  const { rule, slot, occurrenceId } = phaseA;
  const actor: PostAuditActor = {
    actorType: "system",
    actorId: `post-recurrence:${ruleId}`,
    meta: { postRecurrenceRuleId: ruleId, recurrenceSlotAt: slot.toISOString() },
  };
  const template: ResolvedPostTemplate = {
    title: rule.title,
    caption: rule.caption,
    mediaIds: (rule.mediaIds as string[] | null) ?? [],
    targets: templateTargetsFromRecord(rule.targets),
  };
  let created: MaterializePostTemplateResult | null = null;
  let failureReason: string | null = null;
  try {
    created = await materializePostTemplate(db, {
      tenantId,
      userId: rule.createdByUserId,
      auditActor: actor,
      template,
      scheduledAt: slot,
    });
  } catch (err) {
    if (err instanceof PostDomainError) {
      failureReason = err.code;
    } else {
      // Galat tak terduga: kejadian dibiarkan 'claimed' — sapuan
      // berikutnya mengambil alihnya sebagai missed 'claim_stale'
      // sesudah ambang basi, persis pola G9.
      throw err;
    }
  }

  // --- Fase C (transaksi tenant): finalisasi ledger + majukan aturan ---
  await withTenantDb(db, tenantId, async (tx) => {
    const [fresh] = await tx
      .select()
      .from(postRecurrenceRules)
      .where(eq(postRecurrenceRules.id, ruleId))
      .limit(1);
    if (!fresh) return;
    if (failureReason === null && created) {
      const finalized = await finalizePostOccurrence(tx, tenantId, occurrenceId, {
        status: "created",
        reason: null,
        postGroupId: created.groupId,
        postIds: created.postIds,
      });
      if (!finalized) {
        // Klaim sudah diambil alih sapuan lain sebagai claim_stale
        // selagi materialisasi berjalan — sapuan itu yang memajukan
        // aturan; postingan anak ini tetap sah (sudah terjadwal) dan
        // jejaknya ada di audit post.created/post.scheduled, tetapi
        // ledger tidak ditulis dua kali.
        return;
      }
      await tx
        .update(postRecurrenceRules)
        .set({
          occurrencesCreated: fresh.occurrencesCreated + 1,
          updatedAt: new Date(),
        })
        .where(eq(postRecurrenceRules.id, ruleId));
      await writePostOccurrenceAudit(tx, tenantId, fresh, slot, "created", null, created.postIds);
      const advanced = await advancePostRule(
        tx,
        tenantId,
        { ...fresh, occurrencesCreated: fresh.occurrencesCreated + 1 },
        slot,
      );
      if (advanced === "completed") counts.completed += 1;
      counts.created += 1;
    } else {
      const finalized = await finalizePostOccurrence(tx, tenantId, occurrenceId, {
        status: "skipped",
        reason: failureReason ?? "POST_TARGET_NOT_FOUND",
        postGroupId: null,
        postIds: [],
      });
      if (!finalized) return;
      await writePostOccurrenceAudit(
        tx,
        tenantId,
        fresh,
        slot,
        "skipped",
        failureReason ?? "POST_TARGET_NOT_FOUND",
        [],
      );
      const advanced = await advancePostRule(tx, tenantId, fresh, slot);
      if (advanced === "completed") counts.completed += 1;
      counts.skipped += 1;
    }
  });
  return "continue";
}

/**
 * Pemeriksaan gerbang SEBELUM klaim materialisasi, agar kegagalan
 * yang sudah pasti (channel putus, media templat terhapus)
 * tercatat skipped TANPA melahirkan postingan anak yatim. Gerbang
 * otoritatifnya tetap createPost/createPostGroup/schedulePost
 * sesudah ini.
 */
async function precheckPostMaterialization(
  tx: DbTx,
  tenantId: string,
  rule: PostRecurrenceRule,
): Promise<SlotDecision> {
  const targets = templateTargetsFromRecord(rule.targets);
  if (targets.length === 0) {
    return { kind: "skip", status: "skipped", reason: "POST_TARGET_NOT_FOUND" };
  }
  for (const target of targets) {
    const check = await checkTemplateTarget(tx, tenantId, target.conversationId);
    if (check === "target_not_found") {
      return { kind: "skip", status: "skipped", reason: "POST_TARGET_NOT_FOUND" };
    }
    if (check === "target_not_connected") {
      return { kind: "skip", status: "skipped", reason: "POST_TARGET_NOT_CONNECTED" };
    }
  }
  const mediaCheck = await checkTemplateMedia(
    tx,
    tenantId,
    (rule.mediaIds as string[] | null) ?? [],
  );
  if (mediaCheck === "media_not_found") {
    return { kind: "skip", status: "skipped", reason: "POST_MEDIA_NOT_FOUND" };
  }
  if (mediaCheck === "media_too_many") {
    return { kind: "skip", status: "skipped", reason: "POST_MEDIA_TOO_MANY" };
  }
  return { kind: "materialize" };
}

async function finalizePostOccurrence(
  tx: DbTx,
  tenantId: string,
  occurrenceId: string,
  outcome: {
    status: "created" | "skipped" | "missed";
    reason: string | null;
    postGroupId: string | null;
    postIds: string[];
  },
): Promise<boolean> {
  const updated = await tx
    .update(postRecurrenceOccurrences)
    .set({
      status: outcome.status,
      reason: outcome.reason,
      postGroupId: outcome.postGroupId,
      postIds: outcome.postIds,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(postRecurrenceOccurrences.tenantId, tenantId),
        eq(postRecurrenceOccurrences.id, occurrenceId),
        eq(postRecurrenceOccurrences.status, "claimed"),
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
async function advancePostRule(
  tx: DbTx,
  tenantId: string,
  rule: PostRecurrenceRule,
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
    await completePostRule(
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
    .update(postRecurrenceRules)
    .set({ nextRunAt: next, updatedAt: new Date() })
    .where(eq(postRecurrenceRules.id, rule.id));
  return "advanced";
}

async function completePostRule(
  tx: DbTx,
  tenantId: string,
  rule: PostRecurrenceRule,
  reason: string,
): Promise<void> {
  const [updated] = await tx
    .update(postRecurrenceRules)
    .set({ status: "completed", nextRunAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(postRecurrenceRules.id, rule.id),
        inArray(postRecurrenceRules.status, ["active", "paused"]),
      ),
    )
    .returning();
  if (!updated) return;
  await tx.insert(auditLogs).values({
    tenantId,
    actorType: "system",
    actorId: `post-recurrence:${rule.id}`,
    action: "post_recurrence.completed",
    meta: { ruleId: rule.id, reason },
  });
}

async function writePostOccurrenceAudit(
  tx: DbTx,
  tenantId: string,
  rule: PostRecurrenceRule,
  slot: Date,
  status: "created" | "skipped" | "missed",
  reason: string | null,
  postIds: string[],
): Promise<void> {
  await tx.insert(auditLogs).values({
    tenantId,
    actorType: "system",
    actorId: `post-recurrence:${rule.id}`,
    action:
      status === "created"
        ? "post_recurrence.occurrence_created"
        : status === "missed"
          ? "post_recurrence.occurrence_missed"
          : "post_recurrence.occurrence_skipped",
    meta: {
      ruleId: rule.id,
      slotAt: slot.toISOString(),
      ...(reason ? { reason } : {}),
      ...(postIds.length > 0 ? { postIds } : {}),
    },
  });
}
