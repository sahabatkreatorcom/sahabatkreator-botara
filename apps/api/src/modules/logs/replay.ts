import {
  recordIntegrationLog,
  recordIntegrationReplayAudit,
  recordPlatformIntegrationReplayAudit,
  resolveTelegramAccountById,
  type IntegrationLogInboundOutcome,
  type RecordIntegrationLogInput,
} from "@sahabat-kreator/core";
import type { IntegrationLogRow } from "@sahabat-kreator/db";
import type { RealtimePublisher } from "@sahabat-kreator/queue";
import type { AuthBundle } from "../../auth";
import { processMetaWebhookPayload } from "../meta/process";
import { processTelegramUpdate } from "../telegram/process";

/**
 * Mesin replay log integrasi (Fase 7B.2): memproses ulang payload SATU
 * baris log arah masuk yang eligible (kelayakan dinilai pemanggil lewat
 * core `evaluateIntegrationLogReplayEligibility`) melalui jalur
 * pemrosesan webhook LIVE yang sama — `processTelegramUpdate` /
 * `processMetaWebhookPayload` hasil ekstraksi route. Replay TIDAK
 * memverifikasi ulang tanda tangan: baris sumber hanya eligible bila
 * `signature_valid === true` saat intake, dan payload-nya adalah
 * payload yang sama yang lolos verifikasi itu.
 *
 * Keamanan & ketertelusuran:
 * - Telegram: akun ditargetkan dari `channel_account_id` baris sumber
 *   dan WAJIB milik tenant baris sumber yang sama; akun hilang/pindah
 *   tenant → `account_unavailable` (422 di route).
 * - Meta: payload satu hit bisa memuat event banyak tenant → prosesor
 *   dijalankan dengan `tenantScopeId` = tenant baris sumber; event
 *   tenant lain dilewati senyap di dalam prosesor.
 * - Baris sumber TIDAK pernah diubah (append-only). Setiap baris baru
 *   yang ditulis replay membawa provenance `· replay of log <id8>` di
 *   summary-nya, dan aksi operator ditulis ke audit `integration.replay`
 *   (id sumber + outcome hasil) oleh core.
 * - Idempotensi: pencatatan pesan provider ter-dedup pada
 *   `provider_message_id` di core — replay event yang ternyata sudah
 *   tercatat menghasilkan outcome `duplicate` tanpa pesan ganda, tanpa
 *   outbox/automation/agent ganda.
 */
export interface ReplayServiceDeps {
  bundle: AuthBundle;
  publisher: RealtimePublisher | null;
  /** Material kunci enkripsi kredensial channel (env CHANNEL_TOKEN_SECRET). */
  channelTokenSecret?: string;
  /** Base URL Bot API (env TELEGRAM_API_BASE). */
  telegramApiBase?: string;
  /** Base URL Graph API (env META_API_BASE). */
  metaApiBase?: string;
  /** Versi Graph ter-pin (dari @sahabat-kreator/config). */
  graphApiVersion: string;
}

export type ReplayRunResult =
  | { kind: "done"; outcomes: IntegrationLogInboundOutcome[] }
  | { kind: "account_unavailable" };

export async function runIntegrationLogReplay(
  deps: ReplayServiceDeps,
  row: IntegrationLogRow,
  userId: string,
): Promise<ReplayRunResult> {
  const { bundle } = deps;
  // tenantId baris sumber selalu ada: route memuat baris lewat konteks
  // tenant (baris tenant-NULL tidak terjangkau endpoint ini).
  const tenantId = row.tenantId as string;

  // Sink pencatatan replay: mengumpulkan outcome tiap baris baru +
  // menempelkan provenance ke summary sebelum meneruskan ke penulis
  // log bersama (best-effort, tidak pernah melempar — pola route).
  const outcomes: IntegrationLogInboundOutcome[] = [];
  const provenance = ` · replay of log ${row.id.slice(0, 8)}`;
  const log = async (entry: RecordIntegrationLogInput): Promise<void> => {
    outcomes.push(entry.outcome as IntegrationLogInboundOutcome);
    try {
      await recordIntegrationLog(bundle.db, {
        ...entry,
        summary: entry.summary
          ? `${entry.summary}${provenance}`
          : `replay of log ${row.id.slice(0, 8)}`,
      });
    } catch {
      // Sengaja ditelan: log tidak boleh menjatuhkan pemrosesan.
    }
  };

  try {
    if (row.provider === "telegram") {
      if (!row.channelAccountId) return { kind: "account_unavailable" };
      const account = await resolveTelegramAccountById(
        bundle.db,
        row.channelAccountId,
      );
      if (!account || account.tenantId !== tenantId) {
        return { kind: "account_unavailable" };
      }
      await processTelegramUpdate(
        {
          db: bundle.db,
          publisher: deps.publisher,
          channelTokenSecret: deps.channelTokenSecret,
          telegramApiBase: deps.telegramApiBase,
          log,
        },
        account,
        row.payload,
      );
    } else {
      // messenger / instagram / whatsapp (dan 'meta' agregat, yang
      // secara kelayakan tidak akan sampai sini): dispatch di dalam
      // prosesor mengikuti bentuk payload, di-scope ke tenant sumber.
      await processMetaWebhookPayload(
        {
          db: bundle.db,
          publisher: deps.publisher,
          channelTokenSecret: deps.channelTokenSecret,
          metaApiBase: deps.metaApiBase,
          graphApiVersion: deps.graphApiVersion,
          log,
          tenantScopeId: tenantId,
        },
        row.payload,
      );
    }
  } catch (err) {
    // Prosesor mencatat baris `error` untuk event yang gagal SEBELUM
    // melempar (perilaku route live) — baris itu sudah melewati sink
    // di atas, jadi `outcomes` tetap akurat. Replay-nya sendiri
    // dianggap sudah berjalan; hasil error dilaporkan apa adanya.
    console.error(
      `[logs] replay baris ${row.id} berakhir dengan error pemrosesan`,
      err,
    );
    if (outcomes.length === 0) outcomes.push("error");
  }

  try {
    await recordIntegrationReplayAudit(bundle.db, {
      tenantId,
      userId,
      sourceLogId: row.id,
      provider: row.provider,
      outcomes,
    });
  } catch (err) {
    // Audit gagal tidak membatalkan replay yang sudah terjadi;
    // kegagalannya terlihat di log server, bukan ditelan senyap.
    console.error(`[logs] gagal menulis audit replay baris ${row.id}`, err);
  }

  return { kind: "done", outcomes };
}

