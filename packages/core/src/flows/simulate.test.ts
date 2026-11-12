import { describe, expect, it } from "vitest";
import { experimentBucket, flowBranchForBucket, flowExperimentKey } from "../experiments";
import { FLOW_MAX_STEPS, type FlowGraphData } from "./graph";
import { simulateFlowRun } from "./simulate";

/**
 * Simulator flow (G4) — interpreter kering MURNI: test ini tidak
 * menyentuh DB sama sekali (fungsi tidak menerimanya), dan mengunci
 * semantik penelusurannya: pencocokan pemicu, cabang condition,
 * render deterministik berbenih, parkir + balasan simulasi, cap
 * langkah, dan kejujuran node yang hanya dicatat.
 */

const FLOW_ID = "12345678-1234-4123-8123-123456789012";
const TARGET_FLOW_ID = "22345678-1234-4123-8123-123456789012";

function graphOf(
  nodes: FlowGraphData["nodes"],
  edges: FlowGraphData["edges"],
): FlowGraphData {
  return { nodes, edges };
}

function keywordTrigger(keywords: string[], match: "exact" | "contains" = "exact") {
  return {
    id: "t",
    type: "trigger",
    config: { kind: "keyword", keywords, match },
  };
}

describe("simulateFlowRun — pemicu & jalur lurus", () => {
  it("pemicu tidak cocok → trigger_not_matched tanpa langkah", () => {
    const graph = graphOf(
      [keywordTrigger(["halo"]), { id: "a", type: "send_message", config: { text: "Hai" } }],
      [{ from: "t", to: "a" }],
    );
    const res = simulateFlowRun(graph, {
      flowId: FLOW_ID,
      triggerText: "selamat pagi",
      contact: { name: "Sari" },
    });
    expect(res.triggerMatched).toBe(false);
    expect(res.status).toBe("trigger_not_matched");
    expect(res.steps).toEqual([]);
    expect(res.effects).toEqual([]);
  });

  it("any_message selalu cocok; pesan ter-render {name} dan run selesai", () => {
    const graph = graphOf(
      [
        { id: "t", type: "trigger", config: { kind: "any_message" } },
        { id: "a", type: "send_message", config: { text: "Halo {name}!" } },
        { id: "e", type: "end", config: {} },
      ],
      [
        { from: "t", to: "a" },
        { from: "a", to: "e" },
      ],
    );
    const res = simulateFlowRun(graph, {
      flowId: FLOW_ID,
      triggerText: "apa saja",
      contact: { name: "Sari" },
    });
    expect(res.status).toBe("completed");
    expect(res.steps.map((s) => s.nodeId)).toEqual(["a", "e"]);
    expect(res.effects).toEqual([
      {
        kind: "send_message",
        nodeId: "a",
        fidelity: "faithful",
        data: { text: "Halo Sari!" },
      },
    ]);
  });

  it("render spintax deterministik: masukan sama → jejak sama persis", () => {
    const graph = graphOf(
      [
        keywordTrigger(["promo"], "contains"),
        {
          id: "a",
          type: "send_message",
          config: { text: "{Halo|Hai} {name}, ada promo" },
        },
      ],
      [{ from: "t", to: "a" }],
    );
    const opts = {
      flowId: FLOW_ID,
      triggerText: "info promo dong",
      contact: { name: "Bima" },
    };
    const one = simulateFlowRun(graph, opts);
    const two = simulateFlowRun(graph, opts);
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
    expect(String(one.steps[0].detail.text)).toMatch(/^(Halo|Hai) Bima, ada promo$/);
  });
});

