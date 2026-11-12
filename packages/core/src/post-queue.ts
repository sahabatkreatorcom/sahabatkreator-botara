import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import {
  auditLogs,
  channelAccounts,
  conversations,
  postQueueItems,
  postQueueSlotFirings,
  postQueueSlots,
  tenants,
  type Database,
  type PostQueueItem,
  type PostQueueSlot,
  type PostQueueSlotFiring,
} from "@sahabat-kreator/db";
import { withTenantDb, type DbTx } from "./tx";
import {
  nextRecurrenceSlotAfter,
  patternTimeOfDay,
  queueSlotPattern,
  validateRecurrencePattern,
  type RecurrencePattern,
  type RecurrenceValidationKind,
} from "./recurrence-pattern";
import {
  PostDomainError,
  type PostAuditActor,
} from "./posts";
import {
  checkTemplateMedia,
  checkTemplateTarget,
  materializePostTemplate,
  templateTargetsFromRecord,
  templateTargetsToRecord,
  type PostRecurrenceTargetView,
  type PostTemplateTarget,
  type ResolvedPostTemplate,
} from "./post-recurrence";

/**
 * Antrean Konten Rutin (Fase Susulan S2) — pasangan "tarik" dari
 * aturan berulang postingan:
 *
 * - ANTREAN: daftar item konten (judul + caption + media — templat
 *   TANPA sasaran) milik tenant, berurutan (position). Item teratas
 *   adalah yang berikutnya terbit.
 * - SLOT RUTIN: pola mingguan (hari + jam dalam zona tenant) +
 *   himpunan sasaran. Saat slot tiba, penyapu worker menarik SATU
 *   item teratas dan mematerialisasikannya menjadi postingan
 *   terjadwal lewat jalur yang sama seperti aturan berulang
 *   (createPost/createPostGroup → schedulePost). Antrean kosong →
 *   tembakan dicatat `empty` (tidak ada postingan karangan).
 * - Setiap tembakan meninggalkan tepat satu baris LEDGER
 *   (post_queue_slot_firings, unik (slot_id, slot_at)): pulled /
 *   empty / skipped / missed + alasan.
 *
 * Penarikan atomik: klaim tembakan dan RESERVASI item teratas
 * terjadi dalam SATU transaksi tenant — item tereservasi tak
 * terlihat oleh tembakan lain (juga oleh slot lain) sampai
 * tembakan selesai. Kegagalan materialisasi melepaskan reservasi
 * (item tetap paling atas untuk slot berikutnya, tidak hilang);
 * klaim yang basi (>10 menit, proses mati) diambil alih sebagai
 * missed `claim_stale` dan reservasinya dilepas.
 *
 * Interaksi persetujuan S1 sama seperti aturan berulang: postingan
 * hasil lahir sebagai draf persetujuan `draft` yang terjadwal;
 * gerbang penerbitan worker yang menahan bila tenant mewajibkan
 * persetujuan. Tidak ada jalur pintas di sini.
 */

export type PostQueueSlotStatus = "active" | "paused" | "cancelled";
export type PostQueueItemStatus = "queued" | "pulled";
export type PostQueueFiringStatus =
  | "claimed"
  | "pulled"
  | "empty"
  | "skipped"
  | "missed";

/** Ambang keterlambatan slot antrean — sama seperti aturan (1 jam). */
export const POST_QUEUE_MAX_LATENESS_MS = 60 * 60 * 1000;
/** Klaim tembakan yang lebih tua dari ini dianggap basi dan diambil alih. */
export const POST_QUEUE_CLAIM_STALE_MS = 10 * 60 * 1000;
/** Batas slot yang dipindai per sapuan penyapu. */
export const POST_QUEUE_SWEEP_SLOT_LIMIT = 50;
/** Batas tembakan yang diproses per slot per sapuan. */
export const POST_QUEUE_SWEEP_FIRING_LIMIT = 100;

function clampLimit(limit: number | undefined): number {
  if (!limit || Number.isNaN(limit)) return 50;
  return Math.min(100, Math.max(1, Math.floor(limit)));
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

// ---------------------------------------------------------------------------
// Item antrean
// ---------------------------------------------------------------------------

export interface PostQueueItemInput {
  title?: string;
  caption?: string;
  mediaIds?: string[];
}

export type AddPostQueueItemResult =
  | { kind: "added"; item: PostQueueItem }
  | { kind: "template_incomplete" }
  | { kind: "media_not_found" }
  | { kind: "media_too_many" };

/** Menambah item ke EKOR antrean (position = maks + 1). */
export async function addPostQueueItem(
  db: Database,
  input: {
    tenantId: string;
    userId: string;
    item: PostQueueItemInput;
  },
): Promise<AddPostQueueItemResult> {
  if (!input.item.title || input.item.title.trim() === "") {
    return { kind: "template_incomplete" };
  }
  return withTenantDb(db, input.tenantId, async (tx) => {
    const mediaIds = [...new Set(input.item.mediaIds ?? [])];
    const mediaCheck = await checkTemplateMedia(tx, input.tenantId, mediaIds);
    if (mediaCheck !== "ok") return { kind: mediaCheck };
    const [maxRow] = await tx
      .select({ max: sql<number | null>`MAX(${postQueueItems.position})` })
      .from(postQueueItems)
      .where(eq(postQueueItems.tenantId, input.tenantId));
    const [row] = await tx
      .insert(postQueueItems)
      .values({
        tenantId: input.tenantId,
        position: (maxRow?.max ?? 0) + 1,
        title: input.item.title!,
        caption: input.item.caption ?? "",
        mediaIds,
        status: "queued",
        createdByUserId: input.userId,
      })
      .returning();
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "post_queue.item_added",
      meta: { itemId: row.id, position: row.position },
    });
    return { kind: "added" as const, item: row };
  });
}

