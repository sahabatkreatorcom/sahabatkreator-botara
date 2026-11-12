import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  auditLogs,
  channelAccounts,
  channelIdentities,
  comments,
  contactScanCandidates,
  contactScanRuns,
  contacts,
  outboxEvents,
  type ContactScanCandidate,
  type ContactScanRun,
  type Database,
} from "@sahabat-kreator/db";
import type { TenantContext } from "./tenant";
import { withTenantDb } from "./tx";

/**
 * PINDAI PELANGGAN OTOMATIS (Gelombang G18 butir 2).
 *
 * Sumber pindai: tabel `comments` (komentar Instagram/Messenger +
 * balasan Threads). Alasannya faktual dari model data repo: penulis
 * DM selalu menjadi kontak saat pesan pertamanya masuk — semua
 * ingest kanal membuat baris kontak + `channel_identities` — jadi
 * memindai percakapan tidak akan pernah menemukan orang baru.
 * Penulis komentar berbeda: `comments.contact_id` hanya terisi bila
 * aksi comment-to-DM pernah berjalan untuknya; selain itu ia ada di
 * data kanal (id + username + isi komentar) tanpa menjadi kontak.
 * Itulah populasi yang dipindai di sini.
 *
 * Alur: API membuat baris `contact_scan_runs` (queued) + event
 * outbox `contact_scan.requested` dalam satu transaksi → relay
 * worker menjadikannya job BullMQ → `executeContactScan` menghitung
 * kandidat → tenant MENINJAU kandidat → impor mengeksekusi kandidat
 * terpilih. Klasifikasi per kandidat:
 * - pending         : belum ada identitas/kontak — boleh diimpor.
 * - already_contact : identitas (akun, penulis) sudah tertaut ke
 *                     kontak — tercatat, tidak pernah diimpor.
 * - self_account    : penulis adalah akun kanal tenant itu sendiri
 *                     (author = channel_accounts.external_id) —
 *                     tercatat, tidak pernah diimpor (pelajaran
 *                     pemisahan akun-sendiri gelombang inbox/contacts).
 * - skipped_existing: saat impor, penulisnya ternyata sudah menjadi
 *                     kontak sejak pindai — dilewati, tidak diduplikat.
 * Impor membuat kontak + identitas kanal (agar DM berikutnya dari
 * orang yang sama teresolusi ke kontak ini) dan menautkan baris
 * komentarnya (comments.contact_id), memakai nama tampil yang sama
 * seperti resolusi comment-to-DM.
 */

export const CONTACT_SCAN_REQUESTED_OUTBOX_TYPE = "contact_scan.requested";

/** Batas baris komentar yang dibaca satu pindai (katup pengaman memori). */
export const SCAN_COMMENT_ROW_CAP = 50_000;

export type ContactScanStatus = "queued" | "running" | "completed" | "failed";
export type ContactScanCandidateStatus =
  | "pending"
  | "imported"
  | "already_contact"
  | "self_account"
  | "skipped_existing";

export interface ContactScanStats {
  commentsSeen: number;
  distinctAuthors: number;
  pending: number;
  alreadyContact: number;
  selfAccount: number;
}

const EMPTY_STATS: ContactScanStats = {
  commentsSeen: 0,
  distinctAuthors: 0,
  pending: 0,
  alreadyContact: 0,
  selfAccount: 0,
};

export function readScanStats(run: ContactScanRun): ContactScanStats {
  const raw = (run.stats ?? {}) as Partial<ContactScanStats>;
  return {
    commentsSeen: raw.commentsSeen ?? 0,
    distinctAuthors: raw.distinctAuthors ?? 0,
    pending: raw.pending ?? 0,
    alreadyContact: raw.alreadyContact ?? 0,
    selfAccount: raw.selfAccount ?? 0,
  };
}

/** Nama kontak dari label penulis komentar — aturan yang sama seperti resolusi comment-to-DM. */
export function commentAuthorDisplayName(
  provider: string,
  username: string | null,
): string {
  if (username) {
    return provider === "instagram" || provider === "threads"
      ? `@${username.replace(/^@/, "")}`
      : username;
  }
  if (provider === "instagram") return "Instagram user";
  if (provider === "threads") return "Threads user";
  return "Messenger user";
}

