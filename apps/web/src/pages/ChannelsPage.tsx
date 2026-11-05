import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type {
  ChannelAccountResponse,
  MetaOAuthAsset,
  MetaOAuthInfoResponse,
  MetaOAuthProvider,
  MetaOAuthSessionResponse,
  MetaWebhookInfoResponse,
} from "@sahabat-kreator/contracts";
import type { Locale, TranslationKey } from "@sahabat-kreator/i18n";
import { api, ApiClientError } from "../api/client";
import { translateApiError } from "../api/errorText";
import { FieldError, inputClassName } from "../components/AuthLayout";
import { PasswordInput } from "../components/PasswordInput";
import {
  ChannelAvatar,
  ProviderGlyph,
  providerMeta,
} from "../components/ChannelAvatar";
import { useWorkspace } from "../workspace/WorkspaceProvider";
import {
  formatDate,
  formatDateTime,
  formatRelativeTime,
} from "../utils/format";

type Translate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

interface ChannelsPageProps {
  t: Translate;
  locale: Locale;
}

function providerLabel(t: Translate, provider: string): string {
  return t(`inbox.providers.${provider}` as TranslationKey);
}

function embedSnippet(siteKey: string): string {
  const origin =
    typeof window !== "undefined" ? window.location.origin : "https://botara.my.id";
  return `<script src="${origin}/widget.js" data-site-key="${siteKey}"></script>`;
}

/** Tautan demo publik webchat — halaman yang benar-benar bisa dibuka pengunjung. */
function demoUrl(siteKey: string): string {
  const origin =
    typeof window !== "undefined" ? window.location.origin : "https://botara.my.id";
  return `${origin}/webchat-demo?key=${siteKey}`;
}

/** Potong string panjang di tengah: `wc_kY1iy8xy…kLTw9`. */
function truncateMiddle(value: string, head = 10, tail = 4): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** Baris @handle di bawah nama kartu; null bila tidak ada yang masuk akal. */
function handleLine(channel: ChannelAccountResponse): string | null {
  if (channel.provider === "telegram") {
    return channel.botUsername ? `@${channel.botUsername}` : null;
  }
  if (channel.provider === "messenger" || channel.provider === "instagram") {
    // Fase 7A: handle publik Meta dari Graph; Page tanpa username
    // menampilkan Page ID-nya (terpotong rapi seperti siteKey webchat).
    return channel.publicHandle
      ? `@${channel.publicHandle}`
      : truncateMiddle(channel.externalId);
  }
  if (channel.provider === "whatsapp") {
    // Fase 7B: handle WhatsApp = nomor tampil terformat dari Graph
    // (display_phone_number di publicHandle); bukan @handle.
    return channel.publicHandle ?? truncateMiddle(channel.externalId);
  }
  if (channel.provider === "webchat") {
    // Webchat tidak punya @handle — siteKey terpotong adalah identitasnya.
    return truncateMiddle(channel.externalId);
  }
  return null;
}

interface PublicLink {
  url: string;
  display: string;
}

/**
 * Tautan publik kartu + tombol salinnya. Telegram: profil bot t.me (tetap
 * sah walau channel sedang terputus — botnya tetap ada). Webchat: tautan
 * demo, hanya saat connected (channel terputus menolak sesi baru, jadi
 * menampilkannya akan menyesatkan).
 */
function publicLink(channel: ChannelAccountResponse): PublicLink | null {
  if (channel.provider === "telegram" && channel.botUsername) {
    return {
      url: `https://t.me/${channel.botUsername}`,
      display: `t.me/${channel.botUsername}`,
    };
  }
  // Fase 7A: tautan publik Meta hanya saat connected (pola webchat) —
  // Messenger memakai m.me/<username atau Page ID>; Instagram butuh
  // username (akun IG selalu punya) untuk ig.me/m/<username>.
  if (channel.provider === "messenger" && channel.status === "connected") {
    const slug = channel.publicHandle || channel.externalId;
    return { url: `https://m.me/${slug}`, display: `m.me/${slug}` };
  }
  if (
    channel.provider === "instagram" &&
    channel.status === "connected" &&
    channel.publicHandle
  ) {
    return {
      url: `https://ig.me/m/${channel.publicHandle}`,
      display: `ig.me/m/${channel.publicHandle}`,
    };
  }
  // Fase 7B: chip WhatsApp = wa.me/<digit nomor> (hanya digit dari
  // nomor tampil; phone_number_id BUKAN nomor telepon, jadi tanpa
  // publicHandle tidak ada chip yang jujur untuk ditampilkan).
  if (
    channel.provider === "whatsapp" &&
    channel.status === "connected" &&
    channel.publicHandle
  ) {
    const digits = channel.publicHandle.replace(/\D/g, "");
    if (digits) {
      return { url: `https://wa.me/${digits}`, display: `wa.me/${digits}` };
    }
  }
  if (channel.provider === "webchat" && channel.status === "connected") {
    const url = demoUrl(channel.externalId);
    return { url, display: url.replace(/^https?:\/\//, "") };
  }
  return null;
}

function PowerIcon() {
  return (
    <svg
      className="h-5 w-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={true}
    >
      <path d="M12 3v8" />
      <path d="M17.7 6.3a8 8 0 1 1-11.4 0" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      className="h-5 w-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={true}
    >
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={true}
    >
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={true}
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={true}
    >
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg
      className="h-5 w-5 shrink-0 text-muted"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={true}
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={true}
    >
      <path d="m15 6-6 6 6 6" />
    </svg>
  );
}

/** Pill status kartu: titik + label, warna mengikuti token semantik tema. */
/** Glyph "f" Facebook (jalur terisi sederhana) untuk tombol OAuth Fase 7D. */
function FacebookIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className="h-5 w-5 shrink-0"
    >
      <path d="M13.22 21.888v-7.638h2.565l.435-2.99H13.22V9.35c0-.865.24-1.455 1.48-1.455h1.58V5.22c-.274-.036-1.212-.116-2.304-.116-2.28 0-3.84 1.39-3.84 3.945v2.202H7.56v2.99h2.576v7.638a12.05 12.05 0 0 0 3.084 0Z" />
    </svg>
  );
}

/**
 * Blok OAuth Meta di langkah form modal (Fase 7D): tombol primer
 * "Lanjutkan dengan Facebook" bila provider itu tersedia (App ID +
 * App Secret + config ID terisi di Panel Admin), selain itu tombol
 * nonaktif + petunjuk. Untuk Instagram ditambah blok prasyarat Unified
 * Login (akun Professional + Portofolio Bisnis Meta) agar kreator tidak
 * mentok di dialog Meta tanpa penjelasan.
 */
