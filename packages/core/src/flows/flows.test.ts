import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  firstNodeAfterTrigger,
  FLOW_GOTO_MAX_DEPTH,
  FLOW_HTTP_TIMEOUT_MS,
  FLOW_MAX_STEPS,
  nextNodeId,
  normalizeFlowGraph,
  triggerOf,
  type FlowGraphData,
} from "./graph";
import { clampLimit, decodeCursor, encodeCursor } from "./pagination";
import {
  validateQuestionnaireAnswer,
  type QuestionnaireQuestion,
} from "./questionnaire";
import { validateFlowGraph } from "./validate";
import { createTestDb, TEST_TENANT_ID, type TestDb } from "../testing/pglite";

/**
 * Graf flow: validasi saat disimpan, navigasi saat dijalankan.
 *
 * Yang dicegah di sini adalah kegagalan yang mahal karena terjadi jauh
 * dari penyebabnya. Flow yang menyimpan graf rusak akan lolos ke
 * produksi, lalu gagal di tengah percakapan pelanggan — bukan saat
 * operator menekan "Aktifkan". Karena itu validasi harus menolak graf
 * yang tidak dapat dijalankan SEBELUM diaktifkan.
 *
 * Catatan jujur tentang cakupan: batas langkah runtime
 * (`FLOW_MAX_STEPS`) dan kedalaman goto (`FLOW_GOTO_MAX_DEPTH`)
 * ditegakkan di `executeFlowStep`, yang membutuhkan run lengkap
 * (flow, versi, kontak, percakapan, pesan). Berkas ini mengunci
 * NILAI batas itu dan aturan navigasi yang membuatnya berarti;
 * penegakan runtime-nya ada di `pnpm --filter @sahabat-kreator/core verify`.
 */

/** Graf valid minimal: trigger → send_message → end. */
function validGraph(): FlowGraphData {
  return {
    nodes: [
      { id: "t", type: "trigger", config: { kind: "any_message" } },
      { id: "s", type: "send_message", config: { text: "Halo" } },
    ],
    edges: [{ from: "t", to: "s" }],
  };
}

describe("batas yang menghentikan flow liar", () => {
  it("nilai batasnya terkunci", () => {
    // Angka-angka ini adalah pengaman terhadap graf melingkar tanpa
    // delay. Menaikkannya tanpa sengaja berarti satu run bisa
    // menahan worker jauh lebih lama.
    expect(FLOW_MAX_STEPS).toBe(100);
    expect(FLOW_GOTO_MAX_DEPTH).toBe(5);
    expect(FLOW_HTTP_TIMEOUT_MS).toBe(10_000);
  });
});

describe("normalisasi graf dari data tak tepercaya", () => {
  it("membuang node dan edge yang bentuknya rusak", () => {
    const graph = normalizeFlowGraph({
      nodes: [
        { id: "t", type: "trigger" },
        { id: 42, type: "send_message" },
        { type: "send_message" },
        null,
        "bukan node",
      ],
      edges: [{ from: "t", to: "s" }, { from: "t" }, null],
    });
    expect(graph.nodes.map((n) => n.id)).toEqual(["t"]);
    expect(graph.edges).toEqual([{ from: "t", to: "s", branch: undefined }]);
  });

  it("config yang hilang menjadi objek kosong, bukan undefined", () => {
    const graph = normalizeFlowGraph({ nodes: [{ id: "t", type: "trigger" }] });
    expect(graph.nodes[0]?.config).toEqual({});
  });

  it("position hanya dipertahankan bila dua angkanya sah", () => {
    const graph = normalizeFlowGraph({
      nodes: [
        { id: "a", type: "trigger", position: { x: 10, y: 20 } },
        { id: "b", type: "send_message", position: { x: "10", y: 20 } },
        { id: "c", type: "send_message", position: { x: Number.NaN, y: 20 } },
      ],
    });
    expect(graph.nodes[0]?.position).toEqual({ x: 10, y: 20 });
    expect(graph.nodes[1]?.position).toBeUndefined();
    expect(graph.nodes[2]?.position).toBeUndefined();
  });

  it("branch yang tidak dikenal dibuang", () => {
    const graph = normalizeFlowGraph({
      edges: [
        { from: "a", to: "b", branch: "yes" },
        { from: "a", to: "c", branch: "entah" },
      ],
    });
    expect(graph.edges[0]?.branch).toBe("yes");
    expect(graph.edges[1]?.branch).toBeUndefined();
  });

  it("input yang bukan objek menghasilkan graf kosong, bukan lemparan", () => {
    for (const raw of [null, undefined, 42, "teks", []]) {
      expect(normalizeFlowGraph(raw)).toEqual({ nodes: [], edges: [] });
    }
  });
});

