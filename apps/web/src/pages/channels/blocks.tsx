/**
 * Blok tampilan yang sudah berdiri sendiri di halaman Channels: langkah
 * OAuth Meta, pill status, blok kesehatan channel, dan info webhook Meta.
 *
 * Semua sudah berupa komponen dengan props eksplisit — tidak ada yang
 * membaca closure halaman — sehingga pemindahannya murni relokasi.
 */
import type {
  ChannelAccountResponse,
  MetaOAuthProvider,
  MetaWebhookInfoResponse,
  ThreadsOAuthInfoResponse,
} from "@sahabat-kreator/contracts";
import type { Locale, TranslationKey } from "@sahabat-kreator/i18n";
import { FieldError } from "../../components/AuthLayout";
import { formatDateTime, formatRelativeTime } from "../../utils/format";
import type { Translate } from "./helpers";
import { CheckIcon, CopyIcon, FacebookIcon } from "./icons";

/**
 * Blok OAuth Meta di langkah form modal (Fase 7D): tombol primer
 * "Lanjutkan dengan Facebook" bila provider itu tersedia (App ID +
 * App Secret + config ID terisi di Panel Admin), selain itu tombol
 * nonaktif + petunjuk. Untuk Instagram ditambah blok prasyarat Unified
 * Login (akun Professional + Portofolio Bisnis Meta) agar kreator tidak
 * mentok di dialog Meta tanpa penjelasan.
 */