/**
 * Daftar antrean. `queued` = antrean hidup dalam urutan tarik
 * (position naik); `pulled` = riwayat tarik (paling baru dulu).
 */
export async function listPostQueueItems(
  db: Database,
  input: {
    tenantId: string;
    status?: PostQueueItemStatus;
    cursor?: string;
    limit?: number;
  },
): Promise<{ items: PostQueueItem[]; nextCursor: string | null }> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const limit = clampLimit(input.limit);
    const status = input.status ?? "queued";
    const conditions = [
      eq(postQueueItems.tenantId, input.tenantId),
      eq(postQueueItems.status, status),
    ];
    const cursor = decodeCursor(input.cursor);
    if (status === "queued") {
      if (cursor) {
        // Kursor antrean hidup mengkodekan POSITION terakhir sebagai
        // instan epoch (new Date(position).toISOString()) agar cocok
        // dengan bentuk kursor bersama; Date.parse memulihkannya.
        const cursorPosition = Date.parse(cursor.createdAt);
        conditions.push(
          or(
            sql`${postQueueItems.position} > ${cursorPosition}`,
            and(
              sql`${postQueueItems.position} = ${cursorPosition}`,
              sql`${postQueueItems.id} > ${cursor.id}`,
            ),
          )!,
        );
      }
      const rows = await tx
        .select()
        .from(postQueueItems)
        .where(and(...conditions))
        .orderBy(asc(postQueueItems.position), asc(postQueueItems.id))
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const last = pageRows[pageRows.length - 1];
      return {
        items: pageRows,
        nextCursor:
          hasMore && last
            ? encodeCursor({
                createdAt: new Date(last.position),
                id: last.id,
              })
            : null,
      };
    }
    if (cursor) {
      const cursorDate = new Date(cursor.createdAt);
      conditions.push(
        or(
          lt(postQueueItems.createdAt, cursorDate),
          and(
            eq(postQueueItems.createdAt, cursorDate),
            lt(postQueueItems.id, cursor.id),
          ),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(postQueueItems)
      .where(and(...conditions))
      .orderBy(desc(postQueueItems.createdAt), desc(postQueueItems.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: pageRows,
      nextCursor: hasMore
        ? encodeCursor(pageRows[pageRows.length - 1])
        : null,
    };
  });
}

export type UpdatePostQueueItemResult =
  | { kind: "updated"; item: PostQueueItem }
  | { kind: "not_found" }
  | { kind: "invalid_state"; status: PostQueueItemStatus }
  | { kind: "template_incomplete" }
  | { kind: "media_not_found" }
  | { kind: "media_too_many" };

export async function updatePostQueueItem(
  db: Database,
  input: {
    tenantId: string;
    itemId: string;
    userId: string;
    item: PostQueueItemInput;
  },
): Promise<UpdatePostQueueItemResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(postQueueItems)
      .where(
        and(
          eq(postQueueItems.tenantId, input.tenantId),
          eq(postQueueItems.id, input.itemId),
        ),
      )
      .limit(1);
    if (!existing) return { kind: "not_found" as const };
    if (existing.status !== "queued") {
      return { kind: "invalid_state" as const, status: existing.status };
    }
    const title = input.item.title ?? existing.title;
    if (!title || title.trim() === "") {
      return { kind: "template_incomplete" as const };
    }
    const mediaIds = [
      ...new Set(
        input.item.mediaIds ??
          ((existing.mediaIds as string[] | null) ?? []),
      ),
    ];
    const mediaCheck = await checkTemplateMedia(tx, input.tenantId, mediaIds);
    if (mediaCheck !== "ok") return { kind: mediaCheck };
    const [row] = await tx
      .update(postQueueItems)
      .set({
        title,
        caption: input.item.caption ?? existing.caption,
        mediaIds,
        updatedAt: new Date(),
      })
      .where(eq(postQueueItems.id, input.itemId))
      .returning();
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "post_queue.item_updated",
      meta: { itemId: input.itemId },
    });
    return { kind: "updated" as const, item: row };
  });
}

export type RemovePostQueueItemResult =
  | { kind: "removed" }
  | { kind: "not_found" }
  | { kind: "invalid_state"; status: PostQueueItemStatus };