// ---------------------------------------------------------------------------
// Buat & baca pindai
// ---------------------------------------------------------------------------

export async function createContactScan(
  db: Database,
  ctx: Pick<TenantContext, "tenantId" | "userId">,
): Promise<ContactScanRun> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [run] = await tx
      .insert(contactScanRuns)
      .values({
        tenantId: ctx.tenantId,
        status: "queued",
        createdByUserId: ctx.userId,
      })
      .returning();
    await tx.insert(outboxEvents).values({
      tenantId: ctx.tenantId,
      type: CONTACT_SCAN_REQUESTED_OUTBOX_TYPE,
      payload: { scanRunId: run.id },
    });
    await tx.insert(auditLogs).values({
      tenantId: ctx.tenantId,
      actorType: "user",
      actorId: ctx.userId,
      action: "contact.scan_created",
      meta: { scanRunId: run.id },
    });
    return run;
  });
}

export async function listContactScans(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  limit = 20,
): Promise<ContactScanRun[]> {
  return withTenantDb(db, ctx.tenantId, async (tx) =>
    tx
      .select()
      .from(contactScanRuns)
      .where(eq(contactScanRuns.tenantId, ctx.tenantId))
      .orderBy(desc(contactScanRuns.createdAt))
      .limit(limit),
  );
}

/** Null bila pindai tidak ada di tenant ini (API menerjemahkan ke 404). */
export async function getContactScan(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  scanRunId: string,
): Promise<{ run: ContactScanRun; candidates: ContactScanCandidate[] } | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [run] = await tx
      .select()
      .from(contactScanRuns)
      .where(
        and(
          eq(contactScanRuns.tenantId, ctx.tenantId),
          eq(contactScanRuns.id, scanRunId),
        ),
      )
      .limit(1);
    if (!run) return null;
    const candidates = await tx
      .select()
      .from(contactScanCandidates)
      .where(
        and(
          eq(contactScanCandidates.tenantId, ctx.tenantId),
          eq(contactScanCandidates.scanRunId, scanRunId),
        ),
      )
      .orderBy(asc(contactScanCandidates.displayName));
    return { run, candidates };
  });
}

// ---------------------------------------------------------------------------
// Eksekusi pindai (worker)
// ---------------------------------------------------------------------------

export type ExecuteContactScanResult =
  | { kind: "completed"; stats: ContactScanStats }
  | { kind: "already_completed" }
  | { kind: "not_found" };

/**
 * Hitung kandidat satu pindai. Idempoten: pindai yang sudah selesai
 * tidak dihitung ulang (relay/job ganda aman); kandidat ditulis
 * dengan ON CONFLICT DO NOTHING pada unik (pindai, akun, penulis).
 * Kegagalan tak terduga menandai pindai 'failed' + pesan, lalu
 * DILEMPAR agar job BullMQ menerapkan percobaan ulangnya.
 */