export function MetaOAuthStepBlock({
  t,
  provider,
  available,
  starting,
  startError,
  onStart,
}: {
  t: Translate;
  provider: MetaOAuthProvider;
  available: boolean;
  starting: boolean;
  startError: string | null;
  onStart: (provider: MetaOAuthProvider) => void;
}) {
  return (
    <div className="mt-4">
      {provider === "instagram" ? (
        <div className="rounded-lg border border-line bg-elevated/40 p-3">
          <div className="text-sm font-semibold">
            {t("channels.oauthIgPrereqTitle")}
          </div>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted">
            <li>{t("channels.oauthIgPrereqProfessional")}</li>
            <li>{t("channels.oauthIgPrereqPortfolio")}</li>
            <li>{t("channels.oauthIgPrereqLogin")}</li>
          </ul>
        </div>
      ) : null}
      <button
        type="button"
        disabled={!available || starting}
        onClick={() => onStart(provider)}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
        style={{ backgroundColor: "#1877F2" }}
      >
        <FacebookIcon />
        {starting
          ? t("channels.oauthStarting")
          : t("channels.oauthContinueFacebook")}
      </button>
      {!available ? (
        <p className="mt-2 text-xs text-muted">
          {t("channels.oauthNotConfigured")}
        </p>
      ) : null}
      {startError ? (
        <div className="mt-2">
          <FieldError message={startError} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Blok OAuth Threads di langkah form modal (integrasi Threads):
 * penjelasan singkat + Redirect URI resmi yang harus didaftarkan di
 * aplikasi Threads + tombol primer "Hubungkan dengan Threads" bila
 * kredensial aplikasi Threads terisi di Panel Admin (selain itu
 * tombol nonaktif + petunjuk). Threads TIDAK punya cara manual —
 * langkah ini murni OAuth, dan callback-nya langsung menghubungkan
 * akun (tanpa pemilih aset seperti Meta).
 */
export function ThreadsOAuthStepBlock({
  t,
  info,
  starting,
  startError,
  onStart,
}: {
  t: Translate;
  info: ThreadsOAuthInfoResponse | null;
  starting: boolean;
  startError: string | null;
  onStart: () => void;
}) {
  const available = info?.available ?? false;
  return (
    <div className="mt-4">
      <p className="text-sm text-muted">{t("channels.threadsConnectBody")}</p>
      {info ? (
        <div className="mt-3 rounded-lg border border-line bg-elevated/40 p-3">
          <div className="text-xs text-muted">
            {t("channels.threadsRedirectUriLabel")}
          </div>
          <div className="mt-0.5 break-all font-mono text-xs text-ink">
            {info.oauthRedirectUri}
          </div>
        </div>
      ) : null}
      <button
        id="threads-connect-button"
        type="button"
        disabled={!available || starting}
        onClick={onStart}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-md bg-black px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
      >
        {starting
          ? t("channels.threadsStarting")
          : t("channels.threadsContinue")}
      </button>
      {!available ? (
        <p className="mt-2 text-xs text-muted">
          {t("channels.threadsNotConfigured")}
        </p>
      ) : null}
      {startError ? (
        <div className="mt-2">
          <FieldError message={startError} />
        </div>
      ) : null}
    </div>
  );
}

export function StatusPill({
  t,
  status,
}: {
  t: Translate;
  status: ChannelAccountResponse["status"];
}) {
  if (status === "connected") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success">
        <span className="h-1.5 w-1.5 rounded-full bg-success" />
        {t("channels.statusActive")}
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-danger/10 px-2 py-0.5 text-xs font-medium text-danger">
        <span className="h-1.5 w-1.5 rounded-full bg-danger" />
        {t("channels.statusError")}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-elevated px-2 py-0.5 text-xs font-medium text-muted">
      <span className="h-1.5 w-1.5 rounded-full bg-muted" />
      {t("channels.statusDisconnected")}
    </span>
  );
}

/** Label outcome log integrasi — kunci yang sama seperti halaman Logs. */
export const HEALTH_OUTCOME_LABEL_KEYS: Record<string, TranslationKey> = {
  recorded: "logs.outcomeRecorded",
  duplicate: "logs.outcomeDuplicate",
  ignored_disconnected: "logs.outcomeIgnoredDisconnected",
  ignored_echo: "logs.outcomeIgnoredEcho",
  ignored_status_only: "logs.outcomeIgnoredStatusOnly",
  rejected_signature: "logs.outcomeRejectedSignature",
  rejected_unconfigured: "logs.outcomeRejectedUnconfigured",
  unresolved_account: "logs.outcomeUnresolvedAccount",
  error: "logs.outcomeError",
  sent: "logs.outcomeSent",
  failed: "logs.outcomeFailed",
};

/**
 * Blok kesehatan operasional kartu (Fase 7B.3): titik status + fakta
 * terakhir dari server (health di respons channel). `idle` tampil
 * sebagai satu baris redup "belum ada aktivitas" — BUKAN alarm. Untuk
 * webchat label masuknya "Pesan terakhir" (webchat tidak punya webhook;
 * server mengambilnya dari aktivitas pesan, lihat core channel-health).
 */
export function ChannelHealthBlock({
  t,
  locale,
  channel,
}: {
  t: Translate;
  locale: Locale;
  channel: ChannelAccountResponse;
}) {
  const health = channel.health;
  if (health.status === "idle") {
    return (
      <div className="mt-3 flex items-center gap-1.5 text-xs text-muted">
        <span className="h-1.5 w-1.5 rounded-full bg-muted" />
        {t("channels.healthNoActivity")}
      </div>
    );
  }
  const isOk = health.status === "ok";
  const inboundLabel =
    channel.provider === "webchat"
      ? t("channels.healthLastMessage")
      : t("channels.healthLastWebhook");
  return (
    <div className="mt-3 border-t border-line pt-3 text-xs">
      <div className="flex items-center gap-1.5">
        <span
          className={`h-1.5 w-1.5 rounded-full ${isOk ? "bg-success" : "bg-warning"}`}
        />
        <span className={`font-medium ${isOk ? "text-success" : "text-warning"}`}>
          {isOk ? t("channels.healthOk") : t("channels.healthAttention")}
        </span>
      </div>
      <dl className="mt-1.5 space-y-0.5 text-muted">
        {health.lastInboundAt ? (
          <div className="flex items-baseline justify-between gap-2">
            <dt>{inboundLabel}</dt>
            <dd title={formatDateTime(health.lastInboundAt, locale)}>
              {formatRelativeTime(health.lastInboundAt, locale)}
            </dd>
          </div>
        ) : null}
        {health.lastDeliveredAt ? (
          <div className="flex items-baseline justify-between gap-2">
            <dt>{t("channels.healthLastDelivered")}</dt>
            <dd title={formatDateTime(health.lastDeliveredAt, locale)}>
              {formatRelativeTime(health.lastDeliveredAt, locale)}
            </dd>
          </div>
        ) : null}
      </dl>
      {health.lastFailureAt && health.lastFailureOutcome ? (
        <div className="mt-2">
          <span
            className="inline-flex max-w-full flex-wrap items-center gap-x-1 rounded-full bg-warning/10 px-2 py-0.5 font-medium text-warning"
            title={formatDateTime(health.lastFailureAt, locale)}
          >
            <span>
              {t("channels.healthLastFailure")}:{" "}
              {t(
                HEALTH_OUTCOME_LABEL_KEYS[health.lastFailureOutcome] ??
                  "logs.outcomeError",
              )}
            </span>
            {health.lastFailureErrorCode ? (
              <code className="font-mono">{health.lastFailureErrorCode}</code>
            ) : null}
            <span>· {formatRelativeTime(health.lastFailureAt, locale)}</span>
          </span>
        </div>
      ) : null}
    </div>
  );
}

/** Provider yang bisa dihubungkan, urutan tampil di pemilih modal. */
export const CONNECT_PROVIDERS = [
  { provider: "webchat", descKey: "channels.pickWebchatDesc" },
  { provider: "telegram", descKey: "channels.pickTelegramDesc" },
  { provider: "messenger", descKey: "channels.pickMessengerDesc" },
  { provider: "instagram", descKey: "channels.pickInstagramDesc" },
  { provider: "whatsapp", descKey: "channels.pickWhatsappDesc" },
  { provider: "threads", descKey: "channels.pickThreadsDesc" },
] as const;

export type ConnectProvider = (typeof CONNECT_PROVIDERS)[number]["provider"];

/** Provider Meta — langkah form-nya menampilkan blok info webhook. */
export const META_PROVIDERS: readonly string[] = ["messenger", "instagram", "whatsapp"];

/** Judul langkah form modal per provider (kunci form yang sudah ada). */
export const CONNECT_FORM_TITLES: Record<ConnectProvider, TranslationKey> = {
  webchat: "channels.createTitle",
  telegram: "channels.telegramTitle",
  messenger: "channels.messengerTitle",
  instagram: "channels.instagramTitle",
  whatsapp: "channels.whatsappTitle",
  threads: "channels.threadsTitle",
};

/** Field pertama yang difokuskan saat langkah form modal dibuka. */
export const CONNECT_FORM_FOCUS_IDS: Record<ConnectProvider, string> = {
  webchat: "channel-name",
  telegram: "telegram-token",
  messenger: "messenger-page-id",
  instagram: "instagram-ig-id",
  whatsapp: "whatsapp-phone-id",
  // Threads tanpa form manual: fokus ke tombol connect OAuth-nya.
  threads: "threads-connect-button",
};

/**
 * Blok info Webhook Meta (Fase 7A): Callback URL + Verify Token + status
 * app secret + petunjuk subscribe — konten yang sama persis seperti
 * panel lama, kini dipakai bersama oleh dialog header (akses owner/admin)
 * dan langkah form provider Meta di dalam modal Hubungkan Channel.
 */
export function MetaWebhookInfoBlock({
  t,
  info,
  copiedField,
  onCopy,
}: {
  t: Translate;
  info: MetaWebhookInfoResponse;
  copiedField: string | null;
  onCopy: (field: string, value: string) => void;
}) {
  return (
    <>
      <h2 className="font-semibold">{t("channels.metaWebhookTitle")}</h2>
      <p className="mt-1 text-sm text-muted">{t("channels.metaWebhookBody")}</p>
      <label className="mt-3 block text-sm font-medium">
        {t("channels.metaWebhookUrlLabel")}
      </label>
      <div className="mt-1 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md bg-elevated px-3 py-2 font-mono text-xs">
          {info.webhookUrl}
        </code>
        <button
          type="button"
          onClick={() => onCopy("url", info.webhookUrl)}
          aria-label={t("channels.copyLink")}
          title={
            copiedField === "url" ? t("channels.copied") : t("channels.copyLink")
          }
          className="shrink-0 rounded-lg border border-line bg-surface p-2 text-muted hover:text-ink"
        >
          {copiedField === "url" ? (
            <span className="text-success">
              <CheckIcon />
            </span>
          ) : (
            <CopyIcon />
          )}
        </button>
      </div>
      <label className="mt-3 block text-sm font-medium">
        {t("channels.metaWebhookTokenLabel")}
      </label>
      {info.verifyToken ? (
        <div className="mt-1 flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-md bg-elevated px-3 py-2 font-mono text-xs">
            {info.verifyToken}
          </code>
          <button
            type="button"
            onClick={() => onCopy("token", info.verifyToken ?? "")}
            aria-label={t("channels.copyLink")}
            title={
              copiedField === "token"
                ? t("channels.copied")
                : t("channels.copyLink")
            }
            className="shrink-0 rounded-lg border border-line bg-surface p-2 text-muted hover:text-ink"
          >
            {copiedField === "token" ? (
              <span className="text-success">
                <CheckIcon />
              </span>
            ) : (
              <CopyIcon />
            )}
          </button>
        </div>
      ) : (
        <p className="mt-1 text-sm text-muted">
          {t("channels.metaWebhookNotConfigured")}
        </p>
      )}
      {!info.appSecretConfigured ? (
        <p className="mt-2 text-xs text-muted">
          {t("channels.metaWebhookSecretMissing")}
        </p>
      ) : null}
    </>
  );
}
