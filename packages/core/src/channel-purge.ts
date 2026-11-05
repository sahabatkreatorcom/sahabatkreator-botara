import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import {
  agentSuggestions,
  auditLogs,
  automationRuns,
  channelAccounts,
  channelIdentities,
  conversations,
  media,
  messages,
  outboxEvents,
  profilePhotos,
  sequenceEnrollments,
  type Database,
} from "@sahabat-kreator/db";
import { CHANNEL_TRASH_GRACE_DAYS } from "./channels";
import { withTenantDb } from "./tx";

/**
 * Purge permanen channel Sampah (Fase 6I — hapus permanen BERPENJAGA).
 *
 * Setelah masa tenggang (CHANNEL_TRASH_GRACE_DAYS sejak `trashed_at`),
 * worker menghapus akun channel beserta seluruh jejak operasionalnya:
 * pesan, media yang hanya dirujuk pesan-pesan itu, percakapan, identitas
 * channel, dan baris akunnya. Peta FK & keputusan per tabel (skema db):
 *
 * - messages            → DIHAPUS eksplisit (FK conversation CASCADE
 *                         sebenarnya cukup; eksplisit agar hitungan audit
 *                         akurat dan media bisa dibersihkan sesudahnya).
 * - media               → baris yang dirujuk pesan yang dihapus DAN tidak
 *                         lagi dirujuk pesan mana pun DIHAPUS. Objek R2
 *                         belum ditulis pipeline media mana pun di fase
 *                         ini, jadi belum ada objek fisik untuk dihapus;
 *                         saat pipeline media tiba, hapus objeknya di sini.
 * - conversations       → DIHAPUS; FK CASCADE membawa serta:
 * - automation_runs     → ikut terhapus (conversation_id CASCADE),
 * - sequence_enrollments→ ikut terhapus (conversation_id CASCADE) — job
 *                         BullMQ tertunda yang menunjuk enrollment hilang
 *                         akan menemukan datanya tidak ada & berhenti wajar,
 * - agent_suggestions   → ikut terhapus (conversation_id CASCADE).
 * - channel_identities  → DIHAPUS eksplisit (FK account CASCADE juga ada).
 * - outbox_events       → event yang BELUM ter-publish dan menunjuk
 *                         percakapan yang dihapus DIHAPUS (tidak akan
 *                         pernah bisa diproses secara bermakna); event
 *                         yang sudah ter-publish DIPERTAHANKAN sebagai
 *                         catatan sejarah, sama seperti audit.
 * - audit_logs          → TIDAK PERNAH dihapus (append-only); purge
 *                         justru MENULIS `channel.purged` dengan hitungan.
 * - profile_photos      → foto milik AKUN channel ini (Fase 6D,
 *                         owner_type='channel_account') DIHAPUS —
 *                         owner_id polimorfik tanpa FK, jadi dibersihkan
 *                         eksplisit di sini. Foto KONTAK tidak disentuh:
 *                         kontaknya sendiri dipertahankan (lihat bawah).
 * - contacts            → TIDAK dihapus: kontak adalah data CRM tenant
 *                         lintas channel.
 * - usage_ledger        → TIDAK dihapus (append-only, dasar billing);
 *   ref_id-nya varchar tanpa FK, jadi tidak menghalangi penghapusan.
 * - webhook_inbox       → TIDAK disentuh: dedup provider tingkat tenant,
 *   tanpa FK ke akun channel.
 *
 * Pemindaian lintas tenant memakai lengan RLS `system_purge_scan`
 * (migrasi 0023): flag transaksi `app.system_relay='channel_purge'`
 * hanya membuka baris yang sudah di Sampah. Penghapusan per akun tetap
 * berjalan di konteks tenant pemiliknya (satu transaksi per akun —
 * kegagalan satu akun tidak menggagalkan akun lain).
 */

export interface ExpiredTrashedChannelRef {
  channelAccountId: string;
  tenantId: string;
  trashedAt: Date;
}

/** Batas kedaluwarsa Sampah untuk sebuah waktu acuan. */
export function trashExpiryCutoff(now: Date): Date {
  return new Date(now.getTime() - CHANNEL_TRASH_GRACE_DAYS * 24 * 3600 * 1000);
}