export async function executeContactScan(
  db: Database,
  input: { tenantId: string; scanRunId: string },
): Promise<ExecuteContactScanResult> {
  try {
    return await withTenantDb(db, input.tenantId, async (tx) => {
      const [run] = await tx
        .select()
        .from(contactScanRuns)
        .where(
          and(
            eq(contactScanRuns.tenantId, input.tenantId),
            eq(contactScanRuns.id, input.scanRunId),
          ),
        )
        .limit(1);
      if (!run) return { kind: "not_found" as const };
      if (run.status === "completed") {
        return { kind: "already_completed" as const };
      }
      await tx
        .update(contactScanRuns)
        .set({ status: "running", updatedAt: new Date(), error: null })
        .where(eq(contactScanRuns.id, run.id));

      // Akun kanal tenant: untuk klasifikasi akun-sendiri + provider.
      const accounts = await tx
        .select({
          id: channelAccounts.id,
          externalId: channelAccounts.externalId,
          provider: channelAccounts.provider,
        })
        .from(channelAccounts)
        .where(eq(channelAccounts.tenantId, input.tenantId));
      const accountById = new Map(accounts.map((a) => [a.id, a]));

      // Semua komentar yang penulisnya belum tertaut kontak, terbaru
      // lebih dulu — kemunculan pertama per (akun, penulis) adalah
      // komentar terakhirnya (sumber label + contoh teks).
      const rows = await tx
        .select({
          channelAccountId: comments.channelAccountId,
          provider: comments.provider,
          authorExternalId: comments.authorExternalId,
          authorUsername: comments.authorUsername,
          text: comments.text,
          providerCreatedAt: comments.providerCreatedAt,
          createdAt: comments.createdAt,
        })
        .from(comments)
        .where(
          and(
            eq(comments.tenantId, input.tenantId),
            isNull(comments.contactId),
          ),
        )
        .orderBy(desc(comments.createdAt))
        .limit(SCAN_COMMENT_ROW_CAP);

      interface Aggregate {
        channelAccountId: string;
        provider: string;
        authorExternalId: string;
        username: string | null;
        commentCount: number;
        lastCommentAt: Date | null;
        sampleText: string;
      }
      const aggregates = new Map<string, Aggregate>();
      for (const row of rows) {
        const key = `${row.channelAccountId}:${row.authorExternalId}`;
        const existing = aggregates.get(key);
        if (existing) {
          existing.commentCount += 1;
          continue;
        }
        aggregates.set(key, {
          channelAccountId: row.channelAccountId,
          provider: row.provider,
          authorExternalId: row.authorExternalId,
          username: row.authorUsername,
          commentCount: 1,
          lastCommentAt: row.providerCreatedAt ?? row.createdAt,
          sampleText: row.text.slice(0, 280),
        });
      }

      // Identitas yang sudah ada untuk penulis-penulis ini.
      const authorIds = [...new Set(rows.map((r) => r.authorExternalId))];
      const identities =
        authorIds.length > 0
          ? await tx
              .select({
                channelAccountId: channelIdentities.channelAccountId,
                externalUserId: channelIdentities.externalUserId,
                contactId: channelIdentities.contactId,
              })
              .from(channelIdentities)
              .where(
                and(
                  eq(channelIdentities.tenantId, input.tenantId),
                  inArray(channelIdentities.externalUserId, authorIds),
                ),
              )
          : [];
      const identityByKey = new Map(
        identities.map((i) => [`${i.channelAccountId}:${i.externalUserId}`, i.contactId]),
      );

      const stats: ContactScanStats = {
        ...EMPTY_STATS,
        commentsSeen: rows.length,
        distinctAuthors: aggregates.size,
      };
      const now = new Date();
      for (const agg of aggregates.values()) {
        const account = accountById.get(agg.channelAccountId);
        let status: ContactScanCandidateStatus = "pending";
        let importedContactId: string | null = null;
        if (account && account.externalId === agg.authorExternalId) {
          status = "self_account";
          stats.selfAccount += 1;
        } else {
          const knownContactId = identityByKey.get(
            `${agg.channelAccountId}:${agg.authorExternalId}`,
          );
          if (knownContactId) {
            status = "already_contact";
            importedContactId = knownContactId;
            stats.alreadyContact += 1;
          } else {
            stats.pending += 1;
          }
        }
        await tx
          .insert(contactScanCandidates)
          .values({
            tenantId: input.tenantId,
            scanRunId: run.id,
            channelAccountId: agg.channelAccountId,
            provider: agg.provider,
            externalUserId: agg.authorExternalId,
            displayName: commentAuthorDisplayName(agg.provider, agg.username),
            username: agg.username,
            commentCount: agg.commentCount,
            lastCommentAt: agg.lastCommentAt,
            sampleText: agg.sampleText,
            status,
            importedContactId,
            updatedAt: now,
          })
          .onConflictDoNothing();
      }

      await tx
        .update(contactScanRuns)
        .set({
          status: "completed",
          stats: {
            commentsSeen: stats.commentsSeen,
            distinctAuthors: stats.distinctAuthors,
            pending: stats.pending,
            alreadyContact: stats.alreadyContact,
            selfAccount: stats.selfAccount,
          },
          completedAt: now,
          updatedAt: now,
          error: null,
        })
        .where(eq(contactScanRuns.id, run.id));
      return { kind: "completed" as const, stats };
    });
  } catch (err) {
    // Tandai gagal di transaksi terpisah (transaksi utama sudah
    // rollback), lalu lempar agar job bisa mencoba lagi.
    await withTenantDb(db, input.tenantId, async (tx) => {
      await tx
        .update(contactScanRuns)
        .set({
          status: "failed",
          error: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(contactScanRuns.tenantId, input.tenantId),
            eq(contactScanRuns.id, input.scanRunId),
          ),
        );
    }).catch(() => undefined);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Impor kandidat (sesudah tinjauan tenant)
// ---------------------------------------------------------------------------

export interface ImportContactScanResult {
  imported: number;
  skippedExisting: number;
  notPending: number;
}

/**
 * Impor kandidat pending terpilih (atau semua pending bila
 * `candidateIds` kosong). Setiap kandidat DITINJAU ULANG terhadap
 * identitas saat eksekusi: yang sudah menjadi kontak sejak pindai
 * dilewati sebagai skipped_existing — impor tidak pernah membuat
 * kontak ganda untuk identitas yang sama. Mengembalikan null bila
 * pindainya tidak ada di tenant ini.
 */
export async function importContactScanCandidates(
  db: Database,
  ctx: Pick<TenantContext, "tenantId" | "userId">,
  input: { scanRunId: string; candidateIds?: string[] },
): Promise<ImportContactScanResult | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [run] = await tx
      .select()
      .from(contactScanRuns)
      .where(
        and(
          eq(contactScanRuns.tenantId, ctx.tenantId),
          eq(contactScanRuns.id, input.scanRunId),
        ),
      )
      .limit(1);
    if (!run) return null;

    const requested = input.candidateIds ?? [];
    const candidates = await tx
      .select()
      .from(contactScanCandidates)
      .where(
        and(
          eq(contactScanCandidates.tenantId, ctx.tenantId),
          eq(contactScanCandidates.scanRunId, run.id),
          ...(requested.length > 0
            ? [inArray(contactScanCandidates.id, requested)]
            : []),
        ),
      );
    const pending = candidates.filter((k) => k.status === "pending");
    const notPending =
      requested.length > 0
        ? requested.length - pending.length
        : candidates.length - pending.length;

    let imported = 0;
    let skippedExisting = 0;
    const now = new Date();
    for (const candidate of pending) {
      const [identity] = await tx
        .select({ contactId: channelIdentities.contactId })
        .from(channelIdentities)
        .where(
          and(
            eq(channelIdentities.channelAccountId, candidate.channelAccountId),
            eq(channelIdentities.externalUserId, candidate.externalUserId),
          ),
        )
        .limit(1);
      if (identity) {
        await tx
          .update(contactScanCandidates)
          .set({
            status: "skipped_existing",
            importedContactId: identity.contactId,
            updatedAt: now,
          })
          .where(eq(contactScanCandidates.id, candidate.id));
        skippedExisting += 1;
        continue;
      }
      const [contact] = await tx
        .insert(contacts)
        .values({
          tenantId: ctx.tenantId,
          name:
            candidate.displayName ??
            commentAuthorDisplayName(candidate.provider, candidate.username),
          source: "scan:comments",
        })
        .returning();
      await tx.insert(channelIdentities).values({
        tenantId: ctx.tenantId,
        contactId: contact.id,
        channelAccountId: candidate.channelAccountId,
        provider: candidate.provider as typeof channelIdentities.$inferInsert.provider,
        externalUserId: candidate.externalUserId,
        username: candidate.username,
      });
      // Tautkan riwayat komentar penulis ini ke kontak barunya.
      await tx
        .update(comments)
        .set({ contactId: contact.id })
        .where(
          and(
            eq(comments.tenantId, ctx.tenantId),
            eq(comments.channelAccountId, candidate.channelAccountId),
            eq(comments.authorExternalId, candidate.externalUserId),
            isNull(comments.contactId),
          ),
        );
      await tx
        .update(contactScanCandidates)
        .set({ status: "imported", importedContactId: contact.id, updatedAt: now })
        .where(eq(contactScanCandidates.id, candidate.id));
      imported += 1;
    }

    if (imported > 0 || skippedExisting > 0) {
      await tx.insert(auditLogs).values({
        tenantId: ctx.tenantId,
        actorType: "user",
        actorId: ctx.userId,
        action: "contact.scan_imported",
        meta: { scanRunId: run.id, imported, skippedExisting },
      });
    }
    return { imported, skippedExisting, notPending };
  });
}