describe("navigasi graf", () => {
  const graph = normalizeFlowGraph({
    nodes: [
      { id: "t", type: "trigger", config: {} },
      { id: "c", type: "condition", config: {} },
      { id: "yes", type: "send_message", config: { text: "ya" } },
      { id: "no", type: "send_message", config: { text: "tidak" } },
    ],
    edges: [
      { from: "t", to: "c" },
      { from: "c", to: "yes", branch: "yes" },
      { from: "c", to: "no", branch: "no" },
    ],
  });

  it("menemukan trigger dan node sesudahnya", () => {
    expect(triggerOf(graph)?.id).toBe("t");
    expect(firstNodeAfterTrigger(graph)).toBe("c");
  });

  it("node bercabang hanya dilanjutkan bila branch disebut", () => {
    expect(nextNodeId(graph, "c", "yes")).toBe("yes");
    expect(nextNodeId(graph, "c", "no")).toBe("no");
  });

  it("branch yang tidak punya edge mengembalikan null, bukan menebak", () => {
    // Menebak di sini berarti pelanggan menerima cabang yang salah.
    expect(nextNodeId(graph, "c", "a")).toBeNull();
  });

  it("node tanpa edge keluar mengembalikan null", () => {
    expect(nextNodeId(graph, "yes")).toBeNull();
  });

  it("graf tanpa trigger tidak punya titik awal", () => {
    const noTrigger = normalizeFlowGraph({ nodes: [{ id: "s", type: "send_message" }] });
    expect(triggerOf(noTrigger)).toBeNull();
    expect(firstNodeAfterTrigger(noTrigger)).toBeNull();
  });
});

