/**
 * Halaman pembangun flow.
 *
 * Berkas ini menyimpan yang memang hanya milik halaman: state kanvas,
 * pemuatan data, penyimpanan, dan penataan tata letak. Bagian yang dapat
 * berdiri sendiri sudah dipindah ke `./flowBuilder/` — konversi graf,
 * kartu node, panel konfigurasi, panel run, dan panel eksperimen.
 */
import "@xyflow/react/dist/style.css";
import { type AppointmentServiceResponse, type FlowEdgeBranch, type FlowGraphIssue, type FlowNodeType, type FlowResponse, type ProductResponse } from "@sahabat-kreator/contracts";
import { type Locale } from "@sahabat-kreator/i18n";
import { Background, BackgroundVariant, type Connection, Controls, MiniMap, ReactFlow, ReactFlowProvider, addEdge, useEdgesState, useNodesState, useReactFlow } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiClientError, api } from "../api/client";
import { translateApiError } from "../api/errorText";
import { ADDABLE_NODE_TYPES, FLOW_BRANCHED_TYPES, FLOW_NODE_LABEL_KEYS, defaultNodeConfig, issuesFromError, splitIssues, translateFlowIssue } from "../flows/graphModel";
import { useWorkspace } from "../workspace/WorkspaceProvider";
import { FlowExperimentsPanel } from "./flowBuilder/FlowExperimentsPanel";
import { NODE_TYPES } from "./flowBuilder/FlowNodeCard";
import { FlowRunsPanel } from "./flowBuilder/FlowRunsPanel";
import { FlowSimulatorPanel } from "./flowBuilder/FlowSimulatorPanel";
import { FlowVersionsPanel } from "./flowBuilder/FlowVersionsPanel";
import { NodeConfigPanel, type TenantMeta } from "./flowBuilder/NodeConfigPanel";
import { NODE_ICON_PATHS, branchEdgeLabelProps, graphToRf, rfToGraph } from "./flowBuilder/graph";
import { BuilderCtx, type BuilderShared, type FlowRfEdge, type FlowRfNode, type Translate } from "./flowBuilder/types";

interface BuilderInnerProps {
  t: Translate;
  locale: Locale;
  tenantId: string;
  flow: FlowResponse;
  canManage: boolean;
  meta: TenantMeta;
  onFlowChange: (flow: FlowResponse) => void;
  onBack: () => void;
}

