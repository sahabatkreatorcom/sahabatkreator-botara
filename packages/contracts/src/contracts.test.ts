import { describe, expect, it } from "vitest";
import { FlowGraphSchema, FlowNodeTypeSchema } from "./flows";
import { SendMessageRequestSchema } from "./inbox";

/**
 * Kontrak adalah sumber kebenaran tunggal untuk API, SDK, dan schema tool
 * MCP. Test di sini menjaga dua hal yang paling mudah rusak diam-diam:
 * batas panjang input, dan daftar nilai enum yang dipakai klien.
 */
describe("kontrak inbox", () => {
  it("menerima teks biasa dan memangkas spasi tepi", () => {
    const parsed = SendMessageRequestSchema.parse({ contentText: "  halo  " });
    expect(parsed.contentText).toBe("halo");
  });

  it("menolak teks kosong atau hanya spasi", () => {
    expect(SendMessageRequestSchema.safeParse({ contentText: "" }).success).toBe(false);
    expect(SendMessageRequestSchema.safeParse({ contentText: "   " }).success).toBe(false);
  });

  it("menolak teks melebihi 4096 karakter", () => {
    const tooLong = "a".repeat(4097);
    expect(SendMessageRequestSchema.safeParse({ contentText: tooLong }).success).toBe(false);
    expect(
      SendMessageRequestSchema.safeParse({ contentText: "a".repeat(4096) }).success,
    ).toBe(true);
  });

  it("replyToMessageId harus uuid bila diisi", () => {
    expect(
      SendMessageRequestSchema.safeParse({
        contentText: "halo",
        replyToMessageId: "bukan-uuid",
      }).success,
    ).toBe(false);
    expect(
      SendMessageRequestSchema.safeParse({
        contentText: "halo",
        replyToMessageId: "0f8fad5b-d9cb-469f-a165-70867728950e",
      }).success,
    ).toBe(true);
  });
});

describe("kontrak flow graph", () => {
  it("menerima graf minimal dengan config default", () => {
    const parsed = FlowGraphSchema.parse({
      nodes: [{ id: "trigger", type: "trigger" }],
      edges: [],
    });
    expect(parsed.nodes[0]?.config).toEqual({});
  });

  it("menolak tipe node yang tidak dikenal", () => {
    expect(FlowNodeTypeSchema.safeParse("teleport").success).toBe(false);
  });

  it("menolak edge tanpa from/to", () => {
    expect(
      FlowGraphSchema.safeParse({ nodes: [], edges: [{ from: "a" }] }).success,
    ).toBe(false);
  });

  it("menolak cabang edge di luar daftar resmi", () => {
    expect(
      FlowGraphSchema.safeParse({
        nodes: [],
        edges: [{ from: "a", to: "b", branch: "mungkin" }],
      }).success,
    ).toBe(false);
  });

  it("membatasi jumlah node 200 dan edge 400", () => {
    const nodes = Array.from({ length: 201 }, (_, i) => ({
      id: `n${i}`,
      type: "trigger" as const,
    }));
    expect(FlowGraphSchema.safeParse({ nodes, edges: [] }).success).toBe(false);
  });
});