/**
 * Memindai akun Sampah yang masa tenggangnya sudah lewat, dari SEMUA
 * tenant. Hanya id/tenant/trashedAt yang dibaca — cukup untuk menjadwalkan
 * purge per akun.
 */
export async function findExpiredTrashedChannelAccounts(
  db: Database,
  now: Date = new Date(),
  limit = 50,
): Promise<ExpiredTrashedChannelRef[]> {
  const cutoff = trashExpiryCutoff(now);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.system_relay', 'channel_purge', true)`);
    const rows = await tx
      .select({
        id: channelAccounts.id,
        tenantId: channelAccounts.tenantId,
        trashedAt: channelAccounts.trashedAt,
      })
      .from(channelAccounts)
      .where(lt(channelAccounts.trashedAt, cutoff))
      .limit(limit);
    return rows
      .filter((r) => r.trashedAt !== null)
      .map((r) => ({
        channelAccountId: r.id,
        tenantId: r.tenantId,
        trashedAt: r.trashedAt as Date,
      }));
  });
}

export interface ChannelPurgeCounts {
  conversations: number;
  messages: number;
  media: number;
  channelIdentities: number;
  automationRuns: number;
  sequenceEnrollments: number;
  agentSuggestions: number;
  outboxEventsRemoved: number;
  /** Foto profil milik akun channel (Fase 6D); foto kontak tidak dihitung. */
  profilePhotos: number;
}

/**
 * Menghapus permanen SATU akun Sampah yang sudah kedaluwarsa, dalam
 * konteks tenant pemiliknya, satu transaksi. Mengembalikan hitungan yang
 * terhapus, atau null bila akun tidak ditemukan / tidak lagi di Sampah /
 * belum kedaluwarsa (mis. dipulihkan di antara pindai & purge).
 */
