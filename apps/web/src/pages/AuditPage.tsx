import { useCallback, useEffect, useRef, useState } from "react";
import type { AuditLogResponse } from "@sahabat-kreator/contracts";
import type { Locale, TranslationKey } from "@sahabat-kreator/i18n";
import { api, ApiClientError } from "../api/client";
import { translateApiError } from "../api/errorText";
import { inputClassName } from "../components/AuthLayout";
import { usePolling } from "../hooks/usePolling";
import { formatDateTime } from "../utils/format";
import { useWorkspace } from "../workspace/WorkspaceProvider";

type Translate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

interface AuditPageProps {
  t: Translate;
  locale: Locale;
  /** Sesi platform admin → pengalih baris tingkat platform tampil. */
  isPlatformAdmin: boolean;
}

const ACTOR_VALUES = ["user", "agent", "system", "api_key"] as const;
type ActorValue = (typeof ACTOR_VALUES)[number];

const ACTOR_LABEL_KEYS: Record<ActorValue, TranslationKey> = {
  user: "audit.actorUser",
  agent: "audit.actorAgent",
  system: "audit.actorSystem",
  api_key: "audit.actorApiKey",
};

/** Kategori = awalan action (taksonomi nyata penulis audit di core). */
const CATEGORY_VALUES = [
  "tenant",
  "channel",
  "message",
  "automation",
  "sequence",
  "agent",
  "contact",
  "payment_link",
  "payment",
  "api_key",
  "telegram",
  "integration",
  "platform_settings",
  "broadcast",
  "whatsapp_template",
  "comment",
  "flow",
  "saved_reply",
  "growth_link",
  "kb_document",
  // Fase 16E: job BullMQ yang menyerah setelah semua percobaan.
  "job",
] as const;
type CategoryValue = (typeof CATEGORY_VALUES)[number];

const CATEGORY_LABEL_KEYS: Record<CategoryValue, TranslationKey> = {
  tenant: "audit.categoryTenant",
  channel: "audit.categoryChannel",
  message: "audit.categoryMessage",
  automation: "audit.categoryAutomation",
  sequence: "audit.categorySequence",
  agent: "audit.categoryAgent",
  contact: "audit.categoryContact",
  payment_link: "audit.categoryPaymentLink",
  payment: "audit.categoryPayment",
  api_key: "audit.categoryApiKey",
  telegram: "audit.categoryTelegram",
  integration: "audit.categoryIntegration",
  platform_settings: "audit.categoryPlatformSettings",
  broadcast: "audit.categoryBroadcast",
  whatsapp_template: "audit.categoryWhatsappTemplate",
  comment: "audit.categoryComment",
  flow: "audit.categoryFlow",
  saved_reply: "audit.categorySavedReply",
  growth_link: "audit.categoryGrowthLink",
  kb_document: "audit.categoryKbDocument",
  job: "audit.categoryJob",
};

/**
 * Label terjemahan per action yang dikenal (taksonomi nyata dari
 * pemanggil audit di core). Action di luar peta ini tampil APA ADANYA
 * (string action mentah) — penelusur tidak boleh gagal atau menyembunyikan
 * baris hanya karena action-nya belum punya label.
 */