describe("validasi graf", () => {
  let ctx: TestDb;

  beforeAll(async () => {
    ctx = await createTestDb();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const validate = (graph: FlowGraphData, options?: { selfFlowId?: string }) =>
    validateFlowGraph(ctx.db, TEST_TENANT_ID, graph, options);

  const codes = async (graph: FlowGraphData) =>
    (await validate(graph)).map((i) => i.code);

  const errorCodes = async (graph: FlowGraphData) =>
    (await validate(graph))
      .filter((i) => i.severity === "error")
      .map((i) => i.code);

  it("graf valid tidak menghasilkan error", async () => {
    expect(await errorCodes(validGraph())).toEqual([]);
  });

  it("graf kosong ditolak", async () => {
    expect(await codes({ nodes: [], edges: [] })).toContain("GRAPH_EMPTY");
  });

  it("id node ganda ditolak", async () => {
    expect(
      await codes({
        nodes: [
          { id: "t", type: "trigger", config: { kind: "any_message" } },
          { id: "t", type: "send_message", config: { text: "Halo" } },
        ],
        edges: [{ from: "t", to: "t" }],
      }),
    ).toContain("NODE_ID_DUPLICATE");
  });

  it("graf tanpa trigger ditolak", async () => {
    expect(
      await codes({
        nodes: [{ id: "s", type: "send_message", config: { text: "Halo" } }],
        edges: [],
      }),
    ).toContain("TRIGGER_MISSING");
  });

  it("dua trigger ditolak", async () => {
    expect(
      await codes({
        nodes: [
          { id: "t1", type: "trigger", config: { kind: "any_message" } },
          { id: "t2", type: "trigger", config: { kind: "any_message" } },
        ],
        edges: [],
      }),
    ).toContain("TRIGGER_MULTIPLE");
  });

  it("edge ke node yang tidak ada ditolak", async () => {
    expect(
      await codes({
        nodes: [{ id: "t", type: "trigger", config: { kind: "any_message" } }],
        edges: [{ from: "t", to: "hantu" }],
      }),
    ).toContain("EDGE_TO_UNKNOWN");
  });

  it("condition tanpa cabang yes/no ditolak", async () => {
    const found = await codes({
      nodes: [
        { id: "t", type: "trigger", config: { kind: "any_message" } },
        { id: "c", type: "condition", config: { predicate: { type: "has_tag", tag: "vip" } } },
      ],
      edges: [{ from: "t", to: "c" }],
    });
    expect(found).toContain("CONDITION_BRANCH_YES_MISSING");
    expect(found).toContain("CONDITION_BRANCH_NO_MISSING");
  });

  it("branch pada node yang tidak bercabang ditolak", async () => {
    expect(
      await codes({
        nodes: [
          { id: "t", type: "trigger", config: { kind: "any_message" } },
          { id: "s", type: "send_message", config: { text: "Halo" } },
          { id: "e", type: "send_message", config: { text: "Selesai" } },
        ],
        edges: [
          { from: "t", to: "s" },
          { from: "s", to: "e", branch: "yes" },
        ],
      }),
    ).toContain("EDGE_BRANCH_MISPLACED");
  });

  it("send_message tanpa teks ditolak", async () => {
    expect(
      await codes({
        nodes: [
          { id: "t", type: "trigger", config: { kind: "any_message" } },
          { id: "s", type: "send_message", config: { text: "   " } },
        ],
        edges: [{ from: "t", to: "s" }],
      }),
    ).toContain("SEND_TEXT_REQUIRED");
  });

  it("trigger tanpa node lanjutan hanya memberi peringatan", async () => {
    // Bukan error: flow yang baru dibuat setengah jalan harus tetap
    // bisa disimpan sebagai draf.
    const issues = await validate({
      nodes: [{ id: "t", type: "trigger", config: { kind: "any_message" } }],
      edges: [],
    });
    const warn = issues.find((i) => i.code === "TRIGGER_NO_NEXT");
    expect(warn?.severity).toBe("warning");
  });

  it("node yang tidak terjangkau hanya memberi peringatan", async () => {
    const issues = await validate({
      nodes: [
        { id: "t", type: "trigger", config: { kind: "any_message" } },
        { id: "s", type: "send_message", config: { text: "Halo" } },
        { id: "yatim", type: "send_message", config: { text: "Tidak terjangkau" } },
      ],
      edges: [{ from: "t", to: "s" }],
    });
    const unreachable = issues.find((i) => i.code === "NODE_UNREACHABLE");
    expect(unreachable?.nodeId).toBe("yatim");
    expect(unreachable?.severity).toBe("warning");
  });

  it("goto_flow ke flow yang tidak ada ditolak", async () => {
    expect(
      await codes({
        nodes: [
          { id: "t", type: "trigger", config: { kind: "any_message" } },
          {
            id: "g",
            type: "goto_flow",
            config: { flowId: "00000000-0000-4000-8000-000000000000" },
          },
        ],
        edges: [{ from: "t", to: "g" }],
      }),
    ).toContain("GOTO_FLOW_NOT_FOUND");
  });

  it("goto_flow ke flow itu sendiri sah saat aktivasi", async () => {
    // Saat aktivasi, flow ini BELUM aktif — memeriksa statusnya tanpa
    // pengecualian akan menolak flow yang sah.
    const selfId = crypto.randomUUID();
    const graph: FlowGraphData = {
      nodes: [
        { id: "t", type: "trigger", config: { kind: "any_message" } },
        { id: "g", type: "goto_flow", config: { flowId: selfId } },
      ],
      edges: [{ from: "t", to: "g" }],
    };
    const withSelf = (await validate(graph, { selfFlowId: selfId })).filter(
      (i) => i.code === "GOTO_FLOW_NOT_FOUND",
    );
    expect(withSelf).toEqual([]);
  });
});

describe("kursor halaman", () => {
  it("bolak-balik mempertahankan nilai", () => {
    const row = { createdAt: new Date("2026-11-05T12:34:56.789Z"), id: "abc" };
    const decoded = decodeCursor(encodeCursor(row));
    expect(decoded).toEqual({ createdAt: "2026-11-05T12:34:56.789Z", id: "abc" });
  });

  it("kursor rusak atau dipalsukan kembali ke halaman pertama", () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor("bukan-base64-json")).toBeNull();
    // Base64 sah tetapi tanggalnya tidak masuk akal.
    const forged = Buffer.from(
      JSON.stringify({ createdAt: "kemarin", id: "abc" }),
      "utf8",
    ).toString("base64url");
    expect(decodeCursor(forged)).toBeNull();
  });

  it("limit dijepit ke rentang yang aman", () => {
    expect(clampLimit(undefined)).toBe(50);
    expect(clampLimit(0)).toBe(50);
    expect(clampLimit(Number.NaN)).toBe(50);
    expect(clampLimit(-5)).toBe(1);
    expect(clampLimit(10_000)).toBe(100);
    expect(clampLimit(25)).toBe(25);
    expect(clampLimit(25.9)).toBe(25);
  });
});

