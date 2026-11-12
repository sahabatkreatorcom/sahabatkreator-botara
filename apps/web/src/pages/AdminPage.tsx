import { useCallback, useEffect, useRef, useState } from "react";
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
import { LEGAL_PATHS } from "../components/LegalLinks";
import { formatDateTime } from "../utils/format";

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
 * Baris URL read-only + tombol salin (Fase 7D.1) — pola yang sama dengan
 * baris Redirect URI OAuth: nilai ditampilkan mono, salin memberi
 * umpan balik "Tersalin!" selama 2 detik. State salin per baris.
 */
function CopyableUrlRow({
  t,
  label,
  url,
}: {
  t: Translate;
  label: string;
  url: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-xl bg-surface p-3">
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
          className="rounded-md bg-elevated px-2 py-1 text-xs font-medium text-ink"
        >
          {copied ? t("admin.copiedLabel") : t("admin.copyButton")}
        </button>
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
  // Aplikasi Threads (terpisah dari Meta App utama) — sub-blok di grup Meta.
  threads_app_id: "admin.threadsAppIdLabel",
  threads_webhook_verify_token: "admin.threadsWebhookVerifyTokenLabel",
  threads_app_secret: "admin.threadsAppSecretLabel",
  // Aplikasi TikTok (TikTok for Developers) — bagian tersendiri.
  tiktok_client_key: "admin.tiktokClientKeyLabel",
  tiktok_client_secret: "admin.tiktokClientSecretLabel",
  // Aplikasi LinkedIn (LinkedIn Developer Portal) — bagian tersendiri.
  linkedin_client_id: "admin.linkedinClientIdLabel",
  linkedin_client_secret: "admin.linkedinClientSecretLabel",
  // Aplikasi Pinterest (Pinterest Developers) — bagian tersendiri.
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
  post_media_public_base_url: "admin.postMediaPublicBaseUrlLabel",
  youtube_privacy_status: "admin.youtubePrivacyStatusLabel",
  tiktok_privacy_level: "admin.tiktokPrivacyLevelLabel",
};

/**
 * Halaman Panel Admin Platform (Fase 6C) — HANYA dirender untuk user
 * ber-flag isPlatformAdmin (menu pun disembunyikan untuk yang lain, dan
 * API menjawab 404 untuk non-admin). Mengelola kredensial provider milik
 * platform per grup (OpenRouter / R2 / Meta): status per kunci (chip sumber
 * Panel/Env/Belum diatur + jejak ubah), field password untuk nilai baru
 * (nilai tersimpan TIDAK PERNAH dirender kembali — field selalu mulai
 * kosong), tombol Simpan / Hapus (kembali ke env) / Uji koneksi.
 * Grup Meta (Fase 7A.1) hanya berisi App Secret dan SENGAJA tanpa tombol
 * Uji: Meta tidak menyediakan validasi app secret yang berdiri sendiri.
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
  const [redirectCopied, setRedirectCopied] = useState(false);
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

      <section className="mt-6">
        <h2 className="text-base font-semibold text-ink">
          {t("admin.openrouterTitle")}
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          {t("admin.openrouterBody")}
        </p>
        <div className="mt-4 space-y-3">
          <SettingRow
            t={t}
            locale={locale}
            settingKey="openrouter_api_key"
            status={byKey("openrouter_api_key")}
            onStatusChanged={onStatusChanged}
          />
          <SettingRow
            t={t}
            locale={locale}
            settingKey="openrouter_model"
            status={byKey("openrouter_model")}
            secret={false}
            onStatusChanged={onStatusChanged}
          />
          <SettingRow
            t={t}
            locale={locale}
            settingKey="openrouter_embedding_model"
            status={byKey("openrouter_embedding_model")}
            secret={false}
            onStatusChanged={onStatusChanged}
          />
        </div>
      </section>

      {/*
        Grup R2 SATU kesatuan (instruksi pemilik 2026-11-12): identitas
        bucket (account id, endpoint, bucket — publik, baris teks,
        nilai efektif ditampilkan di kartu), kredensial access key
        (rahasia, baris password + uji koneksi), dan base URL media
        publik yang memang alamat publik dari bucket yang sama (dulu
        di grup Content schedule). Baris publik dimuat ulang sesudah
        diubah agar kartu efektifnya segar — pola identifier Meta.
      */}
      <section className="mt-8">
        <h2 className="text-base font-semibold text-ink">{t("admin.r2Title")}</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">{t("admin.r2Body")}</p>
        {r2Info ? (
          <dl className="mt-3 grid max-w-2xl grid-cols-1 gap-2 text-sm sm:grid-cols-2">
            <div className="rounded-xl bg-surface p-3">
              <dt className="text-xs text-muted">{t("admin.r2AccountLabel")}</dt>
              <dd className="mt-0.5 break-all font-mono text-xs text-ink">
                {r2Info.accountId}
              </dd>
            </div>
            <div className="rounded-xl bg-surface p-3">
              <dt className="text-xs text-muted">{t("admin.r2EndpointLabel")}</dt>
              <dd className="mt-0.5 break-all font-mono text-xs text-ink">
                {r2Info.endpoint}
              </dd>
            </div>
            <div className="rounded-xl bg-surface p-3">
              <dt className="text-xs text-muted">{t("admin.r2BucketLabel")}</dt>
              <dd className="mt-0.5 break-all font-mono text-xs text-ink">
                {r2Info.bucket}
              </dd>
            </div>
            <div className="rounded-xl bg-surface p-3">
              <dt className="text-xs text-muted">
                {t("admin.postMediaPublicBaseUrlLabel")}
              </dt>
              <dd className="mt-0.5 break-all font-mono text-xs text-ink">
                {contentScheduleInfo?.publicMediaBaseUrl ?? "—"}
              </dd>
            </div>
          </dl>
        ) : null}
        <div className="mt-4 space-y-3">
          <SettingRow
            t={t}
            locale={locale}
            settingKey="r2_account_id"
            status={byKey("r2_account_id")}
            secret={false}
            onStatusChanged={(next) => {
              onStatusChanged(next);
              void load();
            }}
          />
          <SettingRow
            t={t}
            locale={locale}
            settingKey="r2_endpoint"
            status={byKey("r2_endpoint")}
            secret={false}
            onStatusChanged={(next) => {
              onStatusChanged(next);
              void load();
            }}
          />
          <SettingRow
            t={t}
            locale={locale}
            settingKey="r2_bucket"
            status={byKey("r2_bucket")}
            secret={false}
            onStatusChanged={(next) => {
              onStatusChanged(next);
              void load();
            }}
          />
          <SettingRow
            t={t}
            locale={locale}
            settingKey="r2_access_key_id"
            status={byKey("r2_access_key_id")}
            onStatusChanged={onStatusChanged}
          />
          <SettingRow
            t={t}
            locale={locale}
            settingKey="r2_secret_access_key"
            status={byKey("r2_secret_access_key")}
            onStatusChanged={onStatusChanged}
          />
          <SettingRow
            t={t}
            locale={locale}
            settingKey="post_media_public_base_url"
            status={byKey("post_media_public_base_url")}
            secret={false}
            onStatusChanged={(next) => {
              onStatusChanged(next);
              void load();
            }}
          />
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-base font-semibold text-ink">{t("admin.metaTitle")}</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">{t("admin.metaBody")}</p>
        <div className="mt-4 space-y-3">
          <SettingRow
            t={t}
            locale={locale}
            settingKey="meta_app_secret"
            status={byKey("meta_app_secret")}
            onStatusChanged={onStatusChanged}
          />
        </div>

        {/*
          Token verifikasi handshake webhook Meta — nilai yang KITA
          tentukan (bukan dari Meta). Baris password seperti app secret:
          nilai tersimpan tidak dirender; owner/admin workspace yang
          memasang webhook melihat nilai efektifnya di halaman Channel.
        */}
        <p className="mt-6 max-w-2xl text-sm text-muted">
          {t("admin.metaWebhookVerifyTokenBody")}
        </p>
        <div className="mt-4 space-y-3">
          <SettingRow
            t={t}
            locale={locale}
            settingKey="meta_webhook_verify_token"
            status={byKey("meta_webhook_verify_token")}
            onStatusChanged={onStatusChanged}
          />
        </div>

        {/*
          Fase 7D — identifier publik OAuth Meta. Berbeda dari kunci
          rahasia di atas: App ID & config ID BUKAN kredensial, jadi
          nilai efektifnya (panel → env) DITAMPILKAN agar bisa
          diverifikasi, dan field-nya teks biasa (bukan password).
          Baris tetap memakai mekanisme simpan/hapus panel yang sama.
        */}
        <p className="mt-6 max-w-2xl text-sm text-muted">
          {t("admin.metaPublicIdsBody")}
        </p>
        {metaInfo ? (
          <dl className="mt-3 grid max-w-2xl grid-cols-1 gap-2 text-sm">
            <div className="rounded-xl bg-surface p-3">
              <dt className="text-xs text-muted">
                {t("admin.metaOauthRedirectLabel")}
              </dt>
              <dd className="mt-0.5 flex flex-wrap items-center gap-2">
                <span className="break-all font-mono text-xs text-ink">
                  {metaInfo.oauthRedirectUri}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard
                      ?.writeText(metaInfo.oauthRedirectUri)
                      .then(() => {
                        setRedirectCopied(true);
                        setTimeout(() => setRedirectCopied(false), 2000);
                      })
                      .catch(() => undefined);
                  }}
                  className="rounded-md bg-elevated px-2 py-1 text-xs font-medium text-ink"
                >
                  {redirectCopied
                    ? t("admin.copiedLabel")
                    : t("admin.copyButton")}
                </button>
              </dd>
            </div>
            <div className="rounded-xl bg-surface p-3">
              <dt className="text-xs text-muted">{t("admin.metaAppIdLabel")}</dt>
              <dd className="mt-0.5 break-all font-mono text-xs text-ink">
                {metaInfo.appId ?? "—"}
              </dd>
            </div>
            <div className="rounded-xl bg-surface p-3">
              <dt className="text-xs text-muted">
                {t("admin.metaIgConfigIdLabel")}
              </dt>
              <dd className="mt-0.5 break-all font-mono text-xs text-ink">
                {metaInfo.igConfigId ?? "—"}
              </dd>
            </div>
            <div className="rounded-xl bg-surface p-3">
              <dt className="text-xs text-muted">
                {t("admin.metaWaConfigIdLabel")}
              </dt>
              <dd className="mt-0.5 break-all font-mono text-xs text-ink">
                {metaInfo.waConfigId ?? "—"}
              </dd>
            </div>
            {/*
              Fase 7D.1 — URL halaman legal publik untuk diisi ke
              pengaturan aplikasi Meta (Privasi & instruksi penghapusan
              data wajib ada untuk App Review). Nilainya diturunkan dari
              origin publik saat ini + path tetap halaman legal.
            */}
            <CopyableUrlRow
              t={t}
              label={t("admin.metaPrivacyUrlLabel")}
              url={`${window.location.origin}${LEGAL_PATHS.privacy}`}
            />
            <CopyableUrlRow
              t={t}
              label={t("admin.metaTermsUrlLabel")}
              url={`${window.location.origin}${LEGAL_PATHS.terms}`}
            />
            <CopyableUrlRow
              t={t}
              label={t("admin.metaDeletionUrlLabel")}
              url={`${window.location.origin}${LEGAL_PATHS.deletion}`}
            />
          </dl>
        ) : null}
        <div className="mt-4 space-y-3">
          <SettingRow
            t={t}
            locale={locale}
            settingKey="meta_app_id"
            status={byKey("meta_app_id")}
            secret={false}
            onStatusChanged={(next) => {
              onStatusChanged(next);
              void load();
            }}
          />
          <SettingRow
            t={t}
            locale={locale}
            settingKey="meta_ig_config_id"
            status={byKey("meta_ig_config_id")}
            secret={false}
            onStatusChanged={(next) => {
              onStatusChanged(next);
              void load();
            }}
          />
          <SettingRow
            t={t}
            locale={locale}
            settingKey="meta_wa_config_id"
            status={byKey("meta_wa_config_id")}
            secret={false}
            onStatusChanged={(next) => {
              onStatusChanged(next);
              void load();
            }}
          />
        </div>

        {/*
          Kredensial APLIKASI Threads — aplikasi TERPISAH dari Meta App
          utama (ditambahkan 2026-11-12 karena pemilik tidak menemukan
          formnya). Pola mengikuti Meta: app id publik (teks biasa,
          nilai efektif ditampilkan), app secret baris password yang
          tidak pernah dirender. BELUM ada konsumen — disiapkan untuk
          alur connect/OAuth Threads; penerbitan memakai token akun.
        */}
        <p className="mt-6 max-w-2xl text-sm text-muted">
          {t("admin.threadsBody")}
        </p>
        {threadsInfo ? (
          <dl className="mt-3 grid max-w-2xl grid-cols-1 gap-2 text-sm">
            <div className="rounded-xl bg-surface p-3">
              <dt className="text-xs text-muted">
                {t("admin.threadsAppIdLabel")}
              </dt>
              <dd className="mt-0.5 break-all font-mono text-xs text-ink">
                {threadsInfo.appId ?? "—"}
              </dd>
            </div>
          </dl>
        ) : null}
        <div className="mt-4 space-y-3">
          <SettingRow
            t={t}
            locale={locale}
            settingKey="threads_app_id"
            status={byKey("threads_app_id")}
            secret={false}
            onStatusChanged={(next) => {
              onStatusChanged(next);
              void load();
            }}
          />
          <SettingRow
            t={t}
            locale={locale}
            settingKey="threads_app_secret"
            status={byKey("threads_app_secret")}
            onStatusChanged={onStatusChanged}
          />
          <SettingRow
            t={t}
            locale={locale}
            settingKey="threads_webhook_verify_token"
            status={byKey("threads_webhook_verify_token")}
            onStatusChanged={onStatusChanged}
          />
        </div>
        <p className="mt-3 max-w-2xl text-sm text-muted">
          {t("admin.threadsWebhookVerifyTokenBody")}
        </p>
      </section>

      {/*
        Kredensial APLIKASI TikTok (TikTok for Developers) — bagian
        tersendiri (bukan aplikasi Meta): client key pengenal publik
        (teks biasa, nilai efektif ditampilkan), client secret baris
        password yang tidak pernah dirender. BELUM ada konsumen —
        disiapkan untuk alur connect/OAuth TikTok (Login Kit).
      */}
      <section className="mt-8">
        <h2 className="text-base font-semibold text-ink">
          {t("admin.tiktokTitle")}
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          {t("admin.tiktokBody")}
        </p>
        {tiktokInfo ? (
          <dl className="mt-3 grid max-w-2xl grid-cols-1 gap-2 text-sm">
            <div className="rounded-xl bg-surface p-3">
              <dt className="text-xs text-muted">
                {t("admin.tiktokClientKeyLabel")}
              </dt>
              <dd className="mt-0.5 break-all font-mono text-xs text-ink">
                {tiktokInfo.clientKey ?? "—"}
              </dd>
            </div>
          </dl>
        ) : null}
        <div className="mt-4 space-y-3">
          <SettingRow
            t={t}
            locale={locale}
            settingKey="tiktok_client_key"
            status={byKey("tiktok_client_key")}
            secret={false}
            onStatusChanged={(next) => {
              onStatusChanged(next);
              void load();
            }}
          />
          <SettingRow
            t={t}
            locale={locale}
            settingKey="tiktok_client_secret"
            status={byKey("tiktok_client_secret")}
            onStatusChanged={onStatusChanged}
          />
        </div>
      </section>

      {/*
        Kredensial APLIKASI LinkedIn (LinkedIn Developer Portal) —
        bagian tersendiri: client ID pengenal publik (teks biasa,
        nilai efektif ditampilkan), client secret baris password yang
        tidak pernah dirender. Konsumennya adalah alur connect/OAuth
        LinkedIn gelombang Semua OAuth (Sign In with LinkedIn +
        Share on LinkedIn) — token LinkedIn TIDAK bisa di-refresh,
        jadi connect ulang adalah bagian dari siklus hidupnya.
      */}
      <section className="mt-8">
        <h2 className="text-base font-semibold text-ink">
          {t("admin.linkedinTitle")}
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          {t("admin.linkedinBody")}
        </p>
        {linkedinInfo ? (
          <dl className="mt-3 grid max-w-2xl grid-cols-1 gap-2 text-sm">
            <div className="rounded-xl bg-surface p-3">
              <dt className="text-xs text-muted">
                {t("admin.linkedinClientIdLabel")}
              </dt>
              <dd className="mt-0.5 break-all font-mono text-xs text-ink">
                {linkedinInfo.clientId ?? "—"}
              </dd>
            </div>
          </dl>
        ) : null}
        <div className="mt-4 space-y-3">
          <SettingRow
            t={t}
            locale={locale}
            settingKey="linkedin_client_id"
            status={byKey("linkedin_client_id")}
            secret={false}
            onStatusChanged={(next) => {
              onStatusChanged(next);
              void load();
            }}
          />
          <SettingRow
            t={t}
            locale={locale}
            settingKey="linkedin_client_secret"
            status={byKey("linkedin_client_secret")}
            onStatusChanged={onStatusChanged}
          />
        </div>
      </section>

      {/*
        Kredensial APLIKASI Pinterest (Pinterest Developers) — bagian
        tersendiri: app ID pengenal publik (teks biasa, nilai efektif
        ditampilkan), app secret baris password yang tidak pernah
        dirender. Konsumennya adalah alur connect/OAuth Pinterest
        gelombang Semua OAuth + refresh token di worker (token
        endpoint v5 memakai pasangan ini sebagai Basic auth).
      */}
      <section className="mt-8">
        <h2 className="text-base font-semibold text-ink">
          {t("admin.pinterestTitle")}
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          {t("admin.pinterestBody")}
        </p>
        {pinterestInfo ? (
          <dl className="mt-3 grid max-w-2xl grid-cols-1 gap-2 text-sm">
            <div className="rounded-xl bg-surface p-3">
              <dt className="text-xs text-muted">
                {t("admin.pinterestAppIdLabel")}
              </dt>
              <dd className="mt-0.5 break-all font-mono text-xs text-ink">
                {pinterestInfo.appId ?? "—"}
              </dd>
            </div>
          </dl>
        ) : null}
        <div className="mt-4 space-y-3">
          <SettingRow
            t={t}
            locale={locale}
            settingKey="pinterest_app_id"
            status={byKey("pinterest_app_id")}
            secret={false}
            onStatusChanged={(next) => {
              onStatusChanged(next);
              void load();
            }}
          />
          <SettingRow
            t={t}
            locale={locale}
            settingKey="pinterest_app_secret"
            status={byKey("pinterest_app_secret")}
            onStatusChanged={onStatusChanged}
          />
        </div>
      </section>

      {/*
        Fase 11B — email transaksional Resend. Kunci API rahasia (baris
        password + tombol Uji via GET /domains); identitas pengirim
        BUKAN rahasia — nilai efektifnya ditampilkan seperti identifier
        Meta, dan barisnya teks biasa, dimuat ulang sesudah diubah agar
        tampilan efektifnya segar.
      */}
      <section className="mt-8">
        <h2 className="text-base font-semibold text-ink">
          {t("admin.resendTitle")}
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          {t("admin.resendBody")}
        </p>
        {emailInfo ? (
          <dl className="mt-3 grid max-w-2xl grid-cols-1 gap-2 text-sm sm:grid-cols-2">
            <div className="rounded-xl bg-surface p-3">
              <dt className="text-xs text-muted">
                {t("admin.resendFromEmailLabel")}
              </dt>
              <dd className="mt-0.5 break-all font-mono text-xs text-ink">
                {emailInfo.fromEmail ?? "—"}
              </dd>
            </div>
            <div className="rounded-xl bg-surface p-3">
              <dt className="text-xs text-muted">
                {t("admin.resendFromNameLabel")}
              </dt>
              <dd className="mt-0.5 break-all font-mono text-xs text-ink">
                {emailInfo.fromName ?? "—"}
              </dd>
            </div>
          </dl>
        ) : null}
        <div className="mt-4 space-y-3">
          <SettingRow
            t={t}
            locale={locale}
            settingKey="resend_api_key"
            status={byKey("resend_api_key")}
            onStatusChanged={onStatusChanged}
          />
          <SettingRow
            t={t}
            locale={locale}
            settingKey="resend_from_email"
            status={byKey("resend_from_email")}
            secret={false}
            onStatusChanged={(next) => {
              onStatusChanged(next);
              void load();
            }}
          />
          <SettingRow
            t={t}
            locale={locale}
            settingKey="resend_from_name"
            status={byKey("resend_from_name")}
            secret={false}
            onStatusChanged={(next) => {
              onStatusChanged(next);
              void load();
            }}
          />
        </div>
      </section>

      {/*
        Fase 13G — klien OAuth Google milik platform. Client ID publik
        (baris teks + nilai efektif ditampilkan); client secret rahasia
        (baris password, SENGAJA tanpa tombol Uji — pola Meta app
        secret). Gelombang Pemisahan Google: pasangan pertama kini
        berperan BERSAMA/fallback; tiga pasangan per layanan di bawah
        membolehkan proyek Cloud terpisah per layanan (billing/kuota/
        persetujuan API sendiri-sendiri). Client ID efektif per
        layanan ditampilkan agar pemilik bisa memverifikasi rantai
        fallback-nya.
      */}
      <section className="mt-8">
        <h2 className="text-base font-semibold text-ink">
          {t("admin.googleTitle")}
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          {t("admin.googleBody")}
        </p>
        {googleInfo ? (
          <dl className="mt-3 grid max-w-2xl grid-cols-1 gap-2 text-sm">
            <div className="rounded-xl bg-surface p-3">
              <dt className="text-xs text-muted">
                {t("admin.googleOauthClientIdLabel")}
              </dt>
              <dd className="mt-0.5 break-all font-mono text-xs text-ink">
                {googleInfo.clientId ?? "—"}
              </dd>
            </div>
            <CopyableUrlRow
              t={t}
              label={`${t("admin.googleServiceCalendarName")} — ${t("admin.googleOauthRedirectLabel")}`}
              url={googleInfo.services.calendar.redirectUri}
            />
            <CopyableUrlRow
              t={t}
              label={`${t("admin.googleServiceYoutubeName")} — ${t("admin.googleOauthRedirectLabel")}`}
              url={googleInfo.services.youtube.redirectUri}
            />
            <CopyableUrlRow
              t={t}
              label={`${t("admin.googleServiceBusinessName")} — ${t("admin.googleOauthRedirectLabel")}`}
              url={googleInfo.services.business.redirectUri}
            />
            <div className="rounded-xl bg-surface p-3">
              <dt className="text-xs text-muted">
                {t("admin.googleServiceEffectiveLabel")}
              </dt>
              <dd className="mt-0.5 break-all font-mono text-xs text-ink">
                {t("admin.googleServiceCalendarName")}:{" "}
                {googleInfo.services.calendar.clientId ?? "—"}
                <br />
                {t("admin.googleServiceYoutubeName")}:{" "}
                {googleInfo.services.youtube.clientId ?? "—"}
                <br />
                {t("admin.googleServiceBusinessName")}:{" "}
                {googleInfo.services.business.clientId ?? "—"}
              </dd>
            </div>
          </dl>
        ) : null}
        <div className="mt-4 space-y-3">
          <SettingRow
            t={t}
            locale={locale}
            settingKey="google_oauth_client_id"
            status={byKey("google_oauth_client_id")}
            secret={false}
            onStatusChanged={(next) => {
              onStatusChanged(next);
              void load();
            }}
          />
          <SettingRow
            t={t}
            locale={locale}
            settingKey="google_oauth_client_secret"
            status={byKey("google_oauth_client_secret")}
            onStatusChanged={onStatusChanged}
          />
          <SettingRow
            t={t}
            locale={locale}
            settingKey="google_calendar_client_id"
            status={byKey("google_calendar_client_id")}
            secret={false}
            onStatusChanged={(next) => {
              onStatusChanged(next);
              void load();
            }}
          />
          <SettingRow
            t={t}
            locale={locale}
            settingKey="google_calendar_client_secret"
            status={byKey("google_calendar_client_secret")}
            onStatusChanged={onStatusChanged}
          />
          <SettingRow
            t={t}
            locale={locale}
            settingKey="google_youtube_client_id"
            status={byKey("google_youtube_client_id")}
            secret={false}
            onStatusChanged={(next) => {
              onStatusChanged(next);
              void load();
            }}
          />
          <SettingRow
            t={t}
            locale={locale}
            settingKey="google_youtube_client_secret"
            status={byKey("google_youtube_client_secret")}
            onStatusChanged={onStatusChanged}
          />
          <SettingRow
            t={t}
            locale={locale}
            settingKey="google_business_client_id"
            status={byKey("google_business_client_id")}
            secret={false}
            onStatusChanged={(next) => {
              onStatusChanged(next);
              void load();
            }}
          />
          <SettingRow
            t={t}
            locale={locale}
            settingKey="google_business_client_secret"
            status={byKey("google_business_client_secret")}
            onStatusChanged={onStatusChanged}
          />
        </div>
      </section>

      {/*
        Pengaturan content schedule multi-platform — BUKAN kredensial:
        dua level privasi enum (base URL media publik PINDAH ke grup
        Cloudflare R2 di atas — ia alamat publik bucket yang sama).
        Nilai efektif (panel → env → bawaan aman) DITAMPILKAN seperti
        grup publik lain; barisnya teks biasa dan dimuat ulang sesudah
        diubah agar tampilan efektifnya segar. Nilai di luar pilihan
        sah ditolak server saat disimpan.
      */}
      <section className="mt-8">
        <h2 className="text-base font-semibold text-ink">
          {t("admin.contentScheduleTitle")}
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          {t("admin.contentScheduleBody")}
        </p>
        {contentScheduleInfo ? (
          <dl className="mt-3 grid max-w-2xl grid-cols-1 gap-2 text-sm sm:grid-cols-2">
            <div className="rounded-xl bg-surface p-3">
              <dt className="text-xs text-muted">
                {t("admin.youtubePrivacyStatusLabel")}
              </dt>
              <dd className="mt-0.5 break-all font-mono text-xs text-ink">
                {contentScheduleInfo.youtubePrivacyStatus}
              </dd>
            </div>
            <div className="rounded-xl bg-surface p-3">
              <dt className="text-xs text-muted">
                {t("admin.tiktokPrivacyLevelLabel")}
              </dt>
              <dd className="mt-0.5 break-all font-mono text-xs text-ink">
                {contentScheduleInfo.tiktokPrivacyLevel}
              </dd>
            </div>
          </dl>
        ) : null}
        <div className="mt-4 space-y-3">
          <SettingRow
            t={t}
            locale={locale}
            settingKey="youtube_privacy_status"
            status={byKey("youtube_privacy_status")}
            secret={false}
            onStatusChanged={(next) => {
              onStatusChanged(next);
              void load();
            }}
          />
          <SettingRow
            t={t}
            locale={locale}
            settingKey="tiktok_privacy_level"
            status={byKey("tiktok_privacy_level")}
            secret={false}
            onStatusChanged={(next) => {
              onStatusChanged(next);
              void load();
            }}
          />
        </div>
      </section>

      <UnresolvedLogsSection t={t} locale={locale} />
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