/** Menghapus item yang masih queued (riwayat pulled tidak bisa dihapus). */
export async function removePostQueueItem(
  db: Database,
  input: { tenantId: string; itemId: string; userId: string },
): Promise<RemovePostQueueItemResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(postQueueItems)
      .where(
        and(
          eq(postQueueItems.tenantId, input.tenantId),
          eq(postQueueItems.id, input.itemId),
        ),
      )
      .limit(1);
    if (!existing) return { kind: "not_found" as const };
    if (existing.status !== "queued") {
      return { kind: "invalid_state" as const, status: existing.status };
    }
    await tx
      .delete(postQueueItems)
      .where(eq(postQueueItems.id, input.itemId));
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "post_queue.item_removed",
      meta: { itemId: input.itemId, position: existing.position },
    });
    return { kind: "removed" as const };
  });
}

export type MovePostQueueItemResult =
  | { kind: "moved"; item: PostQueueItem }
  | { kind: "unchanged"; item: PostQueueItem }
  | { kind: "not_found" }
  | { kind: "invalid_state"; status: PostQueueItemStatus };

/**
 * Memindahkan item satu langkah dalam antrean (naik = menuju
 * teratas). Bertukar position dengan tetangganya; item yang sedang
 * tereservasi tembakan berjalan tetap ikut tertukar secara aman
 * (reservasi menunjuk id, bukan position).
 */
export async function movePostQueueItem(
  db: Database,
  input: {
    tenantId: string;
    itemId: string;
    userId: string;
    direction: "up" | "down";
  },
): Promise<MovePostQueueItemResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const queued = await tx
      .select()
      .from(postQueueItems)
      .where(
        and(
          eq(postQueueItems.tenantId, input.tenantId),
          eq(postQueueItems.status, "queued"),
        ),
      )
      .orderBy(asc(postQueueItems.position), asc(postQueueItems.id));
    const index = queued.findIndex((row) => row.id === input.itemId);
    if (index === -1) {
      const [existing] = await tx
        .select()
        .from(postQueueItems)
        .where(
          and(
            eq(postQueueItems.tenantId, input.tenantId),
            eq(postQueueItems.id, input.itemId),
          ),
        )
        .limit(1);
      if (!existing) return { kind: "not_found" as const };
      return { kind: "invalid_state" as const, status: existing.status };
    }
    const item = queued[index]!;
    const neighborIndex = input.direction === "up" ? index - 1 : index + 1;
    const neighbor = queued[neighborIndex];
    if (!neighbor) return { kind: "unchanged" as const, item };
    await tx
      .update(postQueueItems)
      .set({ position: neighbor.position, updatedAt: new Date() })
      .where(eq(postQueueItems.id, item.id));
    await tx
      .update(postQueueItems)
      .set({ position: item.position, updatedAt: new Date() })
      .where(eq(postQueueItems.id, neighbor.id));
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "post_queue.item_moved",
      meta: {
        itemId: item.id,
        direction: input.direction,
        fromPosition: item.position,
        toPosition: neighbor.position,
      },
    });
    const [moved] = await tx
      .select()
      .from(postQueueItems)
      .where(eq(postQueueItems.id, item.id))
      .limit(1);
    return { kind: "moved" as const, item: moved! };
  });
}

// ---------------------------------------------------------------------------
// Slot rutin
// ---------------------------------------------------------------------------

export interface PostQueueSlotRecord
  extends Omit<PostQueueSlot, "targets"> {
  targets: PostRecurrenceTargetView[];
  /**
   * Jam slot "HH:MM" — diturunkan dari jangkar startsAt dalam zona
   * slot (jam tidak disimpan dua kali; lihat skema postQueueSlots).
   */
  timeOfDay: string;
}