describe("simulateFlowRun — condition & mutasi kontak mock", () => {
  const branchGraph = graphOf(
    [
      keywordTrigger(["mulai"]),
      { id: "c", type: "condition", config: { predicate: "has_tag", tag: "vip" } },
      { id: "y", type: "send_message", config: { text: "Jalur VIP" } },
      { id: "n", type: "send_message", config: { text: "Jalur tamu" } },
      { id: "tg", type: "add_tag", config: { tag: "gold" } },
      { id: "st", type: "set_stage", config: { stage: "lead" } },
      { id: "sf", type: "set_field", config: { field: "custom:kota", value: "Bandung" } },
    ],
    [
      { from: "t", to: "c" },
      { from: "c", to: "y", branch: "yes" },
      { from: "c", to: "n", branch: "no" },
      { from: "y", to: "tg" },
      { from: "tg", to: "st" },
      { from: "st", to: "sf" },
    ],
  );

  it("has_tag benar → cabang yes; tag/stage/field berubah pada kontak mock", () => {
    const res = simulateFlowRun(branchGraph, {
      flowId: FLOW_ID,
      triggerText: "mulai",
      contact: { name: "Sari", tags: ["vip"], pipelineStage: "baru" },
    });
    expect(res.status).toBe("completed");
    expect(res.steps.map((s) => s.nodeId)).toEqual(["c", "y", "tg", "st", "sf"]);
    expect(res.steps[0].detail).toMatchObject({ outcome: "evaluated", result: true });
    expect(res.contact.tags).toEqual(["vip", "gold"]);
    expect(res.contact.pipelineStage).toBe("lead");
    expect(res.contact.customFields).toEqual({ kota: "Bandung" });
  });

  it("has_tag salah → cabang no; kontak mock tidak berubah", () => {
    const res = simulateFlowRun(branchGraph, {
      flowId: FLOW_ID,
      triggerText: "mulai",
      contact: { name: "Tamu" },
    });
    expect(res.steps.map((s) => s.nodeId)).toEqual(["c", "n"]);
    expect(res.contact.tags).toEqual([]);
    expect(res.contact.pipelineStage).toBeNull();
  });

  it("message_contains memakai teks pemicu", () => {
    const graph = graphOf(
      [
        { id: "t", type: "trigger", config: { kind: "any_message" } },
        { id: "c", type: "condition", config: { predicate: "message_contains", text: "Harga" } },
        { id: "y", type: "send_message", config: { text: "Daftar harga" } },
        { id: "n", type: "end", config: {} },
      ],
      [
        { from: "t", to: "c" },
        { from: "c", to: "y", branch: "yes" },
        { from: "c", to: "n", branch: "no" },
      ],
    );
    const res = simulateFlowRun(graph, {
      flowId: FLOW_ID,
      triggerText: "minta HARGA terbaru",
      contact: {},
    });
    expect(res.steps[0].detail).toMatchObject({ result: true });
    expect(res.steps.map((s) => s.nodeId)).toEqual(["c", "y"]);
  });
});

describe("simulateFlowRun — delay, parkir, balasan", () => {
  it("delay dicatat sebagai efek dan penelusuran lanjut (tidak menunggu)", () => {
    const graph = graphOf(
      [
        keywordTrigger(["nanti"]),
        { id: "d", type: "delay", config: { amount: 2, unit: "hours" } },
        { id: "a", type: "send_message", config: { text: "Sesudah jeda" } },
      ],
      [
        { from: "t", to: "d" },
        { from: "d", to: "a" },
      ],
    );
    const res = simulateFlowRun(graph, {
      flowId: FLOW_ID,
      triggerText: "nanti",
      contact: {},
      now: new Date("2026-11-12T00:00:00.000Z"),
    });
    expect(res.status).toBe("completed");
    expect(res.effects.find((e) => e.kind === "delay")?.data).toMatchObject({
      delayMs: 7_200_000,
    });
    expect(res.steps[0].detail).toMatchObject({
      resumeAt: "2026-11-12T02:00:00.000Z",
    });
  });

  const waitGraph = graphOf(
    [
      keywordTrigger(["tanya"]),
      { id: "w", type: "wait_reply", config: { amount: 30, unit: "minutes" } },
      { id: "s", type: "send_message", config: { text: "Lanjut" } },
      { id: "e", type: "end", config: {} },
    ],
    [
      { from: "t", to: "w" },
      { from: "w", to: "s", branch: "replied" },
      { from: "w", to: "e", branch: "timeout" },
    ],
  );

  it("wait_reply tanpa balasan → parked waiting_for_reply, node lanjutan tidak dikunjungi", () => {
    const res = simulateFlowRun(waitGraph, {
      flowId: FLOW_ID,
      triggerText: "tanya",
      contact: {},
    });
    expect(res.status).toBe("parked");
    expect(res.parkedNodeId).toBe("w");
    expect(res.parkReason).toBe("waiting_for_reply");
    expect(res.steps.map((s) => s.nodeId)).toEqual(["w"]);
  });

  it("wait_reply dengan replyText → lanjut cabang replied sampai selesai", () => {
    const res = simulateFlowRun(waitGraph, {
      flowId: FLOW_ID,
      triggerText: "tanya",
      contact: {},
      replyText: "jawabanku",
    });
    expect(res.status).toBe("completed");
    expect(res.steps.map((s) => s.nodeId)).toEqual(["w", "s"]);
    expect(res.steps[0].detail).toMatchObject({ outcome: "replied" });
  });

  it("questionnaire merender pertanyaan pertama lalu parkir", () => {
    const graph = graphOf(
      [
        keywordTrigger(["daftar"]),
        {
          id: "q",
          type: "questionnaire",
          config: {
            questions: [
              {
                id: "nama",
                prompt: "Siapa nama kamu?",
                answerType: "text",
                target: "name",
                required: true,
              },
            ],
            amount: 10,
            unit: "minutes",
            maxInvalidAttempts: 2,
          },
        },
        { id: "e", type: "end", config: {} },
      ],
      [
        { from: "t", to: "q" },
        { from: "q", to: "e", branch: "completed" },
        { from: "q", to: "e", branch: "invalid" },
        { from: "q", to: "e", branch: "timeout" },
      ],
    );
    const res = simulateFlowRun(graph, {
      flowId: FLOW_ID,
      triggerText: "daftar",
      contact: { name: "Sari" },
    });
    expect(res.status).toBe("parked");
    expect(res.parkReason).toBe("waiting_for_questionnaire_answer");
    expect(res.effects[0]).toMatchObject({
      kind: "send_message",
      data: { text: "Siapa nama kamu?", via: "questionnaire" },
    });
  });
});