export async function purgeTrashedChannelAccount(
  db: Database,
  ref: ExpiredTrashedChannelRef,
  now: Date = new Date(),
): Promise<ChannelPurgeCounts | null> {
  const cutoff = trashExpiryCutoff(now);
  return withTenantDb(db, ref.tenantId, async (tx) => {
    const [account] = await tx
      .select()
      .from(channelAccounts)
      .where(
        and(
          eq(channelAccounts.tenantId, ref.tenantId),
          eq(channelAccounts.id, ref.channelAccountId),
        ),
      )
      .limit(1);
    if (!account || !account.trashedAt || account.trashedAt >= cutoff) {
      return null;
    }

    const convRows = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.tenantId, ref.tenantId),
          eq(conversations.channelAccountId, account.id),
        ),
      );
    const convIds = convRows.map((r) => r.id);

    const counts: ChannelPurgeCounts = {
      conversations: convIds.length,
      messages: 0,
      media: 0,
      channelIdentities: 0,
      automationRuns: 0,
      sequenceEnrollments: 0,
      agentSuggestions: 0,
      outboxEventsRemoved: 0,
      profilePhotos: 0,
    };

    if (convIds.length > 0) {
      const countOf = async (
        table:
          | typeof messages
          | typeof automationRuns
          | typeof sequenceEnrollments
          | typeof agentSuggestions,
      ): Promise<number> => {
        const [row] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(table)
          .where(
            and(
              eq(table.tenantId, ref.tenantId),
              inArray(table.conversationId, convIds),
            ),
          );
        return row?.n ?? 0;
      };
      counts.messages = await countOf(messages);
      counts.automationRuns = await countOf(automationRuns);
      counts.sequenceEnrollments = await countOf(sequenceEnrollments);
      counts.agentSuggestions = await countOf(agentSuggestions);

      // Media yang dirujuk pesan-pesan ini — kandidat dibersihkan
      // setelah pesannya hilang (baris media dipakai bersama antar
      // percakapan hanya dibuang bila tak ada rujukan tersisa).
      const mediaRows = await tx
        .selectDistinct({ mediaId: messages.mediaId })
        .from(messages)
        .where(
          and(
            eq(messages.tenantId, ref.tenantId),
            inArray(messages.conversationId, convIds),
          ),
        );
      const mediaIds = mediaRows
        .map((r) => r.mediaId)
        .filter((v): v is string => v !== null);

      // Event outbox yang belum ter-publish untuk percakapan ini tidak
      // akan pernah bisa diproses lagi — buang; yang sudah ter-publish
      // dipertahankan sebagai sejarah.
      const removedEvents = await tx
        .delete(outboxEvents)
        .where(
          and(
            eq(outboxEvents.tenantId, ref.tenantId),
            isNull(outboxEvents.publishedAt),
            sql`${outboxEvents.payload} ->> 'conversationId' IN (${sql.join(
              convIds.map((id) => sql`${id}`),
              sql`, `,
            )})`,
          ),
        )
        .returning({ id: outboxEvents.id });
      counts.outboxEventsRemoved = removedEvents.length;

      await tx
        .delete(messages)
        .where(
          and(
            eq(messages.tenantId, ref.tenantId),
            inArray(messages.conversationId, convIds),
          ),
        );

      if (mediaIds.length > 0) {
        const removedMedia = await tx
          .delete(media)
          .where(
            and(
              eq(media.tenantId, ref.tenantId),
              inArray(media.id, mediaIds),
              sql`NOT EXISTS (SELECT 1 FROM messages WHERE messages.media_id = ${media.id})`,
            ),
          )
          .returning({ id: media.id });
        counts.media = removedMedia.length;
      }

      // CASCADE membawa automation_runs, sequence_enrollments, dan
      // agent_suggestions milik percakapan-percakapan ini.
      await tx
        .delete(conversations)
        .where(
          and(
            eq(conversations.tenantId, ref.tenantId),
            inArray(conversations.id, convIds),
          ),
        );
    }

    const removedIdentities = await tx
      .delete(channelIdentities)
      .where(
        and(
          eq(channelIdentities.tenantId, ref.tenantId),
          eq(channelIdentities.channelAccountId, account.id),
        ),
      )
      .returning({ id: channelIdentities.id });
    counts.channelIdentities = removedIdentities.length;

    // Foto profil akun channel (Fase 6D): owner_id polimorfik tanpa FK —
    // tanpa penghapusan eksplisit ini baris fotonya yatim selamanya.
    const removedPhotos = await tx
      .delete(profilePhotos)
      .where(
        and(
          eq(profilePhotos.tenantId, ref.tenantId),
          eq(profilePhotos.ownerType, "channel_account"),
          eq(profilePhotos.ownerId, account.id),
        ),
      )
      .returning({ id: profilePhotos.id });
    counts.profilePhotos = removedPhotos.length;

    await tx
      .delete(channelAccounts)
      .where(
        and(
          eq(channelAccounts.tenantId, ref.tenantId),
          eq(channelAccounts.id, account.id),
        ),
      );

    await tx.insert(auditLogs).values({
      tenantId: ref.tenantId,
      actorType: "system",
      actorId: "channel-purge",
      action: "channel.purged",
      meta: {
        channelAccountId: account.id,
        provider: account.provider,
        externalId: account.externalId,
        trashedAt: account.trashedAt.toISOString(),
        counts,
      },
    });

    return counts;
  });
}

export interface ChannelPurgeRunResult {
  scanned: number;
  purged: Array<{
    channelAccountId: string;
    tenantId: string;
    counts: ChannelPurgeCounts;
  }>;
  failed: Array<{ channelAccountId: string; tenantId: string; error: string }>;
}

/**
 * Satu putaran purge: pindai akun Sampah kedaluwarsa lalu hapus satu per
 * satu. Kegagalan satu akun dicatat dan TIDAK menghentikan akun lain;
 * akun yang ternyata sudah dipulihkan/diubah di tengah jalan dilewati
 * diam-diam (purge mengembalikan null).
 */
export async function purgeExpiredTrashedChannels(
  db: Database,
  opts: { now?: Date; limit?: number } = {},
): Promise<ChannelPurgeRunResult> {
  const now = opts.now ?? new Date();
  const refs = await findExpiredTrashedChannelAccounts(db, now, opts.limit ?? 50);
  const result: ChannelPurgeRunResult = {
    scanned: refs.length,
    purged: [],
    failed: [],
  };
  for (const ref of refs) {
    try {
      const counts = await purgeTrashedChannelAccount(db, ref, now);
      if (counts) {
        result.purged.push({
          channelAccountId: ref.channelAccountId,
          tenantId: ref.tenantId,
          counts,
        });
      }
    } catch (err) {
      result.failed.push({
        channelAccountId: ref.channelAccountId,
        tenantId: ref.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}
