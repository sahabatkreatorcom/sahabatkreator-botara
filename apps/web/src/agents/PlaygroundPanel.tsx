import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type {
  AgentPlaygroundDraftConfig,
  AgentPlaygroundIntent,
  AgentPlaygroundResponse,
  AgentResponse,
} from "@sahabat-kreator/contracts";
import {
  formatNumber,
  type Locale,
  type TranslationKey,
} from "@sahabat-kreator/i18n";
import { api } from "../api/client";
import { translateApiError } from "../api/errorText";
import { FieldError, inputClassName } from "../components/AuthLayout";
import { useWorkspace } from "../workspace/WorkspaceProvider";

type Translate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

interface PlaygroundTurn {
  id: number;
  role: "user" | "assistant";
  text: string;
  /** Nama agent yang menjawab giliran ini (untuk label kartu). */
  agentName?: string;
  result?: AgentPlaygroundResponse;
}

/** Label lencana niat tool — niat adalah yang AKAN dilakukan agent, bukan yang sudah terjadi. */
function intentLabel(t: Translate, intent: AgentPlaygroundIntent): string {
  switch (intent.kind) {
    case "add_tag":
      return t("agentsHub.playgroundIntentAddTag", { tag: intent.tag ?? "" });
    case "set_stage":
      return t("agentsHub.playgroundIntentSetStage", {
        stage: intent.stage ?? "",
      });
    case "handoff":
      return t("agentsHub.playgroundIntentHandoff");
    case "create_payment_link":
      if (intent.productName) {
        return t("agentsHub.playgroundIntentPaymentLink", {
          product: intent.productName,
        });
      }
      if (intent.query) {
        return t("agentsHub.playgroundIntentPaymentLinkQuery", {
          query: intent.query,
        });
      }
      return t("agentsHub.playgroundIntentPaymentLinkNone");
    default:
      return t("agentsHub.playgroundIntentUnknown", {
        name: intent.toolName ?? "",
      });
  }
}

/** Biaya provider sangat kecil per lari — tampilkan presisi yang terbaca. */
function formatUsd(value: number): string {
  if (value === 0) return "0";
  return value < 0.01 ? value.toFixed(6) : value.toFixed(4);
}

interface PlaygroundPanelProps {
  t: Translate;
  locale: Locale;
  /** Berpindah ke tab Agen (dipakai tombol pada keadaan belum ada agent). */
  onOpenAgentsTab: () => void;
  /**
   * Draf agent dari formulir buat/edit ("Coba di Playground") — bila
   * terisi, panel masuk MODE DRAF: uji memakai konfigurasi draf ini
   * lewat endpoint playground-draft, tanpa agent tersimpan apa pun.
   */
  draft?: AgentPlaygroundDraftConfig | null;
  /** Keluar mode draf → kembali ke mode agent tersimpan. */
  onExitDraft?: () => void;
}

/**
 * Panel Playground hub /agents (Fase 12E): uji KERING agent pilihan
 * pemilik. Riwayat chat HANYA hidup di state komponen ini (tidak pernah
 * disimpan di server); setiap kiriman memanggil endpoint playground
 * yang menjalankan jalur draft yang sama seperti runtime — balasan,
 * potongan KB terambil, dan NIAT tool ditampilkan, tetapi tidak ada
 * pesan terkirim dan tidak ada data berubah (penanda mode uji selalu
 * terlihat di atas panel).
 */