/**
 * Replay PLATFORM atas baris tenant-NULL (Fase 13A — sisa 7B.2 yang
 * tidak terjangkau endpoint tenant di atas): baris sumber lahir tanpa
 * tenant (event gagal SEBELUM atribusi tenant — mis. error pemrosesan
 * payload Meta agregat), jadi replay-nya meniru jalur webhook LIVE
 * tanpa konteks tenant:
 * - Telegram: akun ditargetkan dari `channel_account_id` baris sumber
 *   lewat lengan resolusi sempit yang sama; tenant efektif adalah
 *   tenant AKUN itu (bukan dari baris). Tanpa id akun / akun hilang →
 *   `account_unavailable` (422 di route).
 * - Meta: prosesor dijalankan TANPA `tenantScopeId` — persis webhook
 *   live: tiap event men-resolve akunnya sendiri lewat lengan
 *   provider_external_lookup; event yang akunnya kini ada terproses ke
 *   tenant pemiliknya, sisanya tercatat lagi sebagai baris baru.
 * Auditnya baris PLATFORM (`integration.replay`, tenant NULL,
 * meta.platform) lewat core — termasuk daftar tenant yang akhirnya
 * ter-resolve dari baris-baris baru yang ditulis replay. Baris sumber
 * tetap append-only seperti jalur tenant.
 */
export async function runPlatformIntegrationLogReplay(
  deps: ReplayServiceDeps,
  row: IntegrationLogRow,
  userId: string,
): Promise<ReplayRunResult> {
  const { bundle } = deps;

  const outcomes: IntegrationLogInboundOutcome[] = [];
  const resolvedTenantIds = new Set<string>();
  const provenance = ` · replay of log ${row.id.slice(0, 8)}`;
  const log = async (entry: RecordIntegrationLogInput): Promise<void> => {
    outcomes.push(entry.outcome as IntegrationLogInboundOutcome);
    if (entry.tenantId) resolvedTenantIds.add(entry.tenantId);
    try {
      await recordIntegrationLog(bundle.db, {
        ...entry,
        summary: entry.summary
          ? `${entry.summary}${provenance}`
          : `replay of log ${row.id.slice(0, 8)}`,
      });
    } catch {
      // Sengaja ditelan: log tidak boleh menjatuhkan pemrosesan.
    }
  };

  try {
    if (row.provider === "telegram") {
      if (!row.channelAccountId) return { kind: "account_unavailable" };
      const account = await resolveTelegramAccountById(
        bundle.db,
        row.channelAccountId,
      );
      if (!account) return { kind: "account_unavailable" };
      resolvedTenantIds.add(account.tenantId);
      await processTelegramUpdate(
        {
          db: bundle.db,
          publisher: deps.publisher,
          channelTokenSecret: deps.channelTokenSecret,
          telegramApiBase: deps.telegramApiBase,
          log,
        },
        account,
        row.payload,
      );
    } else {
      // TANPA tenantScopeId — semantik webhook live (lihat docstring).
      await processMetaWebhookPayload(
        {
          db: bundle.db,
          publisher: deps.publisher,
          channelTokenSecret: deps.channelTokenSecret,
          metaApiBase: deps.metaApiBase,
          graphApiVersion: deps.graphApiVersion,
          log,
        },
        row.payload,
      );
    }
  } catch (err) {
    // Sama seperti jalur tenant: prosesor mencatat baris `error`
    // sebelum melempar; outcome itu sudah melewati sink di atas.
    console.error(
      `[logs] replay platform baris ${row.id} berakhir dengan error pemrosesan`,
      err,
    );
    if (outcomes.length === 0) outcomes.push("error");
  }

  try {
    await recordPlatformIntegrationReplayAudit(bundle.db, {
      userId,
      sourceLogId: row.id,
      provider: row.provider,
      outcomes,
      resolvedTenantIds: [...resolvedTenantIds],
    });
  } catch (err) {
    console.error(
      `[logs] gagal menulis audit replay platform baris ${row.id}`,
      err,
    );
  }

  return { kind: "done", outcomes };
}
