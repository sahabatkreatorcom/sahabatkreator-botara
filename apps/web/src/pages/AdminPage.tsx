import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  IntegrationLogResponse,
  PlatformContentScheduleInfo,
  PlatformEmailInfo,
  PlatformGoogleInfo,
  PlatformMetaInfo,
  PlatformSettingKey,
  PlatformSettingStatus,
  PlatformSettingTestResult,
  PlatformR2Info,
  PlatformThreadsInfo,
  PlatformTikTokInfo,
  PlatformLinkedInInfo,
  PlatformPinterestInfo,
} from "@sahabat-kreator/contracts";
import type { Locale, TranslationKey } from "@sahabat-kreator/i18n";
import { api } from "../api/client";
import { translateApiError } from "../api/errorText";
import { FieldError, inputClassName } from "../components/AuthLayout";
import { PasswordInput } from "../components/PasswordInput";
import { ProviderGlyph, providerMeta } from "../components/ChannelAvatar";
import { LEGAL_PATHS } from "../components/LegalLinks";
import { formatDateTime } from "../utils/format";
import {
  WEBHOOK_PATHS,
  adminCardById,
  type AdminCardId,
  type AdminCardFieldSpec,
} from "./admin/platformCards";

type Translate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

interface AdminPageProps {
  t: Translate;
  locale: Locale;
}

const TESTABLE: ReadonlySet<PlatformSettingKey> = new Set([
  "openrouter_api_key",
  "r2_access_key_id",
  "r2_secret_access_key",
  "resend_api_key",
]);

/**
 * Baris URL read-only + tombol salin — pola baris Redirect URI OAuth:
 * nilai ditampilkan mono, salin memberi umpan balik "Tersalin!" selama
 * 2 detik. State salin per baris. Varian kotak info kartu memakai
 * `bg-elevated` (kotak krem referensi) di atas permukaan kartu.
 */
function CopyableUrlRow({
  t,
  label,
  url,
  help,
  boxed = false,
}: {
  t: Translate;
  label: string;
  url: string;
  help?: string;
  boxed?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={`rounded-xl p-3 ${boxed ? "bg-elevated" : "bg-surface"}`}>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 flex flex-wrap items-center gap-2">
        <span className="break-all font-mono text-xs text-ink">{url}</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(url)
              .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              })
              .catch(() => undefined);
          }}
          className="rounded-md bg-surface px-2 py-1 text-xs font-medium text-ink"
        >
          {copied ? t("admin.copiedLabel") : t("admin.copyButton")}
        </button>
      </dd>
      {help ? <p className="mt-1 text-xs text-muted">{help}</p> : null}
    </div>
  );
}

/** Kotak nilai efektif read-only (identifier publik / identitas R2). */
function InfoValue({
  label,
  value,
}: {
  label: string;
  value: string | null;
}) {
  return (
    <div className="rounded-xl bg-elevated p-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 break-all font-mono text-xs text-ink">
        {value ?? "—"}
      </dd>
    </div>
  );
}

const KEY_LABELS: Record<PlatformSettingKey, TranslationKey> = {
  openrouter_api_key: "admin.openrouterApiKeyLabel",
  openrouter_model: "admin.openrouterModelLabel",
  openrouter_embedding_model: "admin.openrouterEmbeddingModelLabel",
  r2_access_key_id: "admin.r2AccessKeyIdLabel",
  r2_secret_access_key: "admin.r2SecretAccessKeyLabel",
  // Label baris identitas memakai ulang label kartu info di atasnya
  // (pola Meta: metaAppIdLabel dipakai kartu sekaligus baris).
  r2_account_id: "admin.r2AccountLabel",
  r2_endpoint: "admin.r2EndpointLabel",
  r2_bucket: "admin.r2BucketLabel",
  meta_app_secret: "admin.metaAppSecretLabel",
  meta_webhook_verify_token: "admin.metaWebhookVerifyTokenLabel",
  meta_app_id: "admin.metaAppIdLabel",
  meta_ig_config_id: "admin.metaIgConfigIdLabel",
  meta_wa_config_id: "admin.metaWaConfigIdLabel",
  // Aplikasi Threads (terpisah dari Meta App utama) — kartu Threads.
  threads_app_id: "admin.threadsAppIdLabel",
  threads_app_secret: "admin.threadsAppSecretLabel",
  threads_webhook_verify_token: "admin.threadsWebhookVerifyTokenLabel",
  // Aplikasi TikTok (TikTok for Developers) — kartu TikTok.
  tiktok_client_key: "admin.tiktokClientKeyLabel",
  tiktok_client_secret: "admin.tiktokClientSecretLabel",
  // Aplikasi LinkedIn (LinkedIn Developer Portal) — kartu LinkedIn.
  linkedin_client_id: "admin.linkedinClientIdLabel",
  linkedin_client_secret: "admin.linkedinClientSecretLabel",
  // Aplikasi Pinterest (Pinterest Developers) — kartu Pinterest.
  pinterest_app_id: "admin.pinterestAppIdLabel",
  pinterest_app_secret: "admin.pinterestAppSecretLabel",
  resend_api_key: "admin.resendApiKeyLabel",
  resend_from_email: "admin.resendFromEmailLabel",
  resend_from_name: "admin.resendFromNameLabel",
  google_oauth_client_id: "admin.googleOauthClientIdLabel",
  google_oauth_client_secret: "admin.googleOauthClientSecretLabel",
  // Gelombang Pemisahan Google: kredensial aplikasi per layanan.
  google_calendar_client_id: "admin.googleCalendarClientIdLabel",
  google_calendar_client_secret: "admin.googleCalendarClientSecretLabel",
  google_youtube_client_id: "admin.googleYoutubeClientIdLabel",
  google_youtube_client_secret: "admin.googleYoutubeClientSecretLabel",
  google_business_client_id: "admin.googleBusinessClientIdLabel",
  google_business_client_secret: "admin.googleBusinessClientSecretLabel",
  // G16: layanan Google Ads — klien OAuth per layanan + developer
  // token milik platform (kartu Google Ads).
  google_ads_client_id: "admin.googleAdsClientIdLabel",
  google_ads_client_secret: "admin.googleAdsClientSecretLabel",
  google_ads_developer_token: "admin.googleAdsDeveloperTokenLabel",
  // G17: layanan Google Sheets — klien OAuth per layanan (kartu
  // Google Sheets).
  google_sheets_client_id: "admin.googleSheetsClientIdLabel",
  google_sheets_client_secret: "admin.googleSheetsClientSecretLabel",
  post_media_public_base_url: "admin.postMediaPublicBaseUrlLabel",
  youtube_privacy_status: "admin.youtubePrivacyStatusLabel",
  tiktok_privacy_level: "admin.tiktokPrivacyLevelLabel",
};