const ACTION_LABEL_KEYS: Partial<Record<string, TranslationKey>> = {
  "tenant.created": "audit.actionTenantCreated",
  "channel.created": "audit.actionChannelCreated",
  "channel.connected": "audit.actionChannelConnected",
  "channel.disconnected": "audit.actionChannelDisconnected",
  "channel.trashed": "audit.actionChannelTrashed",
  "channel.restored": "audit.actionChannelRestored",
  "channel.exported": "audit.actionChannelExported",
  "channel.purged": "audit.actionChannelPurged",
  "message.queued": "audit.actionMessageQueued",
  "message.sent": "audit.actionMessageSent",
  "message.failed": "audit.actionMessageFailed",
  "message.status": "audit.actionMessageStatus",
  "message.retry": "audit.actionMessageRetry",
  "automation.fired": "audit.actionAutomationFired",
  "sequence.enrolled": "audit.actionSequenceEnrolled",
  "sequence.step_sent": "audit.actionSequenceStepSent",
  "sequence.completed": "audit.actionSequenceCompleted",
  "sequence.cancelled_reply": "audit.actionSequenceCancelledReply",
  "sequence.cancelled_opt_out": "audit.actionSequenceCancelledOptOut",
  "agent.responded": "audit.actionAgentResponded",
  "agent.capped": "audit.actionAgentCapped",
  "agent.failed": "audit.actionAgentFailed",
  "agent.handoff": "audit.actionAgentHandoff",
  "agent.payment_link": "audit.actionAgentPaymentLink",
  "agent.suggestion_approved": "audit.actionAgentSuggestionApproved",
  "agent.suggestion_rejected": "audit.actionAgentSuggestionRejected",
  "contact.tagged": "audit.actionContactTagged",
  "contact.stage_changed": "audit.actionContactStageChanged",
  "contact.merged": "audit.actionContactMerged",
  "contact.opt_in_changed": "audit.actionContactOptInChanged",
  "segment.created": "audit.actionSegmentCreated",
  "segment.updated": "audit.actionSegmentUpdated",
  "segment.deleted": "audit.actionSegmentDeleted",
  "optin.settings_updated": "audit.actionOptInSettingsUpdated",
  "payment_link.created": "audit.actionPaymentLinkCreated",
  "payment.paid": "audit.actionPaymentPaid",
  "api_key.created": "audit.actionApiKeyCreated",
  "api_key.revoked": "audit.actionApiKeyRevoked",
  "telegram.my_chat_member": "audit.actionTelegramMyChatMember",
  "integration.replay": "audit.actionIntegrationReplay",
  "platform_settings.set": "audit.actionPlatformSettingsSet",
  "platform_settings.cleared": "audit.actionPlatformSettingsCleared",
  "platform_settings.test": "audit.actionPlatformSettingsTest",
  "broadcast.created": "audit.actionBroadcastCreated",
  "broadcast.scheduled": "audit.actionBroadcastScheduled",
  "broadcast.dispatched": "audit.actionBroadcastDispatched",
  "broadcast.completed": "audit.actionBroadcastCompleted",
  "broadcast.failed": "audit.actionBroadcastFailed",
  "broadcast.cancelled": "audit.actionBroadcastCancelled",
  "broadcast.deleted": "audit.actionBroadcastDeleted",
  "broadcast.ab_config_changed": "audit.actionBroadcastAbConfigChanged",
  "whatsapp_template.synced": "audit.actionWhatsappTemplateSynced",
  "whatsapp_template.created": "audit.actionWhatsappTemplateCreated",
  "whatsapp_template.deleted": "audit.actionWhatsappTemplateDeleted",
  "comment.rule_fired": "audit.actionCommentRuleFired",
  "comment.hidden": "audit.actionCommentHidden",
  "comment.unhidden": "audit.actionCommentUnhidden",
  "flow.created": "audit.actionFlowCreated",
  "flow.template_instantiated": "audit.actionFlowTemplateInstantiated",
  "flow.updated": "audit.actionFlowUpdated",
  "flow.activated": "audit.actionFlowActivated",
  "flow.deactivated": "audit.actionFlowDeactivated",
  "flow.run_started": "audit.actionFlowRunStarted",
  "flow.run_completed": "audit.actionFlowRunCompleted",
  "flow.run_failed": "audit.actionFlowRunFailed",
  "flow.run_cancelled": "audit.actionFlowRunCancelled",
  "flow.experiment_enabled": "audit.actionFlowExperimentEnabled",
  "flow.experiment_disabled": "audit.actionFlowExperimentDisabled",
  "saved_reply.created": "audit.actionSavedReplyCreated",
  "saved_reply.updated": "audit.actionSavedReplyUpdated",
  "saved_reply.deleted": "audit.actionSavedReplyDeleted",
  "growth_link.created": "audit.actionGrowthLinkCreated",
  "growth_link.updated": "audit.actionGrowthLinkUpdated",
  "growth_link.deleted": "audit.actionGrowthLinkDeleted",
  "kb_document.uploaded": "audit.actionKbDocumentUploaded",
  "kb_document.deleted": "audit.actionKbDocumentDeleted",
  "conversation.assigned": "audit.actionConversationAssigned",
  "conversation.unassigned": "audit.actionConversationUnassigned",
  "conversation.note_created": "audit.actionConversationNoteCreated",
  "conversation.note_deleted": "audit.actionConversationNoteDeleted",
  "team.invited": "audit.actionTeamInvited",
  "team.invitation_revoked": "audit.actionTeamInvitationRevoked",
  "team.member_joined": "audit.actionTeamMemberJoined",
  "team.role_changed": "audit.actionTeamRoleChanged",
  "team.member_removed": "audit.actionTeamMemberRemoved",
  "agent.batched": "audit.actionAgentBatched",
  "job.failed": "audit.actionJobFailed",
};

