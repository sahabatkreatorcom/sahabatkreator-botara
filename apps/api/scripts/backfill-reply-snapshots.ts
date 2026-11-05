/**
 * Run-once backfill snapshot kutipan cadangan (Hotfix 7B.6): mengisi
 * `messages.reply_to_snapshot` untuk pesan Telegram yang SUDAH tercatat
 * sebelum 7B.6 — dari payload webhook mentah yang tersimpan di
 * `integration_log` (retensi 30 hari). Pesan yang dikutipnya tidak
 * tertaut (`reply_to_message_id` NULL — mis. target pra-6A.2 tanpa
 * provider_message_id) kini tetap menampilkan isi kutipannya.
 *
 * Aturan ketat (idempoten, aman dijalankan berulang):
 * - hanya baris log telegram arah 'in' berpayload LENGKAP (bukan
 *   penanda truncated ±32KB) yang payload-nya memuat `reply_to_message`;
 * - baris pesan dicocokkan PERSIS lewat provider_message_id majemuk
 *   `telegram:<botId>:<message_id>` (botId = external_id akun pada
 *   baris log) DAN tenant baris pesan harus sama dengan tenant log;
 * - hanya baris dengan `reply_to_message_id` NULL dan
 *   `reply_to_snapshot` NULL yang diisi — tautan yang sudah ada tidak
 *   pernah ditimpa, snapshot yang sudah terisi tidak ditulis ulang;
 * - snapshot dibangun parser channel-telegram yang sama dengan jalur
 *   ingest live (satu sumber semantik label penulis & cuplikan).
 *
 * Koneksi: skrip ini membaca log lintas tenant, sedangkan RLS
 * `integration_log` memang tidak punya lengan baca lintas tenant —
 * jalankan dengan `MIGRATION_DATABASE_URL` (role migrasi, pemilik
 * data; pola yang sama seperti perbaikan data manual fase-fase
 * sebelumnya). Dengan `DATABASE_URL` biasa (sk_app) skrip hanya akan
 * melaporkan 0 baris kandidat.
 *
 * Jalankan dari server staging (env dari .env.staging):
 *   set -a; . ./.env.staging; set +a
 *   pnpm --filter @sahabat-kreator/api backfill:reply-snapshots
 */
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import {
  createDb,
  channelAccounts,
  integrationLog,
  messages,
} from "@sahabat-kreator/db";
import { isIntegrationLogPayloadTruncated } from "@sahabat-kreator/core";
import {
  parseTelegramChannelPost,
  parseTelegramUpdate,
  type ReplyToSnapshot,
  type TelegramUpdate,
} from "@sahabat-kreator/channel-telegram";

const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    "[backfill:reply-snapshots] MIGRATION_DATABASE_URL (atau DATABASE_URL) wajib diisi",
  );
}
const { db, pool } = createDb(url, { applicationName: "sk-script" });

try {
  const logRows = await db
    .select({
      id: integrationLog.id,
      tenantId: integrationLog.tenantId,
      channelAccountId: integrationLog.channelAccountId,
      payload: integrationLog.payload,
    })
    .from(integrationLog)
    .where(
      and(
        eq(integrationLog.provider, "telegram"),
        eq(integrationLog.direction, "in"),
        isNotNull(integrationLog.payload),
        isNotNull(integrationLog.tenantId),
        isNotNull(integrationLog.channelAccountId),
      ),
    );

  const botExternalIdByAccount = new Map<string, string>();
  const botExternalIdOf = async (
    channelAccountId: string,
  ): Promise<string | null> => {
    const cached = botExternalIdByAccount.get(channelAccountId);
    if (cached !== undefined) return cached;
    const [account] = await db
      .select({ externalId: channelAccounts.externalId })
      .from(channelAccounts)
      .where(eq(channelAccounts.id, channelAccountId))
      .limit(1);
    const externalId = account?.externalId ?? null;
    if (externalId !== null) {
      botExternalIdByAccount.set(channelAccountId, externalId);
    }
    return externalId;
  };

  let withQuote = 0;
  let filled = 0;
  let alreadyLinked = 0;
  let alreadyFilled = 0;
  let unmatched = 0;
  let tenantMismatch = 0;

  for (const row of logRows) {
    if (isIntegrationLogPayloadTruncated(row.payload)) continue;
    const payload = row.payload as TelegramUpdate;

    // Ekstrak snapshot + message_id mentah lewat parser yang sama
    // dengan ingest live; payload tanpa reply_to_message dilewati.
    let snapshot: ReplyToSnapshot | null = null;
    let rawMessageId: number | null = null;
    if (payload?.channel_post) {
      const post = parseTelegramChannelPost(payload);
      if (post?.replyToProviderMessageId && post.replyToSnapshot) {
        snapshot = post.replyToSnapshot;
        rawMessageId =
          typeof payload.channel_post.message_id === "number"
            ? payload.channel_post.message_id
            : null;
      }
    } else if (payload?.message) {
      const [event] = parseTelegramUpdate(payload);
      if (event?.message?.replyToProviderMessageId && event.message.replyToSnapshot) {
        snapshot = event.message.replyToSnapshot;
        rawMessageId =
          typeof payload.message.message_id === "number"
            ? payload.message.message_id
            : null;
      }
    }
    if (!snapshot || rawMessageId === null) continue;
    // Snapshot kedua bidangnya kosong (payload minimal hanya membawa
    // id kutipan) disetarakan tidak ada snapshot — cermin
    // normalizeReplyToSnapshot di core jalur ingest.
    if (snapshot.authorLabel === null && snapshot.contentPreview === null) {
      continue;
    }
    withQuote += 1;

    const botExternalId = await botExternalIdOf(row.channelAccountId!);
    if (!botExternalId) {
      unmatched += 1;
      continue;
    }
    const composite = `telegram:${botExternalId}:${rawMessageId}`;
    const [message] = await db
      .select({
        id: messages.id,
        tenantId: messages.tenantId,
        replyToMessageId: messages.replyToMessageId,
        replyToSnapshot: messages.replyToSnapshot,
      })
      .from(messages)
      .where(eq(messages.providerMessageId, composite))
      .limit(1);
    if (!message) {
      unmatched += 1;
      continue;
    }
    if (message.tenantId !== row.tenantId) {
      tenantMismatch += 1;
      continue;
    }
    if (message.replyToMessageId !== null) {
      alreadyLinked += 1;
      continue;
    }
    if (message.replyToSnapshot !== null) {
      alreadyFilled += 1;
      continue;
    }
    // Guard ganda pada UPDATE: hanya baris yang snapshot-nya masih
    // NULL yang berubah (balapan dengan ingest/backfill lain aman).
    const updated = await db
      .update(messages)
      .set({ replyToSnapshot: snapshot })
      .where(and(eq(messages.id, message.id), isNull(messages.replyToSnapshot)))
      .returning({ id: messages.id });
    if (updated.length > 0) filled += 1;
  }

  console.log(
    `[backfill:reply-snapshots] baris log telegram masuk terpindai: ${logRows.length}; ` +
      `memuat kutipan: ${withQuote}; terisi snapshot: ${filled}; ` +
      `sudah tertaut: ${alreadyLinked}; sudah terisi: ${alreadyFilled}; ` +
      `tanpa baris pesan: ${unmatched}; tenant tak cocok: ${tenantMismatch}`,
  );
} finally {
  await pool.end();
}