async function attachSlotTargetViews(
  tx: DbTx,
  tenantId: string,
  slots: PostQueueSlot[],
): Promise<PostQueueSlotRecord[]> {
  const allTargets = slots.map((slot) =>
    templateTargetsFromRecord(slot.targets),
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
  return slots.map((slot, i) => ({
    ...slot,
    timeOfDay: patternTimeOfDay(patternOfSlot(slot)),
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

async function selectSlotRecord(
  tx: DbTx,
  tenantId: string,
  slotId: string,
): Promise<PostQueueSlotRecord | null> {
  const [row] = await tx
    .select()
    .from(postQueueSlots)
    .where(
      and(eq(postQueueSlots.tenantId, tenantId), eq(postQueueSlots.id, slotId)),
    )
    .limit(1);
  if (!row) return null;
  const [record] = await attachSlotTargetViews(tx, tenantId, [row]);
  return record ?? null;
}

export async function getPostQueueSlot(
  db: Database,
  input: { tenantId: string; slotId: string },
): Promise<PostQueueSlotRecord | null> {
  return withTenantDb(db, input.tenantId, (tx) =>
    selectSlotRecord(tx, input.tenantId, input.slotId),
  );
}

export async function listPostQueueSlots(
  db: Database,
  input: {
    tenantId: string;
    status?: PostQueueSlotStatus;
    cursor?: string;
    limit?: number;
  },
): Promise<{ slots: PostQueueSlotRecord[]; nextCursor: string | null }> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const limit = clampLimit(input.limit);
    const conditions = [eq(postQueueSlots.tenantId, input.tenantId)];
    if (input.status) {
      conditions.push(eq(postQueueSlots.status, input.status));
    }
    const cursor = decodeCursor(input.cursor);
    if (cursor) {
      const cursorDate = new Date(cursor.createdAt);
      conditions.push(
        or(
          lt(postQueueSlots.createdAt, cursorDate),
          and(
            eq(postQueueSlots.createdAt, cursorDate),
            lt(postQueueSlots.id, cursor.id),
          ),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(postQueueSlots)
      .where(and(...conditions))
      .orderBy(desc(postQueueSlots.createdAt), desc(postQueueSlots.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    return {
      slots: await attachSlotTargetViews(tx, input.tenantId, pageRows),
      nextCursor: hasMore
        ? encodeCursor(pageRows[pageRows.length - 1])
        : null,
    };
  });
}

export interface PostQueueSlotPatternInput {
  daysOfWeek: number[];
  /** Format "HH:MM" 24 jam, waktu lokal zona slot. */
  timeOfDay: string;
  timezone?: string;
  startsAt?: Date;
}

/**
 * Validasi target slot: himpunan tidak boleh kosong, tiap sasaran
 * harus percakapan channel yang terhubung (pemeriksaan yang sama
 * seperti templat aturan).
 */
async function validateSlotTargets(
  tx: DbTx,
  tenantId: string,
  rawTargets: PostTemplateTarget[] | undefined,
): Promise<
  | { kind: "ok"; targets: PostTemplateTarget[] }
  | { kind: "targets_incomplete" }
  | { kind: "target_not_found" }
  | { kind: "target_not_connected" }
> {
  if (!rawTargets || rawTargets.length === 0) {
    return { kind: "targets_incomplete" };
  }
  const targets = [
    ...new Map(rawTargets.map((t) => [t.conversationId, t])).values(),
  ];
  for (const target of targets) {
    const check = await checkTemplateTarget(tx, tenantId, target.conversationId);
    if (check !== "ok") return { kind: check };
  }
  return { kind: "ok", targets };
}

export type CreatePostQueueSlotResult =
  | { kind: "created"; slot: PostQueueSlotRecord }
  | { kind: "invalid_pattern"; reason: RecurrenceValidationKind | "invalid_time" }
  | { kind: "targets_incomplete" }
  | { kind: "target_not_found" }
  | { kind: "target_not_connected" };

export async function createPostQueueSlot(
  db: Database,
  input: {
    tenantId: string;
    userId: string;
    name: string;
    targets: PostTemplateTarget[];
    pattern: PostQueueSlotPatternInput;
  },
): Promise<CreatePostQueueSlotResult> {
  let timezone = input.pattern.timezone;
  if (!timezone) {
    const [tenant] = await db
      .select({ timezone: tenants.timezone })
      .from(tenants)
      .where(eq(tenants.id, input.tenantId))
      .limit(1);
    timezone = tenant?.timezone ?? "Asia/Jakarta";
  }
  const built = queueSlotPattern({
    daysOfWeek: input.pattern.daysOfWeek,
    timeOfDay: input.pattern.timeOfDay,
    timezone,
    fromMs: (input.pattern.startsAt ?? new Date()).getTime(),
  });
  if (!built) {
    return {
      kind: "invalid_pattern",
      reason: /^([01]\d|2[0-3]):([0-5]\d)$/.test(input.pattern.timeOfDay)
        ? "invalid_days_of_week"
        : "invalid_time",
    };
  }
  const invalid = validateRecurrencePattern(built);
  if (invalid) return { kind: "invalid_pattern", reason: invalid };

  return withTenantDb(db, input.tenantId, async (tx) => {
    const checked = await validateSlotTargets(tx, input.tenantId, input.targets);
    if (checked.kind !== "ok") return checked;
    const [row] = await tx
      .insert(postQueueSlots)
      .values({
        tenantId: input.tenantId,
        name: input.name,
        targets: templateTargetsToRecord(checked.targets),
        daysOfWeek: [...new Set(input.pattern.daysOfWeek)].sort((a, b) => a - b),
        timezone,
        startsAt: built.startsAt,
        status: "active",
        nextRunAt: built.startsAt,
        createdByUserId: input.userId,
      })
      .returning();
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "post_queue.slot_created",
      meta: {
        slotId: row.id,
        daysOfWeek: row.daysOfWeek,
        timeOfDay: input.pattern.timeOfDay,
        timezone,
        firstFiringAt: built.startsAt.toISOString(),
        targetCount: checked.targets.length,
      },
    });
    const slot = await selectSlotRecord(tx, input.tenantId, row.id);
    return { kind: "created" as const, slot: slot! };
  });
}

export type UpdatePostQueueSlotResult =
  | { kind: "updated"; slot: PostQueueSlotRecord }
  | { kind: "not_found" }
  | { kind: "invalid_state"; status: PostQueueSlotStatus }
  | { kind: "invalid_pattern"; reason: RecurrenceValidationKind | "invalid_time" }
  | { kind: "targets_incomplete" }
  | { kind: "target_not_found" }
  | { kind: "target_not_connected" };

export async function updatePostQueueSlot(
  db: Database,
  input: {
    tenantId: string;
    slotId: string;
    userId: string;
    name?: string;
    targets?: PostTemplateTarget[];
    pattern: Partial<PostQueueSlotPatternInput>;
  },
): Promise<UpdatePostQueueSlotResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(postQueueSlots)
      .where(
        and(
          eq(postQueueSlots.tenantId, input.tenantId),
          eq(postQueueSlots.id, input.slotId),
        ),
      )
      .limit(1);
    if (!existing) return { kind: "not_found" as const };
    if (existing.status === "cancelled") {
      return { kind: "invalid_state" as const, status: existing.status };
    }
    const checked = await validateSlotTargets(
      tx,
      input.tenantId,
      input.targets ?? templateTargetsFromRecord(existing.targets),
    );
    if (checked.kind !== "ok") return checked;
    const daysOfWeek =
      input.pattern.daysOfWeek ??
      ((existing.daysOfWeek as number[] | null) ?? []);
    const timeOfDay =
      input.pattern.timeOfDay ?? patternTimeOfDay(patternOfSlot(existing));
    const timezone = input.pattern.timezone ?? existing.timezone;
    const built = queueSlotPattern({
      daysOfWeek,
      timeOfDay,
      timezone,
      fromMs: (input.pattern.startsAt ?? new Date()).getTime(),
    });
    if (!built) {
      return {
        kind: "invalid_pattern" as const,
        reason: /^([01]\d|2[0-3]):([0-5]\d)$/.test(timeOfDay)
          ? ("invalid_days_of_week" as const)
          : ("invalid_time" as const),
      };
    }
    const invalid = validateRecurrencePattern(built);
    if (invalid) return { kind: "invalid_pattern", reason: invalid };
    await tx
      .update(postQueueSlots)
      .set({
        name: input.name ?? existing.name,
        targets: templateTargetsToRecord(checked.targets),
        daysOfWeek: [...new Set(daysOfWeek)].sort((a, b) => a - b),
        timezone,
        startsAt: built.startsAt,
        nextRunAt: built.startsAt,
        updatedAt: new Date(),
      })
      .where(eq(postQueueSlots.id, input.slotId));
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "post_queue.slot_updated",
      meta: { slotId: input.slotId },
    });
    const slot = await selectSlotRecord(tx, input.tenantId, input.slotId);
    return { kind: "updated" as const, slot: slot! };
  });
}