function BuilderInner({
  t,
  locale,
  tenantId,
  flow,
  canManage,
  meta,
  onFlowChange,
  onBack,
}: BuilderInnerProps) {
  const readOnly = flow.status !== "draft" || !canManage;
  const [name, setName] = useState(flow.name);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowRfNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowRfEdge>([]);
  const [tab, setTab] = useState<"canvas" | "runs" | "versions" | "simulate">(
    "canvas",
  );
  const [issues, setIssues] = useState<FlowGraphIssue[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [activating, setActivating] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const snapshotRef = useRef<string>("");
  const counterRef = useRef(0);
  const reactFlow = useReactFlow();
  const initializedForRef = useRef<string | null>(null);

  // Muat graf ke kanvas sekali per flow (atau saat status kembali ke
  // draft lewat nonaktifkan — graf server adalah sumber kebenaran).
  useEffect(() => {
    if (initializedForRef.current === flow.id) return;
    initializedForRef.current = flow.id;
    const { nodes: rfNodes, edges: rfEdges } = graphToRf(flow.graph);
    const labeledEdges = rfEdges.map((e) =>
      e.data?.branch
        ? { ...e, ...branchEdgeLabelProps(t, e.data.branch) }
        : e,
    );
    setNodes(rfNodes);
    setEdges(labeledEdges);
    setName(flow.name);
    snapshotRef.current = JSON.stringify({
      name: flow.name,
      graph: rfToGraph(rfNodes, rfEdges),
    });
    setIssues([]);
    setNotice(null);
    setError(null);
  }, [flow, setNodes, setEdges, t]);

  // Label cabang pada edge mengikuti bahasa aktif. Dipisah dari efek
  // pemuatan graf di atas dengan sengaja: efek itu dijaga
  // `initializedForRef` supaya kanvas tidak dimuat ulang (dan perubahan
  // yang belum disimpan tidak hilang), sehingga pergantian bahasa tidak
  // akan pernah memperbarui label bila pelabelan menumpang di sana.
  useEffect(() => {
    setEdges((eds) =>
      eds.map((e) =>
        e.data?.branch ? { ...e, ...branchEdgeLabelProps(t, e.data.branch) } : e,
      ),
    );
  }, [t, setEdges]);

  const currentGraph = useMemo(
    () => rfToGraph(nodes, edges),
    [nodes, edges],
  );
  const dirty =
    snapshotRef.current !== "" &&
    JSON.stringify({ name, graph: currentGraph }) !== snapshotRef.current;

  const selectedNode = nodes.find((n) => n.selected) ?? null;

  const sequenceName = useCallback(
    (automationId: string) =>
      meta.sequences.find((s) => s.id === automationId)?.name,
    [meta.sequences],
  );

  const flowName = useCallback(
    (flowId: string) =>
      flowId === flow.id
        ? flow.name
        : meta.flows.find((f) => f.id === flowId)?.name,
    [meta.flows, flow.id, flow.name],
  );

  const productName = useCallback(
    (productId: string) =>
      meta.products.find((p) => p.id === productId)?.name,
    [meta.products],
  );

  const serviceName = useCallback(
    (serviceId: string) =>
      meta.appointmentServices.find((s) => s.id === serviceId)?.name,
    [meta.appointmentServices],
  );

  const dealStageName = useCallback(
    (stageId: string) => meta.dealStages.find((s) => s.id === stageId)?.name,
    [meta.dealStages],
  );

  // Tandai node yang disebut issue (klik issue juga memilih node itu).
  useEffect(() => {
    const severityByNode = new Map<string, "error" | "warning">();
    for (const issue of issues) {
      if (!issue.nodeId) continue;
      const prev = severityByNode.get(issue.nodeId);
      if (prev !== "error") severityByNode.set(issue.nodeId, issue.severity);
    }
    setNodes((prev) =>
      prev.map((n) => {
        const sev = severityByNode.get(n.id) ?? null;
        return n.data.issueSeverity === sev
          ? n
          : { ...n, data: { ...n.data, issueSeverity: sev } };
      }),
    );
  }, [issues, setNodes]);

  const focusNode = useCallback(
    (nodeId: string) => {
      setTab("canvas");
      setNodes((prev) =>
        prev.map((n) => ({ ...n, selected: n.id === nodeId })),
      );
      const node = nodes.find((n) => n.id === nodeId);
      if (node) {
        void reactFlow.setCenter(
          node.position.x + 114,
          node.position.y + 40,
          { zoom: 1.1, duration: 400 },
        );
      }
    },
    [nodes, reactFlow, setNodes],
  );

  const handleNodesChange = useCallback(
    (changes: Parameters<typeof onNodesChange>[0]) => {
      // Trigger tidak pernah terhapus (deletable=false + saring di sini
      // untuk jalur keyboard sekalipun).
      const safeChanges = changes.filter(
        (c) =>
          !(
            c.type === "remove" &&
            nodes.find((n) => n.id === c.id)?.data.nodeType === "trigger"
          ),
      );
      const removedIds = safeChanges
        .filter((c) => c.type === "remove")
        .map((c) => c.id);
      onNodesChange(safeChanges);
      if (removedIds.length > 0) {
        setEdges((prev) =>
          prev.filter(
            (e) => !removedIds.includes(e.source) && !removedIds.includes(e.target),
          ),
        );
      }
    },
    [nodes, onNodesChange, setEdges],
  );

  // Mode hanya-baca: perubahan posisi/koneksi dimatikan, tetapi seleksi
  // tetap diteruskan agar panel konfigurasi bisa dipakai untuk MEMBACA.
  const handleNodesChangeReadOnly = useCallback(
    (changes: Parameters<typeof onNodesChange>[0]) => {
      onNodesChange(changes.filter((c) => c.type === "select"));
    },
    [onNodesChange],
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      if (connection.source === connection.target) return;
      const sourceNode = nodes.find((n) => n.id === connection.source);
      const targetNode = nodes.find((n) => n.id === connection.target);
      if (!sourceNode || !targetNode) return;
      if (targetNode.data.nodeType === "trigger") return;
      // Node bercabang: branch berasal dari handle sumber yang
      // dipakai; koneksi tanpa handle spesifik jatuh ke cabang
      // pertama tipe itu (perilaku condition 8B digeneralisasi).
      const branched = FLOW_BRANCHED_TYPES[sourceNode.data.nodeType];
      const branch: FlowEdgeBranch | undefined = branched
        ? (branched.find((b) => b.branch === connection.sourceHandle)
            ?.branch ?? branched[0].branch)
        : undefined;
      counterRef.current += 1;
      const newEdge: FlowRfEdge = {
        id: `e-${connection.source}-${branch ?? "next"}-${connection.target}-${Date.now()}-${counterRef.current}`,
        source: connection.source,
        target: connection.target,
        ...(branch ? { sourceHandle: branch } : {}),
        ...(branch ? branchEdgeLabelProps(t, branch) : {}),
        data: branch ? { branch } : {},
      };
      setEdges((prev) => {
        // Satu edge keluar per (node, cabang): koneksi baru menggantikan
        // yang lama — selaras semantik eksekutor (edge pertama yang
        // dipakai untuk node non-condition).
        const kept = prev.filter(
          (e) =>
            !(
              e.source === connection.source &&
              (e.data?.branch ?? undefined) === branch
            ),
        );
        return addEdge(newEdge, kept);
      });
    },
    [nodes, setEdges, t],
  );

  const isValidConnection = useCallback(
    (connection: Connection | FlowRfEdge) => {
      if (!connection.source || !connection.target) return false;
      if (connection.source === connection.target) return false;
      const targetNode = nodes.find((n) => n.id === connection.target);
      if (!targetNode || targetNode.data.nodeType === "trigger") return false;
      return true;
    },
    [nodes],
  );

  const addNode = useCallback(
    (type: FlowNodeType, position?: { x: number; y: number }) => {
      counterRef.current += 1;
      const id = `n_${type}_${Date.now().toString(36)}_${counterRef.current}`;
      const maxY = nodes.reduce((acc, n) => Math.max(acc, n.position.y), 0);
      const newNode: FlowRfNode = {
        id,
        type: "flowNode",
        position: position ?? { x: 290, y: maxY + 180 },
        data: {
          nodeType: type,
          config: defaultNodeConfig(type),
          issueSeverity: null,
        },
        deletable: type !== "trigger",
        selected: true,
      };
      setNodes((prev) => [
        ...prev.map((n) => ({ ...n, selected: false })),
        newNode,
      ]);
    },
    [nodes, setNodes],
  );

  const onDragStartPalette = (
    event: React.DragEvent,
    type: FlowNodeType,
  ) => {
    event.dataTransfer.setData("application/sk-flow-node", type);
    event.dataTransfer.effectAllowed = "move";
  };

  const onCanvasDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const type = event.dataTransfer.getData(
        "application/sk-flow-node",
      ) as FlowNodeType;
      if (!type || !ADDABLE_NODE_TYPES.includes(type)) return;
      const position = reactFlow.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      addNode(type, { x: position.x - 114, y: position.y - 30 });
    },
    [addNode, reactFlow],
  );

  const updateNodeConfig = useCallback(
    (nodeId: string, config: Record<string, unknown>) => {
      setNodes((prev) =>
        prev.map((n) =>
          n.id === nodeId ? { ...n, data: { ...n.data, config } } : n,
        ),
      );
    },
    [setNodes],
  );

  const deleteNode = useCallback(
    (nodeId: string) => {
      setNodes((prev) => prev.filter((n) => n.id !== nodeId));
      setEdges((prev) =>
        prev.filter((e) => e.source !== nodeId && e.target !== nodeId),
      );
    },
    [setNodes, setEdges],
  );

  const saveDraft = useCallback(async (): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      const saved = await api.flows.update(tenantId, flow.id, {
        name: name.trim() || flow.name,
        graph: currentGraph,
      });
      snapshotRef.current = JSON.stringify({
        name: saved.name,
        graph: rfToGraph(nodes, edges),
      });
      onFlowChange(saved);
      return true;
    } catch (err) {
      setError(translateApiError(t, err));
      return false;
    } finally {
      setSaving(false);
    }
  }, [tenantId, flow.id, flow.name, name, currentGraph, nodes, edges, onFlowChange, t]);

  const runValidate = async () => {
    setValidating(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.flows.validate(tenantId, flow.id, currentGraph);
      setIssues(result.issues);
      const { errors, warnings } = splitIssues(result.issues);
      if (errors.length === 0) {
        setNotice(
          warnings.length > 0
            ? t("flows.validWithWarnings", { count: warnings.length })
            : t("flows.validOk"),
        );
      }
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setValidating(false);
    }
  };

  const runActivate = async () => {
    setActivating(true);
    setError(null);
    setNotice(null);
    try {
      if (dirty) {
        const ok = await saveDraft();
        if (!ok) return;
      }
      const result = await api.flows.activate(tenantId, flow.id);
      onFlowChange(result.flow);
      setIssues(result.warnings);
      setNotice(
        result.warnings.length > 0
          ? t("flows.activatedWithWarnings", {
              count: result.warnings.length,
            })
          : t("flows.activatedOk"),
      );
    } catch (err) {
      const parsed = issuesFromError(err);
      if (err instanceof ApiClientError && err.code === "FLOW_GRAPH_INVALID" && parsed) {
        setIssues(parsed);
      } else {
        setError(translateApiError(t, err));
      }
    } finally {
      setActivating(false);
    }
  };

  const changeStatus = async (action: "deactivate" | "unarchive") => {
    setStatusBusy(true);
    setError(null);
    try {
      const updated =
        action === "deactivate"
          ? await api.flows.deactivate(tenantId, flow.id)
          : await api.flows.unarchive(tenantId, flow.id);
      // Status kembali draft → muat ulang graf dari server ke kanvas.
      initializedForRef.current = null;
      onFlowChange(updated);
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setStatusBusy(false);
    }
  };

  const { errors: issueErrors, warnings: issueWarnings } = splitIssues(issues);

  const renderIssueList = (list: FlowGraphIssue[], danger: boolean) => (
    <ul className="space-y-1">
      {list.map((issue, i) => {
        const node = issue.nodeId
          ? nodes.find((n) => n.id === issue.nodeId)
          : undefined;
        return (
          <li key={`${issue.code}-${issue.nodeId ?? "graph"}-${i}`}>
            <button
              type="button"
              disabled={!node}
              onClick={() => issue.nodeId && focusNode(issue.nodeId)}
              className={`text-left text-sm ${
                danger ? "text-danger" : "text-warning"
              } ${node ? "hover:underline" : "cursor-default"}`}
            >
              {translateFlowIssue(t, issue)}
              <span className="text-muted">
                {" — "}
                {node
                  ? t("flows.issueOnNode", {
                      node: t(FLOW_NODE_LABEL_KEYS[node.data.nodeType]),
                    })
                  : t("flows.issueGraphWide")}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );

  const shared: BuilderShared = {
    t,
    readOnly,
    sequenceName,
    flowName,
    productName,
    serviceName,
    dealStageName,
  };

  return (
    <section>
      <button
        type="button"
        onClick={onBack}
        className="text-sm text-muted hover:text-ink"
      >
        ← {t("flows.backToList")}
      </button>

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <input
          className="min-w-52 flex-1 rounded-lg border border-line bg-surface px-3 py-2 text-lg font-bold text-ink disabled:opacity-70 sm:flex-none sm:text-xl"
          value={name}
          disabled={readOnly}
          maxLength={255}
          onChange={(e) => setName(e.target.value)}
          aria-label={t("flows.nameLabel")}
        />
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
            flow.status === "active"
              ? "bg-success/15 text-success"
              : "bg-elevated text-muted"
          }`}
        >
          {t(
            flow.status === "active"
              ? "flows.statusActive"
              : flow.status === "archived"
                ? "flows.statusArchived"
                : "flows.statusDraft",
          )}
        </span>
        <span className="text-xs text-muted">
          {t("flows.runCount", { count: flow.runCount })}
        </span>
      </div>

      {flow.status !== "draft" ? (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg bg-warning/10 px-3 py-2 text-sm text-ink">
          <span>
            {flow.status === "active"
              ? t("flows.readonlyActive")
              : t("flows.readonlyArchived")}
          </span>
          {canManage ? (
            <button
              type="button"
              disabled={statusBusy}
              onClick={() =>
                void changeStatus(
                  flow.status === "active" ? "deactivate" : "unarchive",
                )
              }
              className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink hover:bg-elevated disabled:opacity-50"
            >
              {flow.status === "active"
                ? t("flows.deactivateToEdit")
                : t("flows.unarchiveToEdit")}
            </button>
          ) : null}
        </div>
      ) : null}
      {!canManage ? (
        <p className="mt-4 rounded-lg bg-elevated px-3 py-2 text-sm text-muted">
          {t("flows.forbidden")}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-lg border border-line">
          {(
            [
              ["canvas", "flows.tabCanvas"],
              ["runs", "flows.tabRuns"],
              ["versions", "flows.tabVersions"],
              ["simulate", "flows.tabSimulate"],
            ] as const
          ).map(([value, key]) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              className={`px-3 py-1.5 text-sm font-medium ${
                tab === value
                  ? "bg-accent text-white"
                  : "bg-surface text-muted hover:text-ink"
              }`}
            >
              {t(key)}
            </button>
          ))}
        </div>
        {tab === "canvas" && !readOnly ? (
          <>
            <button
              type="button"
              disabled={saving}
              onClick={() =>
                void saveDraft().then((ok) => {
                  if (ok) setNotice(t("flows.savedOk"));
                })
              }
              className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {saving ? t("flows.saving") : t("flows.saveDraft")}
            </button>
            <button
              type="button"
              disabled={validating}
              onClick={() => void runValidate()}
              className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink hover:bg-elevated disabled:opacity-50"
            >
              {t("flows.validateButton")}
            </button>
            <button
              type="button"
              disabled={activating}
              onClick={() => void runActivate()}
              className="rounded-lg border border-success px-3 py-1.5 text-sm font-medium text-success hover:bg-success/10 disabled:opacity-50"
            >
              {activating ? t("flows.activating") : t("flows.activateButton")}
            </button>
            {dirty ? (
              <span className="text-xs text-warning">
                {t("flows.unsavedChanges")}
              </span>
            ) : null}
          </>
        ) : null}
      </div>

      {error ? (
        <p className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="mt-3 rounded-lg bg-success/10 px-3 py-2 text-sm text-success">
          {notice}
        </p>
      ) : null}
      {issueErrors.length > 0 ? (
        <div className="mt-3 rounded-lg bg-danger/5 px-3 py-2">
          <p className="text-sm font-semibold text-danger">
            {t("flows.issuesErrorsTitle")}
          </p>
          <div className="mt-1">{renderIssueList(issueErrors, true)}</div>
        </div>
      ) : null}
      {issueWarnings.length > 0 ? (
        <div className="mt-3 rounded-lg bg-warning/5 px-3 py-2">
          <p className="text-sm font-semibold text-warning">
            {t("flows.issuesWarningsTitle")}
          </p>
          <div className="mt-1">{renderIssueList(issueWarnings, false)}</div>
        </div>
      ) : null}

      {tab === "runs" ? (
        <div className="mt-4 rounded-xl border border-line bg-surface p-4">
          {tenantId ? (
            <FlowExperimentsPanel
              t={t}
              tenantId={tenantId}
              flowId={flow.id}
            />
          ) : null}
          <FlowRunsPanel
            t={t}
            locale={locale}
            tenantId={tenantId}
            flowId={flow.id}
            graph={currentGraph}
          />
        </div>
      ) : tab === "simulate" ? (
        <div className="mt-4 rounded-xl border border-line bg-surface p-4">
          <FlowSimulatorPanel
            t={t}
            tenantId={tenantId}
            flowId={flow.id}
            graph={currentGraph}
          />
        </div>
      ) : tab === "versions" ? (
        <div className="mt-4 rounded-xl border border-line bg-surface p-4">
          <FlowVersionsPanel
            t={t}
            locale={locale}
            tenantId={tenantId}
            flowId={flow.id}
            canManage={canManage}
            onRestored={(next) => {
              // Graf server berubah (isi snapshot yang dipulihkan):
              // paksa efek pemuatan kanvas membaca ulang flow ini.
              initializedForRef.current = null;
              onFlowChange(next);
            }}
          />
        </div>
      ) : (
        <div
          className={`mt-4 grid gap-4 ${
            readOnly
              ? "xl:grid-cols-[minmax(0,1fr)_300px]"
              : "xl:grid-cols-[220px_minmax(0,1fr)_300px]"
          }`}
        >
          {!readOnly ? (
            <aside className="order-2 rounded-xl border border-line bg-surface p-3 xl:order-1">
              <h3 className="text-sm font-semibold text-ink">
                {t("flows.paletteTitle")}
              </h3>
              <p className="mt-1 text-xs text-muted">
                {t("flows.paletteHint")}
              </p>
              <div className="mt-3 grid grid-cols-2 gap-2 xl:grid-cols-1">
                {ADDABLE_NODE_TYPES.map((type) => (
                  <button
                    key={type}
                    type="button"
                    draggable
                    onDragStart={(e) => onDragStartPalette(e, type)}
                    onClick={() => addNode(type)}
                    className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-2 text-left text-xs font-medium text-ink hover:bg-elevated"
                  >
                    <svg
                      className="h-4 w-4 shrink-0 text-muted"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.7}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden={true}
                    >
                      <path d={NODE_ICON_PATHS[type]} />
                    </svg>
                    {t(FLOW_NODE_LABEL_KEYS[type])}
                  </button>
                ))}
              </div>
            </aside>
          ) : null}

          <div
            className="sk-flow order-1 h-[560px] overflow-hidden rounded-xl border border-line xl:order-2"
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }}
            onDrop={readOnly ? undefined : onCanvasDrop}
          >
            <BuilderCtx.Provider value={shared}>
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={NODE_TYPES}
                onNodesChange={
                  readOnly ? handleNodesChangeReadOnly : handleNodesChange
                }
                onEdgesChange={readOnly ? undefined : onEdgesChange}
                onConnect={readOnly ? undefined : handleConnect}
                isValidConnection={isValidConnection}
                nodesDraggable={!readOnly}
                nodesConnectable={!readOnly}
                elementsSelectable
                deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
                fitView
                fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
                minZoom={0.2}
                maxZoom={1.75}
              >
                <Background
                  variant={BackgroundVariant.Dots}
                  gap={22}
                  size={1.6}
                />
                <Controls showInteractive={false} />
                <MiniMap pannable zoomable />
              </ReactFlow>
            </BuilderCtx.Provider>
          </div>

          <aside className="order-3 rounded-xl border border-line bg-surface p-4">
            <h3 className="text-sm font-semibold text-ink">
              {t("flows.configTitle")}
            </h3>
            <div className="mt-3">
              {selectedNode ? (
                <NodeConfigPanel
                  t={t}
                  node={selectedNode}
                  allNodes={nodes}
                  meta={meta}
                  readOnly={readOnly}
                  tenantId={tenantId}
                  flowId={flow.id}
                  onChange={updateNodeConfig}
                  onDelete={deleteNode}
                />
              ) : (
                <p className="text-sm text-muted">{t("flows.configEmpty")}</p>
              )}
            </div>
            <p className="mt-4 border-t border-line pt-3 text-xs text-muted">
              {t("flows.canvasHint")}
            </p>
          </aside>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------


interface FlowBuilderPageProps {
  t: Translate;
  locale: Locale;
  flowId: string;
  onBack: () => void;
}

/**
 * Halaman Flow Builder (Fase 8B) di /flows/:flowId: memuat flow +
 * metadata tenant (tag/stage dari kontak, sequence aktif), lalu
 * menyerahkan kanvas ke BuilderInner di dalam ReactFlowProvider.
 */
export function FlowBuilderPage({
  t,
  locale,
  flowId,
  onBack,
}: FlowBuilderPageProps) {
  const { status, active } = useWorkspace();
  const tenantId = active?.id ?? null;
  const canManage = active?.role === "owner" || active?.role === "admin";
  const [flow, setFlow] = useState<FlowResponse | null>(null);
  const [meta, setMeta] = useState<TenantMeta>({
    tags: [],
    stages: [],
    sequences: [],
    dealStages: [],
    members: [],
    flows: [],
    selfFlow: null,
    products: [],
    appointmentServices: [],
    customFieldKeys: [],
    channelAccounts: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [
          flowRes,
          automations,
          contacts,
          flowsRes,
          products,
          appointmentServices,
          dealPipelines,
          members,
          channelAccounts,
        ] = await Promise.all([
          api.flows.get(tenantId, flowId),
          api.automations.list(tenantId).catch(() => []),
          api.contacts.list(tenantId, { limit: 200 }).catch(() => null),
          api.flows
            .list(tenantId, { status: "active", limit: 100 })
            .catch(() => null),
          api.products.list(tenantId).catch(() => [] as ProductResponse[]),
          api.appointments
            .listServices(tenantId)
            .catch(() => [] as AppointmentServiceResponse[]),
          api.deals.listPipelines(tenantId).catch(() => []),
          api.team.listMembers(tenantId).catch(() => []),
          api.channels.list(tenantId).catch(() => []),
        ]);
        if (cancelled) return;
        setFlow(flowRes);
        const tags = new Set<string>();
        const stages = new Set<string>();
        const customFieldKeys = new Set<string>();
        for (const contact of contacts?.contacts ?? []) {
          for (const tag of contact.tags) tags.add(tag);
          if (contact.pipelineStage) stages.add(contact.pipelineStage);
          for (const key of Object.keys(contact.customFields ?? {})) {
            customFieldKeys.add(key);
          }
        }
        setMeta({
          tags: [...tags].sort(),
          stages: [...stages].sort(),
          sequences: automations.filter(
            (a) => a.kind === "sequence" && a.isActive,
          ),
          dealStages: dealPipelines.flatMap((p) =>
            p.stages.map((s) => ({
              id: s.id,
              name: s.name,
              pipelineName: p.name,
              kind: s.kind,
            })),
          ),
          members,
          flows: flowsRes?.flows ?? [],
          selfFlow: { id: flowRes.id, name: flowRes.name },
          products: products.filter((p) => p.isActive),
          appointmentServices: appointmentServices.filter((s) => s.isActive),
          customFieldKeys: [...customFieldKeys].sort(),
          channelAccounts,
        });
      } catch (err) {
        if (!cancelled) setError(translateApiError(t, err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, flowId, t]);

  if (status === "loading" || loading) {
    return (
      <section>
        <p className="mt-6 text-sm text-muted">{t("workspace.loading")}</p>
      </section>
    );
  }
  if (status === "error" || error || !flow || !tenantId) {
    return (
      <section>
        <button
          type="button"
          onClick={onBack}
          className="text-sm text-muted hover:text-ink"
        >
          ← {t("flows.backToList")}
        </button>
        <p className="mt-6 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
          {error ?? t("errors.NOT_FOUND")}
        </p>
      </section>
    );
  }

  return (
    <ReactFlowProvider>
      <BuilderInner
        t={t}
        locale={locale}
        tenantId={tenantId}
        flow={flow}
        canManage={canManage}
        meta={meta}
        onFlowChange={setFlow}
        onBack={onBack}
      />
    </ReactFlowProvider>
  );
}