const TARGET_LABEL_KEYS: Partial<Record<string, TranslationKey>> = {
  channel_account: "audit.targetChannelAccount",
  payment_link: "audit.targetPaymentLink",
  api_key: "audit.targetApiKey",
  agent_suggestion: "audit.targetAgentSuggestion",
  sequence_enrollment: "audit.targetSequenceEnrollment",
  automation: "audit.targetAutomation",
  agent: "audit.targetAgent",
  message: "audit.targetMessage",
  conversation: "audit.targetConversation",
  product: "audit.targetProduct",
  contact: "audit.targetContact",
  integration_log: "audit.targetIntegrationLog",
  platform_setting: "audit.targetPlatformSetting",
  broadcast: "audit.targetBroadcast",
  whatsapp_template: "audit.targetWhatsappTemplate",
  flow: "audit.targetFlow",
  flow_run: "audit.targetFlowRun",
  saved_reply: "audit.targetSavedReply",
  growth_link: "audit.targetGrowthLink",
  kb_document: "audit.targetKbDocument",
  invitation: "audit.targetInvitation",
  member: "audit.targetMember",
  conversation_note: "audit.targetConversationNote",
};

/** Warna chip actor mengikuti token semantik (pola chip Logs). */
function actorChipClass(actorType: string): string {
  switch (actorType) {
    case "user":
      return "bg-accent/10 text-accent";
    case "agent":
      return "bg-warning/10 text-warning";
    case "api_key":
      return "bg-success/10 text-success";
    default:
      return "bg-elevated text-muted";
  }
}

/**
 * Halaman Penelusur Audit (Fase 7B.4) — pembacaan `audit_logs` untuk
 * workspace aktif: aksi operator, runtime agent, komponen sistem, dan
 * API publik, dengan filter actor/kategori/rentang tanggal/pencarian
 * action + paginasi kursor. Baris dapat diperluas menampilkan meta
 * JSON apa adanya (dirender sebagai teks — tidak ada HTML mentah).
 * Endpoint-nya owner/admin saja; anggota biasa melihat penjelasan 403.
 * Sesi platform admin mendapat pengalih ke baris tingkat platform
 * (tenant NULL, mis. `platform_settings.*`) di halaman yang sama.
 * Penyegaran otomatis memakai pola polling yang sama seperti Logs.
 */