export type PostQueueSlotStateChangeResult =
  | { kind: "changed"; slot: PostQueueSlotRecord }
  | { kind: "not_found" }
  | { kind: "invalid_state"; status: PostQueueSlotStatus };

async function changeSlotStatus(
  db: Database,
  input: {
    tenantId: string;
    slotId: string;
    userId: string;
    from: PostQueueSlotStatus[];
    to: PostQueueSlotStatus;
    action: string;
    clearNextRun?: boolean;
  },
): Promise<PostQueueSlotStateChangeResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const existing = await selectSlotRecord(tx, input.tenantId, input.slotId);
    if (!existing) return { kind: "not_found" as const };
    if (!input.from.includes(existing.status)) {
      return { kind: "invalid_state" as const, status: existing.status };
    }
    await tx
      .update(postQueueSlots)
      .set({
        status: input.to,
        ...(input.clearNextRun ? { nextRunAt: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(postQueueSlots.id, input.slotId));
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: input.action,
      meta: { slotId: input.slotId, fromStatus: existing.status },
    });
    const slot = await selectSlotRecord(tx, input.tenantId, input.slotId);
    return { kind: "changed" as const, slot: slot! };
  });
}

export function pausePostQueueSlot(
  db: Database,
  input: { tenantId: string; slotId: string; userId: string },
): Promise<PostQueueSlotStateChangeResult> {
  return changeSlotStatus(db, {
    ...input,
    from: ["active"],
    to: "paused",
    action: "post_queue.slot_paused",
  });
}

export function resumePostQueueSlot(
  db: Database,
  input: { tenantId: string; slotId: string; userId: string },
): Promise<PostQueueSlotStateChangeResult> {
  return changeSlotStatus(db, {
    ...input,
    from: ["paused"],
    to: "active",
    action: "post_queue.slot_resumed",
  });
}

export function cancelPostQueueSlot(
  db: Database,
  input: { tenantId: string; slotId: string; userId: string },
): Promise<PostQueueSlotStateChangeResult> {
  return changeSlotStatus(db, {
    ...input,
    from: ["active", "paused"],
    to: "cancelled",
    action: "post_queue.slot_cancelled",
    clearNextRun: true,
  });
}

export async function listPostQueueSlotFirings(
  db: Database,
  input: {
    tenantId: string;
    slotId: string;
    cursor?: string;
    limit?: number;
  },
): Promise<
  | { kind: "ok"; firings: PostQueueSlotFiring[]; nextCursor: string | null }
  | { kind: "not_found" }
> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const slot = await selectSlotRecord(tx, input.tenantId, input.slotId);
    if (!slot) return { kind: "not_found" as const };
    const limit = clampLimit(input.limit);
    const conditions = [
      eq(postQueueSlotFirings.tenantId, input.tenantId),
      eq(postQueueSlotFirings.slotId, input.slotId),
    ];
    const cursor = decodeCursor(input.cursor);
    if (cursor) {
      const cursorDate = new Date(cursor.createdAt);
      conditions.push(
        or(
          lt(postQueueSlotFirings.slotAt, cursorDate),
          and(
            eq(postQueueSlotFirings.slotAt, cursorDate),
            lt(postQueueSlotFirings.id, cursor.id),
          ),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(postQueueSlotFirings)
      .where(and(...conditions))
      .orderBy(desc(postQueueSlotFirings.slotAt), desc(postQueueSlotFirings.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    return {
      kind: "ok" as const,
      firings: pageRows,
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
// Penyapu tarik antrean (sisi worker, berkala)
// ---------------------------------------------------------------------------

export interface ProcessPostQueueSlotsResult {
  slotsScanned: number;
  pulled: number;
  empty: number;
  skipped: number;
  missed: number;
}

/** Pola mingguan bersama untuk satu slot (jangkar = startsAt slot). */
function patternOfSlot(slot: PostQueueSlot): RecurrencePattern {
  return {
    frequency: "weekly",
    interval: 1,
    daysOfWeek: (slot.daysOfWeek as number[] | null) ?? [],
    dayOfMonth: null,
    lastDayOfMonth: false,
    timezone: slot.timezone,
    startsAt: slot.startsAt,
    endsAt: null,
  };
}

/**
 * Satu sapuan penarikan slot antrean lintas tenant — struktur yang
 * sama seperti penyapu aturan: pindai lewat lengan
 * `system_post_recurrence_scan`, lalu per slot dalam konteks
 * tenant: klaim tembakan + reservasi item teratas dalam satu
 * transaksi → materialisasi di luar transaksi → finalisasi.
 */
export async function processPostQueueSlots(
  db: Database,
  now: Date = new Date(),
): Promise<ProcessPostQueueSlotsResult> {
  const targets = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.post_recurrence', 'scan', true)`,
    );
    return tx
      .select({ id: postQueueSlots.id, tenantId: postQueueSlots.tenantId })
      .from(postQueueSlots)
      .where(
        and(
          inArray(postQueueSlots.status, ["active", "paused"]),
          sql`${postQueueSlots.nextRunAt} IS NOT NULL`,
          sql`${postQueueSlots.nextRunAt} <= ${now}`,
        ),
      )
      .orderBy(asc(postQueueSlots.nextRunAt))
      .limit(POST_QUEUE_SWEEP_SLOT_LIMIT);
  });

  const totals: ProcessPostQueueSlotsResult = {
    slotsScanned: targets.length,
    pulled: 0,
    empty: 0,
    skipped: 0,
    missed: 0,
  };
  for (const target of targets) {
    const result = await processPostQueueSlot(
      db,
      target.tenantId,
      target.id,
      now,
    );
    totals.pulled += result.pulled;
    totals.empty += result.empty;
    totals.skipped += result.skipped;
    totals.missed += result.missed;
  }
  return totals;
}

async function processPostQueueSlot(
  db: Database,
  tenantId: string,
  slotId: string,
  now: Date,
): Promise<{ pulled: number; empty: number; skipped: number; missed: number }> {
  const counts = { pulled: 0, empty: 0, skipped: 0, missed: 0 };
  for (let i = 0; i < POST_QUEUE_SWEEP_FIRING_LIMIT; i++) {
    const step = await processOneQueueFiring(db, tenantId, slotId, now, counts);
    if (step === "done") break;
  }
  return counts;
}

async function processOneQueueFiring(
  db: Database,
  tenantId: string,
  slotId: string,
  now: Date,
  counts: { pulled: number; empty: number; skipped: number; missed: number },
): Promise<"continue" | "done"> {
  // --- Fase A (transaksi tenant): putuskan + klaim + reservasi ---
  const phaseA = await withTenantDb(db, tenantId, async (tx) => {
    const [slot] = await tx
      .select()
      .from(postQueueSlots)
      .where(
        and(
          eq(postQueueSlots.tenantId, tenantId),
          eq(postQueueSlots.id, slotId),
        ),
      )
      .limit(1);
    if (!slot) return { kind: "done" as const };
    if (slot.status !== "active" && slot.status !== "paused") {
      return { kind: "done" as const };
    }
    const firingAt = slot.nextRunAt;
    if (!firingAt || firingAt.getTime() > now.getTime()) {
      return { kind: "done" as const };
    }

    const [existing] = await tx
      .select()
      .from(postQueueSlotFirings)
      .where(
        and(
          eq(postQueueSlotFirings.slotId, slotId),
          eq(postQueueSlotFirings.slotAt, firingAt),
        ),
      )
      .limit(1);
    if (existing) {
      if (existing.status === "claimed") {
        if (
          now.getTime() - existing.updatedAt.getTime() >
          POST_QUEUE_CLAIM_STALE_MS
        ) {
          // Ambil alih klaim basi: catat missed, lepas reservasi
          // item tembakan itu (item tetap antre, tidak hilang).
          await finalizeQueueFiring(tx, tenantId, existing.id, {
            status: "missed",
            reason: "claim_stale",
            queueItemId: existing.queueItemId,
            postGroupId: null,
            postIds: [],
          });
          if (existing.queueItemId) {
            await releaseQueueReservation(tx, existing.id);
          }
          await writeQueueFiringAudit(tx, tenantId, slot, firingAt, "missed", "claim_stale", existing.queueItemId, []);
          const advanced = await advanceQueueSlot(tx, slot, firingAt);
          return {
            kind: "counted" as const,
            outcome: "missed" as const,
            done: !advanced,
          };
        }
        return { kind: "done" as const };
      }
      const advanced = await advanceQueueSlot(tx, slot, firingAt);
      return { kind: "advance_only" as const, done: !advanced };
    }

    if (slot.status === "paused") {
      const [claimed] = await tx
        .insert(postQueueSlotFirings)
        .values({
          tenantId,
          slotId,
          slotAt: firingAt,
          status: "skipped",
          reason: "slot_paused",
        })
        .onConflictDoNothing()
        .returning();
      if (!claimed) return { kind: "done" as const };
      await writeQueueFiringAudit(tx, tenantId, slot, firingAt, "skipped", "slot_paused", null, []);
      const advanced = await advanceQueueSlot(tx, slot, firingAt);
      return { kind: "counted" as const, outcome: "skipped" as const, done: !advanced };
    }
    if (now.getTime() - firingAt.getTime() > POST_QUEUE_MAX_LATENESS_MS) {
      const [claimed] = await tx
        .insert(postQueueSlotFirings)
        .values({
          tenantId,
          slotId,
          slotAt: firingAt,
          status: "missed",
          reason: "slot_expired",
        })
        .onConflictDoNothing()
        .returning();
      if (!claimed) return { kind: "done" as const };
      await writeQueueFiringAudit(tx, tenantId, slot, firingAt, "missed", "slot_expired", null, []);
      const advanced = await advanceQueueSlot(tx, slot, firingAt);
      return { kind: "counted" as const, outcome: "missed" as const, done: !advanced };
    }

    // Item teratas yang bisa ditarik: queued, belum tereservasi.
    const [top] = await tx
      .select()
      .from(postQueueItems)
      .where(
        and(
          eq(postQueueItems.tenantId, tenantId),
          eq(postQueueItems.status, "queued"),
          isNull(postQueueItems.reservedFiringId),
        ),
      )
      .orderBy(asc(postQueueItems.position), asc(postQueueItems.id))
      .limit(1);
    if (!top) {
      const [claimed] = await tx
        .insert(postQueueSlotFirings)
        .values({
          tenantId,
          slotId,
          slotAt: firingAt,
          status: "empty",
          reason: "queue_empty",
        })
        .onConflictDoNothing()
        .returning();
      if (!claimed) return { kind: "done" as const };
      await writeQueueFiringAudit(tx, tenantId, slot, firingAt, "empty", "queue_empty", null, []);
      const advanced = await advanceQueueSlot(tx, slot, firingAt);
      return { kind: "counted" as const, outcome: "empty" as const, done: !advanced };
    }

    const [claimed] = await tx
      .insert(postQueueSlotFirings)
      .values({
        tenantId,
        slotId,
        slotAt: firingAt,
        status: "claimed",
        queueItemId: top.id,
      })
      .onConflictDoNothing()
      .returning();
    if (!claimed) return { kind: "done" as const };
    // Reservasi dalam transaksi yang sama dengan klaim: item ini
    // tidak terlihat oleh tembakan/slot mana pun sampai finalisasi.
    await tx
      .update(postQueueItems)
      .set({ reservedFiringId: claimed.id, reservedAt: now, updatedAt: now })
      .where(eq(postQueueItems.id, top.id));
    return {
      kind: "materialize" as const,
      slot,
      firingAt,
      firingId: claimed.id,
      item: top,
    };
  });

  if (phaseA.kind === "counted") {
    counts[phaseA.outcome] += 1;
    return phaseA.done ? "done" : "continue";
  }
  if (phaseA.kind === "advance_only") {
    return phaseA.done ? "done" : "continue";
  }
  if (phaseA.kind === "done") return "done";

  // --- Fase B: materialisasi dari item + sasaran slot ---
  const { slot, firingAt, firingId, item } = phaseA;
  const actor: PostAuditActor = {
    actorType: "system",
    actorId: `post-queue:${slotId}`,
    meta: {
      postQueueSlotId: slotId,
      postQueueItemId: item.id,
      queueSlotAt: firingAt.toISOString(),
    },
  };
  const template: ResolvedPostTemplate = {
    title: item.title,
    caption: item.caption,
    mediaIds: (item.mediaIds as string[] | null) ?? [],
    targets: templateTargetsFromRecord(slot.targets),
  };
  let created: { postIds: string[]; groupId: string | null } | null = null;
  let failureReason: string | null = null;
  try {
    created = await materializePostTemplate(db, {
      tenantId,
      userId: slot.createdByUserId,
      auditActor: actor,
      template,
      scheduledAt: firingAt,
    });
  } catch (err) {
    if (err instanceof PostDomainError) {
      failureReason = err.code;
    } else {
      throw err;
    }
  }

  // --- Fase C (transaksi tenant): finalisasi + nasib item ---
  await withTenantDb(db, tenantId, async (tx) => {
    if (failureReason === null && created) {
      const finalized = await finalizeQueueFiring(tx, tenantId, firingId, {
        status: "pulled",
        reason: null,
        queueItemId: item.id,
        postGroupId: created.groupId,
        postIds: created.postIds,
      });
      if (!finalized) return; // diambil alih claim_stale selagi materialisasi
      // Item keluar dari antrean; riwayatnya tertaut ke postingan.
      await tx
        .update(postQueueItems)
        .set({
          status: "pulled",
          pulledAt: new Date(),
          pulledPostGroupId: created.groupId,
          pulledPostIds: created.postIds,
          reservedFiringId: null,
          reservedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(postQueueItems.id, item.id));
      await writeQueueFiringAudit(tx, tenantId, slot, firingAt, "pulled", null, item.id, created.postIds);
      counts.pulled += 1;
    } else {
      const reason = failureReason ?? "POST_TARGET_NOT_FOUND";
      const finalized = await finalizeQueueFiring(tx, tenantId, firingId, {
        status: "skipped",
        reason,
        queueItemId: item.id,
        postGroupId: null,
        postIds: [],
      });
      if (!finalized) return;
      // Kegagalan BUKAN konsumsi: reservasi lepas, item tetap
      // paling atas untuk slot berikutnya.
      await releaseQueueReservation(tx, firingId);
      await writeQueueFiringAudit(tx, tenantId, slot, firingAt, "skipped", reason, item.id, []);
      counts.skipped += 1;
    }
    await advanceQueueSlot(tx, slot, firingAt);
  });
  return "continue";
}

async function finalizeQueueFiring(
  tx: DbTx,
  tenantId: string,
  firingId: string,
  outcome: {
    status: "pulled" | "skipped" | "missed";
    reason: string | null;
    queueItemId: string | null;
    postGroupId: string | null;
    postIds: string[];
  },
): Promise<boolean> {
  const updated = await tx
    .update(postQueueSlotFirings)
    .set({
      status: outcome.status,
      reason: outcome.reason,
      queueItemId: outcome.queueItemId,
      postGroupId: outcome.postGroupId,
      postIds: outcome.postIds,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(postQueueSlotFirings.tenantId, tenantId),
        eq(postQueueSlotFirings.id, firingId),
        eq(postQueueSlotFirings.status, "claimed"),
      ),
    )
    .returning();
  return updated.length > 0;
}

/**
 * Lepas reservasi item milik satu tembakan — hanya bila item itu
 * belum tertaut ke postingan hasil (item yang sudah pulled tidak
 * pernah disentuh di sini).
 */
async function releaseQueueReservation(
  tx: DbTx,
  firingId: string,
): Promise<void> {
  await tx
    .update(postQueueItems)
    .set({ reservedFiringId: null, reservedAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(postQueueItems.reservedFiringId, firingId),
        eq(postQueueItems.status, "queued"),
      ),
    );
}

/** Majukan next_run_at slot sesudah tembakan `processedAt`. */
async function advanceQueueSlot(
  tx: DbTx,
  slot: PostQueueSlot,
  processedAt: Date,
): Promise<boolean> {
  const next = nextRecurrenceSlotAfter(patternOfSlot(slot), processedAt.getTime());
  if (!next) return false;
  await tx
    .update(postQueueSlots)
    .set({ nextRunAt: next, updatedAt: new Date() })
    .where(eq(postQueueSlots.id, slot.id));
  return true;
}

async function writeQueueFiringAudit(
  tx: DbTx,
  tenantId: string,
  slot: PostQueueSlot,
  firingAt: Date,
  status: "pulled" | "empty" | "skipped" | "missed",
  reason: string | null,
  queueItemId: string | null,
  postIds: string[],
): Promise<void> {
  await tx.insert(auditLogs).values({
    tenantId,
    actorType: "system",
    actorId: `post-queue:${slot.id}`,
    action:
      status === "pulled"
        ? "post_queue.firing_pulled"
        : status === "empty"
          ? "post_queue.firing_empty"
          : status === "missed"
            ? "post_queue.firing_missed"
            : "post_queue.firing_skipped",
    meta: {
      slotId: slot.id,
      slotAt: firingAt.toISOString(),
      ...(reason ? { reason } : {}),
      ...(queueItemId ? { queueItemId } : {}),
      ...(postIds.length > 0 ? { postIds } : {}),
    },
  });
}
