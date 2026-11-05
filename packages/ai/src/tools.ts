import type { LlmToolDefinition } from "./types";

/**
 * Tool yang tersedia untuk agent v1 (Fase 3A).
 *
 * Sesuai RANCANGAN §5.1 langkah 7 himpunan penuhnya adalah send_message,
 * send_payment_link, tag_contact, move_pipeline_stage, create_follow_up,
 * handoff_to_human. Yang dieksekusi runtime:
 * - `tag_contact`        → menambah tag ke kontak lawan bicara.
 * - `move_pipeline_stage`→ memindahkan tahap pipeline kontak (nilai valid:
 *                          PIPELINE_STAGES — kolom DB varchar bebas, daftar
 *                          ini adalah validasi aplikasi).
 * - `handoff_to_human`   → mematikan AI pada percakapan ini
 *                          (conversations.agent_enabled=false) + audit.
 * - `send_payment_link`  → (Fase 4A) membuat tautan bayar produk aktif
 *                          yang cocok & mengirim URL-nya sebagai pesan
 *                          terpisah. Provider tautan fase ini 'simulation'
 *                          — belum ada pembayaran sungguhan di baliknya.
 * `send_message` bukan tool: teks hasil chat adalah pesannya (lihat
 * types.ts). `create_follow_up` menunggu fase sequence — belum
 * didefinisikan agar model tidak memanggil tool yang tidak dieksekusi
 * siapa pun.
 */

export const PIPELINE_STAGES = [
  "new",
  "engaged",
  "qualified",
  "customer",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export function isPipelineStage(value: unknown): value is PipelineStage {
  return (
    typeof value === "string" &&
    (PIPELINE_STAGES as readonly string[]).includes(value)
  );
}

export const AGENT_TOOLS: LlmToolDefinition[] = [
  {
    name: "tag_contact",
    description:
      "Tambahkan satu tag ke kontak lawan bicara (mis. 'ai-lead', 'tanya-harga'). Gunakan untuk menandai minat/segmen kontak.",
    parameters: {
      type: "object",
      properties: {
        tag: {
          type: "string",
          description: "Tag singkat tanpa spasi, huruf kecil & tanda hubung.",
        },
      },
      required: ["tag"],
    },
  },
  {
    name: "move_pipeline_stage",
    description:
      "Pindahkan tahap pipeline penjualan kontak sesuai kemajuan percakapan.",
    parameters: {
      type: "object",
      properties: {
        stage: {
          type: "string",
          enum: [...PIPELINE_STAGES],
          description: "Tahap tujuan.",
        },
      },
      required: ["stage"],
    },
  },
  {
    name: "send_payment_link",
    description:
      "Buat tautan bayar untuk produk yang ingin dibeli kontak dan kirimkan URL-nya sebagai pesan tersendiri. Gunakan bila kontak menyatakan ingin membeli/checkout. Isi productName dengan nama produk yang disebut kontak bila ada.",
    parameters: {
      type: "object",
      properties: {
        productName: {
          type: "string",
          description:
            "Nama produk yang ingin dibeli (opsional; kosong = produk aktif utama tenant).",
        },
      },
    },
  },
  {
    name: "handoff_to_human",
    description:
      "Serahkan percakapan ke manusia: AI berhenti membalas di percakapan ini. Gunakan bila pertanyaan di luar kemampuan/basis pengetahuan, kontak meminta manusia, atau ada keluhan serius.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Alasan singkat penyerahan (untuk catatan tim).",
        },
      },
      required: ["reason"],
    },
  },
];
