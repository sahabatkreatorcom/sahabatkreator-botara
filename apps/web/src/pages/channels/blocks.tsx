/**
 * Blok tampilan yang sudah berdiri sendiri di halaman Channels: langkah
 * OAuth Meta, pill status, blok kesehatan channel, dan info webhook Meta.
 *
 * Semua sudah berupa komponen dengan props eksplisit — tidak ada yang
 * membaca closure halaman — sehingga pemindahannya murni relokasi.
 */
import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import type {
  ChannelAccountResponse,
  GoogleService,
  GoogleServiceConnection,
  MetaOAuthProvider,
  MetaWebhookInfoResponse,
  PinterestBoardPrivacy,
  PinterestBoardsResponse,
  ThreadsOAuthInfoResponse,
  WhatsAppNumberHealthResponse,
} from "@sahabat-kreator/contracts";
import type { Locale, TranslationKey } from "@sahabat-kreator/i18n";
import { api, ApiClientError } from "../../api/client";
import { translateApiError } from "../../api/errorText";
import { FieldError, inputClassName } from "../../components/AuthLayout";
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
          <div className="mt-2 text-xs text-muted">
            {t("channels.threadsWebhookUrlLabel")}
          </div>
          <div className="mt-0.5 break-all font-mono text-xs text-ink">
            {info.webhookUrl}
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

/**
 * Blok OAuth generik gelombang Semua OAuth (TikTok/LinkedIn/
 * Pinterest) — pola ThreadsOAuthStepBlock persis: penjelasan +
 * Redirect URI resmi yang harus didaftarkan di aplikasi platform +
 * tombol primer bila kredensial aplikasi terisi di Panel Admin.
 * Perbedaan antar platform hanya kunci i18n + warna tombol, jadi
 * satu komponen parameterized dipakai bertiga; Threads tetap memakai
 * blok khususnya sendiri yang sudah lebih dulu mendarat.
 */