describe("simulateFlowRun — ab_split", () => {
  const splitGraph = (extra: Record<string, unknown> = {}) =>
    graphOf(
      [
        { id: "t", type: "trigger", config: { kind: "any_message" } },
        { id: "sp", type: "ab_split", config: { percentA: 50, ...extra } },
        { id: "a", type: "send_message", config: { text: "Varian A" } },
        { id: "b", type: "send_message", config: { text: "Varian B" } },
      ],
      [
        { from: "t", to: "sp" },
        { from: "sp", to: "a", branch: "a" },
        { from: "sp", to: "b", branch: "b" },
      ],
    );

  it("pilihan paksa splitChoices mengalahkan undian", () => {
    const res = simulateFlowRun(splitGraph(), {
      flowId: FLOW_ID,
      triggerText: "x",
      contact: {},
      splitChoices: { sp: "b" },
    });
    expect(res.steps[0].detail).toMatchObject({ branch: "b", selection: "forced" });
    expect(res.steps.map((s) => s.nodeId)).toEqual(["sp", "b"]);
  });

  it("mode eksperimen memakai hash lengket eksekutor yang sama", () => {
    const contactId = "contact-uji-1";
    const expected = flowBranchForBucket(
      experimentBucket(flowExperimentKey(FLOW_ID, "sp", contactId)),
      50,
    );
    const res = simulateFlowRun(splitGraph({ experiment: true }), {
      flowId: FLOW_ID,
      triggerText: "x",
      contact: { id: contactId },
    });
    expect(res.steps[0].detail).toMatchObject({
      branch: expected,
      selection: "experiment_hash",
    });
    expect(res.steps[1].nodeId).toBe(expected);
  });
});

