/**
 * Panel eksperimen A/B sebuah flow.
 */
import { type FlowExperimentsResponse } from "@sahabat-kreator/contracts";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../api/client";
import { usePolling } from "../../hooks/usePolling";
import { type Translate } from "./types";

export interface FlowExperimentsPanelProps {
  t: Translate;
  tenantId: string;
  flowId: string;
}

/**
 * Panel hasil eksperimen A/B (Fase 13D) — membaca endpoint dashboard
 * `flows/:id/experiments`. Semua angka + putusan dihitung SERVER
 * (uji z dua-proporsi + pagar sampel minimum di core); panel ini
 * hanya menampilkan: pemenang hanya disebut bila server menyatakan
 * status "winner" beserta nilai z/p-nya.
 */
export function FlowExperimentsPanel({ t, tenantId, flowId }: FlowExperimentsPanelProps) {
  const [data, setData] = useState<FlowExperimentsResponse | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.flows.experiments(tenantId, flowId);
      setData(res);
    } catch {
      setData(null);
    } finally {
      setLoaded(true);
    }
  }, [tenantId, flowId]);

  useEffect(() => {
    void load();
  }, [load]);
  usePolling(() => void load(), 10000, true);

  if (!loaded) return null;
  const experiments = data?.experiments ?? [];
  return (
    <div className="mb-4 border-b border-line pb-4">
      <h3 className="text-sm font-semibold text-ink">
        {t("flows.experimentsTitle")}
      </h3>
      <p className="mt-1 text-xs text-muted">{t("flows.experimentsHint")}</p>
      {experiments.length === 0 ? (
        <p className="mt-3 text-sm text-muted">
          {t("flows.experimentsEmpty")}
        </p>
      ) : (
        <div className="mt-3 space-y-4">
          {experiments.map((exp) => (
            <div
              key={exp.nodeId}
              className="rounded-lg border border-line bg-elevated/40 p-3"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-medium text-ink">
                  {exp.label ?? exp.nodeId}
                </p>
                <p className="text-xs text-muted">
                  {t("flows.expSplitNote", {
                    percentA: exp.percentA,
                    percentB: 100 - exp.percentA,
                  })}
                </p>
              </div>
              <table className="mt-2 w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted">
                    <th className="py-1 pr-2 font-medium">
                      {t("flows.expColBranch")}
                    </th>
                    <th className="py-1 pr-2 font-medium">
                      {t("flows.expColAssigned")}
                    </th>
                    <th className="py-1 pr-2 font-medium">
                      {t("flows.expColRuns")}
                    </th>
                    <th className="py-1 pr-2 font-medium">
                      {t("flows.expColCompleted")}
                    </th>
                    <th className="py-1 pr-2 font-medium">
                      {t("flows.expColConversions")}
                    </th>
                    <th className="py-1 font-medium">
                      {t("flows.expColRate")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {exp.variants.map((v) => (
                    <tr key={v.branch} className="border-t border-line">
                      <td className="py-1.5 pr-2 font-semibold uppercase text-ink">
                        {v.branch}
                      </td>
                      <td className="py-1.5 pr-2 text-ink">
                        {v.assignedContacts}
                      </td>
                      <td className="py-1.5 pr-2 text-ink">{v.runs}</td>
                      <td className="py-1.5 pr-2 text-ink">
                        {v.completedRuns}
                      </td>
                      <td className="py-1.5 pr-2 text-ink">{v.conversions}</td>
                      <td className="py-1.5 text-ink">
                        {v.conversionRate === null
                          ? "—"
                          : `${(v.conversionRate * 100).toFixed(1)}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-muted">
                {!exp.conversionNodeId
                  ? t("flows.expNoConversionPoint")
                  : exp.verdict.status === "winner"
                    ? t("flows.expWinner", {
                        branch: (exp.verdict.winnerBranch ?? "").toUpperCase(),
                        z: exp.verdict.z?.toFixed(2) ?? "—",
                        p: exp.verdict.pValue?.toFixed(4) ?? "—",
                      })
                    : exp.verdict.status === "no_significant_difference"
                      ? t("flows.expNoDifference", {
                          z: exp.verdict.z?.toFixed(2) ?? "—",
                          p: exp.verdict.pValue?.toFixed(4) ?? "—",
                        })
                      : t("flows.expNotEnoughData", {
                          min: exp.verdict.minSamplePerVariant,
                        })}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