export function ProviderOAuthStepBlock({
  t,
  info,
  starting,
  startError,
  onStart,
  keys,
  buttonId,
  buttonStyle,
}: {
  t: Translate;
  info: { available: boolean; oauthRedirectUri: string; webhookUrl?: string } | null;
  starting: boolean;
  startError: string | null;
  onStart: () => void;
  keys: {
    body: TranslationKey;
    redirectUriLabel: TranslationKey;
    continueLabel: TranslationKey;
    startingLabel: TranslationKey;
    notConfigured: TranslationKey;
    /** Label baris URL webhook — hanya TikTok yang punya webhook untuk didaftarkan. */
    webhookUrlLabel?: TranslationKey;
  };
  buttonId: string;
  buttonStyle: CSSProperties;
}) {
  const available = info?.available ?? false;
  return (
    <div className="mt-4">
      <p className="text-sm text-muted">{t(keys.body)}</p>
      {info ? (
        <div className="mt-3 rounded-lg border border-line bg-elevated/40 p-3">
          <div className="text-xs text-muted">{t(keys.redirectUriLabel)}</div>
          <div className="mt-0.5 break-all font-mono text-xs text-ink">
            {info.oauthRedirectUri}
          </div>
          {keys.webhookUrlLabel && info.webhookUrl ? (
            <>
              <div className="mt-2 text-xs text-muted">
                {t(keys.webhookUrlLabel)}
              </div>
              <div className="mt-0.5 break-all font-mono text-xs text-ink">
                {info.webhookUrl}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
      <button
        id={buttonId}
        type="button"
        disabled={!available || starting}
        onClick={onStart}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
        style={buttonStyle}
      >
        {starting ? t(keys.startingLabel) : t(keys.continueLabel)}
      </button>
      {!available ? (
        <p className="mt-2 text-xs text-muted">{t(keys.notConfigured)}</p>
      ) : null}
      {startError ? (
        <div className="mt-2">
          <FieldError message={startError} />
        </div>
      ) : null}
    </div>
  );
}

/** Layanan Google yang masing-masing punya koneksi sendiri. */
const GOOGLE_SERVICE_ROWS = [
  {
    service: "calendar",
    nameKey: "channels.googleServiceCalendar",
    disconnectConfirmKey: "channels.googleDisconnectConfirmCalendar",
  },
  {
    service: "youtube",
    nameKey: "channels.googleServiceYoutube",
    disconnectConfirmKey: "channels.googleDisconnectConfirmYoutube",
  },
  {
    service: "business",
    nameKey: "channels.googleServiceBusiness",
    disconnectConfirmKey: "channels.googleDisconnectConfirmBusiness",
  },
  // G17: layanan Sheets — consent-nya memberi node flow
  // append_sheet_row akses ke spreadsheet akun tenant.
  {
    service: "sheets",
    nameKey: "channels.googleServiceSheets",
    disconnectConfirmKey: "channels.googleDisconnectConfirmSheets",
  },
] as const;

/**
 * Blok Google di modal Channels — sejak pemisahan Google
 * (2026-11-12) ada koneksi mandiri SATU per layanan: Calendar
 * (janji temu), YouTube (kanal), Google Business (lokasi), Sheets
 * (node flow). Tiap baris menampilkan status + email akun layanan
 * ITU dan tombol Hubungkan sendiri yang membuka dialog consent
 * SEMPIT layanan itu lewat backend (satu callback untuk semuanya);
 * sinkron turunan (kanal/lokasi) terjadi di callback OAuth API.
 * Menggantikan blok consent gabungan gelombang Semua OAuth agar
 * billing/kuota/persetujuan API terpisah per layanan.
 *
 * Fase Susulan S4: baris yang terhubung juga punya tombol Putuskan
 * SENDIRI (DELETE per layanan di API) — memutus satu layanan tidak
 * menyentuh layanan lain. Konfirmasi menyebut nama layanan +
 * konsekuensi persisnya untuk layanan itu (kunci per baris di
 * GOOGLE_SERVICE_ROWS); untuk YouTube/Business konsekuensinya
 * termasuk akun channel turunannya yang ikut nonaktif.
 */
export function GoogleChannelsStepBlock({
  t,
  services,
  startingService,
  startError,
  onConnect,
  disconnectingService,
  disconnectError,
  onDisconnect,
}: {
  t: Translate;
  services: GoogleServiceConnection[] | null;
  startingService: GoogleService | null;
  startError: string | null;
  onConnect: (service: GoogleService) => void;
  disconnectingService: GoogleService | null;
  disconnectError: string | null;
  onDisconnect: (service: GoogleService) => void;
}) {
  const byService = new Map((services ?? []).map((row) => [row.service, row]));
  const busy = startingService !== null || disconnectingService !== null;
  return (
    <div className="mt-4">
      <p className="text-sm text-muted">{t("channels.googleConnectBody")}</p>
      <div className="mt-3 space-y-2">
        {GOOGLE_SERVICE_ROWS.map(
          ({ service, nameKey, disconnectConfirmKey }) => {
            const status = byService.get(service);
            const starting = startingService === service;
            const disconnecting = disconnectingService === service;
            return (
              <div
                key={service}
                className="flex items-center justify-between gap-3 rounded-lg border border-line bg-elevated/40 p-3"
              >
                <div className="min-w-0 text-sm">
                  <p className="font-medium text-ink">{t(nameKey)}</p>
                  {status?.connected ? (
                    <span className="text-ink">
                      {t("channels.googleConnectedAs", {
                        email: status.accountEmail ?? "—",
                      })}
                    </span>
                  ) : (
                    <span className="text-muted">
                      {t("channels.googleNotConnected")}
                    </span>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {status?.connected ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(t(disconnectConfirmKey))) {
                          onDisconnect(service);
                        }
                      }}
                      className="rounded-md px-3.5 py-2 text-sm font-semibold text-danger disabled:opacity-60"
                    >
                      {disconnecting
                        ? t("channels.googleDisconnecting")
                        : t("channels.googleDisconnectButton")}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onConnect(service)}
                    className="rounded-md bg-accent px-3.5 py-2 text-sm font-semibold text-white disabled:opacity-60"
                  >
                    {starting
                      ? t("channels.googleConnecting")
                      : status?.connected
                        ? t("channels.googleReconnectButton")
                        : t("channels.googleConnectButton")}
                  </button>
                </div>
              </div>
            );
          },
        )}
      </div>
      {startError ? (
        <div className="mt-2">
          <FieldError message={startError} />
        </div>
      ) : null}
      {disconnectError ? (
        <div className="mt-2">
          <FieldError message={disconnectError} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Pemilih board Pinterest pada kartu akun Channels: dropdown board
 * tujuan Pin PER AKUN + formulir buat board baru (POST /v5/boards).
 * Blok ini sengaja mandiri — memuat & menyimpan lewat API channels
 * sendiri dari props tenantId + channelId — agar perubahan halaman
 * Channels sekecil mungkin. Pilihan disimpan server per akun dan
 * dibaca penerbit saat publikasi; tanpa pilihan penerbit memakai
 * board pertama akun. Board terpilih yang sudah dihapus di
 * Pinterest tetap ditampilkan dari snapshot namanya + catatan
 * jujur, sampai pemilik memilih ulang.
 */
export function PinterestBoardPickerBlock({
  t,
  tenantId,
  channelId,
}: {
  t: Translate;
  tenantId: string;
  channelId: string;
}) {
  const [data, setData] = useState<PinterestBoardsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newPrivacy, setNewPrivacy] =
    useState<PinterestBoardPrivacy>("PUBLIC");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.channels.pinterestBoards(tenantId, channelId));
    } catch (err) {
      // Peran selain owner/admin: panel memang bukan untuk mereka —
      // sembunyikan blok ini (pola info webhook Meta), bukan error.
      if (err instanceof ApiClientError && err.status === 403) {
        setForbidden(true);
      } else {
        setError(translateApiError(t, err));
      }
    } finally {
      setLoading(false);
    }
  }, [t, tenantId, channelId]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedId = data?.selectedBoardId ?? null;
  const selectedMissing =
    data !== null &&
    selectedId !== null &&
    !data.boards.some((b) => b.id === selectedId);

  async function handleSelect(value: string) {
    setSaving(true);
    setError(null);
    try {
      setData(
        await api.channels.pinterestBoardSelect(
          tenantId,
          channelId,
          value === "" ? null : value,
        ),
      );
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setSaving(false);
    }
  }

  if (forbidden) return null;

  async function handleCreate(ev: FormEvent) {
    ev.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const created = await api.channels.pinterestBoardCreate(
        tenantId,
        channelId,
        {
          name: newName.trim(),
          ...(newDesc.trim() ? { description: newDesc.trim() } : {}),
          privacy: newPrivacy,
        },
      );
      setData(created);
      setShowCreate(false);
      setNewName("");
      setNewDesc("");
      setNewPrivacy("PUBLIC");
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="mt-3 space-y-2 border-t border-line pt-3">
      <div className="text-sm font-medium">
        {t("channels.pinterestBoardTitle")}
      </div>
      <p className="text-xs text-muted">{t("channels.pinterestBoardHint")}</p>
      {loading ? (
        <p className="text-xs text-muted">
          {t("channels.pinterestBoardLoading")}
        </p>
      ) : data ? (
        <>
          <select
            aria-label={t("channels.pinterestBoardTitle")}
            className={inputClassName}
            value={selectedId ?? ""}
            disabled={saving}
            onChange={(e) => void handleSelect(e.target.value)}
          >
            <option value="">
              {t("channels.pinterestBoardDefaultOption")}
            </option>
            {selectedMissing ? (
              <option value={selectedId ?? ""}>
                {data.selectedBoardName ?? selectedId}
              </option>
            ) : null}
            {data.boards.map((board) => (
              <option key={board.id} value={board.id}>
                {board.name ?? board.id}
              </option>
            ))}
          </select>
          {selectedMissing ? (
            <p className="text-xs text-warning">
              {t("channels.pinterestBoardMissingNote")}
            </p>
          ) : null}
          {saving ? (
            <p className="text-xs text-muted">
              {t("channels.pinterestBoardSaving")}
            </p>
          ) : null}
        </>
      ) : (
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-md bg-elevated px-3 py-1 text-sm"
        >
          {t("common.retry")}
        </button>
      )}
      {error ? <FieldError message={error} /> : null}
      {showCreate ? (
        <form onSubmit={(ev) => void handleCreate(ev)} className="space-y-2">
          <div>
            <label className="text-xs text-muted" htmlFor={`pin-board-name-${channelId}`}>
              {t("channels.pinterestBoardNameLabel")}
            </label>
            <input
              id={`pin-board-name-${channelId}`}
              className={inputClassName}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t("channels.pinterestBoardNamePlaceholder")}
              maxLength={180}
              required
            />
          </div>
          <div>
            <label className="text-xs text-muted" htmlFor={`pin-board-desc-${channelId}`}>
              {t("channels.pinterestBoardDescLabel")}
            </label>
            <input
              id={`pin-board-desc-${channelId}`}
              className={inputClassName}
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              maxLength={500}
            />
          </div>
          <div>
            <label className="text-xs text-muted" htmlFor={`pin-board-privacy-${channelId}`}>
              {t("channels.pinterestBoardPrivacyLabel")}
            </label>
            <select
              id={`pin-board-privacy-${channelId}`}
              className={inputClassName}
              value={newPrivacy}
              onChange={(e) =>
                setNewPrivacy(e.target.value as PinterestBoardPrivacy)
              }
            >
              <option value="PUBLIC">
                {t("channels.pinterestBoardPrivacyPublic")}
              </option>
              <option value="PROTECTED">
                {t("channels.pinterestBoardPrivacyProtected")}
              </option>
            </select>
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={creating || newName.trim() === ""}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60"
            >
              {creating
                ? t("channels.pinterestBoardCreating")
                : t("channels.pinterestBoardCreateButton")}
            </button>
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className="rounded-md px-3 py-1.5 text-sm text-muted hover:bg-elevated"
            >
              {t("common.cancel")}
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="text-sm font-medium text-accent hover:underline"
        >
          {t("channels.pinterestBoardCreateToggle")}
        </button>
      )}
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
  { provider: "tiktok", descKey: "channels.pickTiktokDesc" },
  { provider: "linkedin", descKey: "channels.pickLinkedinDesc" },
  { provider: "pinterest", descKey: "channels.pickPinterestDesc" },
  { provider: "bluesky", descKey: "channels.pickBlueskyDesc" },
  { provider: "google", descKey: "channels.pickGoogleDesc" },
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
  tiktok: "channels.tiktokTitle",
  linkedin: "channels.linkedinTitle",
  pinterest: "channels.pinterestTitle",
  bluesky: "channels.blueskyTitle",
  google: "channels.googleTitle",
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
  tiktok: "tiktok-connect-button",
  linkedin: "linkedin-connect-button",
  pinterest: "pinterest-connect-button",
  // Bluesky = formulir handle + app password: fokus ke handle.
  bluesky: "bluesky-handle",
  google: "google-connect-button",
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
        {t("channels.whatsappWebhookUrlLabel")}
      </label>
      <div className="mt-1 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md bg-elevated px-3 py-2 font-mono text-xs">
          {info.whatsappWebhookUrl}
        </code>
        <button
          type="button"
          onClick={() => onCopy("wa-url", info.whatsappWebhookUrl)}
          aria-label={t("channels.copyLink")}
          title={
            copiedField === "wa-url" ? t("channels.copied") : t("channels.copyLink")
          }
          className="shrink-0 rounded-lg border border-line bg-surface p-2 text-muted hover:text-ink"
        >
          {copiedField === "wa-url" ? (
            <span className="text-success">
              <CheckIcon />
            </span>
          ) : (
            <CopyIcon />
          )}
        </button>
      </div>
      <label className="mt-3 block text-sm font-medium">
        {t("channels.dataDeletionCallbackUrlLabel")}
      </label>
      <div className="mt-1 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md bg-elevated px-3 py-2 font-mono text-xs">
          {info.dataDeletionCallbackUrl}
        </code>
        <button
          type="button"
          onClick={() => onCopy("deletion-url", info.dataDeletionCallbackUrl)}
          aria-label={t("channels.copyLink")}
          title={
            copiedField === "deletion-url"
              ? t("channels.copied")
              : t("channels.copyLink")
          }
          className="shrink-0 rounded-lg border border-line bg-surface p-2 text-muted hover:text-ink"
        >
          {copiedField === "deletion-url" ? (
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

/**
 * Kesehatan nomor WhatsApp (G13 butir 5): snapshot LANGSUNG dari
 * Graph saat kartu dirender — rating kualitas (GREEN/YELLOW/RED →
 * chip Baik/Berisiko/Dibatasi) + tingkatan batas pesan nomor ini.
 * Nilai yang tidak dikembalikan Meta tampil apa adanya sebagai
 * "tidak diketahui" — tidak pernah ditebak. Tombol periksa memuat
 * ulang snapshot (fetchedAt dari server menyatakan waktu ambilnya).
 */
export function WhatsAppHealthBlock({
  t,
  locale,
  tenantId,
  channelId,
}: {
  t: Translate;
  locale: Locale;
  tenantId: string;
  channelId: string;
}) {
  const [data, setData] = useState<WhatsAppNumberHealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.channels.whatsappHealth(tenantId, channelId));
    } catch {
      setError(t("channels.waHealth.loadError"));
    } finally {
      setLoading(false);
    }
  }, [t, tenantId, channelId]);

  useEffect(() => {
    void load();
  }, [load]);

  const qualityChip = (rating: string) => {
    const upper = rating.toUpperCase();
    if (upper === "GREEN")
      return {
        cls: "bg-success/15 text-success",
        label: t("channels.waHealth.qualityGreen"),
      };
    if (upper === "YELLOW")
      return {
        cls: "bg-warning/15 text-warning",
        label: t("channels.waHealth.qualityYellow"),
      };
    if (upper === "RED")
      return {
        cls: "bg-danger/15 text-danger",
        label: t("channels.waHealth.qualityRed"),
      };
    return { cls: "bg-elevated text-muted", label: rating };
  };

  return (
    <div className="mt-3 space-y-2 border-t border-line pt-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{t("channels.waHealth.title")}</span>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="rounded-lg border border-line bg-surface px-2.5 py-1 text-xs font-medium text-ink hover:bg-elevated disabled:opacity-60"
        >
          {t("channels.waHealth.refresh")}
        </button>
      </div>
      {loading && !data ? (
        <p className="text-xs text-muted">{t("channels.waHealth.loading")}</p>
      ) : error ? (
        <p className="text-xs text-danger">{error}</p>
      ) : data && !data.available ? (
        <p className="text-xs text-muted">{t("channels.waHealth.unknown")}</p>
      ) : data ? (
        <div className="space-y-1.5 text-xs text-muted">
          <div className="flex flex-wrap items-center gap-2">
            <span>{t("channels.waHealth.qualityLabel")}:</span>
            {data.qualityRating ? (
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 font-medium ${qualityChip(data.qualityRating).cls}`}
              >
                {qualityChip(data.qualityRating).label} ({data.qualityRating})
              </span>
            ) : (
              <span>{t("channels.waHealth.unknown")}</span>
            )}
            {data.messagingLimitTier ? (
              <span className="inline-flex items-center rounded-full bg-elevated px-2 py-0.5 font-mono font-medium text-ink">
                {t("channels.waHealth.tierLabel")}: {data.messagingLimitTier}
              </span>
            ) : null}
          </div>
          {data.throughputLevel ? (
            <p>
              {t("channels.waHealth.throughputLabel")}: {data.throughputLevel}
            </p>
          ) : null}
          {data.nameStatus ? (
            <p>
              {t("channels.waHealth.nameStatusLabel")}: {data.nameStatus}
            </p>
          ) : null}
          <p>
            {t("channels.waHealth.fetchedAt", {
              time: formatRelativeTime(data.fetchedAt, locale),
            })}
          </p>
        </div>
      ) : null}
    </div>
  );
}