/** Teks bantuan per kolom (di bawah input) — hanya untuk kunci yang perlu. */
const FIELD_HELP: Partial<Record<PlatformSettingKey, TranslationKey>> = {
  // Privasi bawaan postingan: default panel yang dapat ditimpa
  // pengguna per postingan di formulir /posts (koreksi pemilik).
  youtube_privacy_status: "admin.postPrivacyDefaultHelp",
  tiktok_privacy_level: "admin.postPrivacyDefaultHelp",
};

/**
 * Halaman Panel Admin Platform (Fase 6C) — HANYA dirender untuk user
 * ber-flag isPlatformAdmin (menu pun disembunyikan untuk yang lain, dan
 * API menjawab 404 untuk non-admin). Mengelola kredensial provider
 * milik platform per grup: status per kunci (chip sumber Panel/Env/
 * Belum diatur + jejak ubah), field password untuk nilai baru (nilai
 * tersimpan TIDAK PERNAH dirender kembali — field selalu mulai kosong),
 * tombol Simpan / Hapus (kembali ke env) / Uji koneksi.
 *
 * Tata letak GRID KARTU per platform (permintaan pemilik 2026-11-12
 * dengan referensi UI): pemetaan kunci → kartu hidup di registry
 * `admin/platformCards.ts` (dibuktikan test), tombol Simpan kini per
 * kartu (menyimpan hanya kunci kartu itu lewat API yang sama), dan
 * keterangan SUMBER nilai efektif per kolom (Panel / Environment /
 * Belum diatur) dipertahankan persis seperti perilaku sebelumnya —
 * termasuk untuk status kartu: nilai dari Environment tetap berarti
 * terkonfigurasi. Semantik resolver panel→env, enkripsi, audit, dan
 * guard admin TIDAK berubah; ini murni penataan presentasi.
 */