function SettingRow({
  t,
  locale,
  settingKey,
  status,
  secret = true,
  onStatusChanged,
}: {
  t: Translate;
  locale: Locale;
  settingKey: PlatformSettingKey;
  status: PlatformSettingStatus | null;
  /** True = input password (kredensial); false = teks biasa (nama model). */
  secret?: boolean;
  onStatusChanged: (next: PlatformSettingStatus) => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState<"save" | "clear" | "test" | null>(null);
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

  const handleSave = async () => {
    if (!value.trim()) return;
    setBusy("save");
    setRowError(null);
    try {
      const next = await api.admin.setSetting(settingKey, value.trim());
      setValue("");
      setTestResult(null);
      onStatusChanged(next);
    } catch (err) {
      setRowError(translateApiError(t, err));
    } finally {
      setBusy(null);
    }
  };

  const handleClear = async () => {
    setBusy("clear");
    setRowError(null);
    try {
      const next = await api.admin.clearSetting(settingKey);
      setConfirmClear(false);
      setTestResult(null);
      onStatusChanged(next);
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
    <div className="max-w-2xl rounded-xl bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-ink">{label}</span>
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

      <label className="mt-3 block">
        <span className="mb-1 block text-xs font-medium text-muted">
          {t("admin.newValueLabel")}
        </span>
        {secret ? (
          <PasswordInput
            t={t}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={t("admin.newValuePlaceholder")}
            autoComplete="off"
            className={inputClassName}
          />
        ) : (
          <input
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
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
      <FieldError message={rowError} />

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={busy !== null || !value.trim()}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
        >
          {busy === "save" ? t("admin.saving") : t("admin.saveButton")}
        </button>
        {status?.source === "panel" ? (
          <button
            type="button"
            onClick={() => setConfirmClear(true)}
            disabled={busy !== null}
            className="rounded-lg bg-elevated px-3 py-2 text-sm font-medium text-red-600 disabled:opacity-60"
          >
            {t("admin.clearButton")}
          </button>
        ) : null}
        {TESTABLE.has(settingKey) ? (
          <button
            type="button"
            onClick={handleTest}
            disabled={busy !== null}
            className="rounded-lg bg-elevated px-3 py-2 text-sm font-medium text-ink disabled:opacity-60"
          >
            {busy === "test" ? t("admin.testing") : t("admin.testButton")}
          </button>
        ) : null}
      </div>

      {testResult ? (
        <div className="mt-3 rounded-lg bg-elevated px-3 py-2 text-sm">
          <span
            className={testResult.ok ? "text-accent" : "text-red-600"}
          >
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