function MetaOAuthStepBlock({
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

function StatusPill({
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
const HEALTH_OUTCOME_LABEL_KEYS: Record<string, TranslationKey> = {
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
function ChannelHealthBlock({
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
const CONNECT_PROVIDERS = [
  { provider: "webchat", descKey: "channels.pickWebchatDesc" },
  { provider: "telegram", descKey: "channels.pickTelegramDesc" },
  { provider: "messenger", descKey: "channels.pickMessengerDesc" },
  { provider: "instagram", descKey: "channels.pickInstagramDesc" },
  { provider: "whatsapp", descKey: "channels.pickWhatsappDesc" },
] as const;

type ConnectProvider = (typeof CONNECT_PROVIDERS)[number]["provider"];

/** Provider Meta — langkah form-nya menampilkan blok info webhook. */
const META_PROVIDERS: readonly string[] = ["messenger", "instagram", "whatsapp"];

/** Judul langkah form modal per provider (kunci form yang sudah ada). */
const CONNECT_FORM_TITLES: Record<ConnectProvider, TranslationKey> = {
  webchat: "channels.createTitle",
  telegram: "channels.telegramTitle",
  messenger: "channels.messengerTitle",
  instagram: "channels.instagramTitle",
  whatsapp: "channels.whatsappTitle",
};

/** Field pertama yang difokuskan saat langkah form modal dibuka. */
const CONNECT_FORM_FOCUS_IDS: Record<ConnectProvider, string> = {
  webchat: "channel-name",
  telegram: "telegram-token",
  messenger: "messenger-page-id",
  instagram: "instagram-ig-id",
  whatsapp: "whatsapp-phone-id",
};

/**
 * Blok info Webhook Meta (Fase 7A): Callback URL + Verify Token + status
 * app secret + petunjuk subscribe — konten yang sama persis seperti
 * panel lama, kini dipakai bersama oleh dialog header (akses owner/admin)
 * dan langkah form provider Meta di dalam modal Hubungkan Channel.
 */
function MetaWebhookInfoBlock({
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

/**
 * Halaman Channels (Fase 1F; kartu Fase 6H mengikuti referensi UI user):
 * daftar channel workspace aktif sebagai KARTU (avatar + badge provider,
 * nama/@handle, pill status + tanggal terhubung, chip tautan publik).
 * Penghubungan channel (Redesain Connect — permintaan user): tombol
 * "+ Hubungkan Channel" di kanan atas header membuka MODAL dua langkah
 * (pemilih provider → form provider itu); info Webhook Meta hidup di
 * dialog header owner/admin + kontekstual di langkah form Meta. Badan
 * halaman hanya grid kartu + seksi Sampah (Fase 6I: hapus BERPENJAGA —
 * ketik nama untuk konfirmasi + tombol ekspor riwayat di dialog yang
 * sama; masa tenggang 30 hari: Pulihkan / Ekspor, lalu worker purge).
 * Ikon power pada kartu memakai alur Disconnect yang sudah ada.
 */
export function ChannelsPage({ t, locale }: ChannelsPageProps) {
  const { active } = useWorkspace();
  const tenantId = active?.id ?? null;

  const [items, setItems] = useState<ChannelAccountResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // Modal Hubungkan Channel: null = tertutup, "pick" = langkah pemilih
  // provider, selain itu nama provider = langkah form provider itu.
  const [connectStep, setConnectStep] = useState<string | null>(null);
  const [webhookDialogOpen, setWebhookDialogOpen] = useState(false);
  // Kartu yang baru berhasil dihubungkan — disorot sesaat sesudah modal
  // tertutup agar pengguna melihat hasil kerjanya di grid.
  const [justConnectedId, setJustConnectedId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null);
  const [tgName, setTgName] = useState("");
  const [tgToken, setTgToken] = useState("");
  const [tgCreating, setTgCreating] = useState(false);
  const [tgError, setTgError] = useState<string | null>(null);
  // Form Meta (Fase 7A): Messenger (Page) & Instagram — token-based
  // seperti Telegram; token hanya hidup di state selama form terisi.
  const [msName, setMsName] = useState("");
  const [msPageId, setMsPageId] = useState("");
  const [msToken, setMsToken] = useState("");
  const [msCreating, setMsCreating] = useState(false);
  const [msError, setMsError] = useState<string | null>(null);
  const [igName, setIgName] = useState("");
  const [igPageId, setIgPageId] = useState("");
  const [igId, setIgId] = useState("");
  const [igToken, setIgToken] = useState("");
  // Jenis token connect manual IG (Fase 7D.3): Page Access Token (7A)
  // atau System User Token — varian SUAT tidak memakai Page ID.
  const [igTokenType, setIgTokenType] = useState<
    "page_access_token" | "system_user_token"
  >("page_access_token");
  const [igCreating, setIgCreating] = useState(false);
  const [igError, setIgError] = useState<string | null>(null);
  // Form WhatsApp (Fase 7B): WABA ID + Phone Number ID + token System
  // User — token-based seperti Meta; token hanya hidup di state form.
  const [waName, setWaName] = useState("");
  const [waWabaId, setWaWabaId] = useState("");
  const [waPhoneId, setWaPhoneId] = useState("");
  const [waToken, setWaToken] = useState("");
  const [waCreating, setWaCreating] = useState(false);
  const [waError, setWaError] = useState<string | null>(null);
  const [metaWebhook, setMetaWebhook] =
    useState<MetaWebhookInfoResponse | null>(null);
  // OAuth Meta (Fase 7D): ketersediaan per provider, status start,
  // lipatan form manual, dan alur pulang dari dialog Meta (sesi pemilih
  // aset / banner error / peringatan subscribe).
  const [oauthInfo, setOauthInfo] = useState<MetaOAuthInfoResponse | null>(
    null,
  );
  const [oauthStarting, setOauthStarting] = useState(false);
  const [oauthStartError, setOauthStartError] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [oauthSessionId, setOauthSessionId] = useState<string | null>(null);
  const [oauthSession, setOauthSession] =
    useState<MetaOAuthSessionResponse | null>(null);
  const [oauthSessionError, setOauthSessionError] = useState<string | null>(
    null,
  );
  const [oauthCompletingId, setOauthCompletingId] = useState<string | null>(
    null,
  );
  const [oauthCompleteError, setOauthCompleteError] = useState<string | null>(
    null,
  );
  const [oauthBannerError, setOauthBannerError] = useState<string | null>(
    null,
  );
  const [oauthWarning, setOauthWarning] = useState<string | null>(null);
  const oauthParamsHandled = useRef(false);
  const [copiedWebhookField, setCopiedWebhookField] = useState<string | null>(
    null,
  );
  const [disconnectTarget, setDisconnectTarget] =
    useState<ChannelAccountResponse | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  const [trashItems, setTrashItems] = useState<ChannelAccountResponse[]>([]);
  const [deleteTarget, setDeleteTarget] =
    useState<ChannelAccountResponse | null>(null);
  const [deleteName, setDeleteName] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    setError(null);
    try {
      const [channels, trashed] = await Promise.all([
        api.channels.list(tenantId),
        api.channels.listTrash(tenantId),
      ]);
      setItems(channels);
      setTrashItems(trashed);
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setLoading(false);
    }
  }, [tenantId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Buka modal Hubungkan Channel — tanpa argumen di langkah pemilih. */
  const openConnect = useCallback((provider?: ConnectProvider) => {
    setConnectStep(provider ?? "pick");
  }, []);

  /** Sesudah connect sukses: tutup modal + sorot kartu barunya di grid. */
  const finishConnect = useCallback((channelId: string) => {
    setConnectStep(null);
    setJustConnectedId(channelId);
  }, []);

  // Sorotan kartu baru hanya sesaat (±3 detik), lalu kembali normal.
  useEffect(() => {
    if (!justConnectedId) return;
    const timer = window.setTimeout(() => setJustConnectedId(null), 3000);
    return () => window.clearTimeout(timer);
  }, [justConnectedId]);

  // Langkah form modal dibuka → fokuskan field pertamanya (perilaku yang
  // sama seperti "Hubungkan lagi" lama yang memfokuskan field form).
  useEffect(() => {
    if (!connectStep || connectStep === "pick") return;
    const id =
      CONNECT_FORM_FOCUS_IDS[connectStep as ConnectProvider] ?? undefined;
    if (!id) return;
    const timer = window.setTimeout(() => {
      document.getElementById(id)?.focus({ preventScroll: true });
    }, 60);
    return () => window.clearTimeout(timer);
  }, [connectStep]);

  // Info webhook Meta (Fase 7A): hanya owner/admin yang bisa membaca
  // endpoint-nya — peran lain menerima 403 dan panel disembunyikan
  // diam-diam (bukan error halaman).
  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
    api.channels
      .metaWebhookInfo(tenantId)
      .then((info) => {
        if (!cancelled) setMetaWebhook(info);
      })
      .catch(() => {
        if (!cancelled) setMetaWebhook(null);
      });
    // Ketersediaan OAuth Meta (Fase 7D) — gerbang yang sama (owner/admin);
    // kegagalan berarti tombol OAuth tampil nonaktif, bukan error halaman.
    api.channels
      .metaOAuthInfo(tenantId)
      .then((info) => {
        if (!cancelled) setOauthInfo(info);
      })
      .catch(() => {
        if (!cancelled) setOauthInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  // Ganti langkah modal → lipatan manual tertutup lagi + error start bersih.
  useEffect(() => {
    setManualOpen(false);
    setOauthStartError(null);
  }, [connectStep]);

  // Kepulangan dari dialog Meta (Fase 7D): callback API me-redirect ke
  // /channels?meta_oauth=<sesi> atau ?meta_oauth_error=<kode>. Baca
  // SEKALI, bersihkan query dari URL, lalu tampilkan pemilih/banner.
  useEffect(() => {
    if (oauthParamsHandled.current) return;
    oauthParamsHandled.current = true;
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("meta_oauth");
    const errorCode = params.get("meta_oauth_error");
    if (!sessionId && !errorCode) return;
    params.delete("meta_oauth");
    params.delete("meta_oauth_error");
    const rest = params.toString();
    window.history.replaceState(
      null,
      "",
      window.location.pathname + (rest ? `?${rest}` : ""),
    );
    if (errorCode) {
      setOauthBannerError(
        translateApiError(t, new ApiClientError(0, errorCode, "")),
      );
    }
    if (sessionId) {
      setOauthSessionError(null);
      setOauthSession(null);
      setOauthSessionId(sessionId);
    }
    // Sengaja hanya sekali saat mount; `t` dari render pertama cukup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Muat aset sesi OAuth begitu id sesi + tenant siap (dialog pemilih).
  useEffect(() => {
    if (!tenantId || !oauthSessionId) return;
    let cancelled = false;
    api.channels
      .metaOAuthSession(tenantId, oauthSessionId)
      .then((session) => {
        if (!cancelled) setOauthSession(session);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setOauthSessionError(
            err instanceof ApiClientError
              ? translateApiError(t, err)
              : t("errors.generic"),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, oauthSessionId, t]);

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (!tenantId) return;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await api.channels.create(tenantId, {
        provider: "webchat",
        displayName: name.trim() || undefined,
      });
      setName("");
      await load();
      finishConnect(created.id);
    } catch (err) {
      setCreateError(
        err instanceof ApiClientError
          ? translateApiError(t, err)
          : t("errors.generic"),
      );
    } finally {
      setCreating(false);
    }
  };

  const handleConnectTelegram = async (event: FormEvent) => {
    event.preventDefault();
    if (!tenantId) return;
    setTgCreating(true);
    setTgError(null);
    try {
      const created = await api.channels.create(tenantId, {
        provider: "telegram",
        displayName: tgName.trim() || undefined,
        botToken: tgToken.trim(),
      });
      // Token tidak disimpan di state lebih lama dari yang perlu.
      setTgToken("");
      setTgName("");
      await load();
      finishConnect(created.id);
    } catch (err) {
      setTgError(
        err instanceof ApiClientError
          ? translateApiError(t, err)
          : t("errors.generic"),
      );
    } finally {
      setTgCreating(false);
    }
  };

  const handleConnectMessenger = async (event: FormEvent) => {
    event.preventDefault();
    if (!tenantId) return;
    setMsCreating(true);
    setMsError(null);
    try {
      const created = await api.channels.create(tenantId, {
        provider: "messenger",
        displayName: msName.trim() || undefined,
        pageId: msPageId.trim(),
        pageAccessToken: msToken.trim(),
      });
      // Token tidak disimpan di state lebih lama dari yang perlu.
      setMsToken("");
      setMsName("");
      setMsPageId("");
      await load();
      finishConnect(created.id);
    } catch (err) {
      setMsError(
        err instanceof ApiClientError
          ? translateApiError(t, err)
          : t("errors.generic"),
      );
    } finally {
      setMsCreating(false);
    }
  };

  const handleConnectInstagram = async (event: FormEvent) => {
    event.preventDefault();
    if (!tenantId) return;
    setIgCreating(true);
    setIgError(null);
    const suat = igTokenType === "system_user_token";
    try {
      const created = await api.channels.create(tenantId, {
        provider: "instagram",
        displayName: igName.trim() || undefined,
        // Varian SUAT (Fase 7D.3): tanpa Page ID — server memvalidasi
        // token langsung ke akun IG.
        ...(suat ? {} : { pageId: igPageId.trim() }),
        igUserId: igId.trim(),
        pageAccessToken: igToken.trim(),
        tokenType: igTokenType,
      });
      setIgToken("");
      setIgName("");
      setIgPageId("");
      setIgId("");
      // Peringatan subscribe varian SUAT memakai banner yang sama
      // seperti alur OAuth (koneksi berhasil, webhook belum tentu).
      if (created.warnings?.includes("META_SUBSCRIBE_FAILED")) {
        setOauthWarning(t("channels.oauthSubscribeWarning"));
      }
      await load();
      finishConnect(created.id);
    } catch (err) {
      setIgError(
        err instanceof ApiClientError
          ? translateApiError(t, err)
          : t("errors.generic"),
      );
    } finally {
      setIgCreating(false);
    }
  };

  const handleConnectWhatsApp = async (event: FormEvent) => {
    event.preventDefault();
    if (!tenantId) return;
    setWaCreating(true);
    setWaError(null);
    try {
      const created = await api.channels.create(tenantId, {
        provider: "whatsapp",
        displayName: waName.trim() || undefined,
        wabaId: waWabaId.trim(),
        phoneNumberId: waPhoneId.trim(),
        accessToken: waToken.trim(),
      });
      // Token tidak disimpan di state lebih lama dari yang perlu.
      setWaToken("");
      setWaName("");
      setWaWabaId("");
      setWaPhoneId("");
      await load();
      finishConnect(created.id);
    } catch (err) {
      setWaError(
        err instanceof ApiClientError
          ? translateApiError(t, err)
          : t("errors.generic"),
      );
    } finally {
      setWaCreating(false);
    }
  };

  const copyWebhookValue = async (field: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedWebhookField(field);
      window.setTimeout(
        () => setCopiedWebhookField((cur) => (cur === field ? null : cur)),
        2000,
      );
    } catch {
      /* clipboard tidak tersedia — nilai tetap terlihat untuk disalin manual */
    }
  };

  /**
   * Mulai OAuth Meta (Fase 7D): minta URL dialog ke API lalu arahkan
   * browser ke sana (redirect penuh). Callback API yang membawa pulang.
   */
  const handleOAuthStart = async (provider: MetaOAuthProvider) => {
    if (!tenantId || oauthStarting) return;
    setOauthStarting(true);
    setOauthStartError(null);
    try {
      const started = await api.channels.metaOAuthStart(tenantId, provider);
      window.location.href = started.dialogUrl;
    } catch (err) {
      setOauthStartError(
        err instanceof ApiClientError
          ? translateApiError(t, err)
          : t("errors.generic"),
      );
      setOauthStarting(false);
    }
  };

  /** Selesaikan OAuth: hubungkan aset terpilih dari sesi (Fase 7D). */
  const handleOAuthComplete = async (asset: MetaOAuthAsset) => {
    // Hotfix R1: aset nonaktif (Page tanpa token yang dapat dipakai)
    // tidak pernah dikirim ke complete — tombolnya nonaktif, ini
    // penjaga kedua di sisi klien (API juga menolaknya).
    if (asset.connectable === false) return;
    if (!tenantId || !oauthSessionId || oauthCompletingId) return;
    setOauthCompletingId(asset.assetId);
    setOauthCompleteError(null);
    try {
      const result = await api.channels.metaOAuthComplete(
        tenantId,
        oauthSessionId,
        asset.assetId,
      );
      setOauthSessionId(null);
      setOauthSession(null);
      if (result.warnings.includes("META_SUBSCRIBE_FAILED")) {
        setOauthWarning(t("channels.oauthSubscribeWarning"));
      }
      await load();
      finishConnect(result.channel.id);
    } catch (err) {
      setOauthCompleteError(
        err instanceof ApiClientError
          ? translateApiError(t, err)
          : t("errors.generic"),
      );
    } finally {
      setOauthCompletingId(null);
    }
  };

  const closeOAuthPicker = () => {
    setOauthSessionId(null);
    setOauthSession(null);
    setOauthSessionError(null);
    setOauthCompleteError(null);
  };

  const handleDisconnect = async () => {
    if (!tenantId || !disconnectTarget) return;
    setDisconnecting(true);
    setDisconnectError(null);
    try {
      await api.channels.disconnect(tenantId, disconnectTarget.id);
      setDisconnectTarget(null);
      await load();
    } catch (err) {
      setDisconnectError(
        err instanceof ApiClientError
          ? translateApiError(t, err)
          : t("channels.disconnectError"),
      );
    } finally {
      setDisconnecting(false);
    }
  };

  const handleTrash = async () => {
    if (!tenantId || !deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.channels.trash(tenantId, deleteTarget.id, deleteName);
      setDeleteTarget(null);
      setDeleteName("");
      await load();
    } catch (err) {
      setDeleteError(
        err instanceof ApiClientError
          ? translateApiError(t, err)
          : t("channels.deleteError"),
      );
    } finally {
      setDeleting(false);
    }
  };

  const handleRestore = async (channel: ChannelAccountResponse) => {
    if (!tenantId) return;
    setRestoringId(channel.id);
    setRestoreError(null);
    try {
      await api.channels.restore(tenantId, channel.id);
      await load();
    } catch (err) {
      setRestoreError(
        err instanceof ApiClientError
          ? translateApiError(t, err)
          : t("channels.restoreError"),
      );
    } finally {
      setRestoringId(null);
    }
  };

  const handleExport = async (channel: ChannelAccountResponse) => {
    if (!tenantId) return;
    try {
      await api.channels.downloadExport(tenantId, channel.id);
    } catch {
      /* unduhan gagal — riwayat tetap aman; pengguna bisa mencoba lagi */
    }
  };

  const copySnippet = async (channel: ChannelAccountResponse) => {
    try {
      await navigator.clipboard.writeText(embedSnippet(channel.externalId));
      setCopiedId(channel.id);
      window.setTimeout(() => setCopiedId((cur) => (cur === channel.id ? null : cur)), 2000);
    } catch {
      /* clipboard tidak tersedia — snippet tetap bisa disalin manual */
    }
  };

  const copyLink = async (channel: ChannelAccountResponse, url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedLinkId(channel.id);
      window.setTimeout(
        () => setCopiedLinkId((cur) => (cur === channel.id ? null : cur)),
        2000,
      );
    } catch {
      /* clipboard tidak tersedia — tautan tetap terlihat untuk disalin manual */
    }
  };

  // Aset sesi OAuth dikelompokkan per induk (WhatsApp: per WABA);
  // provider lain satu grup tanpa judul (parentId null).
  const oauthGroups: Array<{
    key: string;
    parentName: string | null;
    assets: MetaOAuthAsset[];
  }> = [];
  if (oauthSession) {
    for (const asset of oauthSession.assets) {
      const key = asset.parentId ?? "__single__";
      let group = oauthGroups.find((g) => g.key === key);
      if (!group) {
        group = { key, parentName: asset.parentName, assets: [] };
        oauthGroups.push(group);
      }
      group.assets.push(asset);
    }
  }

  if (!tenantId) {
    return (
      <section>
        <h1 className="text-2xl font-bold">{t("channels.title")}</h1>
        <p className="mt-2 text-sm text-muted">{t("workspace.none")}</p>
      </section>
    );
  }

  return (
    <section>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t("channels.title")}</h1>
          <p className="mt-1 text-sm text-muted">{t("channels.subtitle")}</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {metaWebhook ? (
            <button
              type="button"
              onClick={() => setWebhookDialogOpen(true)}
              className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium"
            >
              {t("channels.metaWebhookButton")}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => openConnect()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white"
          >
            <PlusIcon />
            {t("channels.connectButton")}
          </button>
        </div>
      </div>

      {oauthBannerError ? (
        <div className="mt-4 flex items-start justify-between gap-3 rounded-lg bg-elevated px-3 py-2">
          <FieldError message={oauthBannerError} />
          <button
            type="button"
            onClick={() => setOauthBannerError(null)}
            className="shrink-0 rounded-md px-2 py-1 text-sm font-medium text-muted hover:text-ink"
          >
            {t("common.close")}
          </button>
        </div>
      ) : null}

      {oauthWarning ? (
        <div className="mt-4 flex items-start justify-between gap-3 rounded-lg border border-line bg-elevated px-3 py-2">
          <p className="text-sm text-ink">{oauthWarning}</p>
          <button
            type="button"
            onClick={() => setOauthWarning(null)}
            className="shrink-0 rounded-md px-2 py-1 text-sm font-medium text-muted hover:text-ink"
          >
            {t("common.close")}
          </button>
        </div>
      ) : null}

      {error ? (
        <div className="mt-4">
          <FieldError message={error} />
          <button
            type="button"
            onClick={() => void load()}
            className="mt-2 rounded-md bg-elevated px-3 py-1 text-sm"
          >
            {t("common.retry")}
          </button>
        </div>
      ) : null}

      <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {loading && items.length === 0 ? (
          <p className="text-sm text-muted sm:col-span-2 xl:col-span-3">
            {t("common.loading")}
          </p>
        ) : items.length === 0 ? (
          <div className="rounded-xl border border-line bg-surface p-4 sm:col-span-2 xl:col-span-3">
            <div className="font-semibold">{t("channels.emptyTitle")}</div>
            <p className="mt-1 text-sm text-muted">{t("channels.emptyBody")}</p>
            <button
              type="button"
              onClick={() => openConnect()}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white"
            >
              <PlusIcon />
              {t("channels.connectButton")}
            </button>
          </div>
        ) : (
          items.map((channel) => {
            const handle = handleLine(channel);
            const link = publicLink(channel);
            return (
              <article
                key={channel.id}
                className={`flex flex-col rounded-xl border bg-surface p-4 transition-shadow ${
                  channel.id === justConnectedId
                    ? "border-accent ring-2 ring-accent"
                    : "border-line"
                } ${channel.status === "disconnected" ? "opacity-60" : ""}`}
              >
                <div className="flex items-start gap-3">
                  <ChannelAvatar
                    provider={channel.provider}
                    name={
                      channel.displayName ||
                      channel.botUsername ||
                      channel.publicHandle ||
                      providerLabel(t, channel.provider)
                    }
                    imageUrl={channel.avatarUrl ?? undefined}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold">
                      {channel.displayName || providerLabel(t, channel.provider)}
                    </div>
                    {handle ? (
                      <div className="truncate font-mono text-sm text-muted">
                        {handle}
                      </div>
                    ) : null}
                    <div className="text-xs text-muted">
                      {providerLabel(t, channel.provider)}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-start gap-1">
                    {channel.status !== "disconnected" ? (
                      <button
                        type="button"
                        onClick={() => {
                          setDisconnectError(null);
                          setDisconnectTarget(channel);
                        }}
                        aria-label={t("channels.disconnectButton")}
                        title={t("channels.disconnectButton")}
                        className={`rounded-md p-1.5 hover:bg-elevated ${
                          channel.status === "connected"
                            ? "text-success"
                            : "text-muted"
                        }`}
                      >
                        <PowerIcon />
                      </button>
                    ) : channel.provider === "telegram" ||
                      channel.provider === "messenger" ||
                      channel.provider === "instagram" ||
                      channel.provider === "whatsapp" ? (
                      <button
                        type="button"
                        onClick={() =>
                          openConnect(channel.provider as ConnectProvider)
                        }
                        className="rounded-md px-2 py-1.5 text-sm font-medium text-accent hover:bg-elevated"
                      >
                        {t("channels.reconnectButton")}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => {
                        setDeleteError(null);
                        setDeleteName("");
                        setDeleteTarget(channel);
                      }}
                      aria-label={t("channels.deleteButton")}
                      title={t("channels.deleteButton")}
                      className="rounded-md p-1.5 text-muted hover:bg-elevated hover:text-danger"
                    >
                      <TrashIcon />
                    </button>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <StatusPill t={t} status={channel.status} />
                  <span className="text-xs text-muted">
                    {t("channels.connectedSince", {
                      date: formatDate(channel.createdAt, locale),
                    })}
                  </span>
                </div>

                <ChannelHealthBlock t={t} locale={locale} channel={channel} />

                {link ? (
                  <div className="mt-3 flex items-center gap-2">
                    <div className="flex min-w-0 flex-1 items-center rounded-lg bg-elevated px-3 py-2">
                      <span className="truncate font-mono text-xs text-accent">
                        {link.display}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => void copyLink(channel, link.url)}
                      aria-label={t("channels.copyLink")}
                      title={
                        copiedLinkId === channel.id
                          ? t("channels.copied")
                          : t("channels.copyLink")
                      }
                      className="shrink-0 rounded-lg border border-line bg-surface p-2 text-muted hover:text-ink"
                    >
                      {copiedLinkId === channel.id ? (
                        <span className="text-success">
                          <CheckIcon />
                        </span>
                      ) : (
                        <CopyIcon />
                      )}
                    </button>
                  </div>
                ) : null}

                {channel.provider === "webchat" && channel.status === "connected" ? (
                  <div className="mt-3 space-y-2 border-t border-line pt-3">
                    <div className="text-xs text-muted">
                      {t("channels.siteKeyLabel")}:{" "}
                      <code className="font-mono">{channel.externalId}</code>
                    </div>
                    <div className="text-sm font-medium">{t("channels.embedTitle")}</div>
                    <p className="text-xs text-muted">{t("channels.embedHint")}</p>
                    <textarea
                      readOnly
                      rows={2}
                      value={embedSnippet(channel.externalId)}
                      className="w-full rounded-md border border-line bg-elevated p-2 font-mono text-xs"
                      onFocus={(e) => e.target.select()}
                    />
                    <button
                      type="button"
                      onClick={() => void copySnippet(channel)}
                      className="rounded-md bg-accent px-3 py-1 text-sm font-semibold text-white"
                    >
                      {copiedId === channel.id ? t("channels.copied") : t("channels.copyButton")}
                    </button>
                  </div>
                ) : null}
              </article>
            );
          })
        )}
      </div>


      <div className="mt-8">
        <h2 className="font-semibold">{t("channels.trashTitle")}</h2>
        {restoreError ? (
          <div className="mt-2">
            <FieldError message={restoreError} />
          </div>
        ) : null}
        {trashItems.length === 0 ? (
          <p className="mt-2 text-sm text-muted">{t("channels.trashEmpty")}</p>
        ) : (
          <div className="mt-3 space-y-2">
            {trashItems.map((channel) => (
              <div
                key={channel.id}
                className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface p-3 opacity-80"
              >
                <ChannelAvatar
                  provider={channel.provider}
                  name={
                    channel.displayName ||
                    channel.botUsername ||
                    channel.publicHandle ||
                    providerLabel(t, channel.provider)
                  }
                  imageUrl={channel.avatarUrl ?? undefined}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold">
                    {channel.displayName || providerLabel(t, channel.provider)}
                  </div>
                  <div className="text-xs text-muted">
                    {providerLabel(t, channel.provider)}
                    {channel.trashedAt
                      ? ` · ${t("channels.trashedOn", {
                          date: formatDate(channel.trashedAt, locale),
                        })}`
                      : ""}
                    {channel.purgeAt
                      ? ` · ${t("channels.purgeOn", {
                          date: formatDate(channel.purgeAt, locale),
                        })}`
                      : ""}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleExport(channel)}
                  className="rounded-md bg-elevated px-3 py-1.5 text-sm font-medium"
                >
                  {t("channels.exportButton")}
                </button>
                <button
                  type="button"
                  disabled={restoringId === channel.id}
                  onClick={() => void handleRestore(channel)}
                  className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60"
                >
                  {restoringId === channel.id
                    ? t("channels.restoring")
                    : t("channels.restoreButton")}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {webhookDialogOpen && metaWebhook ? (
        <div
          className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-xl sm:rounded-2xl">
            <MetaWebhookInfoBlock
              t={t}
              info={metaWebhook}
              copiedField={copiedWebhookField}
              onCopy={(field, value) => void copyWebhookValue(field, value)}
            />
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => setWebhookDialogOpen(false)}
                className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium"
              >
                {t("common.close")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {connectStep ? (
        <div
          className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-label={t("channels.connectTitle")}
        >
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-xl sm:rounded-2xl">
            {connectStep === "pick" ? (
              <>
                <h2 className="text-lg font-bold">{t("channels.connectTitle")}</h2>
                <p className="mt-1 text-sm text-muted">
                  {t("channels.connectSubtitle")}
                </p>
                <div className="mt-4 space-y-2">
                  {CONNECT_PROVIDERS.map(({ provider, descKey }) => {
                    const meta = providerMeta(provider);
                    return (
                      <button
                        key={provider}
                        type="button"
                        onClick={() => setConnectStep(provider)}
                        className="flex w-full items-center gap-3 rounded-xl border border-line p-3 text-left hover:bg-elevated"
                      >
                        <span
                          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
                          style={{
                            backgroundColor: `${meta.color}1A`,
                            color: meta.color,
                          }}
                        >
                          <ProviderGlyph provider={provider} className="h-6 w-6" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block font-semibold">
                            {providerLabel(t, provider)}
                          </span>
                          <span className="block text-sm text-muted">
                            {t(descKey)}
                          </span>
                        </span>
                        <ChevronRightIcon />
                      </button>
                    );
                  })}
                </div>
                <div className="mt-4 flex justify-end">
                  <button
                    type="button"
                    onClick={() => setConnectStep(null)}
                    className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium"
                  >
                    {t("common.close")}
                  </button>
                </div>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setConnectStep("pick")}
                  className="inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-ink"
                >
                  <BackIcon />
                  {t("common.back")}
                </button>
                <h2 className="mt-2 text-lg font-bold">
                  {t(CONNECT_FORM_TITLES[connectStep as ConnectProvider])}
                </h2>
                {META_PROVIDERS.includes(connectStep) && metaWebhook ? (
                  <div className="mt-3 rounded-lg border border-line bg-elevated/40 p-3">
                    <MetaWebhookInfoBlock
                      t={t}
                      info={metaWebhook}
                      copiedField={copiedWebhookField}
                      onCopy={(field, value) =>
                        void copyWebhookValue(field, value)
                      }
                    />
                  </div>
                ) : null}

                {connectStep === "webchat" ? (
                  <form onSubmit={handleCreate}>
                    <label
                      className="mt-3 block text-sm font-medium"
                      htmlFor="channel-name"
                    >
                      {t("channels.nameLabel")}
                    </label>
                    <input
                      id="channel-name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder={t("channels.namePlaceholder")}
                      maxLength={255}
                      className={`${inputClassName} mt-1`}
                    />
                    {createError ? (
                      <div className="mt-2">
                        <FieldError message={createError} />
                      </div>
                    ) : null}
                    <button
                      type="submit"
                      disabled={creating}
                      className="mt-3 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                    >
                      {creating
                        ? t("channels.creating")
                        : t("channels.createButton")}
                    </button>
                  </form>
                ) : null}

                {connectStep === "telegram" ? (
                  <form onSubmit={handleConnectTelegram}>
                    <label
                      className="mt-3 block text-sm font-medium"
                      htmlFor="telegram-name"
                    >
                      {t("channels.telegramNameLabel")}
                    </label>
                    <input
                      id="telegram-name"
                      value={tgName}
                      onChange={(e) => setTgName(e.target.value)}
                      placeholder={t("channels.telegramNamePlaceholder")}
                      maxLength={255}
                      className={`${inputClassName} mt-1`}
                    />
                    <label
                      className="mt-3 block text-sm font-medium"
                      htmlFor="telegram-token"
                    >
                      {t("channels.tokenLabel")}
                    </label>
                    <PasswordInput
                      t={t}
                      id="telegram-token"
                      autoComplete="off"
                      value={tgToken}
                      onChange={(e) => setTgToken(e.target.value)}
                      placeholder={t("channels.tokenPlaceholder")}
                      maxLength={255}
                      className={`${inputClassName} mt-1`}
                    />
                    <p className="mt-1 text-xs text-muted">
                      {t("channels.tokenHint")}
                    </p>
                    {tgError ? (
                      <div className="mt-2">
                        <FieldError message={tgError} />
                      </div>
                    ) : null}
                    <button
                      type="submit"
                      disabled={tgCreating || !tgToken.trim()}
                      className="mt-3 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                    >
                      {tgCreating
                        ? t("channels.telegramConnecting")
                        : t("channels.telegramConnectButton")}
                    </button>
                  </form>
                ) : null}

                {connectStep === "messenger" ? (
                  <>
                    <MetaOAuthStepBlock
                      t={t}
                      provider="messenger"
                      available={
                        oauthInfo?.providers.messenger.available ?? false
                      }
                      starting={oauthStarting}
                      startError={oauthStartError}
                      onStart={(p) => void handleOAuthStart(p)}
                    />
                    <button
                      type="button"
                      onClick={() => setManualOpen((open) => !open)}
                      className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-accent"
                      aria-expanded={manualOpen}
                    >
                      {t("channels.oauthManualTitle")}
                      <ChevronRightIcon />
                    </button>
                    {manualOpen ? (
                  <form onSubmit={handleConnectMessenger}>
                    <label
                      className="mt-3 block text-sm font-medium"
                      htmlFor="messenger-name"
                    >
                      {t("channels.metaNameLabel")}
                    </label>
                    <input
                      id="messenger-name"
                      value={msName}
                      onChange={(e) => setMsName(e.target.value)}
                      placeholder={t("channels.metaNamePlaceholder")}
                      maxLength={255}
                      className={`${inputClassName} mt-1`}
                    />
                    <label
                      className="mt-3 block text-sm font-medium"
                      htmlFor="messenger-page-id"
                    >
                      {t("channels.pageIdLabel")}
                    </label>
                    <input
                      id="messenger-page-id"
                      value={msPageId}
                      onChange={(e) => setMsPageId(e.target.value)}
                      placeholder={t("channels.pageIdPlaceholder")}
                      maxLength={64}
                      className={`${inputClassName} mt-1`}
                    />
                    <label
                      className="mt-3 block text-sm font-medium"
                      htmlFor="messenger-token"
                    >
                      {t("channels.pageTokenLabel")}
                    </label>
                    <PasswordInput
                      t={t}
                      id="messenger-token"
                      autoComplete="off"
                      value={msToken}
                      onChange={(e) => setMsToken(e.target.value)}
                      placeholder={t("channels.pageTokenPlaceholder")}
                      maxLength={1024}
                      className={`${inputClassName} mt-1`}
                    />
                    <p className="mt-1 text-xs text-muted">
                      {t("channels.metaTokenHint")}
                    </p>
                    {msError ? (
                      <div className="mt-2">
                        <FieldError message={msError} />
                      </div>
                    ) : null}
                    <button
                      type="submit"
                      disabled={msCreating || !msPageId.trim() || !msToken.trim()}
                      className="mt-3 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                    >
                      {msCreating
                        ? t("channels.metaConnecting")
                        : t("channels.messengerConnectButton")}
                    </button>
                  </form>
                    ) : null}
                  </>
                ) : null}

                {connectStep === "instagram" ? (
                  <>
                    <MetaOAuthStepBlock
                      t={t}
                      provider="instagram"
                      available={
                        oauthInfo?.providers.instagram.available ?? false
                      }
                      starting={oauthStarting}
                      startError={oauthStartError}
                      onStart={(p) => void handleOAuthStart(p)}
                    />
                    <button
                      type="button"
                      onClick={() => setManualOpen((open) => !open)}
                      className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-accent"
                      aria-expanded={manualOpen}
                    >
                      {t("channels.oauthManualTitle")}
                      <ChevronRightIcon />
                    </button>
                    {manualOpen ? (
                  <form onSubmit={handleConnectInstagram}>
                    <label
                      className="mt-3 block text-sm font-medium"
                      htmlFor="instagram-name"
                    >
                      {t("channels.metaNameLabel")}
                    </label>
                    <input
                      id="instagram-name"
                      value={igName}
                      onChange={(e) => setIgName(e.target.value)}
                      placeholder={t("channels.metaNamePlaceholder")}
                      maxLength={255}
                      className={`${inputClassName} mt-1`}
                    />
                    <label
                      className="mt-3 block text-sm font-medium"
                      htmlFor="instagram-ig-id"
                    >
                      {t("channels.igIdLabel")}
                    </label>
                    <input
                      id="instagram-ig-id"
                      value={igId}
                      onChange={(e) => setIgId(e.target.value)}
                      placeholder={t("channels.igIdPlaceholder")}
                      maxLength={64}
                      className={`${inputClassName} mt-1`}
                    />
                    <fieldset className="mt-3">
                      <legend className="text-sm font-medium">
                        {t("channels.igTokenTypeLabel")}
                      </legend>
                      <div className="mt-1 flex flex-wrap gap-4">
                        <label className="inline-flex items-center gap-2 text-sm">
                          <input
                            type="radio"
                            name="instagram-token-type"
                            value="page_access_token"
                            checked={igTokenType === "page_access_token"}
                            onChange={() =>
                              setIgTokenType("page_access_token")
                            }
                          />
                          {t("channels.igTokenTypePage")}
                        </label>
                        <label className="inline-flex items-center gap-2 text-sm">
                          <input
                            type="radio"
                            name="instagram-token-type"
                            value="system_user_token"
                            checked={igTokenType === "system_user_token"}
                            onChange={() =>
                              setIgTokenType("system_user_token")
                            }
                          />
                          {t("channels.igTokenTypeSystemUser")}
                        </label>
                      </div>
                    </fieldset>
                    {igTokenType === "page_access_token" ? (
                      <>
                        <label
                          className="mt-3 block text-sm font-medium"
                          htmlFor="instagram-page-id"
                        >
                          {t("channels.pageIdLabel")}
                        </label>
                        <input
                          id="instagram-page-id"
                          value={igPageId}
                          onChange={(e) => setIgPageId(e.target.value)}
                          placeholder={t("channels.pageIdPlaceholder")}
                          maxLength={64}
                          className={`${inputClassName} mt-1`}
                        />
                      </>
                    ) : null}
                    <label
                      className="mt-3 block text-sm font-medium"
                      htmlFor="instagram-token"
                    >
                      {igTokenType === "system_user_token"
                        ? t("channels.suatTokenLabel")
                        : t("channels.pageTokenLabel")}
                    </label>
                    <PasswordInput
                      t={t}
                      id="instagram-token"
                      autoComplete="off"
                      value={igToken}
                      onChange={(e) => setIgToken(e.target.value)}
                      placeholder={
                        igTokenType === "system_user_token"
                          ? t("channels.suatTokenPlaceholder")
                          : t("channels.pageTokenPlaceholder")
                      }
                      maxLength={1024}
                      className={`${inputClassName} mt-1`}
                    />
                    <p className="mt-1 text-xs text-muted">
                      {igTokenType === "system_user_token"
                        ? t("channels.suatTokenHint")
                        : t("channels.metaTokenHint")}
                    </p>
                    {igError ? (
                      <div className="mt-2">
                        <FieldError message={igError} />
                      </div>
                    ) : null}
                    <button
                      type="submit"
                      disabled={
                        igCreating ||
                        !igId.trim() ||
                        (igTokenType === "page_access_token" &&
                          !igPageId.trim()) ||
                        !igToken.trim()
                      }
                      className="mt-3 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                    >
                      {igCreating
                        ? t("channels.metaConnecting")
                        : t("channels.instagramConnectButton")}
                    </button>
                  </form>
                    ) : null}
                  </>
                ) : null}

                {connectStep === "whatsapp" ? (
                  <>
                    <MetaOAuthStepBlock
                      t={t}
                      provider="whatsapp"
                      available={
                        oauthInfo?.providers.whatsapp.available ?? false
                      }
                      starting={oauthStarting}
                      startError={oauthStartError}
                      onStart={(p) => void handleOAuthStart(p)}
                    />
                    <button
                      type="button"
                      onClick={() => setManualOpen((open) => !open)}
                      className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-accent"
                      aria-expanded={manualOpen}
                    >
                      {t("channels.oauthManualTitle")}
                      <ChevronRightIcon />
                    </button>
                    {manualOpen ? (
                  <form onSubmit={handleConnectWhatsApp}>
                    <label
                      className="mt-3 block text-sm font-medium"
                      htmlFor="whatsapp-name"
                    >
                      {t("channels.metaNameLabel")}
                    </label>
                    <input
                      id="whatsapp-name"
                      value={waName}
                      onChange={(e) => setWaName(e.target.value)}
                      placeholder={t("channels.metaNamePlaceholder")}
                      maxLength={255}
                      className={`${inputClassName} mt-1`}
                    />
                    <label
                      className="mt-3 block text-sm font-medium"
                      htmlFor="whatsapp-waba-id"
                    >
                      {t("channels.wabaIdLabel")}
                    </label>
                    <input
                      id="whatsapp-waba-id"
                      value={waWabaId}
                      onChange={(e) => setWaWabaId(e.target.value)}
                      placeholder={t("channels.wabaIdPlaceholder")}
                      maxLength={64}
                      className={`${inputClassName} mt-1`}
                    />
                    <label
                      className="mt-3 block text-sm font-medium"
                      htmlFor="whatsapp-phone-id"
                    >
                      {t("channels.phoneNumberIdLabel")}
                    </label>
                    <input
                      id="whatsapp-phone-id"
                      value={waPhoneId}
                      onChange={(e) => setWaPhoneId(e.target.value)}
                      placeholder={t("channels.phoneNumberIdPlaceholder")}
                      maxLength={64}
                      className={`${inputClassName} mt-1`}
                    />
                    <label
                      className="mt-3 block text-sm font-medium"
                      htmlFor="whatsapp-token"
                    >
                      {t("channels.waTokenLabel")}
                    </label>
                    <PasswordInput
                      t={t}
                      id="whatsapp-token"
                      autoComplete="off"
                      value={waToken}
                      onChange={(e) => setWaToken(e.target.value)}
                      placeholder={t("channels.waTokenPlaceholder")}
                      maxLength={1024}
                      className={`${inputClassName} mt-1`}
                    />
                    <p className="mt-1 text-xs text-muted">
                      {t("channels.waTokenHint")}
                    </p>
                    {waError ? (
                      <div className="mt-2">
                        <FieldError message={waError} />
                      </div>
                    ) : null}
                    <button
                      type="submit"
                      disabled={
                        waCreating ||
                        !waWabaId.trim() ||
                        !waPhoneId.trim() ||
                        !waToken.trim()
                      }
                      className="mt-3 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                    >
                      {waCreating
                        ? t("channels.metaConnecting")
                        : t("channels.whatsappConnectButton")}
                    </button>
                  </form>
                    ) : null}
                  </>
                ) : null}

                <div className="mt-4 flex justify-end">
                  <button
                    type="button"
                    onClick={() => setConnectStep(null)}
                    className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium"
                  >
                    {t("common.close")}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}

      {oauthSessionId ? (
        <div
          className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-label={t("channels.oauthPickerTitle")}
        >
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-xl sm:rounded-2xl">
            <h2 className="text-lg font-bold">
              {t("channels.oauthPickerTitle")}
            </h2>
            <p className="mt-1 text-sm text-muted">
              {t("channels.oauthPickerBody")}
            </p>
            {!oauthSession && !oauthSessionError ? (
              <p className="mt-4 text-sm text-muted">
                {t("channels.oauthPickerLoading")}
              </p>
            ) : null}
            {oauthSessionError ? (
              <div className="mt-3">
                <FieldError message={oauthSessionError} />
              </div>
            ) : null}
            {oauthSession && oauthSession.assets.length === 0 ? (
              <p className="mt-4 text-sm text-muted">
                {/* Fase 7D.3: petunjuk spesifik per penyebab kosong
                    (jenis token / izin bisnis / belum dibagikan) —
                    generik hanya bila server tak memberi petunjuk. */}
                {oauthSession.emptyHint === "not_system_user"
                  ? t("channels.oauthPickerEmptyNotSystemUser")
                  : oauthSession.emptyHint === "no_accounts_shared"
                    ? t("channels.oauthPickerEmptyNoAccounts")
                    : oauthSession.emptyHint ===
                        "business_permission_missing"
                      ? t("channels.oauthPickerEmptyBusinessPermission")
                      : t("channels.oauthPickerEmpty")}
              </p>
            ) : null}
            {oauthSession
              ? oauthGroups.map((group) => (
                  <div key={group.key} className="mt-4">
                    {oauthSession.provider === "whatsapp" ? (
                      <div className="text-xs font-semibold uppercase tracking-wide text-muted">
                        {group.parentName ?? group.key}
                      </div>
                    ) : null}
                    <div className="mt-2 space-y-2">
                      {group.assets.map((asset) => {
                        const title =
                          asset.name ??
                          (asset.handle
                            ? `@${asset.handle}`
                            : asset.assetId);
                        const subtitle =
                          oauthSession.provider === "whatsapp"
                            ? asset.handle
                            : asset.name && asset.handle
                              ? `@${asset.handle}`
                              : null;
                        // Hotfix R1: aset yang ditemukan tetapi tidak
                        // punya kredensial yang dapat dipakai (Page
                        // tanpa Page token) tetap ditampilkan —
                        // diredupkan, beralasan, tombol nonaktif.
                        const unavailable = asset.connectable === false;
                        return (
                          <div
                            key={asset.assetId}
                            className={`flex items-center gap-3 rounded-xl border border-line p-3${unavailable ? " opacity-70" : ""}`}
                          >
                            <ChannelAvatar
                              provider={oauthSession.provider}
                              name={title}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="truncate font-semibold">
                                {title}
                              </div>
                              {subtitle ? (
                                <div className="truncate font-mono text-sm text-muted">
                                  {subtitle}
                                </div>
                              ) : null}
                              {asset.linkedIgUsername ? (
                                <div className="truncate text-xs text-muted">
                                  {t("channels.oauthLinkedIgLabel", {
                                    username: asset.linkedIgUsername,
                                  })}
                                </div>
                              ) : null}
                              {unavailable ? (
                                <div className="mt-1 text-xs text-muted">
                                  {t(
                                    "channels.oauthPickerUnavailableMissingToken",
                                  )}
                                </div>
                              ) : null}
                            </div>
                            <button
                              type="button"
                              disabled={
                                oauthCompletingId !== null || unavailable
                              }
                              onClick={() => void handleOAuthComplete(asset)}
                              className="shrink-0 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
                            >
                              {oauthCompletingId === asset.assetId
                                ? t("channels.oauthPickerConnecting")
                                : t("channels.oauthPickerConnect")}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))
              : null}
            {oauthCompleteError ? (
              <div className="mt-3">
                <FieldError message={oauthCompleteError} />
              </div>
            ) : null}
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={closeOAuthPicker}
                disabled={oauthCompletingId !== null}
                className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium disabled:opacity-60"
              >
                {t("channels.oauthPickerCancel")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {deleteTarget ? (
        <div
          className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-xl sm:rounded-2xl">
            <h2 className="text-lg font-bold">{t("channels.deleteTitle")}</h2>
            <p className="mt-2 text-sm text-muted">
              {t("channels.deleteBody", {
                name:
                  deleteTarget.displayName ||
                  providerLabel(t, deleteTarget.provider),
              })}
            </p>
            <button
              type="button"
              onClick={() => void handleExport(deleteTarget)}
              className="mt-3 rounded-lg bg-elevated px-4 py-2 text-sm font-medium"
            >
              {t("channels.deleteExportButton")}
            </button>
            <label
              className="mt-4 block text-sm font-medium"
              htmlFor="delete-confirm-name"
            >
              {t("channels.deleteConfirmLabel")}:{" "}
              <span className="font-mono font-semibold">
                {deleteTarget.confirmationName}
              </span>
            </label>
            <input
              id="delete-confirm-name"
              value={deleteName}
              onChange={(e) => setDeleteName(e.target.value)}
              className={`${inputClassName} mt-1`}
              autoComplete="off"
            />
            {deleteError ? (
              <div className="mt-2">
                <FieldError message={deleteError} />
              </div>
            ) : null}
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                disabled={deleting || deleteName !== deleteTarget.confirmationName}
                onClick={() => void handleTrash()}
                className="rounded-lg bg-danger px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {deleting
                  ? t("channels.deleting")
                  : t("channels.deleteConfirmButton")}
              </button>
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium"
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {disconnectTarget ? (
        <div
          className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-xl sm:rounded-2xl">
            <h2 className="text-lg font-bold">{t("channels.disconnectTitle")}</h2>
            <p className="mt-2 text-sm text-muted">
              {t("channels.disconnectBody", {
                name:
                  disconnectTarget.displayName ||
                  providerLabel(t, disconnectTarget.provider),
              })}
            </p>
            {disconnectError ? (
              <div className="mt-2">
                <FieldError message={disconnectError} />
              </div>
            ) : null}
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                disabled={disconnecting}
                onClick={() => void handleDisconnect()}
                className="rounded-lg bg-danger px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {disconnecting
                  ? t("channels.disconnecting")
                  : t("channels.disconnectButton")}
              </button>
              <button
                type="button"
                onClick={() => setDisconnectTarget(null)}
                className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium"
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