export function AdminPage({ t, locale }: AdminPageProps) {
  const [statuses, setStatuses] = useState<PlatformSettingStatus[]>([]);
  const [r2Info, setR2Info] = useState<PlatformR2Info | null>(null);
  const [metaInfo, setMetaInfo] = useState<PlatformMetaInfo | null>(null);
  const [threadsInfo, setThreadsInfo] =
    useState<PlatformThreadsInfo | null>(null);
  const [tiktokInfo, setTiktokInfo] =
    useState<PlatformTikTokInfo | null>(null);
  const [linkedinInfo, setLinkedinInfo] =
    useState<PlatformLinkedInInfo | null>(null);
  const [pinterestInfo, setPinterestInfo] =
    useState<PlatformPinterestInfo | null>(null);
  const [emailInfo, setEmailInfo] = useState<PlatformEmailInfo | null>(null);
  const [googleInfo, setGoogleInfo] = useState<PlatformGoogleInfo | null>(
    null,
  );
  const [contentScheduleInfo, setContentScheduleInfo] =
    useState<PlatformContentScheduleInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const body = await api.admin.getSettings();
      if (requestSeq.current !== seq) return;
      setStatuses(body.settings);
      setR2Info(body.r2);
      setMetaInfo(body.meta);
      setThreadsInfo(body.threads);
      setTiktokInfo(body.tiktok);
      setLinkedinInfo(body.linkedin);
      setPinterestInfo(body.pinterest);
      setEmailInfo(body.email);
      setGoogleInfo(body.google);
      setContentScheduleInfo(body.contentSchedule);
    } catch (err) {
      if (requestSeq.current !== seq) return;
      setError(translateApiError(t, err));
      setStatuses([]);
    } finally {
      if (requestSeq.current === seq) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const byKey = (key: PlatformSettingKey) =>
    statuses.find((s) => s.key === key) ?? null;

  const onStatusChanged = (next: PlatformSettingStatus) => {
    setStatuses((prev) =>
      prev.map((s) => (s.key === next.key ? next : s)),
    );
  };

  /** Terkonfigurasi = punya nilai EFEKTIF (panel ATAU environment). */
  const pairConfigured = (
    idKey: PlatformSettingKey,
    secretKey: PlatformSettingKey,
  ) => Boolean(byKey(idKey)?.isSet && byKey(secretKey)?.isSet);

  /** Status kartu default: semua kunci wajibnya efektif terisi. */
  const cardConfigured = (id: AdminCardId): boolean => {
    // Layanan Google: terkonfigurasi bila pasangan kliennya sendiri
    // lengkap, ATAU ia benar-benar berjalan di atas pasangan bersama
    // (clientId efektif layanan == clientId bersama DAN pasangan
    // bersama lengkap). Semua pemeriksaan memakai keadaan EFEKTIF
    // (isSet = panel atau environment) — nilai dari env tetap berarti
    // terkonfigurasi, sumbernya ditunjukkan chip per kolom.
    if (
      id === "google-calendar" ||
      id === "youtube" ||
      id === "google-business" ||
      id === "google-ads" ||
      id === "google-sheets"
    ) {
      const service =
        id === "google-calendar"
          ? "calendar"
          : id === "youtube"
            ? "youtube"
            : id === "google-business"
              ? "business"
              : id === "google-ads"
                ? "ads"
                : "sheets";
      const effectiveId = googleInfo?.services[service].clientId ?? null;
      if (!effectiveId) return false;
      const [ownId, ownSecret] = adminCardById(id).requiredKeys;
      let pairOk = false;
      if (ownId && ownSecret && pairConfigured(ownId, ownSecret)) {
        pairOk = true;
      } else {
        pairOk =
          effectiveId === (googleInfo?.clientId ?? null) &&
          pairConfigured(
            "google_oauth_client_id",
            "google_oauth_client_secret",
          );
      }
      if (!pairOk) return false;
      // G16: khusus Ads, pasangan klien saja tidak cukup — panggilan
      // Ads API juga wajib membawa developer token platform.
      if (id === "google-ads") {
        return Boolean(byKey("google_ads_developer_token")?.isSet);
      }
      return true;
    }
    return adminCardById(id).requiredKeys.every((k) => byKey(k)?.isSet);
  };

  const origin = window.location.origin;
  const canonicalUrl = (path: string) => `${origin}${path}`;

  const cardShell = (
    id: AdminCardId,
    props: {
      title: string;
      caps: TranslationKey;
      icon: ReactNode;
      body?: ReactNode;
      info?: ReactNode;
    },
  ) => (
    <PlatformCard
      key={id}
      t={t}
      locale={locale}
      cardId={id}
      title={props.title}
      caps={t(props.caps)}
      configured={cardConfigured(id)}
      icon={props.icon}
      body={props.body}
      info={props.info}
      byKey={byKey}
      onStatusChanged={onStatusChanged}
      onReload={() => void load()}
    />
  );

  const providerIcon = (provider: string) => (
    <span
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
      style={{
        color: providerMeta(provider).color,
        backgroundColor: `${providerMeta(provider).color}1A`,
      }}
    >
      <ProviderGlyph provider={provider} className="h-5 w-5" />
    </span>
  );

  const genericIcon = (glyph: ReactNode) => (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-elevated text-muted">
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
        {glyph}
      </svg>
    </span>
  );

  return (
    <div>
      <h1 className="text-xl font-bold text-ink">{t("nav.admin")}</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted">{t("admin.intro")}</p>

      {error ? (
        <p className="mt-3 rounded-lg bg-elevated px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      ) : null}
      {loading && statuses.length === 0 ? (
        <p className="mt-4 text-sm text-muted">{t("common.loading")}</p>
      ) : null}

      <div className="mt-6 grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
        {cardShell("meta", {
          title: t("admin.metaTitle"),
          caps: "admin.cardCapsOauthWebhook",
          icon: providerIcon("messenger"),
          body: (
            <>
              <p>{t("admin.metaBody")}</p>
              <p>{t("admin.metaPublicIdsBody")}</p>
              <p>{t("admin.metaWebhookVerifyTokenBody")}</p>
            </>
          ),
          info: metaInfo ? (
            <>
              <CopyableUrlRow
                t={t}
                boxed
                label={t("admin.cardCallbackLabel")}
                url={metaInfo.oauthRedirectUri}
                help={t("admin.cardCallbackHelp")}
              />
              <CopyableUrlRow
                t={t}
                boxed
                label={t("admin.cardWebhookLabel")}
                url={canonicalUrl(WEBHOOK_PATHS.meta)}
                help={t("admin.metaWebhookHelp")}
              />
              <CopyableUrlRow
                t={t}
                boxed
                label={`${t("admin.cardWebhookLabel")} — WhatsApp`}
                url={canonicalUrl(WEBHOOK_PATHS.whatsapp)}
                help={t("admin.whatsappWebhookHelp")}
              />
              <CopyableUrlRow
                t={t}
                boxed
                label={t("admin.cardDataDeletionLabel")}
                url={canonicalUrl(WEBHOOK_PATHS.metaDataDeletion)}
                help={t("admin.metaDataDeletionHelp")}
              />
              <InfoValue
                label={t("admin.metaAppIdLabel")}
                value={metaInfo.appId}
              />
              <InfoValue
                label={t("admin.metaIgConfigIdLabel")}
                value={metaInfo.igConfigId}
              />
              <InfoValue
                label={t("admin.metaWaConfigIdLabel")}
                value={metaInfo.waConfigId}
              />
              {/*
                URL halaman legal publik untuk diisi ke pengaturan
                aplikasi Meta (Privasi & instruksi penghapusan data
                wajib ada untuk App Review) — diturunkan dari origin
                publik saat ini + path tetap halaman legal.
              */}
              <CopyableUrlRow
                t={t}
                boxed
                label={t("admin.metaPrivacyUrlLabel")}
                url={`${origin}${LEGAL_PATHS.privacy}`}
              />
              <CopyableUrlRow
                t={t}
                boxed
                label={t("admin.metaTermsUrlLabel")}
                url={`${origin}${LEGAL_PATHS.terms}`}
              />
              <CopyableUrlRow
                t={t}
                boxed
                label={t("admin.metaDeletionUrlLabel")}
                url={`${origin}${LEGAL_PATHS.deletion}`}
              />
            </>
          ) : null,
        })}

        {cardShell("threads", {
          title: t("admin.threadsTitle"),
          caps: "admin.cardCapsOauthWebhook",
          icon: providerIcon("threads"),
          body: (
            <>
              <p>{t("admin.threadsBody")}</p>
              <p className="mt-2">{t("admin.threadsWebhookVerifyTokenBody")}</p>
            </>
          ),
          info: (
            <>
              <CopyableUrlRow
                t={t}
                boxed
                label={t("admin.cardCallbackLabel")}
                url={canonicalUrl(
                  adminCardById("threads").callbackPath ?? "",
                )}
                help={t("admin.cardCallbackHelp")}
              />
              <CopyableUrlRow
                t={t}
                boxed
                label={t("admin.cardWebhookLabel")}
                url={canonicalUrl(WEBHOOK_PATHS.threads)}
                help={t("admin.threadsWebhookHelp")}
              />
              {threadsInfo ? (
                <InfoValue
                  label={t("admin.threadsAppIdLabel")}
                  value={threadsInfo.appId}
                />
              ) : null}
            </>
          ),
        })}

        {cardShell("tiktok", {
          title: t("admin.tiktokTitle"),
          caps: "admin.cardCapsOauthWebhook",
          icon: providerIcon("tiktok"),
          body: <p>{t("admin.tiktokBody")}</p>,
          info: (
            <>
              <CopyableUrlRow
                t={t}
                boxed
                label={t("admin.cardCallbackLabel")}
                url={canonicalUrl(adminCardById("tiktok").callbackPath ?? "")}
                help={t("admin.cardCallbackHelp")}
              />
              <CopyableUrlRow
                t={t}
                boxed
                label={t("admin.cardWebhookLabel")}
                url={canonicalUrl(WEBHOOK_PATHS.tiktok)}
                help={t("admin.tiktokWebhookHelp")}
              />
              {tiktokInfo ? (
                <InfoValue
                  label={t("admin.tiktokClientKeyLabel")}
                  value={tiktokInfo.clientKey}
                />
              ) : null}
              {contentScheduleInfo ? (
                <InfoValue
                  label={t("admin.tiktokPrivacyLevelLabel")}
                  value={contentScheduleInfo.tiktokPrivacyLevel}
                />
              ) : null}
            </>
          ),
        })}

        {cardShell("linkedin", {
          title: t("admin.linkedinTitle"),
          caps: "admin.cardCapsOauth",
          icon: providerIcon("linkedin"),
          body: <p>{t("admin.linkedinBody")}</p>,
          info: (
            <>
              <CopyableUrlRow
                t={t}
                boxed
                label={t("admin.cardCallbackLabel")}
                url={canonicalUrl(
                  adminCardById("linkedin").callbackPath ?? "",
                )}
                help={t("admin.cardCallbackHelp")}
              />
              {linkedinInfo ? (
                <InfoValue
                  label={t("admin.linkedinClientIdLabel")}
                  value={linkedinInfo.clientId}
                />
              ) : null}
            </>
          ),
        })}

        {cardShell("pinterest", {
          title: t("admin.pinterestTitle"),
          caps: "admin.cardCapsOauth",
          icon: providerIcon("pinterest"),
          body: <p>{t("admin.pinterestBody")}</p>,
          info: (
            <>
              <CopyableUrlRow
                t={t}
                boxed
                label={t("admin.cardCallbackLabel")}
                url={canonicalUrl(
                  adminCardById("pinterest").callbackPath ?? "",
                )}
                help={t("admin.cardCallbackHelp")}
              />
              {pinterestInfo ? (
                <InfoValue
                  label={t("admin.pinterestAppIdLabel")}
                  value={pinterestInfo.appId}
                />
              ) : null}
            </>
          ),
        })}

        {cardShell("google-calendar", {
          title: t("admin.googleCalendarTitle"),
          caps: "admin.cardCapsOauth",
          icon: providerIcon("google"),
          body: <p>{t("admin.googleBody")}</p>,
          info: googleInfo ? (
            <>
              <CopyableUrlRow
                t={t}
                boxed
                label={t("admin.cardCallbackLabel")}
                url={googleInfo.services.calendar.redirectUri}
                help={t("admin.cardCallbackHelp")}
              />
              <InfoValue
                label={t("admin.googleCalendarClientIdLabel")}
                value={googleInfo.services.calendar.clientId}
              />
            </>
          ) : null,
        })}

        {cardShell("youtube", {
          title: t("admin.googleYoutubeTitle"),
          caps: "admin.cardCapsOauth",
          icon: providerIcon("youtube"),
          body: <p>{t("admin.googleBody")}</p>,
          info: googleInfo ? (
            <>
              <CopyableUrlRow
                t={t}
                boxed
                label={t("admin.cardCallbackLabel")}
                url={googleInfo.services.youtube.redirectUri}
                help={t("admin.cardCallbackHelp")}
              />
              <InfoValue
                label={t("admin.googleYoutubeClientIdLabel")}
                value={googleInfo.services.youtube.clientId}
              />
              {contentScheduleInfo ? (
                <InfoValue
                  label={t("admin.youtubePrivacyStatusLabel")}
                  value={contentScheduleInfo.youtubePrivacyStatus}
                />
              ) : null}
            </>
          ) : null,
        })}

        {cardShell("google-business", {
          title: t("admin.googleBusinessTitle"),
          caps: "admin.cardCapsOauth",
          icon: providerIcon("google_business"),
          body: <p>{t("admin.googleBody")}</p>,
          info: googleInfo ? (
            <>
              <CopyableUrlRow
                t={t}
                boxed
                label={t("admin.cardCallbackLabel")}
                url={googleInfo.services.business.redirectUri}
                help={t("admin.cardCallbackHelp")}
              />
              <InfoValue
                label={t("admin.googleBusinessClientIdLabel")}
                value={googleInfo.services.business.clientId}
              />
            </>
          ) : null,
        })}

        {cardShell("google-ads", {
          title: t("admin.googleAdsTitle"),
          caps: "admin.cardCapsOauth",
          icon: providerIcon("google"),
          body: <p>{t("admin.googleAdsBody")}</p>,
          info: googleInfo ? (
            <>
              <CopyableUrlRow
                t={t}
                boxed
                label={t("admin.cardCallbackLabel")}
                url={googleInfo.services.ads.redirectUri}
                help={t("admin.cardCallbackHelp")}
              />
              <InfoValue
                label={t("admin.googleAdsClientIdLabel")}
                value={googleInfo.services.ads.clientId}
              />
            </>
          ) : null,
        })}

        {cardShell("google-sheets", {
          title: t("admin.googleSheetsTitle"),
          caps: "admin.cardCapsOauth",
          icon: providerIcon("google"),
          body: <p>{t("admin.googleSheetsBody")}</p>,
          info: googleInfo ? (
            <>
              <CopyableUrlRow
                t={t}
                boxed
                label={t("admin.cardCallbackLabel")}
                url={googleInfo.services.sheets.redirectUri}
                help={t("admin.cardCallbackHelp")}
              />
              <InfoValue
                label={t("admin.googleSheetsClientIdLabel")}
                value={googleInfo.services.sheets.clientId}
              />
            </>
          ) : null,
        })}

        {cardShell("google-shared", {
          title: t("admin.googleSharedTitle"),
          caps: "admin.cardCapsGoogleShared",
          icon: providerIcon("google"),
          body: <p>{t("admin.googleSharedBody")}</p>,
          info: googleInfo ? (
            <InfoValue
              label={t("admin.googleOauthClientIdLabel")}
              value={googleInfo.clientId}
            />
          ) : null,
        })}

        {cardShell("r2", {
          title: t("admin.r2Title"),
          caps: "admin.cardCapsStorage",
          icon: genericIcon(
            <>
              <path d="M17.5 19a4.5 4.5 0 0 0 .9-8.9 6 6 0 0 0-11.7 1.1A4 4 0 0 0 7 19h10.5z" />
            </>,
          ),
          body: <p>{t("admin.r2Body")}</p>,
          info: r2Info ? (
            <>
              <InfoValue
                label={t("admin.r2AccountLabel")}
                value={r2Info.accountId}
              />
              <InfoValue
                label={t("admin.r2EndpointLabel")}
                value={r2Info.endpoint}
              />
              <InfoValue
                label={t("admin.r2BucketLabel")}
                value={r2Info.bucket}
              />
              <InfoValue
                label={t("admin.postMediaPublicBaseUrlLabel")}
                value={contentScheduleInfo?.publicMediaBaseUrl ?? null}
              />
            </>
          ) : null,
        })}

        {cardShell("openrouter", {
          title: t("admin.openrouterTitle"),
          caps: "admin.cardCapsLlm",
          icon: genericIcon(
            <>
              <path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15.5l-1.9-4.6L5.5 9l4.6-1.4L12 3z" />
              <path d="M19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2z" />
            </>,
          ),
          body: <p>{t("admin.openrouterBody")}</p>,
        })}

        {cardShell("resend", {
          title: t("admin.resendTitle"),
          caps: "admin.cardCapsEmail",
          icon: genericIcon(
            <>
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <path d="M3 7l9 6 9-6" />
            </>,
          ),
          body: <p>{t("admin.resendBody")}</p>,
          info: emailInfo ? (
            <>
              <InfoValue
                label={t("admin.resendFromEmailLabel")}
                value={emailInfo.fromEmail}
              />
              <InfoValue
                label={t("admin.resendFromNameLabel")}
                value={emailInfo.fromName}
              />
            </>
          ) : null,
        })}
      </div>

      <UnresolvedLogsSection t={t} locale={locale} />
    </div>
  );
}

/**
 * Satu kartu platform: kepala (ikon + nama + lencana status efektif),
 * subjudul kemampuan + status konfigurasi, teks penjelasan, kotak info
 * URL/nilai efektif, kolom-kolom kuncinya, dan tombol Simpan per kartu
 * (menyimpan HANYA kunci kartu ini yang terisi, satu per satu lewat API
 * yang sama seperti sebelumnya; hasil dilaporkan per kartu).
 */
function PlatformCard({
  t,
  locale,
  cardId,
  title,
  caps,
  configured,
  icon,
  body,
  info,
  byKey,
  onStatusChanged,
  onReload,
}: {
  t: Translate;
  locale: Locale;
  cardId: AdminCardId;
  title: string;
  caps: string;
  configured: boolean;
  icon: ReactNode;
  body?: ReactNode;
  info?: ReactNode;
  byKey: (key: PlatformSettingKey) => PlatformSettingStatus | null;
  onStatusChanged: (next: PlatformSettingStatus) => void;
  onReload: () => void;
}) {
  const spec = adminCardById(cardId);
  const [values, setValues] = useState<
    Partial<Record<PlatformSettingKey, string>>
  >({});
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [saveErrors, setSaveErrors] = useState<
    { label: string; message: string }[]
  >([]);

  const dirtyFields = spec.fields.filter((f) =>
    (values[f.key] ?? "").trim(),
  );

  const handleSaveCard = async () => {
    if (dirtyFields.length === 0 || saving) return;
    setSaving(true);
    setSavedNotice(null);
    setSaveErrors([]);
    const savedLabels: string[] = [];
    const errors: { label: string; message: string }[] = [];
    let needsReload = false;
    for (const field of dirtyFields) {
      const value = (values[field.key] ?? "").trim();
      try {
        const next = await api.admin.setSetting(field.key, value);
        onStatusChanged(next);
        savedLabels.push(t(KEY_LABELS[field.key]));
        if (field.reloadOnChange) needsReload = true;
        setValues((prev) => ({ ...prev, [field.key]: "" }));
      } catch (err) {
        errors.push({
          label: t(KEY_LABELS[field.key]),
          message: translateApiError(t, err),
        });
      }
    }
    if (savedLabels.length > 0) {
      setSavedNotice(
        t("admin.cardSavedNotice", { names: savedLabels.join(", ") }),
      );
    }
    setSaveErrors(errors);
    setSaving(false);
    if (needsReload) onReload();
  };

  return (
    <section className="rounded-2xl bg-surface p-5">
      <div className="flex items-start gap-3">
        {icon}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-ink">{title}</h2>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                configured
                  ? "bg-success/15 text-success"
                  : "bg-elevated text-muted"
              }`}
            >
              {configured
                ? t("admin.cardActiveBadge")
                : t("admin.cardInactiveBadge")}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-muted">
            {caps} ·{" "}
            {configured
              ? t("admin.cardConfiguredText")
              : t("admin.cardUnconfiguredText")}
          </p>
        </div>
      </div>

      {body ? (
        <div className="mt-3 space-y-2 text-sm text-muted">{body}</div>
      ) : null}

      {info ? <dl className="mt-4 grid grid-cols-1 gap-2">{info}</dl> : null}

      <div className="mt-4 space-y-4">
        {spec.fields.map((field) => (
          <CardField
            key={field.key}
            t={t}
            locale={locale}
            field={field}
            status={byKey(field.key)}
            value={values[field.key] ?? ""}
            onValueChange={(next) =>
              setValues((prev) => ({ ...prev, [field.key]: next }))
            }
            disabled={saving}
            onStatusChanged={onStatusChanged}
            onReload={onReload}
          />
        ))}
      </div>

      {savedNotice ? (
        <p className="mt-3 rounded-lg bg-elevated px-3 py-2 text-sm text-success">
          {savedNotice}
        </p>
      ) : null}
      {saveErrors.length > 0 ? (
        <div className="mt-3 rounded-lg bg-elevated px-3 py-2 text-sm text-red-600">
          {saveErrors.map((e) => (
            <p key={e.label}>
              {e.label}: {e.message}
            </p>
          ))}
        </div>
      ) : null}

      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={() => void handleSaveCard()}
          disabled={saving || dirtyFields.length === 0}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
        >
          {saving ? t("admin.saving") : t("admin.saveButton")}
        </button>
      </div>
    </section>
  );
}

/**
 * Satu kolom kunci di dalam kartu. Mempertahankan perilaku baris lama
 * persis: chip SUMBER nilai efektif (Panel / Environment / Belum
 * diatur — istilah & data API yang sama), jejak ubah panel, input
 * nilai baru (password untuk rahasia — placeholder "sudah tersimpan"
 * tidak pernah menampilkan nilai; teks biasa untuk identifier publik),
 * tombol Hapus (kembali ke environment, dengan konfirmasi) dan Uji
 * koneksi untuk kunci yang bisa diuji. Penyimpanan nilai baru kini
 * lewat tombol Simpan kartu.
 */
function CardField({
  t,
  locale,
  field,
  status,
  value,
  onValueChange,
  disabled,
  onStatusChanged,
  onReload,
}: {
  t: Translate;
  locale: Locale;
  field: AdminCardFieldSpec;
  status: PlatformSettingStatus | null;
  value: string;
  onValueChange: (next: string) => void;
  disabled: boolean;
  onStatusChanged: (next: PlatformSettingStatus) => void;
  onReload: () => void;
}) {
  const settingKey = field.key;
  const [busy, setBusy] = useState<"clear" | "test" | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [testResult, setTestResult] =
    useState<PlatformSettingTestResult | null>(null);

  const label = t(KEY_LABELS[settingKey]);
  const sourceChip = !status?.isSet
    ? { text: t("admin.sourceNone"), cls: "bg-elevated text-muted" }
    : status.source === "panel"
      ? { text: t("admin.sourcePanel"), cls: "bg-accent/15 text-accent" }
      : { text: t("admin.sourceEnv"), cls: "bg-elevated text-ink" };

  const handleClear = async () => {
    setBusy("clear");
    setRowError(null);
    try {
      const next = await api.admin.clearSetting(settingKey);
      setConfirmClear(false);
      setTestResult(null);
      onStatusChanged(next);
      if (field.reloadOnChange) onReload();
    } catch (err) {
      setRowError(translateApiError(t, err));
    } finally {
      setBusy(null);
    }
  };

  const handleTest = async () => {
    setBusy("test");
    setRowError(null);
    try {
      setTestResult(await api.admin.testSetting(settingKey));
    } catch (err) {
      setRowError(translateApiError(t, err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-ink">{label}</span>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${sourceChip.cls}`}
        >
          {sourceChip.text}
        </span>
      </div>
      {status?.source === "panel" && status.updatedAt ? (
        <div className="mt-1 text-xs text-muted">
          {t("admin.updatedLabel", {
            date: formatDateTime(status.updatedAt, locale),
            by: status.updatedBy ?? "—",
          })}
        </div>
      ) : null}

      <label className="mt-2 block">
        <span className="mb-1 block text-xs font-medium text-muted">
          {t("admin.newValueLabel")}
        </span>
        {field.secret ? (
          <PasswordInput
            t={t}
            value={value}
            onChange={(e) => onValueChange(e.target.value)}
            placeholder={
              status?.isSet
                ? t("admin.secretSavedPlaceholder")
                : t("admin.newValuePlaceholder")
            }
            autoComplete="off"
            className={inputClassName}
          />
        ) : (
          <input
            type="text"
            value={value}
            onChange={(e) => onValueChange(e.target.value)}
            placeholder={
              settingKey === "openrouter_model"
                ? t("admin.openrouterModelPlaceholder")
                : t("admin.newValuePlaceholder")
            }
            autoComplete="off"
            className={inputClassName}
          />
        )}
      </label>
      {FIELD_HELP[settingKey] ? (
        <p className="mt-1 text-xs text-muted">
          {t(FIELD_HELP[settingKey]!)}
        </p>
      ) : null}
      <FieldError message={rowError} />

      {status?.source === "panel" || TESTABLE.has(settingKey) ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {status?.source === "panel" ? (
            <button
              type="button"
              onClick={() => setConfirmClear(true)}
              disabled={busy !== null || disabled}
              className="rounded-lg bg-elevated px-3 py-1.5 text-xs font-medium text-red-600 disabled:opacity-60"
            >
              {t("admin.clearButton")}
            </button>
          ) : null}
          {TESTABLE.has(settingKey) ? (
            <button
              type="button"
              onClick={handleTest}
              disabled={busy !== null || disabled}
              className="rounded-lg bg-elevated px-3 py-1.5 text-xs font-medium text-ink disabled:opacity-60"
            >
              {busy === "test" ? t("admin.testing") : t("admin.testButton")}
            </button>
          ) : null}
        </div>
      ) : null}

      {testResult ? (
        <div className="mt-2 rounded-lg bg-elevated px-3 py-2 text-sm">
          <span className={testResult.ok ? "text-accent" : "text-red-600"}>
            {testResult.ok
              ? t("admin.testOk")
              : t("admin.testFailed", { code: testResult.code })}
          </span>
          {testResult.ok && testResult.info ? (
            <span className="text-muted">
              {typeof testResult.info.label === "string"
                ? ` · ${t("admin.testInfoLabel")}: ${testResult.info.label}`
                : ""}
              {typeof testResult.info.isFreeTier === "boolean"
                ? ` · ${t("admin.testInfoTier")}: ${testResult.info.isFreeTier ? "✓" : "—"}`
                : ""}
              {typeof testResult.info.limitRemaining === "number"
                ? ` · ${t("admin.testInfoLimitRemaining")}: ${testResult.info.limitRemaining}`
                : ""}
              {typeof testResult.info.domains === "number"
                ? ` · ${t("admin.resendTestInfoDomains")}: ${testResult.info.domains}`
                : ""}
            </span>
          ) : null}
        </div>
      ) : null}

      {confirmClear ? (
        <div
          className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-lg rounded-t-2xl bg-surface p-5 shadow-xl sm:rounded-2xl">
            <h3 className="text-lg font-bold text-ink">
              {t("admin.clearConfirmTitle")}
            </h3>
            <p className="mt-2 text-sm text-muted">
              {t("admin.clearConfirmBody", { name: label })}
            </p>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={handleClear}
                disabled={busy !== null}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {busy === "clear" ? t("admin.clearing") : t("admin.clearButton")}
              </button>
              <button
                type="button"
                onClick={() => setConfirmClear(false)}
                className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium text-ink"
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Label outcome log integrasi — kunci yang sama seperti halaman Logs. */
const LOG_OUTCOME_LABEL_KEYS: Record<string, TranslationKey> = {
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
 * Kelayakan replay platform di sisi UI (cermin aturan server — server
 * tetap penegak akhirnya): arah masuk, tanda tangan valid saat intake,
 * payload tersimpan, outcome belum final (`error` /
 * `ignored_disconnected`).
 */
function isPlatformReplayEligible(row: IntegrationLogResponse): boolean {
  return (
    row.direction === "in" &&
    row.signatureValid === true &&
    row.hasPayload &&
    (row.outcome === "error" || row.outcome === "ignored_disconnected")
  );
}

/**
 * Seksi event integrasi tak ber-tenant (Fase 13A — menutup sisa 7B.2):
 * baris `integration_log` tenant-NULL tidak terjangkau replay tenant,
 * jadi admin platform memproses ulangnya dari sini. Daftar ringkas
 * (provider, outcome, waktu, ringkasan) + tombol proses ulang untuk
 * baris yang eligible; hasil replay tampil sebagai outcome baris-baris
 * baru, dan daftar dimuat ulang sesudahnya.
 */
function UnresolvedLogsSection({
  t,
  locale,
}: {
  t: Translate;
  locale: Locale;
}) {
  const [rows, setRows] = useState<IntegrationLogResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replayingId, setReplayingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const page = await api.logs.listUnresolved({ limit: 20 });
      if (requestSeq.current !== seq) return;
      setRows(page.logs);
      setError(null);
    } catch {
      if (requestSeq.current !== seq) return;
      setError(t("admin.unresolvedLoadError"));
      setRows([]);
    } finally {
      if (requestSeq.current === seq) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const outcomeLabel = (outcome: string): string => {
    const key = LOG_OUTCOME_LABEL_KEYS[outcome];
    return key ? t(key) : outcome;
  };

  const replay = async (row: IntegrationLogResponse) => {
    setReplayingId(row.id);
    setNotice(null);
    setActionError(null);
    try {
      const result = await api.logs.replayUnresolved(row.id);
      setNotice(
        t("admin.unresolvedReplayDone", {
          outcomes: result.outcomes.map(outcomeLabel).join(", "),
        }),
      );
      await load();
    } catch (err) {
      setActionError(translateApiError(t, err));
    } finally {
      setReplayingId(null);
    }
  };

  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-ink">
          {t("admin.unresolvedTitle")}
        </h2>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="rounded-md bg-elevated px-2.5 py-1 text-xs font-medium text-ink disabled:opacity-50"
        >
          {t("admin.unresolvedRefreshButton")}
        </button>
      </div>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        {t("admin.unresolvedBody")}
      </p>
      {error ? (
        <p className="mt-3 rounded-lg bg-elevated px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      ) : null}
      {actionError ? (
        <p className="mt-3 rounded-lg bg-elevated px-3 py-2 text-sm text-red-600">
          {actionError}
        </p>
      ) : null}
      {notice ? (
        <p className="mt-3 rounded-lg bg-elevated px-3 py-2 text-sm text-ink">
          {notice}
        </p>
      ) : null}
      {loading && rows.length === 0 ? (
        <p className="mt-4 text-sm text-muted">{t("common.loading")}</p>
      ) : rows.length === 0 && !error ? (
        <p className="mt-4 text-sm text-muted">{t("admin.unresolvedEmpty")}</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-surface p-3 text-sm"
            >
              <span className="rounded-md bg-elevated px-2 py-0.5 font-mono text-xs text-ink">
                {row.provider}
              </span>
              <span className="font-medium text-ink">
                {outcomeLabel(row.outcome)}
              </span>
              <span className="text-xs text-muted">
                {formatDateTime(row.createdAt, locale)}
              </span>
              {row.summary ? (
                <span className="min-w-0 flex-1 truncate text-xs text-muted">
                  {row.summary}
                </span>
              ) : null}
              {isPlatformReplayEligible(row) ? (
                <button
                  type="button"
                  onClick={() => void replay(row)}
                  disabled={replayingId !== null}
                  className="rounded-md bg-accent px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50"
                >
                  {replayingId === row.id
                    ? t("admin.unresolvedReplaying")
                    : t("admin.unresolvedReplayButton")}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