describe("simulateFlowRun — kejujuran batas & kegagalan", () => {
  it("ai_response & http_request hanya dicatat (tanpa panggilan apa pun)", () => {
    const graph = graphOf(
      [
        { id: "t", type: "trigger", config: { kind: "any_message" } },
        { id: "ai", type: "ai_response", config: {} },
        {
          id: "h",
          type: "http_request",
          config: {
            method: "POST",
            url: "https://contoh.invalid/hook/{name}",
            saveToField: "custom:hasil",
          },
        },
        { id: "e", type: "end", config: {} },
      ],
      [
        { from: "t", to: "ai" },
        { from: "ai", to: "h" },
        { from: "h", to: "e" },
      ],
    );
    const res = simulateFlowRun(graph, {
      flowId: FLOW_ID,
      triggerText: "x",
      contact: { name: "Sari" },
    });
    expect(res.status).toBe("completed");
    expect(res.steps[0].detail).toMatchObject({
      outcome: "simulated",
      reason: "llm_not_called",
    });
    expect(res.steps[1].detail).toMatchObject({
      outcome: "simulated",
      reason: "http_not_executed",
      url: "https://contoh.invalid/hook/Sari",
    });
    expect(
      res.effects.filter((e) => e.fidelity === "recorded").map((e) => e.kind),
    ).toEqual(["ai_response", "http_request"]);
  });

  it("goto_flow dicatat dan menyelesaikan run asal", () => {
    const graph = graphOf(
      [
        { id: "t", type: "trigger", config: { kind: "any_message" } },
        { id: "g", type: "goto_flow", config: { flowId: TARGET_FLOW_ID } },
        { id: "a", type: "send_message", config: { text: "Tidak tercapai" } },
      ],
      [
        { from: "t", to: "g" },
        { from: "g", to: "a" },
      ],
    );
    const res = simulateFlowRun(graph, {
      flowId: FLOW_ID,
      triggerText: "x",
      contact: {},
    });
    expect(res.status).toBe("completed");
    expect(res.steps.map((s) => s.nodeId)).toEqual(["g"]);
    expect(res.effects).toEqual([
      {
        kind: "goto_flow",
        nodeId: "g",
        fidelity: "recorded",
        data: { targetFlowId: TARGET_FLOW_ID, gotoDepth: 1 },
      },
    ]);
  });

  it("cart_checkout mengikuti cartItemCount mock", () => {
    const graph = graphOf(
      [
        { id: "t", type: "trigger", config: { kind: "any_message" } },
        { id: "co", type: "cart_checkout", config: { emptyMessage: "Keranjang kosong, {name}" } },
        { id: "ok", type: "send_message", config: { text: "Checkout!" } },
        { id: "no", type: "send_message", config: { text: "Belum ada isi" } },
      ],
      [
        { from: "t", to: "co" },
        { from: "co", to: "ok", branch: "checked_out" },
        { from: "co", to: "no", branch: "empty_cart" },
      ],
    );
    const empty = simulateFlowRun(graph, {
      flowId: FLOW_ID,
      triggerText: "x",
      contact: { name: "Sari" },
      cartItemCount: 0,
    });
    expect(empty.steps.map((s) => s.nodeId)).toEqual(["co", "no"]);
    expect(empty.effects[0].data).toMatchObject({ text: "Keranjang kosong, Sari" });
    const filled = simulateFlowRun(graph, {
      flowId: FLOW_ID,
      triggerText: "x",
      contact: { name: "Sari" },
      cartItemCount: 3,
    });
    expect(filled.steps.map((s) => s.nodeId)).toEqual(["co", "ok"]);
    expect(filled.effects[0]).toMatchObject({ kind: "checkout", fidelity: "recorded" });
  });

  it("graf melingkar berhenti di cap langkah sebagai failed", () => {
    const graph = graphOf(
      [
        { id: "t", type: "trigger", config: { kind: "any_message" } },
        { id: "a", type: "send_message", config: { text: "putar" } },
        { id: "c", type: "condition", config: { predicate: "message_contains", text: "x" } },
      ],
      [
        { from: "t", to: "a" },
        { from: "a", to: "c" },
        { from: "c", to: "a", branch: "yes" },
        { from: "c", to: "a", branch: "no" },
      ],
    );
    const res = simulateFlowRun(graph, {
      flowId: FLOW_ID,
      triggerText: "x",
      contact: {},
    });
    expect(res.status).toBe("failed");
    expect(res.failReason).toBe("step_cap_exceeded");
    expect(res.steps.length).toBe(FLOW_MAX_STEPS + 1);
    expect(res.steps[res.steps.length - 1].detail).toMatchObject({
      outcome: "cap_exceeded",
    });
  });

  it("show_catalog tanpa data lingkungan dicatat lalu parkir; dengan data dirender setia", () => {
    const graph = graphOf(
      [
        keywordTrigger(["katalog"]),
        {
          id: "cat",
          type: "show_catalog",
          config: { amount: 5, unit: "minutes", maxInvalidAttempts: 2 },
        },
        { id: "e", type: "end", config: {} },
      ],
      [
        { from: "t", to: "cat" },
        { from: "cat", to: "e", branch: "added" },
        { from: "cat", to: "e", branch: "invalid" },
        { from: "cat", to: "e", branch: "timeout" },
      ],
    );
    const noData = simulateFlowRun(graph, {
      flowId: FLOW_ID,
      triggerText: "katalog",
      contact: {},
    });
    expect(noData.status).toBe("parked");
    expect(noData.parkReason).toBe("waiting_for_catalog_choice");
    expect(noData.effects[0]).toMatchObject({
      kind: "catalog_message",
      fidelity: "recorded",
    });
    const withData = simulateFlowRun(graph, {
      flowId: FLOW_ID,
      triggerText: "katalog",
      contact: {},
      catalogProducts: [
        { id: "p1", name: "Kopi Tubruk", priceIdr: 25000, description: null },
      ],
    });
    expect(withData.effects[0]).toMatchObject({ kind: "send_message", fidelity: "faithful" });
    expect(String(withData.effects[0].data.text)).toContain("Kopi Tubruk");
  });
});
