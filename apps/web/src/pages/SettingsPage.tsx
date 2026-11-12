import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  API_KEY_SCOPES,
  OUTBOUND_WEBHOOK_EVENT_TYPES,
  type ApiKeyResponse,
  type ApiKeyScope,
  type CreatedApiKeyResponse,
  type CreatedOutboundWebhookResponse,
  type OutboundWebhookDeliveryResponse,
  type OutboundWebhookEventType,
  type OutboundWebhookResponse,
  type InvitationResponse,
  type InvitableRole,
  type MemberRole,
  type PaymentEnvironment,
  type PaymentProvider,
  type PaymentSettingsResponse,
  type TeamMemberResponse,
  type UpdatePaymentSettingsRequest,
  type WorkSchedule,
} from "@sahabat-kreator/contracts";
import type { Locale, TranslationKey } from "@sahabat-kreator/i18n";
import { api } from "../api/client";
import { translateApiError } from "../api/errorText";
import { FieldError, inputClassName } from "../components/AuthLayout";
import { PasswordInput } from "../components/PasswordInput";
import { formatDateTime, formatRelativeTime } from "../utils/format";
import { useWorkspace } from "../workspace/WorkspaceProvider";

type Translate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

// ---------------------------------------------------------------------------
// Pengaturan pembayaran (Fase 14A) — Settings → Payments
// ---------------------------------------------------------------------------

type PaymentKeyField = Exclude<
  keyof UpdatePaymentSettingsRequest,
  "provider" | "environment"
>;

const MIDTRANS_KEY_FIELDS: {
  field: PaymentKeyField;
  env: PaymentEnvironment;
  kind: "server" | "client";
}[] = [
  { field: "midtransSandboxServerKey", env: "sandbox", kind: "server" },
  { field: "midtransSandboxClientKey", env: "sandbox", kind: "client" },
  { field: "midtransProductionServerKey", env: "production", kind: "server" },
  { field: "midtransProductionClientKey", env: "production", kind: "client" },
];

const XENDIT_KEY_FIELDS: {
  field: PaymentKeyField;
  env: PaymentEnvironment;
  kind: "server" | "client" | "callback";
}[] = [
  { field: "xenditSandboxServerKey", env: "sandbox", kind: "server" },
  { field: "xenditSandboxClientKey", env: "sandbox", kind: "client" },
  { field: "xenditSandboxCallbackToken", env: "sandbox", kind: "callback" },
  { field: "xenditProductionServerKey", env: "production", kind: "server" },
  { field: "xenditProductionClientKey", env: "production", kind: "client" },
  { field: "xenditProductionCallbackToken", env: "production", kind: "callback" },
];

function keyConfigured(
  settings: PaymentSettingsResponse,
  field: PaymentKeyField,
): boolean {
  const m = settings.midtrans;
  const x = settings.xendit;
  switch (field) {
    case "midtransSandboxServerKey":
      return m.sandbox.serverKeyConfigured;
    case "midtransSandboxClientKey":
      return m.sandbox.clientKeyConfigured;
    case "midtransProductionServerKey":
      return m.production.serverKeyConfigured;
    case "midtransProductionClientKey":
      return m.production.clientKeyConfigured;
    case "xenditSandboxServerKey":
      return x.sandbox.serverKeyConfigured;
    case "xenditSandboxClientKey":
      return x.sandbox.clientKeyConfigured;
    case "xenditProductionServerKey":
      return x.production.serverKeyConfigured;
    case "xenditProductionClientKey":
      return x.production.clientKeyConfigured;
    case "xenditSandboxCallbackToken":
      return x.sandbox.callbackTokenConfigured;
    case "xenditProductionCallbackToken":
      return x.production.callbackTokenConfigured;
  }
}

/**
 * Seksi Payments: provider + environment aktif tenant dan kunci per
 * (provider, environment). Nilai kunci TIDAK PERNAH ditampilkan —
 * server hanya melaporkan terkonfigurasi/tidak; kolom kosong saat
 * simpan berarti "pertahankan", tombol hapus mengirim penghapusan
 * eksplisit. Uji koneksi menguji provider+environment AKTIF.
 */