export function PlaygroundPanel({
  t,
  locale,
  onOpenAgentsTab,
  draft,
  onExitDraft,
}: PlaygroundPanelProps) {
  const draftMode = draft != null;
  const draftName =
    draft?.name ?? t("agentsHub.playgroundDraftFallbackName");
  const { status, tenants, active } = useWorkspace();
  const tenantId = active?.id ?? null;

  const [agents, setAgents] = useState<AgentResponse[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [turns, setTurns] = useState<PlaygroundTurn[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nextId = useRef(1);
  const requestSeq = useRef(0);

  const loadAgents = useCallback(async () => {
    if (!tenantId) return;
    const seq = ++requestSeq.current;
    setAgentsLoading(true);
    try {
      const list = await api.agents.list(tenantId);
      if (requestSeq.current !== seq) return;
      setAgents(list);
      setSelectedAgentId((prev) =>
        prev && list.some((a) => a.id === prev) ? prev : (list[0]?.id ?? ""),
      );
    } catch (err) {
      if (requestSeq.current !== seq) return;
      setError(translateApiError(t, err));
      setAgents([]);
    } finally {
      if (requestSeq.current === seq) setAgentsLoading(false);
    }
  }, [tenantId, t]);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  // Ganti workspace = sesi uji baru (riwayat uji tidak menyeberang tenant).
  useEffect(() => {
    setTurns([]);
    setError(null);
    setInput("");
  }, [tenantId]);

  // Ganti draf (seed baru dari formulir) atau keluar mode draf = sesi uji
  // baru: riwayat draf lama tidak boleh terbaca sebagai uji draf yang baru.
  useEffect(() => {
    setTurns([]);
    setError(null);
    setInput("");
  }, [draft]);

  const selectedAgent = agents.find((a) => a.id === selectedAgentId) ?? null;

  const handleSend = async (e: FormEvent) => {
    e.preventDefault();
    const message = input.trim();
    if (!message || !tenantId || sending) return;
    // Mode tersimpan butuh agent pilihan; mode draf berdiri sendiri.
    if (!draftMode && !selectedAgent) return;
    const userTurn: PlaygroundTurn = {
      id: nextId.current++,
      role: "user",
      text: message,
    };
    const history = turns
      .slice(-20)
      .map((turn) => ({ role: turn.role, content: turn.text }));
    setTurns((prev) => [...prev, userTurn]);
    setInput("");
    setError(null);
    setSending(true);
    try {
      const result = draftMode
        ? await api.agents.playgroundDraft(tenantId, {
            draft,
            message,
            history,
          })
        : await api.agents.playground(tenantId, selectedAgent!.id, {
            message,
            history,
          });
      setTurns((prev) => [
        ...prev,
        {
          id: nextId.current++,
          role: "assistant",
          text: result.replyText,
          agentName: draftMode ? draftName : selectedAgent!.name,
          result,
        },
      ]);
    } catch (err) {
      // Gagal = giliran uji tidak terjadi; kembalikan pesan ke kotak
      // ketik agar pemilik bisa mencoba lagi tanpa mengetik ulang.
      setTurns((prev) => prev.filter((turn) => turn.id !== userTurn.id));
      setInput(message);
      setError(translateApiError(t, err));
    } finally {
      setSending(false);
    }
  };

  if (status === "loading") {
    return <p className="text-sm text-muted">{t("workspace.loading")}</p>;
  }
  if (status !== "error" && (tenants.length === 0 || !active)) {
    return (
      <div className="rounded-xl border border-dashed border-line bg-surface p-6">
        <h2 className="text-lg font-semibold text-ink">{t("workspace.emptyTitle")}</h2>
        <p className="mt-1 max-w-md text-sm text-muted">{t("workspace.emptyBody")}</p>
      </div>
    );
  }

  return (
    <div>
      {/* Penanda mode uji — selalu terlihat selama panel terbuka. */}
      <div className="rounded-xl border border-line bg-elevated p-4">
        <p className="text-xs leading-relaxed text-muted">
          {t("agentsHub.playgroundDryRunNote")}
        </p>
      </div>

      {/* Spanduk mode draf: yang diuji adalah isi formulir agent yang
          BELUM disimpan, bukan agent tersimpan mana pun. */}
      {draftMode ? (
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line bg-surface p-4">
          <p className="min-w-0 flex-1 text-sm text-ink">
            {t("agentsHub.playgroundDraftBanner", { name: draftName })}
          </p>
          <span className="shrink-0 rounded-full bg-accent/10 px-2 py-0.5 text-xs font-semibold text-accent">
            {t("agentsHub.playgroundDraftBadge")}
          </span>
          {onExitDraft ? (
            <button
              type="button"
              onClick={onExitDraft}
              className="shrink-0 rounded-lg bg-elevated px-3 py-1.5 text-xs font-medium text-ink"
            >
              {t("agentsHub.playgroundDraftExitButton")}
            </button>
          ) : null}
        </div>
      ) : null}

      {draftMode ? (
        <PlaygroundChat
          t={t}
          locale={locale}
          turns={turns}
          input={input}
          sending={sending}
          error={error}
          canSend={tenantId !== null}
          onInputChange={setInput}
          onSend={handleSend}
          header={
            turns.length > 0 ? (
              <div className="mt-4 flex flex-wrap items-end gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setTurns([]);
                    setError(null);
                  }}
                  className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium text-ink"
                >
                  {t("agentsHub.playgroundResetButton")}
                </button>
              </div>
            ) : null
          }
        />
      ) : agentsLoading ? (
        <p className="mt-6 text-sm text-muted">{t("common.loading")}</p>
      ) : agents.length === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-line bg-surface p-8 text-center">
          <p className="mx-auto max-w-md text-sm text-muted">
            {t("agentsHub.playgroundNoAgents")}
          </p>
          <button
            type="button"
            onClick={onOpenAgentsTab}
            className="mt-4 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white"
          >
            {t("agentsHub.playgroundGoAgentsButton")}
          </button>
        </div>
      ) : (
        <PlaygroundChat
          t={t}
          locale={locale}
          turns={turns}
          input={input}
          sending={sending}
          error={error}
          canSend={selectedAgent !== null}
          onInputChange={setInput}
          onSend={handleSend}
          header={
            <div className="mt-4 flex flex-wrap items-end gap-3">
              <label className="block min-w-56 flex-1 sm:max-w-xs">
                <span className="mb-1 block text-xs font-medium text-muted">
                  {t("agentsHub.playgroundAgentLabel")}
                </span>
                <select
                  value={selectedAgentId}
                  onChange={(e) => setSelectedAgentId(e.target.value)}
                  className={inputClassName}
                >
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                      {" · "}
                      {t(
                        agent.mode === "suggest"
                          ? "agents.modeSuggest"
                          : "agents.modeAuto",
                      )}
                    </option>
                  ))}
                </select>
              </label>
              {turns.length > 0 ? (
                <button
                  type="button"
                  onClick={() => {
                    setTurns([]);
                    setError(null);
                  }}
                  className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium text-ink"
                >
                  {t("agentsHub.playgroundResetButton")}
                </button>
              ) : null}
            </div>
          }
        />
      )}
    </div>
  );
}