export function AuditPage({ t, locale, isPlatformAdmin }: AuditPageProps) {
  const { active } = useWorkspace();
  const tenantId = active?.id ?? null;

  const [showPlatform, setShowPlatform] = useState(false);
  const [actorType, setActorType] = useState("");
  const [category, setCategory] = useState("");
  const [q, setQ] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const [entries, setEntries] = useState<AuditLogResponse[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const requestSeq = useRef(0);
  const loadedMoreRef = useRef(false);

  const platformMode = isPlatformAdmin && showPlatform;

  const buildQuery = useCallback(
    (cursor?: string) => ({
      actorType: actorType || undefined,
      category: category || undefined,
      q: q.trim() || undefined,
      // Batas tanggal lokal pengguna → ISO (awal hari / akhir hari).
      from: fromDate
        ? new Date(`${fromDate}T00:00:00`).toISOString()
        : undefined,
      to: toDate ? new Date(`${toDate}T23:59:59.999`).toISOString() : undefined,
      cursor,
      limit: 50,
    }),
    [actorType, category, q, fromDate, toDate],
  );

  const fetchPage = useCallback(
    async (cursor?: string) => {
      if (platformMode) return api.audit.listPlatform(buildQuery(cursor));
      if (!tenantId) return { entries: [], nextCursor: null };
      return api.audit.list(tenantId, buildQuery(cursor));
    },
    [platformMode, tenantId, buildQuery],
  );

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    loadedMoreRef.current = false;
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      const page = await fetchPage();
      if (requestSeq.current !== seq) return;
      setEntries(page.entries);
      setNextCursor(page.nextCursor);
    } catch (err) {
      if (requestSeq.current !== seq) return;
      if (err instanceof ApiClientError && err.status === 403) {
        setForbidden(true);
        setEntries([]);
      } else {
        setError(translateApiError(t, err));
      }
    } finally {
      if (requestSeq.current === seq) setLoading(false);
    }
  }, [fetchPage, t]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Penyegaran senyap halaman pertama (pola Logs): gabung per id. */
  const refresh = useCallback(async () => {
    if (forbidden) return;
    try {
      const page = await fetchPage();
      setEntries((prev) => {
        const freshIds = new Set(page.entries.map((e) => e.id));
        const rest = prev.filter((e) => !freshIds.has(e.id));
        const merged = [...page.entries, ...rest];
        merged.sort(
          (a, b) =>
            b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
        );
        return merged;
      });
      if (!loadedMoreRef.current) setNextCursor(page.nextCursor);
    } catch {
      // Penyegaran latar gagal diam — siklus berikut mencoba lagi.
    }
  }, [fetchPage, forbidden]);
  usePolling(refresh);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchPage(nextCursor);
      loadedMoreRef.current = true;
      setEntries((prev) => {
        const seen = new Set(prev.map((e) => e.id));
        return [...prev, ...page.entries.filter((e) => !seen.has(e.id))];
      });
      setNextCursor(page.nextCursor);
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setLoadingMore(false);
    }
  };

  const actionLabel = (row: AuditLogResponse): string => {
    const key = ACTION_LABEL_KEYS[row.action];
    return key ? t(key) : row.action;
  };

  const targetLabel = (row: AuditLogResponse): string | null => {
    if (!row.target) return null;
    const key = TARGET_LABEL_KEYS[row.target.type];
    const typeLabel = key ? t(key) : row.target.type;
    const shortId =
      row.target.id.length > 13
        ? `${row.target.id.slice(0, 8)}…`
        : row.target.id;
    return `${typeLabel} · ${shortId}`;
  };

  const selectClass = `${inputClassName} sm:w-auto`;

  return (
    <div>
      <h1 className="text-xl font-bold text-ink">{t("audit.title")}</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted">{t("audit.subtitle")}</p>

      <div className="mt-5 flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">
            {t("audit.filterActor")}
          </span>
          <select
            value={actorType}
            onChange={(e) => setActorType(e.target.value)}
            className={selectClass}
          >
            <option value="">{t("audit.filterAll")}</option>
            {ACTOR_VALUES.map((a) => (
              <option key={a} value={a}>
                {t(ACTOR_LABEL_KEYS[a])}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">
            {t("audit.filterCategory")}
          </span>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className={selectClass}
          >
            <option value="">{t("audit.filterAll")}</option>
            {CATEGORY_VALUES.map((cat) => (
              <option key={cat} value={cat}>
                {t(CATEGORY_LABEL_KEYS[cat])}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">
            {t("audit.filterSearch")}
          </span>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("audit.searchPlaceholder")}
            className={`${inputClassName} sm:w-52`}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">
            {t("audit.filterFrom")}
          </span>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className={selectClass}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">
            {t("audit.filterTo")}
          </span>
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className={selectClass}
          />
        </label>
        {isPlatformAdmin ? (
          <label className="flex cursor-pointer items-center gap-2 pb-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={showPlatform}
              onChange={(e) => setShowPlatform(e.target.checked)}
              className="h-4 w-4 accent-accent"
            />
            {t("audit.platformToggle")}
          </label>
        ) : null}
      </div>

      {platformMode ? (
        <p className="mt-3 max-w-2xl rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">
          {t("audit.platformHint")}
        </p>
      ) : null}

      {forbidden ? (
        <p className="mt-4 rounded-lg bg-elevated px-3 py-2 text-sm text-muted">
          {t("audit.forbidden")}
        </p>
      ) : error ? (
        <p className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}

      {loading && entries.length === 0 ? (
        <p className="mt-4 text-sm text-muted">{t("common.loading")}</p>
      ) : null}

      {!loading && !forbidden && entries.length === 0 ? (
        <p className="mt-6 text-sm text-muted">
          {platformMode ? t("audit.platformEmpty") : t("audit.empty")}
        </p>
      ) : null}

      <div className="mt-4 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
        {entries.map((row) => {
          const expanded = expandedId === row.id;
          const target = targetLabel(row);
          return (
            <div key={row.id}>
              <button
                type="button"
                onClick={() => setExpandedId(expanded ? null : row.id)}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-elevated"
              >
                <span className="w-32 shrink-0 text-xs text-muted">
                  {formatDateTime(row.createdAt, locale)}
                </span>
                <span
                  className={`inline-flex w-20 shrink-0 items-center justify-center rounded-full px-2 py-0.5 text-xs font-medium ${actorChipClass(row.actorType)}`}
                >
                  {t(
                    ACTOR_LABEL_KEYS[row.actorType as ActorValue] ??
                      "audit.actorSystem",
                  )}
                </span>
                <span className="w-44 shrink-0 truncate text-sm font-medium text-ink">
                  {row.actorLabel ?? row.actorId ?? "—"}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-ink">
                  {actionLabel(row)}
                  <span className="ml-2 font-mono text-xs text-muted">
                    {row.action}
                  </span>
                </span>
                {target ? (
                  <span className="hidden shrink-0 text-xs text-muted md:block">
                    {target}
                  </span>
                ) : null}
              </button>
              {expanded ? (
                <div className="border-t border-line bg-elevated/50 px-3 py-3">
                  <dl className="grid gap-1 text-xs text-muted sm:grid-cols-2">
                    {row.actorId ? (
                      <div>
                        <dt className="inline font-medium text-ink">
                          {t("audit.actorIdLabel")}:{" "}
                        </dt>
                        <dd className="inline font-mono">{row.actorId}</dd>
                      </div>
                    ) : null}
                    {row.target ? (
                      <div>
                        <dt className="inline font-medium text-ink">
                          {t("audit.targetLabel")}:{" "}
                        </dt>
                        <dd className="inline font-mono">
                          {row.target.type}:{row.target.id}
                        </dd>
                      </div>
                    ) : null}
                  </dl>
                  <div className="mt-3">
                    <div className="text-xs font-medium text-ink">
                      {t("audit.metaLabel")}
                    </div>
                    <pre className="mt-1 max-h-80 overflow-auto rounded-lg bg-surface p-3 text-xs text-ink">
                      {JSON.stringify(row.meta, null, 2)}
                    </pre>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {nextCursor ? (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="rounded-lg border border-line bg-surface px-4 py-2 text-sm font-medium text-ink disabled:opacity-60"
          >
            {loadingMore ? t("audit.loadingMore") : t("audit.loadMore")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
