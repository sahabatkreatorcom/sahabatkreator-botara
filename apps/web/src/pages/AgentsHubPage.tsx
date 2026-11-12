import { useCallback, useEffect, useState } from "react";
import type { AgentPlaygroundDraftConfig } from "@sahabat-kreator/contracts";
import type { Locale, TranslationKey } from "@sahabat-kreator/i18n";
import { AgentsListSection, SuggestionsSection } from "./AgentsPage";
import { KnowledgePage } from "./KnowledgePage";
import { PlaygroundPanel } from "../agents/PlaygroundPanel";
import { usePendingApprovals } from "../agents/PendingApprovalsProvider";

type Translate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

/** Tab hub /agents (Fase 12E) — nilai query `?tab=` di URL. */
export type AgentsHubTab = "agents" | "suggestions" | "knowledge" | "playground";

const HUB_TABS: AgentsHubTab[] = [
  "agents",
  "suggestions",
  "knowledge",
  "playground",
];

function readTabFromUrl(): AgentsHubTab {
  if (typeof window === "undefined") return "agents";
  const raw = new URLSearchParams(window.location.search).get("tab");
  return HUB_TABS.includes(raw as AgentsHubTab)
    ? (raw as AgentsHubTab)
    : "agents";
}

interface AgentsHubPageProps {
  t: Translate;
  locale: Locale;
}

/**
 * Hub /agents (Fase 12E, arahan user 2026-11-02): Agen, Antrean Saran,
 * Knowledge Base, dan Playground adalah SATU permukaan — keempatnya
 * saling berhubungan (agent menjawab dari KB; saran adalah keluaran
 * agent mode suggest; playground menguji keduanya). Tab hidup di query
 * URL `?tab=` agar bisa di-deep-link (tautan lama /knowledge dialihkan
 * App ke ?tab=knowledge); router shell sendiri tetap berbasis pathname,
 * jadi hub mengelola query-nya sendiri (pushState + popstate).
 *
 * Badge jumlah draf pending pada tab Antrean Saran memakai provider
 * yang sama seperti badge navigasi (PendingApprovalsProvider).
 */
export function AgentsHubPage({ t, locale }: AgentsHubPageProps) {
  const [tab, setTab] = useState<AgentsHubTab>(() => readTabFromUrl());
  const { pendingCount } = usePendingApprovals();
  // Draf agent dari formulir buat/edit ("Coba di Playground") — diuji di
  // PlaygroundPanel TANPA disimpan; null = mode agent tersimpan biasa.
  const [playgroundDraft, setPlaygroundDraft] =
    useState<AgentPlaygroundDraftConfig | null>(null);

  useEffect(() => {
    const onPopState = () => setTab(readTabFromUrl());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const selectTab = useCallback((next: AgentsHubTab) => {
    setTab(next);
    const url = next === "agents" ? "/agents" : `/agents?tab=${next}`;
    if (`${window.location.pathname}${window.location.search}` !== url) {
      window.history.pushState({}, "", url);
    }
  }, []);

  const tabLabel = (id: AgentsHubTab): string =>
    id === "agents"
      ? t("agents.title")
      : id === "suggestions"
        ? t("agentsHub.tabSuggestions")
        : id === "knowledge"
          ? t("knowledge.title")
          : t("agentsHub.tabPlayground");

  return (
    <section>
      <div
        role="tablist"
        aria-label={t("agents.title")}
        className="flex flex-wrap gap-1 border-b border-line"
      >
        {HUB_TABS.map((id) => {
          const selected = tab === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => selectTab(id)}
              className={`-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium ${
                selected
                  ? "border-accent text-ink"
                  : "border-transparent text-muted hover:text-ink"
              }`}
            >
              {tabLabel(id)}
              {id === "suggestions" && pendingCount > 0 ? (
                <span className="rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
                  {pendingCount}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div className="mt-5">
        {tab === "agents" ? (
          <AgentsListSection
            t={t}
            locale={locale}
            onTryInPlayground={(draft) => {
              setPlaygroundDraft(draft);
              selectTab("playground");
            }}
          />
        ) : tab === "suggestions" ? (
          <SuggestionsSection t={t} locale={locale} />
        ) : tab === "knowledge" ? (
          <KnowledgePage t={t} locale={locale} embedded />
        ) : (
          <PlaygroundPanel
            t={t}
            locale={locale}
            onOpenAgentsTab={() => selectTab("agents")}
            draft={playgroundDraft}
            onExitDraft={() => setPlaygroundDraft(null)}
          />
        )}
      </div>
    </section>
  );
}