/**
 * Permukaan chat uji yang dipakai bersama mode agent tersimpan dan
 * mode draf: header (pemilih agent ATAU tombol reset draf) disediakan
 * pemanggil; daftar giliran, keadaan kosong, dan formulir kirim sama
 * persis di kedua mode — hanya sumber balasannya yang berbeda.
 */
function PlaygroundChat({
  t,
  locale,
  turns,
  input,
  sending,
  error,
  canSend,
  onInputChange,
  onSend,
  header,
}: {
  t: Translate;
  locale: Locale;
  turns: PlaygroundTurn[];
  input: string;
  sending: boolean;
  error: string | null;
  /** Mode tersimpan: ada agent terpilih. Mode draf: selalu true. */
  canSend: boolean;
  onInputChange: (value: string) => void;
  onSend: (e: FormEvent) => void;
  header: ReactNode;
}) {
  return (
    <>
      {header}

      <FieldError message={error} />

      {turns.length === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-line bg-surface p-8 text-center">
          <h2 className="text-base font-semibold text-ink">
            {t("agentsHub.playgroundEmptyTitle")}
          </h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted">
            {t("agentsHub.playgroundEmptyBody")}
          </p>
        </div>
      ) : (
        <ul className="mt-6 space-y-4">
          {turns.map((turn) => (
            <li key={turn.id}>
              {turn.role === "user" ? (
                <div className="ml-auto max-w-xl rounded-2xl rounded-br-md bg-accent/10 p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                    {t("agentsHub.playgroundCustomerLabel")}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-ink">
                    {turn.text}
                  </p>
                </div>
              ) : (
                <div className="mr-auto max-w-xl rounded-2xl rounded-bl-md border border-line bg-surface p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                    {turn.agentName ?? t("agentsHub.playgroundAgentLabel")}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-ink">
                    {turn.text}
                  </p>
                  {turn.result ? (
                    <PlaygroundResultDetails
                      t={t}
                      locale={locale}
                      result={turn.result}
                    />
                  ) : null}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={onSend} className="mt-6 flex items-end gap-2">
        <textarea
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={t("agentsHub.playgroundInputPlaceholder")}
          rows={2}
          maxLength={4000}
          className={`${inputClassName} flex-1 resize-none`}
        />
        <button
          type="submit"
          disabled={sending || !canSend || input.trim() === ""}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
        >
          {sending
            ? t("agentsHub.playgroundSending")
            : t("agentsHub.playgroundSendButton")}
        </button>
      </form>
    </>
  );
}

/** Rincian satu lari playground: mode retrieval, niat tool, potongan KB, usage. */
function PlaygroundResultDetails({
  t,
  locale,
  result,
}: {
  t: Translate;
  locale: Locale;
  result: AgentPlaygroundResponse;
}) {
  return (
    <div className="mt-3 space-y-3 border-t border-line pt-3">
      <p>
        <span className="rounded-full bg-elevated px-2 py-0.5 text-[11px] font-semibold text-ink">
          {t(
            result.retrieval === "hybrid"
              ? "agentsHub.playgroundRetrievalHybrid"
              : "agentsHub.playgroundRetrievalFts",
          )}
        </span>
      </p>

      {result.intents.length > 0 ? (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
            {t("agentsHub.playgroundIntentTitle")}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {result.intents.map((intent, idx) => (
              <span
                key={idx}
                className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-semibold text-accent"
              >
                {intentLabel(t, intent)}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <details>
        <summary className="cursor-pointer text-xs font-medium text-ink">
          {t("agentsHub.playgroundKbTitle", { count: result.kbHits.length })}
        </summary>
        {result.kbHits.length === 0 ? (
          <p className="mt-2 text-xs text-muted">
            {t("agentsHub.playgroundKbEmpty")}
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {result.kbHits.map((hit) => (
              <li
                key={hit.chunkId}
                className="rounded-lg border border-line bg-elevated p-3"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs font-semibold text-ink">
                    {hit.documentTitle}
                  </span>
                  {hit.sources.map((source) => (
                    <span
                      key={source}
                      className="rounded-full bg-surface px-1.5 py-0.5 text-[10px] font-semibold text-muted"
                    >
                      {t(
                        source === "vector"
                          ? "agentsHub.playgroundSourceVector"
                          : "agentsHub.playgroundSourceFts",
                      )}
                    </span>
                  ))}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-muted">
                  {hit.snippet}
                </p>
              </li>
            ))}
          </ul>
        )}
      </details>

      <p className="text-[11px] text-muted">
        {t("agentsHub.playgroundUsageLine", {
          provider: result.usage.provider,
          model: result.usage.model,
          tokensIn: formatNumber(result.usage.tokensIn, locale),
          tokensOut: formatNumber(result.usage.tokensOut, locale),
        })}
        {result.usage.costUsd !== null
          ? t("agentsHub.playgroundUsageCost", {
              cost: formatUsd(result.usage.costUsd),
            })
          : ""}
      </p>
    </div>
  );
}