/**
 * Pertanyaan kuesioner lengkap. `validateQuestionnaireAnswer` hanya
 * membaca `answerType` dan `options`, tetapi tipenya menuntut bentuk
 * penuh — membangunnya lewat helper membuat test tetap jujur pada
 * kontrak tanpa mengulang enam field di setiap kasus.
 */
function askQuestion(
  answerType: QuestionnaireQuestion["answerType"],
  options: string[] = [],
): QuestionnaireQuestion {
  return {
    id: "q1",
    prompt: "Pertanyaan uji",
    answerType,
    target: "custom:jawaban",
    required: true,
    options,
  };
}

describe("validasi jawaban kuesioner", () => {
  it("teks kosong ditolak", () => {
    expect(validateQuestionnaireAnswer(askQuestion("text"), "  ")).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  it("email dinormalkan ke huruf kecil", () => {
    const result = validateQuestionnaireAnswer(
      askQuestion("email"),
      "  Budi@Contoh.TEST ",
    );
    expect(result).toEqual({ ok: true, value: "budi@contoh.test" });
  });

  it("email cacat ditolak", () => {
    const result = validateQuestionnaireAnswer(
      askQuestion("email"),
      "budi@",
    );
    expect(result).toEqual({ ok: false, reason: "not_an_email" });
  });

  it("angka menerima koma desimal gaya Indonesia", () => {
    // "1,5" adalah cara orang menulis desimal di Indonesia; menolaknya
    // membuat pertanyaan angka tidak terpakai sama sekali.
    expect(validateQuestionnaireAnswer(askQuestion("number"), "1,5")).toEqual({
      ok: true,
      value: 1.5,
    });
    expect(validateQuestionnaireAnswer(askQuestion("number"), "2.5")).toEqual({
      ok: true,
      value: 2.5,
    });
  });

  it("pilihan menerima nomor maupun teks opsi", () => {
    const question = askQuestion("choice", ["Bali", "Jawa"]);
    expect(validateQuestionnaireAnswer(question, "2")).toEqual({ ok: true, value: "Jawa" });
    expect(validateQuestionnaireAnswer(question, " bali ")).toEqual({
      ok: true,
      value: "Bali",
    });
  });

  it("nomor pilihan di luar daftar ditolak", () => {
    const question = askQuestion("choice", ["Bali", "Jawa"]);
    expect(validateQuestionnaireAnswer(question, "3")).toEqual({
      ok: false,
      reason: "not_a_choice",
    });
    expect(validateQuestionnaireAnswer(question, "0")).toEqual({
      ok: false,
      reason: "not_a_choice",
    });
  });
});