function PaymentsSection({
  t,
  tenantId,
  canManage,
}: {
  t: Translate;
  tenantId: string;
  canManage: boolean;
}) {
  const [settings, setSettings] = useState<PaymentSettingsResponse | null>(
    null,
  );
  const [provider, setProvider] = useState<PaymentProvider>("simulation");
  const [environment, setEnvironment] =
    useState<PaymentEnvironment>("sandbox");
  const [keyValues, setKeyValues] = useState<
    Partial<Record<PaymentKeyField, string>>
  >({});
  const [cleared, setCleared] = useState<PaymentKeyField[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const [testOk, setTestOk] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const s = await api.paymentSettings.get(tenantId);
      setSettings(s);
      setProvider(s.provider);
      setEnvironment(s.environment);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    setSaveError(null);
    setTestMessage(null);
    try {
      const input: UpdatePaymentSettingsRequest = { provider, environment };
      for (const field of [
        ...MIDTRANS_KEY_FIELDS,
        ...XENDIT_KEY_FIELDS,
      ]) {
        if (cleared.includes(field.field)) input[field.field] = "";
        else if (keyValues[field.field]) input[field.field] = keyValues[field.field];
      }
      const s = await api.paymentSettings.update(tenantId, input);
      setSettings(s);
      setProvider(s.provider);
      setEnvironment(s.environment);
      setKeyValues({});
      setCleared([]);
      setSaved(true);
    } catch (err) {
      setSaveError(translateApiError(t, err));
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTestMessage(null);
    try {
      const r = await api.paymentSettings.test(tenantId);
      setTestOk(r.ok);
      setTestMessage(
        r.ok
          ? t("settings.payments.testOk")
          : r.code === "NOT_CONFIGURED"
            ? t("settings.payments.testNotConfigured")
            : r.code.endsWith("AUTH_FAILED")
              ? t("settings.payments.testAuthFailed")
              : t("settings.payments.testUnreachable"),
      );
    } catch (err) {
      setTestOk(false);
      setTestMessage(translateApiError(t, err));
    } finally {
      setTesting(false);
    }
  };

  const renderKeyField = (
    field: PaymentKeyField,
    kind: "server" | "client" | "callback",
  ) => {
    const configured = settings ? keyConfigured(settings, field) : false;
    const isCleared = cleared.includes(field);
    return (
      <div key={field}>
        <label
          htmlFor={`pay-${field}`}
          className="mb-1 flex items-center gap-2 text-sm font-medium text-ink"
        >
          {kind === "server"
            ? t("settings.payments.serverKeyLabel")
            : kind === "client"
              ? t("settings.payments.clientKeyLabel")
              : t("settings.payments.callbackTokenLabel")}
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
              configured && !isCleared
                ? "bg-elevated text-accent"
                : "bg-elevated text-muted"
            }`}
          >
            {configured && !isCleared
              ? t("settings.payments.configuredLabel")
              : t("settings.payments.notConfiguredLabel")}
          </span>
        </label>
        <PasswordInput
          t={t}
          id={`pay-${field}`}
          value={keyValues[field] ?? ""}
          onChange={(e) =>
            setKeyValues((prev) => ({ ...prev, [field]: e.target.value }))
          }
          className={inputClassName}
          autoComplete="off"
          disabled={!canManage || isCleared}
          placeholder={
            configured
              ? t("settings.payments.keyPlaceholderConfigured")
              : t("settings.payments.keyPlaceholderEmpty")
          }
        />
        {configured && canManage ? (
          <button
            type="button"
            onClick={() =>
              setCleared((prev) =>
                isCleared
                  ? prev.filter((f) => f !== field)
                  : [...prev, field],
              )
            }
            className="mt-1 text-xs font-medium text-danger"
          >
            {isCleared
              ? t("common.cancel")
              : t("settings.payments.clearKeyLabel")}
          </button>
        ) : null}
      </div>
    );
  };

  const renderEnvGroup = (
    title: string,
    fields: { field: PaymentKeyField; kind: "server" | "client" | "callback" }[],
  ) => (
    <div className="mt-4">
      <h4 className="text-sm font-semibold text-ink">{title}</h4>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        {fields.map((f) => renderKeyField(f.field, f.kind))}
      </div>
    </div>
  );

  return (
    <section className="mt-10">
      <h2 className="text-base font-semibold text-ink">
        {t("settings.payments.title")}
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        {t("settings.payments.body")}
      </p>
      {!canManage ? (
        <p className="mt-2 max-w-2xl text-sm text-muted">
          {t("settings.payments.adminOnlyNote")}
        </p>
      ) : null}
      {loading ? (
        <p className="mt-4 text-sm text-muted">{t("common.loading")}</p>
      ) : loadError || !settings ? (
        <p className="mt-4 text-sm text-danger">
          {t("settings.payments.loadError")}
        </p>
      ) : (
        <form onSubmit={save} className="mt-4 max-w-2xl">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label
                htmlFor="pay-provider"
                className="mb-1 block text-sm font-medium text-ink"
              >
                {t("settings.payments.providerLabel")}
              </label>
              <select
                id="pay-provider"
                value={provider}
                onChange={(e) =>
                  setProvider(e.target.value as PaymentProvider)
                }
                disabled={!canManage}
                className={inputClassName}
              >
                <option value="simulation">
                  {t("settings.payments.providerSimulation")}
                </option>
                <option value="midtrans">
                  {t("settings.payments.providerMidtrans")}
                </option>
                <option value="xendit">
                  {t("settings.payments.providerXendit")}
                </option>
              </select>
            </div>
            <div>
              <label
                htmlFor="pay-environment"
                className="mb-1 block text-sm font-medium text-ink"
              >
                {t("settings.payments.environmentLabel")}
              </label>
              <select
                id="pay-environment"
                value={environment}
                onChange={(e) =>
                  setEnvironment(e.target.value as PaymentEnvironment)
                }
                disabled={!canManage}
                className={inputClassName}
              >
                <option value="sandbox">
                  {t("settings.payments.environmentSandbox")}
                </option>
                <option value="production">
                  {t("settings.payments.environmentProduction")}
                </option>
              </select>
            </div>
          </div>

          {provider === "midtrans" ? (
            <div className="mt-5 rounded-xl border border-line bg-surface p-4">
              <h3 className="text-sm font-bold text-ink">{t("settings.payments.midtransTitle")}</h3>
              {renderEnvGroup(
                t("settings.payments.sandboxTitle"),
                MIDTRANS_KEY_FIELDS.filter((f) => f.env === "sandbox"),
              )}
              {renderEnvGroup(
                t("settings.payments.productionTitle"),
                MIDTRANS_KEY_FIELDS.filter((f) => f.env === "production"),
              )}
            </div>
          ) : null}

          {provider === "xendit" ? (
            <div className="mt-5 rounded-xl border border-line bg-surface p-4">
              <h3 className="text-sm font-bold text-ink">{t("settings.payments.xenditTitle")}</h3>
              {renderEnvGroup(
                t("settings.payments.sandboxTitle"),
                XENDIT_KEY_FIELDS.filter((f) => f.env === "sandbox"),
              )}
              {renderEnvGroup(
                t("settings.payments.productionTitle"),
                XENDIT_KEY_FIELDS.filter((f) => f.env === "production"),
              )}
            </div>
          ) : null}

          <div className="mt-5 rounded-xl border border-line bg-surface p-4">
            <h3 className="text-sm font-bold text-ink">
              {t("settings.payments.webhookTitle")}
            </h3>
            <p className="mt-1 text-sm text-muted">
              {t("settings.payments.webhookBody")}
            </p>
            <p className="mt-2 break-all font-mono text-xs text-ink">
              {t("settings.payments.webhookMidtrans", { url: settings.webhookUrls.midtrans })}
            </p>
            <p className="mt-1 break-all font-mono text-xs text-ink">
              {t("settings.payments.webhookXendit", { url: settings.webhookUrls.xendit })}
            </p>
          </div>

          <FieldError message={saveError} />
          {saved ? (
            <p className="mt-3 rounded-lg bg-elevated px-3 py-2 text-sm text-ink">
              {t("settings.payments.savedLabel")}
            </p>
          ) : null}
          {testMessage ? (
            <p
              className={`mt-3 rounded-lg bg-elevated px-3 py-2 text-sm ${
                testOk ? "text-ink" : "text-danger"
              }`}
            >
              {testMessage}
            </p>
          ) : null}
          {canManage ? (
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="submit"
                disabled={saving}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                {saving
                  ? t("settings.payments.saving")
                  : t("settings.payments.saveButton")}
              </button>
              <button
                type="button"
                disabled={testing || provider === "simulation"}
                onClick={() => void runTest()}
                className="rounded-lg bg-elevated px-4 py-2 text-sm font-semibold text-ink disabled:opacity-50"
              >
                {testing
                  ? t("settings.payments.testing")
                  : t("settings.payments.testButton")}
              </button>
            </div>
          ) : null}
        </form>
      )}
    </section>
  );
}

interface SettingsPageProps {
  t: Translate;
  locale: Locale;
}

const SCOPE_LABEL_KEYS: Record<ApiKeyScope, TranslationKey> = {
  "contacts:read": "settings.scopeContactsRead",
  "contacts:write": "settings.scopeContactsWrite",
  "conversations:read": "settings.scopeConversationsRead",
  "messages:write": "settings.scopeMessagesWrite",
  "products:read": "settings.scopeProductsRead",
  "comments:read": "settings.scopeCommentsRead",
  "comments:write": "settings.scopeCommentsWrite",
  "broadcasts:read": "settings.scopeBroadcastsRead",
  "flows:read": "settings.scopeFlowsRead",
  "automations:read": "settings.scopeAutomationsRead",
  "agents:read": "settings.scopeAgentsRead",
  "channels:read": "settings.scopeChannelsRead",
  "whatsapp_templates:read": "settings.scopeWhatsappTemplatesRead",
  "knowledge:read": "settings.scopeKnowledgeRead",
  "growth_links:read": "settings.scopeGrowthLinksRead",
  "segments:read": "settings.scopeSegmentsRead",
  "orders:read": "settings.scopeOrdersRead",
  "appointments:read": "settings.scopeAppointmentsRead",
};

/** Scope read tercentang secara bawaan di form (selaras default API). */
const DEFAULT_SCOPES: ApiKeyScope[] = [
  "contacts:read",
  "conversations:read",
  "products:read",
];

/**
 * Halaman Settings — berisi seksi Akun (ganti password, Fase 13A), API
 * Keys (Fase 5A), dan Tim (Fase 9C):
 * daftar kunci workspace aktif (nama, awalan, chip scope, status,
 * terakhir dipakai), form buat (nama + centang scope), modal hasil
 * pembuatan yang menampilkan kunci UTUH satu kali dengan tombol salin
 * dan peringatan, serta cabut dengan konfirmasi. Membuat/mencabut hanya
 * untuk owner/admin — server menegakkan (403), UI memberi catatan.
 */
export function SettingsPage({ t, locale }: SettingsPageProps) {
  const { active } = useWorkspace();
  const tenantId = active?.id ?? null;
  const canManage = active?.role === "owner" || active?.role === "admin";

  const [keys, setKeys] = useState<ApiKeyResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [created, setCreated] = useState<CreatedApiKeyResponse | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyResponse | null>(null);
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    if (!tenantId) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const list = await api.apiKeys.list(tenantId);
      if (requestSeq.current !== seq) return;
      setKeys(list);
    } catch (err) {
      if (requestSeq.current !== seq) return;
      setError(translateApiError(t, err));
      setKeys([]);
    } finally {
      if (requestSeq.current === seq) setLoading(false);
    }
  }, [tenantId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <h1 className="text-xl font-bold text-ink">{t("nav.settings")}</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted">{t("settings.intro")}</p>

      <ChangePasswordSection t={t} />

      {tenantId ? (
        <PaymentsSection t={t} tenantId={tenantId} canManage={canManage} />
      ) : null}

      <section className="mt-10">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-ink">
              {t("settings.apiKeysTitle")}
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-muted">
              {t("settings.apiKeysBody")}
            </p>
          </div>
          {canManage ? (
            <button
              type="button"
              onClick={() => setFormOpen(true)}
              className="shrink-0 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white"
            >
              {t("settings.addButton")}
            </button>
          ) : null}
        </div>

        {!canManage ? (
          <p className="mt-3 rounded-lg bg-elevated px-3 py-2 text-sm text-muted">
            {t("settings.adminOnlyNote")}
          </p>
        ) : null}

        {error ? (
          <p className="mt-3 rounded-lg bg-elevated px-3 py-2 text-sm text-red-600">
            {error}
          </p>
        ) : null}

        {loading ? (
          <p className="mt-4 text-sm text-muted">{t("common.loading")}</p>
        ) : keys.length === 0 && !error ? (
          <div className="mt-4 rounded-xl bg-surface p-5">
            <div className="font-semibold text-ink">{t("settings.emptyTitle")}</div>
            <p className="mt-1 text-sm text-muted">{t("settings.emptyBody")}</p>
          </div>
        ) : (
          <ul className="mt-4 space-y-3">
            {keys.map((key) => {
              const revoked = key.revokedAt !== null;
              return (
                <li key={key.id} className="rounded-xl bg-surface p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-ink">{key.name}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        revoked
                          ? "bg-elevated text-muted"
                          : "bg-accent/15 text-accent"
                      }`}
                    >
                      {revoked
                        ? t("settings.statusRevoked")
                        : t("settings.statusActive")}
                    </span>
                  </div>
                  <div className="mt-1 font-mono text-xs text-muted">
                    {t("settings.prefixLabel")}: {key.keyPrefix}…
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {key.scopes.map((scope) => (
                      <span
                        key={scope}
                        className="rounded-full bg-elevated px-2 py-0.5 text-xs text-ink"
                      >
                        {scope}
                      </span>
                    ))}
                  </div>
                  <div className="mt-2 text-xs text-muted">
                    {t("settings.createdLabel", {
                      date: formatDateTime(key.createdAt, locale),
                    })}
                    {" · "}
                    {key.lastUsedAt
                      ? t("settings.lastUsedLabel", {
                          date: formatDateTime(key.lastUsedAt, locale),
                        })
                      : t("settings.neverUsed")}
                  </div>
                  {canManage && !revoked ? (
                    <div className="mt-3">
                      <button
                        type="button"
                        onClick={() => setRevokeTarget(key)}
                        className="rounded-lg bg-elevated px-3 py-1.5 text-sm font-medium text-red-600"
                      >
                        {t("settings.revokeButton")}
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* G11: seksi Webhook keluar — endpoint HTTPS tenant untuk peristiwa real-time */}
      {tenantId ? (
        <OutboundWebhooksSection t={t} locale={locale} tenantId={tenantId} canManage={canManage} />
      ) : null}

      {/* Fase 9C: seksi Tim — member, peran, undangan */}
      {tenantId ? (
        <TeamSection
          t={t}
          locale={locale}
          tenantId={tenantId}
          tenantTimezone={active?.timezone ?? "UTC"}
          canManage={canManage}
        />
      ) : null}

      {/* G15: seksi SLA — target waktu tanggap + jadwal bawaan workspace */}
      {tenantId ? (
        <SlaSettingsSection
          t={t}
          tenantId={tenantId}
          tenantTimezone={active?.timezone ?? "UTC"}
          canManage={canManage}
        />
      ) : null}

      {formOpen && tenantId ? (
        <CreateApiKeyModal
          t={t}
          tenantId={tenantId}
          onClose={() => setFormOpen(false)}
          onCreated={(createdKey) => {
            setFormOpen(false);
            setCreated(createdKey);
            void load();
          }}
        />
      ) : null}

      {created ? (
        <CreatedApiKeyModal
          t={t}
          created={created}
          onClose={() => setCreated(null)}
        />
      ) : null}

      {revokeTarget && tenantId ? (
        <RevokeApiKeyModal
          t={t}
          tenantId={tenantId}
          target={revokeTarget}
          onClose={() => setRevokeTarget(null)}
          onRevoked={() => {
            setRevokeTarget(null);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Seksi ganti password (Fase 13A — menutup temuan 9A bahwa Settings
 * tidak punya form ini). Tingkat AKUN, bukan workspace: memakai
 * endpoint Better Auth `change-password` yang memverifikasi kata sandi
 * saat ini di server; klien tidak pernah membandingkan hash sendiri.
 * Validasi lokal hanya untuk umpan balik cepat (kosong / <8 karakter /
 * sama dengan saat ini / konfirmasi beda) — penegak akhirnya server
 * (INVALID_PASSWORD / PASSWORD_TOO_SHORT diterjemahkan dari kodenya).
 * Nilai kata sandi tidak pernah di-log atau disimpan di state selain
 * field form, dan form dikosongkan sesudah berhasil.
 */
function ChangePasswordSection({ t }: { t: Translate }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSuccess(false);
    if (!current || !next || !confirm) {
      setError(t("settings.passwordRequired"));
      return;
    }
    if (next.length < 8) {
      setError(t("errors.passwordTooShort"));
      return;
    }
    if (next === current) {
      setError(t("settings.passwordSameAsCurrent"));
      return;
    }
    if (next !== confirm) {
      setError(t("settings.passwordMismatch"));
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await api.auth.changePassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      setSuccess(true);
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="mt-6">
      <h2 className="text-base font-semibold text-ink">
        {t("settings.passwordTitle")}
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        {t("settings.passwordBody")}
      </p>
      <form onSubmit={submit} className="mt-4 max-w-md space-y-3">
        <div>
          <label
            htmlFor="settings-current-password"
            className="mb-1 block text-sm font-medium text-ink"
          >
            {t("settings.passwordCurrentLabel")}
          </label>
          <PasswordInput
            t={t}
            id="settings-current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            className={inputClassName}
            autoComplete="current-password"
          />
        </div>
        <div>
          <label
            htmlFor="settings-new-password"
            className="mb-1 block text-sm font-medium text-ink"
          >
            {t("settings.passwordNewLabel")}
          </label>
          <PasswordInput
            t={t}
            id="settings-new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            className={inputClassName}
            autoComplete="new-password"
          />
        </div>
        <div>
          <label
            htmlFor="settings-confirm-password"
            className="mb-1 block text-sm font-medium text-ink"
          >
            {t("settings.passwordConfirmLabel")}
          </label>
          <PasswordInput
            t={t}
            id="settings-confirm-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className={inputClassName}
            autoComplete="new-password"
          />
        </div>
        <FieldError message={error} />
        {success ? (
          <p className="rounded-lg bg-elevated px-3 py-2 text-sm text-ink">
            {t("settings.passwordSuccess")}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={submitting}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {submitting ? t("settings.passwordSaving") : t("settings.passwordSubmit")}
        </button>
      </form>
    </section>
  );
}

function CreateApiKeyModal({
  t,
  tenantId,
  onClose,
  onCreated,
}: {
  t: Translate;
  tenantId: string;
  onClose: () => void;
  onCreated: (created: CreatedApiKeyResponse) => void;
}) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ApiKeyScope[]>(DEFAULT_SCOPES);
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const toggleScope = (scope: ApiKeyScope, checked: boolean) => {
    setScopes((prev) =>
      checked ? [...prev, scope] : prev.filter((s) => s !== scope),
    );
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setNameError(t("settings.nameRequired"));
      return;
    }
    setNameError(null);
    setError(null);
    setSubmitting(true);
    try {
      const createdKey = await api.apiKeys.create(tenantId, {
        name: name.trim(),
        scopes,
      });
      onCreated(createdKey);
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-xl sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-lg font-bold text-ink">{t("settings.addTitle")}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-elevated px-3 py-1.5 text-sm font-medium text-ink"
          >
            {t("common.close")}
          </button>
        </div>
        <form onSubmit={handleSubmit} className="mt-4 space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">
              {t("settings.nameLabel")} *
            </span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("settings.namePlaceholder")}
              className={inputClassName}
            />
          </label>
          <FieldError message={nameError} />
          <fieldset>
            <legend className="mb-1 text-xs font-medium text-muted">
              {t("settings.scopesLabel")}
            </legend>
            <p className="mb-2 text-xs text-muted">{t("settings.scopesHint")}</p>
            <div className="space-y-2">
              {API_KEY_SCOPES.map((scope) => (
                <label key={scope} className="flex items-center gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    checked={scopes.includes(scope)}
                    onChange={(e) => toggleScope(scope, e.target.checked)}
                    className="h-4 w-4"
                  />
                  <span>
                    {t(SCOPE_LABEL_KEYS[scope])}{" "}
                    <span className="font-mono text-xs text-muted">({scope})</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <FieldError message={error} />
          <div className="flex gap-2 pt-1">
            <button
              type="submit"
              disabled={submitting}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              {submitting ? t("settings.saving") : t("settings.createButton")}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium text-ink"
            >
              {t("common.cancel")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CreatedApiKeyModal({
  t,
  created,
  onClose,
}: {
  t: Translate;
  created: CreatedApiKeyResponse;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(created.key);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-xl sm:rounded-2xl">
        <h2 className="text-lg font-bold text-ink">{t("settings.createdTitle")}</h2>
        <p className="mt-1 text-sm text-muted">{t("settings.createdBody")}</p>
        <div className="mt-3 break-all rounded-lg bg-elevated p-3 font-mono text-sm text-ink">
          {created.key}
        </div>
        <p className="mt-3 rounded-lg bg-elevated px-3 py-2 text-sm font-medium text-red-600">
          {t("settings.createdWarning")}
        </p>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={copy}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white"
          >
            {copied ? t("settings.copiedLabel") : t("settings.copyButton")}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium text-ink"
          >
            {t("settings.doneButton")}
          </button>
        </div>
      </div>
    </div>
  );
}

function RevokeApiKeyModal({
  t,
  tenantId,
  target,
  onClose,
  onRevoked,
}: {
  t: Translate;
  tenantId: string;
  target: ApiKeyResponse;
  onClose: () => void;
  onRevoked: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleRevoke = async () => {
    setError(null);
    setSubmitting(true);
    try {
      await api.apiKeys.revoke(tenantId, target.id);
      onRevoked();
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-xl sm:rounded-2xl">
        <h2 className="text-lg font-bold text-ink">{t("settings.revokeTitle")}</h2>
        <p className="mt-2 text-sm text-muted">
          {t("settings.revokeBody", { name: target.name })}
        </p>
        <FieldError message={error} />
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={handleRevoke}
            disabled={submitting}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            {submitting ? t("settings.revoking") : t("settings.revokeButton")}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium text-ink"
          >
            {t("common.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Seksi Tim (Fase 9C): daftar member + peran, undangan bertoken, ganti
 * peran, keluarkan member. Seluruh mutasi owner/admin (server
 * menegakkan; UI menyembunyikan kontrol untuk peran lain). Tautan
 * undangan ditampilkan SEKALI sesudah dibuat — server hanya menyimpan
 * hash tokennya, jadi panel "tautan siap" adalah satu-satunya tempat
 * tautan itu pernah terlihat di UI; hilang → cabut & undang ulang.
 * Fase 11B: undangan juga dikirim lewat email (Resend) bila platform
 * mengaturnya — panel menyatakan status antre emailnya dari respons
 * pembuatan, dan daftar menampilkan status kirim per undangan.
 */
function roleLabelKey(role: MemberRole): TranslationKey {
  switch (role) {
    case "owner":
      return "settings.team.roleOwner";
    case "admin":
      return "settings.team.roleAdmin";
    case "agent":
      return "settings.team.roleAgent";
    case "viewer":
      return "settings.team.roleViewer";
  }
}

const INVITABLE_ROLES: InvitableRole[] = ["admin", "agent", "viewer"];

// ---------------------------------------------------------------------------
// Jadwal kerja & SLA (G15) — editor mingguan bersama + modal per anggota
// + seksi pengaturan SLA tenant. Definisi yang diukur tertulis di teks
// UI (settings.sla.body / settings.workSchedule.body) dan di kontrak.
// ---------------------------------------------------------------------------

const WORK_DAYS = [0, 1, 2, 3, 4, 5, 6] as const;
const WORK_DAY_LABEL_KEYS = [
  "settings.workSchedule.day0",
  "settings.workSchedule.day1",
  "settings.workSchedule.day2",
  "settings.workSchedule.day3",
  "settings.workSchedule.day4",
  "settings.workSchedule.day5",
  "settings.workSchedule.day6",
] as const;

interface WorkDayDraft {
  enabled: boolean;
  start: string;
  end: string;
}

type WorkScheduleDraft = Record<string, WorkDayDraft>;

/** Draf editor: satu rentang per hari (rentang pertama jadwal tersimpan). */
function scheduleToDraft(schedule: WorkSchedule | null): WorkScheduleDraft {
  const draft: WorkScheduleDraft = {};
  for (const day of WORK_DAYS) {
    const first = schedule?.days[String(day)]?.[0];
    draft[String(day)] = first
      ? { enabled: true, start: first.start, end: first.end }
      : { enabled: false, start: "09:00", end: "17:00" };
  }
  return draft;
}

function draftToSchedule(draft: WorkScheduleDraft): WorkSchedule {
  const days: WorkSchedule["days"] = {};
  for (const day of WORK_DAYS) {
    const d = draft[String(day)];
    if (d?.enabled) days[String(day)] = [{ start: d.start, end: d.end }];
  }
  return { days };
}

function WorkScheduleEditor({
  t,
  draft,
  onChange,
  disabled,
}: {
  t: Translate;
  draft: WorkScheduleDraft;
  onChange: (draft: WorkScheduleDraft) => void;
  disabled?: boolean;
}) {
  const setDay = (day: number, patch: Partial<WorkDayDraft>) => {
    const key = String(day);
    const current = draft[key] ?? { enabled: false, start: "09:00", end: "17:00" };
    onChange({ ...draft, [key]: { ...current, ...patch } });
  };
  return (
    <div className="space-y-1.5">
      {WORK_DAYS.map((day) => {
        const d = draft[String(day)] ?? {
          enabled: false,
          start: "09:00",
          end: "17:00",
        };
        return (
          <div key={day} className="flex flex-wrap items-center gap-2">
            <label className="flex w-28 items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={d.enabled}
                disabled={disabled}
                onChange={(e) => setDay(day, { enabled: e.target.checked })}
                className="h-4 w-4"
              />
              {t(WORK_DAY_LABEL_KEYS[day]!)}
            </label>
            <input
              type="time"
              value={d.start}
              disabled={disabled || !d.enabled}
              onChange={(e) => setDay(day, { start: e.target.value })}
              aria-label={t("settings.workSchedule.startLabel")}
              className={`${inputClassName} w-32`}
            />
            <span className="text-muted">–</span>
            <input
              type="time"
              value={d.end}
              disabled={disabled || !d.enabled}
              onChange={(e) => setDay(day, { end: e.target.value })}
              aria-label={t("settings.workSchedule.endLabel")}
              className={`${inputClassName} w-32`}
            />
          </div>
        );
      })}
    </div>
  );
}

function MemberScheduleModal({
  t,
  tenantId,
  tenantTimezone,
  member,
  canManage,
  onClose,
}: {
  t: Translate;
  tenantId: string;
  tenantTimezone: string;
  member: TeamMemberResponse;
  canManage: boolean;
  onClose: () => void;
}) {
  const editable = member.isSelf || canManage;
  const [draft, setDraft] = useState<WorkScheduleDraft>(() =>
    scheduleToDraft(null),
  );
  const [timezone, setTimezone] = useState("");
  const [hasOwn, setHasOwn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const view = await api.team.getWorkSchedule(tenantId, member.userId);
        if (cancelled) return;
        setDraft(scheduleToDraft(view.schedule));
        setTimezone(view.timezone ?? "");
        setHasOwn(view.schedule !== null);
      } catch (err) {
        if (!cancelled) setError(translateApiError(t, err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, member.userId, t]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const view = await api.team.updateWorkSchedule(tenantId, member.userId, {
        timezone: timezone.trim() === "" ? null : timezone.trim(),
        schedule: draftToSchedule(draft),
      });
      setHasOwn(view.schedule !== null);
      onClose();
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.team.deleteWorkSchedule(tenantId, member.userId);
      setHasOwn(false);
      setDraft(scheduleToDraft(null));
      onClose();
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-xl sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-lg font-bold text-ink">
            {t("settings.workSchedule.title", {
              name: member.name ?? member.email,
            })}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-elevated px-3 py-1.5 text-sm font-medium text-ink"
          >
            {t("settings.workSchedule.closeButton")}
          </button>
        </div>
        <p className="mt-2 text-sm text-muted">
          {t("settings.workSchedule.body")}
        </p>
        {!editable ? (
          <p className="mt-3 rounded-lg bg-elevated px-3 py-2 text-sm text-muted">
            {t("settings.workSchedule.readOnlyNote")}
          </p>
        ) : null}
        {!loading && !hasOwn ? (
          <p className="mt-3 rounded-lg bg-elevated px-3 py-2 text-sm text-muted">
            {t("settings.workSchedule.noOwnSchedule")}
          </p>
        ) : null}
        <FieldError message={error} />
        {loading ? (
          <p className="mt-4 text-sm text-muted">{t("common.loading")}</p>
        ) : (
          <>
            <div className="mt-4">
              <WorkScheduleEditor
                t={t}
                draft={draft}
                onChange={setDraft}
                disabled={!editable || saving}
              />
            </div>
            <label className="mt-4 block">
              <span className="mb-1 block text-xs font-medium text-muted">
                {t("settings.workSchedule.timezoneLabel")}
              </span>
              <input
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                disabled={!editable || saving}
                placeholder={tenantTimezone}
                className={inputClassName}
              />
              <span className="mt-1 block text-xs text-muted">
                {t("settings.workSchedule.timezoneHint", { tz: tenantTimezone })}
              </span>
            </label>
            {editable ? (
              <div className="mt-5 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={saving}
                  className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                >
                  {saving
                    ? t("settings.workSchedule.saving")
                    : t("settings.workSchedule.saveButton")}
                </button>
                {hasOwn ? (
                  <button
                    type="button"
                    onClick={() => void handleDelete()}
                    disabled={saving}
                    className="rounded-lg bg-elevated px-3 py-2 text-sm font-medium text-danger"
                  >
                    {t("settings.workSchedule.deleteButton")}
                  </button>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function SlaSettingsSection({
  t,
  tenantId,
  tenantTimezone,
  canManage,
}: {
  t: Translate;
  tenantId: string;
  tenantTimezone: string;
  canManage: boolean;
}) {
  const [targetText, setTargetText] = useState("");
  const [draft, setDraft] = useState<WorkScheduleDraft>(() =>
    scheduleToDraft(null),
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const settings = await api.sla.getSettings(tenantId);
        if (cancelled) return;
        setTargetText(
          settings.targetMinutes === null
            ? ""
            : String(settings.targetMinutes),
        );
        setDraft(scheduleToDraft(settings.defaultSchedule));
      } catch (err) {
        if (!cancelled) setError(translateApiError(t, err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, t]);

  const handleSave = async () => {
    const trimmed = targetText.trim();
    const targetMinutes = trimmed === "" ? null : Number(trimmed);
    if (
      targetMinutes !== null &&
      (!Number.isInteger(targetMinutes) || targetMinutes < 1)
    ) {
      setError(t("settings.sla.saveError"));
      return;
    }
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const updated = await api.sla.updateSettings(tenantId, {
        targetMinutes,
        defaultSchedule: draftToSchedule(draft),
      });
      setTargetText(
        updated.targetMinutes === null ? "" : String(updated.targetMinutes),
      );
      setDraft(scheduleToDraft(updated.defaultSchedule));
      setSaved(true);
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mt-10">
      <h2 className="text-base font-semibold text-ink">
        {t("settings.sla.title")}
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        {t("settings.sla.body")}
      </p>
      {!canManage ? (
        <p className="mt-3 rounded-lg bg-elevated px-3 py-2 text-sm text-muted">
          {t("settings.sla.managerNote")}
        </p>
      ) : null}
      <FieldError message={error} />
      {loading ? (
        <p className="mt-3 text-sm text-muted">{t("common.loading")}</p>
      ) : (
        <div className="mt-4 max-w-2xl rounded-xl bg-surface p-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">
              {t("settings.sla.targetLabel")}
            </span>
            <input
              type="number"
              min={1}
              value={targetText}
              onChange={(e) => setTargetText(e.target.value)}
              disabled={!canManage || saving}
              className={`${inputClassName} w-48`}
            />
            <span className="mt-1 block text-xs text-muted">
              {t("settings.sla.targetHint")}
            </span>
          </label>
          <h3 className="mt-5 text-sm font-semibold text-ink">
            {t("settings.sla.defaultScheduleLabel")}
          </h3>
          <p className="mt-1 text-sm text-muted">
            {t("settings.sla.defaultScheduleBody")} ({tenantTimezone})
          </p>
          <div className="mt-3">
            <WorkScheduleEditor
              t={t}
              draft={draft}
              onChange={setDraft}
              disabled={!canManage || saving}
            />
          </div>
          {canManage ? (
            <div className="mt-5 flex items-center gap-3">
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={saving}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {saving
                  ? t("settings.sla.saving")
                  : t("settings.sla.saveButton")}
              </button>
              {saved ? (
                <span className="text-sm text-success">
                  {t("settings.sla.savedLabel")}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

function TeamSection({
  t,
  locale,
  tenantId,
  tenantTimezone,
  canManage,
}: {
  t: Translate;
  locale: Locale;
  tenantId: string;
  tenantTimezone: string;
  canManage: boolean;
}) {
  const [members, setMembers] = useState<TeamMemberResponse[]>([]);
  const [invitations, setInvitations] = useState<InvitationResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<InvitableRole>("agent");
  const [inviting, setInviting] = useState(false);
  const [createdLink, setCreatedLink] = useState<{
    url: string;
    email: string;
    /** Fase 11B: status antre email undangan dari respons pembuatan. */
    emailDelivery: "queued" | "not_configured" | null;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<TeamMemberResponse | null>(
    null,
  );
  const [scheduleTarget, setScheduleTarget] =
    useState<TeamMemberResponse | null>(null);
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const memberRows = await api.team.listMembers(tenantId);
      if (requestSeq.current !== seq) return;
      setMembers(memberRows);
      if (canManage) {
        const invitationRows = await api.team.listInvitations(tenantId);
        if (requestSeq.current !== seq) return;
        setInvitations(invitationRows);
      }
    } catch (err) {
      if (requestSeq.current !== seq) return;
      setError(translateApiError(t, err));
    } finally {
      if (requestSeq.current === seq) setLoading(false);
    }
  }, [tenantId, canManage, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRoleChange = async (member: TeamMemberResponse, role: InvitableRole) => {
    setActionError(null);
    try {
      const updated = await api.team.updateMemberRole(tenantId, member.userId, role);
      setMembers((prev) =>
        prev.map((m) => (m.userId === updated.userId ? updated : m)),
      );
    } catch (err) {
      setActionError(translateApiError(t, err));
    }
  };

  const handleInvite = async (e: FormEvent) => {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    setInviting(true);
    setActionError(null);
    try {
      const created = await api.team.invite(tenantId, inviteEmail.trim(), inviteRole);
      setCreatedLink({
        url: created.inviteUrl ?? "",
        email: created.email,
        emailDelivery: created.emailDelivery,
      });
      setCopied(false);
      setInviteEmail("");
      void load();
    } catch (err) {
      setActionError(translateApiError(t, err));
    } finally {
      setInviting(false);
    }
  };

  const handleRevoke = async (invitation: InvitationResponse) => {
    setActionError(null);
    try {
      await api.team.revokeInvitation(tenantId, invitation.id);
      void load();
    } catch (err) {
      setActionError(translateApiError(t, err));
    }
  };

  const copyLink = async () => {
    if (!createdLink) return;
    try {
      await navigator.clipboard.writeText(createdLink.url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="mt-10">
      <h2 className="text-base font-semibold text-ink">{t("settings.team.title")}</h2>
      <p className="mt-1 max-w-2xl text-sm text-muted">{t("settings.team.body")}</p>

      {!canManage ? (
        <p className="mt-3 rounded-lg bg-elevated px-3 py-2 text-sm text-muted">
          {t("settings.team.adminOnlyNote")}
        </p>
      ) : null}
      {error ? (
        <p className="mt-3 rounded-lg bg-elevated px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      ) : null}
      <FieldError message={actionError} />

      <h3 className="mt-5 text-sm font-semibold text-ink">
        {t("settings.team.membersTitle")}
      </h3>
      {loading && members.length === 0 ? (
        <p className="mt-3 text-sm text-muted">{t("common.loading")}</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {members.map((member) => (
            <li
              key={member.userId}
              className="flex flex-wrap items-center gap-3 rounded-xl bg-surface p-4"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-ink">
                  {member.name ?? member.email}
                  {member.isSelf ? (
                    <span className="ml-2 rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent">
                      {t("settings.team.youLabel")}
                    </span>
                  ) : null}
                </div>
                <div className="truncate text-xs text-muted">{member.email}</div>
                {/* Kehadiran tim (G13 butir 9): titik hijau bila detak
                    terakhir ≤120 dtk (jendela sama dengan server),
                    selain itu "aktif terakhir …" dari lastSeenAt. */}
                <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                  <span
                    aria-hidden
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      member.lastSeenAt !== null &&
                      Date.now() - new Date(member.lastSeenAt).getTime() <=
                        120_000
                        ? "bg-success"
                        : "bg-line"
                    }`}
                  />
                  {member.lastSeenAt !== null &&
                  Date.now() - new Date(member.lastSeenAt).getTime() <= 120_000
                    ? t("settings.team.presenceOnline")
                    : member.lastSeenAt !== null
                      ? t("settings.team.presenceLastActive", {
                          time: formatRelativeTime(member.lastSeenAt, locale),
                        })
                      : t("settings.team.presenceNever")}
                </div>
              </div>
              {canManage && member.role !== "owner" && !member.isSelf ? (
                <>
                  <select
                    value={member.role}
                    onChange={(e) =>
                      void handleRoleChange(member, e.target.value as InvitableRole)
                    }
                    className="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink"
                    aria-label={t("settings.team.roleLabel")}
                  >
                    {INVITABLE_ROLES.map((role) => (
                      <option key={role} value={role}>
                        {t(roleLabelKey(role))}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => setRemoveTarget(member)}
                    className="rounded-lg bg-elevated px-3 py-1.5 text-sm font-medium text-danger"
                  >
                    {t("settings.team.removeButton")}
                  </button>
                </>
              ) : (
                <span className="rounded-full bg-elevated px-2.5 py-1 text-xs font-medium text-ink">
                  {t(roleLabelKey(member.role))}
                </span>
              )}
              {/* Jadwal kerja anggota (G15) — modal editor; diri
                  sendiri selalu boleh, orang lain hanya owner/admin
                  (ditegakkan juga di server). */}
              <button
                type="button"
                onClick={() => setScheduleTarget(member)}
                className="rounded-lg bg-elevated px-3 py-1.5 text-sm font-medium text-ink"
              >
                {t("settings.team.scheduleButton")}
              </button>
            </li>
          ))}
        </ul>
      )}

      {canManage ? (
        <>
          <h3 className="mt-6 text-sm font-semibold text-ink">
            {t("settings.team.inviteTitle")}
          </h3>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            {t("settings.team.inviteBody")}
          </p>
          <form
            onSubmit={handleInvite}
            className="mt-3 flex flex-wrap items-end gap-2"
          >
            <label className="flex min-w-56 flex-1 flex-col gap-1">
              <span className="text-xs font-medium text-muted">
                {t("settings.team.emailLabel")}
              </span>
              <input
                type="email"
                required
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder={t("settings.team.emailPlaceholder")}
                className={inputClassName}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted">
                {t("settings.team.roleLabel")}
              </span>
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as InvitableRole)}
                className="rounded-lg border border-line bg-surface px-2 py-2 text-sm text-ink"
              >
                {INVITABLE_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {t(roleLabelKey(role))}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              disabled={inviting || !inviteEmail.trim()}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              {inviting
                ? t("settings.team.inviting")
                : t("settings.team.inviteButton")}
            </button>
          </form>

          {createdLink ? (
            <div className="mt-4 rounded-xl border border-accent/40 bg-accent/10 p-4">
              <div className="text-sm font-semibold text-ink">
                {t("settings.team.linkReadyTitle")}
              </div>
              <p className="mt-1 text-sm text-muted">
                {t(
                  createdLink.emailDelivery === "queued"
                    ? "settings.team.linkReadyBodyEmailed"
                    : "settings.team.linkReadyBody",
                  { email: createdLink.email },
                )}
              </p>
              <div className="mt-3 break-all rounded-lg bg-surface p-3 font-mono text-xs text-ink">
                {createdLink.url}
              </div>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={copyLink}
                  className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white"
                >
                  {copied
                    ? t("settings.team.copiedLabel")
                    : t("settings.team.copyButton")}
                </button>
                <button
                  type="button"
                  onClick={() => setCreatedLink(null)}
                  className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium text-ink"
                >
                  {t("settings.team.doneButton")}
                </button>
              </div>
            </div>
          ) : null}

          <h3 className="mt-6 text-sm font-semibold text-ink">
            {t("settings.team.pendingTitle")}
          </h3>
          {invitations.length === 0 ? (
            <p className="mt-2 text-sm text-muted">
              {t("settings.team.pendingEmpty")}
            </p>
          ) : (
            <ul className="mt-3 space-y-3">
              {invitations.map((invitation) => (
                <li
                  key={invitation.id}
                  className="flex flex-wrap items-center gap-3 rounded-xl bg-surface p-4"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-ink">
                      {invitation.email}
                    </div>
                    <div className="text-xs text-muted">
                      {t(roleLabelKey(invitation.role))}
                      {invitation.status === "pending"
                        ? ` · ${t("settings.team.expiresLabel", {
                            date: formatDateTime(invitation.expiresAt, locale),
                          })}`
                        : ""}
                      {invitation.emailSentAt
                        ? ` · ${t("settings.team.emailSentLabel", {
                            date: formatDateTime(invitation.emailSentAt, locale),
                          })}`
                        : invitation.emailError
                          ? ` · ${t("settings.team.emailFailedLabel")}`
                          : ""}
                    </div>
                  </div>
                  <span className="rounded-full bg-elevated px-2.5 py-1 text-xs font-medium text-ink">
                    {t(
                      `settings.team.status${invitation.status[0].toUpperCase()}${invitation.status.slice(1)}` as TranslationKey,
                    )}
                  </span>
                  {invitation.status === "pending" ? (
                    <button
                      type="button"
                      onClick={() => void handleRevoke(invitation)}
                      className="rounded-lg bg-elevated px-3 py-1.5 text-sm font-medium text-danger"
                    >
                      {t("settings.team.revokeButton")}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}

      {removeTarget ? (
        <RemoveMemberModal
          t={t}
          tenantId={tenantId}
          target={removeTarget}
          onClose={() => setRemoveTarget(null)}
          onRemoved={() => {
            setRemoveTarget(null);
            void load();
          }}
        />
      ) : null}

      {scheduleTarget ? (
        <MemberScheduleModal
          t={t}
          tenantId={tenantId}
          tenantTimezone={tenantTimezone}
          member={scheduleTarget}
          canManage={canManage}
          onClose={() => setScheduleTarget(null)}
        />
      ) : null}
    </section>
  );
}

function RemoveMemberModal({
  t,
  tenantId,
  target,
  onClose,
  onRemoved,
}: {
  t: Translate;
  tenantId: string;
  target: TeamMemberResponse;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleRemove = async () => {
    setError(null);
    setSubmitting(true);
    try {
      await api.team.removeMember(tenantId, target.userId);
      onRemoved();
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-xl sm:rounded-2xl">
        <h2 className="text-lg font-bold text-ink">
          {t("settings.team.removeTitle")}
        </h2>
        <p className="mt-2 text-sm text-muted">
          {t("settings.team.removeBody", { name: target.name ?? target.email })}
        </p>
        <FieldError message={error} />
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={handleRemove}
            disabled={submitting}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            {submitting
              ? t("settings.team.removing")
              : t("settings.team.removeButton")}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium text-ink"
          >
            {t("settings.team.cancelButton")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Seksi Webhook keluar (G11) — Settings → Webhook keluar.
 *
 * Mengelola endpoint HTTPS tenant untuk peristiwa Botara real-time:
 * daftar endpoint (URL, peristiwa, status, kesehatan), buat endpoint
 * (rahasia penanda tangan tampil SATU KALI dengan peringatan salin —
 * pola modal hasil pembuatan API key), aktif/nonaktif, hapus dengan
 * konfirmasi, log pengiriman terakhir per endpoint, dan tombol kirim
 * peristiwa uji. Mutasi hanya owner/admin — server menegakkan (403),
 * UI memberi catatan.
 */
function OutboundWebhooksSection({
  t,
  locale,
  tenantId,
  canManage,
}: {
  t: Translate;
  locale: Locale;
  tenantId: string;
  canManage: boolean;
}) {
  const [endpoints, setEndpoints] = useState<OutboundWebhookResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [created, setCreated] = useState<CreatedOutboundWebhookResponse | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<OutboundWebhookResponse | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<OutboundWebhookDeliveryResponse[]>([]);
  const [deliveriesError, setDeliveriesError] = useState<string | null>(null);
  const [testState, setTestState] = useState<{
    endpointId: string;
    kind: "sending" | "done";
    message: string | null;
  } | null>(null);
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const list = await api.outboundWebhooks.list(tenantId);
      if (requestSeq.current !== seq) return;
      setEndpoints(list);
    } catch (err) {
      if (requestSeq.current !== seq) return;
      setError(translateApiError(t, err));
      setEndpoints([]);
    } finally {
      if (requestSeq.current === seq) setLoading(false);
    }
  }, [tenantId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleDeliveries = async (endpoint: OutboundWebhookResponse) => {
    if (expandedId === endpoint.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(endpoint.id);
    setDeliveries([]);
    setDeliveriesError(null);
    try {
      const rows = await api.outboundWebhooks.deliveries(tenantId, endpoint.id, 20);
      setDeliveries(rows);
    } catch (err) {
      setDeliveriesError(translateApiError(t, err));
    }
  };

  const runTest = async (endpoint: OutboundWebhookResponse) => {
    setTestState({ endpointId: endpoint.id, kind: "sending", message: null });
    try {
      const delivery = await api.outboundWebhooks.test(tenantId, endpoint.id);
      let message: string;
      if (delivery.status === "delivered") {
        message = t("settings.webhooks.testDelivered", {
          status: delivery.lastStatusCode ?? 200,
        });
      } else if (delivery.status === "pending") {
        message = t("settings.webhooks.testPending");
      } else {
        message = t("settings.webhooks.testFailed", {
          error:
            delivery.lastError ??
            (delivery.lastStatusCode
              ? t("settings.webhooks.deliveryHttp", { status: delivery.lastStatusCode })
              : t("settings.webhooks.deliveryNetworkError")),
        });
      }
      setTestState({ endpointId: endpoint.id, kind: "done", message });
      if (expandedId === endpoint.id) {
        const rows = await api.outboundWebhooks.deliveries(tenantId, endpoint.id, 20);
        setDeliveries(rows);
      }
      void load();
    } catch (err) {
      setTestState({
        endpointId: endpoint.id,
        kind: "done",
        message: translateApiError(t, err),
      });
    }
  };

  const setEnabled = async (endpoint: OutboundWebhookResponse, enabled: boolean) => {
    try {
      if (enabled) await api.outboundWebhooks.enable(tenantId, endpoint.id);
      else await api.outboundWebhooks.disable(tenantId, endpoint.id);
      void load();
    } catch (err) {
      setError(translateApiError(t, err));
    }
  };

  return (
    <section className="mt-10">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-ink">{t("settings.webhooks.title")}</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">{t("settings.webhooks.body")}</p>
        </div>
        {canManage ? (
          <button
            type="button"
            onClick={() => setFormOpen(true)}
            className="shrink-0 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white"
          >
            {t("settings.webhooks.addButton")}
          </button>
        ) : null}
      </div>

      {!canManage ? (
        <p className="mt-3 rounded-lg bg-elevated px-3 py-2 text-sm text-muted">
          {t("settings.webhooks.adminOnlyNote")}
        </p>
      ) : null}

      {error ? (
        <p className="mt-3 rounded-lg bg-elevated px-3 py-2 text-sm text-red-600">{error}</p>
      ) : null}

      {loading ? (
        <p className="mt-4 text-sm text-muted">{t("common.loading")}</p>
      ) : endpoints.length === 0 && !error ? (
        <div className="mt-4 rounded-xl bg-surface p-5">
          <div className="font-semibold text-ink">{t("settings.webhooks.emptyTitle")}</div>
          <p className="mt-1 text-sm text-muted">{t("settings.webhooks.emptyBody")}</p>
        </div>
      ) : (
        <ul className="mt-4 space-y-3">
          {endpoints.map((endpoint) => {
            const active = endpoint.status === "active";
            const expanded = expandedId === endpoint.id;
            return (
              <li key={endpoint.id} className="rounded-xl bg-surface p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-ink">{endpoint.name}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      active ? "bg-accent/15 text-accent" : "bg-elevated text-muted"
                    }`}
                  >
                    {active
                      ? t("settings.webhooks.statusActive")
                      : t("settings.webhooks.statusDisabled")}
                  </span>
                  {endpoint.consecutiveFailures > 0 ? (
                    <span className="rounded-full bg-elevated px-2 py-0.5 text-xs font-medium text-red-600">
                      {t("settings.webhooks.failuresLabel", {
                        count: endpoint.consecutiveFailures,
                      })}
                    </span>
                  ) : null}
                </div>
                <div className="mt-1 break-all font-mono text-xs text-muted">{endpoint.url}</div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {endpoint.events.map((event) => (
                    <span
                      key={event}
                      className="rounded-full bg-elevated px-2 py-0.5 text-xs text-ink"
                    >
                      {event}
                    </span>
                  ))}
                </div>
                {!active && endpoint.disabledReason ? (
                  <p className="mt-2 text-xs text-muted">
                    {endpoint.disabledReason === "consecutive_failures"
                      ? t("settings.webhooks.disabledReasonFailures")
                      : t("settings.webhooks.disabledReasonManual")}
                  </p>
                ) : null}
                <div className="mt-2 text-xs text-muted">
                  {t("settings.createdLabel", {
                    date: formatDateTime(endpoint.createdAt, locale),
                  })}
                </div>

                {testState?.endpointId === endpoint.id && testState.message ? (
                  <p className="mt-2 rounded-lg bg-elevated px-3 py-2 text-sm text-ink">
                    {testState.message}
                  </p>
                ) : null}

                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void toggleDeliveries(endpoint)}
                    className="rounded-lg bg-elevated px-3 py-1.5 text-sm font-medium text-ink"
                  >
                    {t("settings.webhooks.deliveriesButton")}
                  </button>
                  {canManage ? (
                    <>
                      <button
                        type="button"
                        disabled={testState?.endpointId === endpoint.id && testState.kind === "sending"}
                        onClick={() => void runTest(endpoint)}
                        className="rounded-lg bg-elevated px-3 py-1.5 text-sm font-medium text-ink disabled:opacity-50"
                      >
                        {testState?.endpointId === endpoint.id && testState.kind === "sending"
                          ? t("settings.webhooks.testing")
                          : t("settings.webhooks.testButton")}
                      </button>
                      {active ? (
                        <button
                          type="button"
                          onClick={() => void setEnabled(endpoint, false)}
                          className="rounded-lg bg-elevated px-3 py-1.5 text-sm font-medium text-ink"
                        >
                          {t("settings.webhooks.disableButton")}
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void setEnabled(endpoint, true)}
                          className="rounded-lg bg-elevated px-3 py-1.5 text-sm font-medium text-ink"
                        >
                          {t("settings.webhooks.enableButton")}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(endpoint)}
                        className="rounded-lg bg-elevated px-3 py-1.5 text-sm font-medium text-red-600"
                      >
                        {t("settings.webhooks.deleteButton")}
                      </button>
                    </>
                  ) : null}
                </div>

                {expanded ? (
                  <div className="mt-3 border-t border-elevated pt-3">
                    <div className="text-sm font-semibold text-ink">
                      {t("settings.webhooks.deliveriesTitle")}
                    </div>
                    {deliveriesError ? (
                      <p className="mt-2 text-sm text-red-600">{deliveriesError}</p>
                    ) : deliveries.length === 0 ? (
                      <p className="mt-2 text-sm text-muted">
                        {t("settings.webhooks.deliveriesEmpty")}
                      </p>
                    ) : (
                      <ul className="mt-2 space-y-2">
                        {deliveries.map((delivery) => (
                          <li key={delivery.id} className="rounded-lg bg-elevated px-3 py-2 text-sm">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-mono text-xs text-ink">{delivery.eventType}</span>
                              <span
                                className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                                  delivery.status === "delivered"
                                    ? "bg-accent/15 text-accent"
                                    : delivery.status === "failed"
                                      ? "bg-red-100 text-red-600"
                                      : "bg-surface text-muted"
                                }`}
                              >
                                {delivery.status === "delivered"
                                  ? t("settings.webhooks.statusDelivered")
                                  : delivery.status === "failed"
                                    ? t("settings.webhooks.statusFailed")
                                    : t("settings.webhooks.statusPending")}
                              </span>
                              <span className="text-xs text-muted">
                                {t("settings.webhooks.deliveryAttempt", {
                                  count: delivery.attempts,
                                })}
                                {" · "}
                                {delivery.lastStatusCode
                                  ? t("settings.webhooks.deliveryHttp", {
                                      status: delivery.lastStatusCode,
                                    })
                                  : t("settings.webhooks.deliveryNetworkError")}
                                {" · "}
                                {formatDateTime(delivery.createdAt, locale)}
                              </span>
                            </div>
                            {delivery.lastError ? (
                              <div className="mt-1 break-all font-mono text-xs text-red-600">
                                {delivery.lastError}
                              </div>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {formOpen ? (
        <CreateOutboundWebhookModal
          t={t}
          tenantId={tenantId}
          onClose={() => setFormOpen(false)}
          onCreated={(createdEndpoint) => {
            setFormOpen(false);
            setCreated(createdEndpoint);
            void load();
          }}
        />
      ) : null}

      {created ? (
        <CreatedOutboundWebhookSecretModal
          t={t}
          created={created}
          onClose={() => setCreated(null)}
        />
      ) : null}

      {deleteTarget ? (
        <DeleteOutboundWebhookModal
          t={t}
          tenantId={tenantId}
          target={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => {
            setDeleteTarget(null);
            void load();
          }}
        />
      ) : null}
    </section>
  );
}

const OUTBOUND_WEBHOOK_EVENT_LABELS: Record<OutboundWebhookEventType, "settings.webhooks.eventMessageReceived" | "settings.webhooks.eventMessageStatusUpdated"> = {
  "message.received": "settings.webhooks.eventMessageReceived",
  "message.status_updated": "settings.webhooks.eventMessageStatusUpdated",
};

function CreateOutboundWebhookModal({
  t,
  tenantId,
  onClose,
  onCreated,
}: {
  t: Translate;
  tenantId: string;
  onClose: () => void;
  onCreated: (created: CreatedOutboundWebhookResponse) => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<OutboundWebhookEventType[]>(["message.received"]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const toggleEvent = (event: OutboundWebhookEventType) => {
    setEvents((prev) =>
      prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event],
    );
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!url.trim()) {
      setError(t("settings.webhooks.urlRequired"));
      return;
    }
    if (events.length === 0) {
      setError(t("settings.webhooks.eventsRequired"));
      return;
    }
    setSubmitting(true);
    try {
      const created = await api.outboundWebhooks.create(tenantId, {
        name: name.trim() || url.trim(),
        url: url.trim(),
        events,
      });
      onCreated(created);
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
    >
      <form
        onSubmit={submit}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-xl sm:rounded-2xl"
      >
        <h2 className="text-lg font-bold text-ink">{t("settings.webhooks.addTitle")}</h2>
        <label className="mt-4 block text-sm font-medium text-ink">
          {t("settings.webhooks.nameLabel")}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("settings.webhooks.namePlaceholder")}
            className={inputClassName}
            maxLength={255}
          />
        </label>
        <label className="mt-3 block text-sm font-medium text-ink">
          {t("settings.webhooks.urlLabel")}
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={t("settings.webhooks.urlPlaceholder")}
            className={inputClassName}
            maxLength={2048}
            inputMode="url"
          />
        </label>
        <fieldset className="mt-4">
          <legend className="text-sm font-medium text-ink">
            {t("settings.webhooks.eventsLabel")}
          </legend>
          <div className="mt-2 space-y-2">
            {OUTBOUND_WEBHOOK_EVENT_TYPES.map((event) => (
              <label key={event} className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={events.includes(event)}
                  onChange={() => toggleEvent(event)}
                />
                {t(OUTBOUND_WEBHOOK_EVENT_LABELS[event])}
              </label>
            ))}
          </div>
        </fieldset>
        {error ? <FieldError message={error} /> : null}
        <div className="mt-4 flex gap-2">
          <button
            type="submit"
            disabled={submitting}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {submitting ? t("settings.webhooks.saving") : t("settings.webhooks.createButton")}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium text-ink"
          >
            {t("settings.webhooks.cancelButton")}
          </button>
        </div>
      </form>
    </div>
  );
}

function CreatedOutboundWebhookSecretModal({
  t,
  created,
  onClose,
}: {
  t: Translate;
  created: CreatedOutboundWebhookResponse;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(created.signingSecret);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-xl sm:rounded-2xl">
        <h2 className="text-lg font-bold text-ink">{t("settings.webhooks.createdTitle")}</h2>
        <p className="mt-1 text-sm text-muted">{t("settings.webhooks.createdBody")}</p>
        <div className="mt-3 break-all rounded-lg bg-elevated p-3 font-mono text-sm text-ink">
          {created.signingSecret}
        </div>
        <p className="mt-3 rounded-lg bg-elevated px-3 py-2 text-sm font-medium text-red-600">
          {t("settings.webhooks.createdWarning")}
        </p>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={copy}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white"
          >
            {copied ? t("settings.webhooks.copiedLabel") : t("settings.webhooks.copyButton")}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium text-ink"
          >
            {t("settings.webhooks.doneButton")}
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteOutboundWebhookModal({
  t,
  tenantId,
  target,
  onClose,
  onDeleted,
}: {
  t: Translate;
  tenantId: string;
  target: OutboundWebhookResponse;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleDelete = async () => {
    setError(null);
    setSubmitting(true);
    try {
      await api.outboundWebhooks.remove(tenantId, target.id);
      onDeleted();
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-xl sm:rounded-2xl">
        <h2 className="text-lg font-bold text-ink">{t("settings.webhooks.deleteTitle")}</h2>
        <p className="mt-1 text-sm text-muted">
          {t("settings.webhooks.deleteBody", { name: target.name })}
        </p>
        {error ? <FieldError message={error} /> : null}
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            disabled={submitting}
            onClick={() => void handleDelete()}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {submitting ? t("settings.webhooks.deleting") : t("settings.webhooks.deleteButton")}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium text-ink"
          >
            {t("settings.webhooks.cancelButton")}
          </button>
        </div>
      </div>
    </div>
  );
}
