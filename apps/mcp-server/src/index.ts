import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  CreateContactRequestSchema,
  SendMessageRequestSchema,
  UpdateContactRequestSchema,
} from "@sahabat-kreator/contracts";
import {
  SahabatKreatorApiError,
  SahabatKreatorClient,
} from "@sahabat-kreator/sdk";
import { z } from "zod";

/**
 * MCP server Sahabat Kreator (Fase 5B, RANCANGAN §2 & §8) — transport stdio.
 *
 * Adapter TIPIS di atas @sahabat-kreator/sdk: setiap tool memanggil API
 * publik v1 yang sama dengan yang dipakai integrasi lain. Server ini TIDAK
 * mengakses database dan TIDAK memegang kredensial selain satu API key
 * tenant dari env:
 *
 *   SAHABAT_KREATOR_API_KEY   (wajib)  kunci `sk_live_...` dari dashboard
 *                                      Settings → API Keys. Scope kunci
 *                                      membatasi tool: mis. tanpa
 *                                      `messages:write`, tool send_message
 *                                      ditolak API (403 API_KEY_SCOPE_DENIED)
 *                                      dan diteruskan sebagai tool error.
 *   SAHABAT_KREATOR_BASE_URL  (opsional) origin API, default
 *                                      https://botara.my.id
 *   MCP_ALLOW_WRITES          (opsional, Fase 9B) tiering keamanan:
 *                                      DEFAULT server ini READ-ONLY.
 *                                      Tool TULIS (create_contact,
 *                                      update_contact, send_message,
 *                                      hide_comment, unhide_comment —
 *                                      dua terakhir Fase 10B) terdaftar
 *                                      tetapi MENOLAK dengan error yang
 *                                      jelas sampai env ini bernilai
 *                                      persis "1". Tool baca selalu
 *                                      jalan — termasuk permukaan BACA
 *                                      Fase 15A (broadcast, flow,
 *                                      otomasi, agen, channel, template
 *                                      WhatsApp, basis pengetahuan).
 *                                      Ini lapisan opt-in lokal di atas
 *                                      scope API key — keduanya harus
 *                                      mengizinkan agar tulis berhasil.
 *
 * Error API TIDAK membuat server crash: ia menjadi hasil tool `isError`
 * yang memuat kode kontrak agar model/pengguna bisa memahami penolakan.
 * stdout adalah kanal protokol MCP — log diagnostik HANYA ke stderr.
 */

const apiKey = process.env.SAHABAT_KREATOR_API_KEY;
if (!apiKey) {
  console.error(
    "[mcp-server] SAHABAT_KREATOR_API_KEY wajib diisi (API key tenant dari dashboard Settings → API Keys).",
  );
  process.exit(1);
}
const baseUrl = process.env.SAHABAT_KREATOR_BASE_URL ?? "https://botara.my.id";

/** Tiering keamanan MCP (Fase 9B): tulis hanya dengan opt-in eksplisit. */
const writesEnabled = process.env.MCP_ALLOW_WRITES === "1";

/** Hasil penolakan tool tulis saat tier tulis tidak diaktifkan. */
function writeDisabledResult(toolName: string): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text:
          `Tool "${toolName}" adalah tool TULIS dan server MCP ini berjalan ` +
          `READ-ONLY secara default (tiering keamanan Fase 9B). ` +
          `Untuk mengizinkan tool tulis, jalankan ulang server dengan env ` +
          `MCP_ALLOW_WRITES=1. Tool baca tetap tersedia tanpa env tersebut.`,
      },
    ],
  };
}

const client = new SahabatKreatorClient({ baseUrl, apiKey });

function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(err: unknown): CallToolResult {
  if (err instanceof SahabatKreatorApiError) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Sahabat Kreator API error [${err.code}] (HTTP ${err.status}): ${err.message}`,
        },
      ],
    };
  }
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
      },
    ],
  };
}

/** Jalankan panggilan SDK; kegagalan apa pun menjadi tool error yang terbaca. */
async function run<T>(fn: () => Promise<T>): Promise<CallToolResult> {
  try {
    return jsonResult(await fn());
  } catch (err) {
    return errorResult(err);
  }
}

/**
 * Menyalin shape Zod milik KONTRAK sambil menambahkan deskripsi untuk
 * model. Batas (min/max/format/refine) TIDAK ditulis ulang di sini —
 * seluruhnya diwarisi dari `@sahabat-kreator/contracts`, sehingga
 * perubahan batas di kontrak otomatis berlaku di MCP dan tidak bisa
 * menyimpang diam-diam (Fase 13D).
 *
 * Konsekuensi yang disengaja: bila kontrak menambah field baru, field
 * itu ikut muncul di tool (tanpa deskripsi sampai hint ditambahkan).
 */
function withHints<T extends z.ZodRawShape>(
  shape: T,
  hints: { [K in keyof T]?: string },
): T {
  const out: Record<string, z.ZodTypeAny> = {};
  for (const [key, schema] of Object.entries(shape)) {
    const hint = hints[key as keyof T];
    out[key] = hint ? schema.describe(hint) : schema;
  }
  return out as T;
}

const server = new McpServer({ name: "sahabat-kreator", version: "0.1.0" });

server.registerTool(
  "whoami",
  {
    description:
      "Identitas tenant pemilik API key yang dipakai server ini (tenantId, tenantName) beserta scope kunci. Berguna untuk memastikan kunci/workspace yang benar sebelum bertindak.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => run(() => client.me()),
);

server.registerTool(
  "list_contacts",
  {
    description:
      "Daftar kontak workspace (scope contacts:read). Mendukung pencarian teks bebas dan pagination limit/offset. Hasil: { contacts, total }.",
    inputSchema: {
      search: z.string().max(255).optional().describe("Kata kunci pencarian nama/email/telepon"),
      limit: z.number().int().min(1).max(100).optional().describe("Maks. jumlah kontak (default server 50)"),
      offset: z.number().int().min(0).optional().describe("Lewati N kontak pertama"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ search, limit, offset }) =>
    run(() => client.listContacts({ search, limit, offset })),
);

server.registerTool(
  "create_contact",
  {
    description:
      "Buat kontak baru di workspace (scope contacts:write). Hasil: kontak yang dibuat. [TIER TULIS — menolak kecuali server dijalankan dengan MCP_ALLOW_WRITES=1; default server read-only.]",
    inputSchema: withHints(CreateContactRequestSchema.shape, {
      name: "Nama kontak",
      phone: "Nomor telepon (opsional)",
      email: "Email (opsional)",
      tags: "Daftar tag (opsional)",
      customFields:
        "Field kustom kontak sebagai peta string→string (opsional; kunci 1–64 karakter, nilai maks 1000 karakter, maks 50 entri)",
    }),
    annotations: { readOnlyHint: false },
  },
  async ({ name, phone, email, tags, customFields }) =>
    writesEnabled
      ? run(() =>
          client.createContact({ name, phone, email, tags, customFields }),
        )
      : writeDisabledResult("create_contact"),
);

server.registerTool(
  "list_conversations",
  {
    description:
      "Daftar percakapan workspace (scope conversations:read), terbaru dulu, dengan cuplikan pesan terakhir dan jumlah belum terbaca.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => run(() => client.listConversations()),
);

server.registerTool(
  "list_messages",
  {
    description:
      "Riwayat pesan satu percakapan (scope conversations:read), kronologis menaik. Membaca lewat tool ini tidak menandai percakapan terbaca.",
    inputSchema: {
      conversationId: z.string().uuid().describe("Id percakapan (dari list_conversations)"),
      limit: z.number().int().min(1).max(200).optional().describe("Maks. jumlah pesan (default server 50)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ conversationId, limit }) =>
    run(() => client.listMessages(conversationId, { limit })),
);

server.registerTool(
  "send_message",
  {
    description:
      "Kirim pesan keluar ke satu percakapan sebagai workspace (scope messages:write). Pesan masuk jalur pengiriman yang sama dengan balasan dashboard — untuk webchat, pengunjung yang terhubung menerimanya realtime. [TIER TULIS — menolak kecuali server dijalankan dengan MCP_ALLOW_WRITES=1; default server read-only.]",
    inputSchema: {
      conversationId: z.string().uuid().describe("Id percakapan tujuan"),
      // Batas panjang pesan diwarisi dari kontrak (SendMessageRequest),
      // bukan ditulis ulang — Fase 13D.
      text: SendMessageRequestSchema.shape.contentText.describe("Isi pesan teks"),
    },
    annotations: { readOnlyHint: false },
  },
  async ({ conversationId, text }) =>
    writesEnabled
      ? run(() => client.sendMessage(conversationId, text))
      : writeDisabledResult("send_message"),
);

server.registerTool(
  "list_products",
  {
    description:
      "Daftar produk workspace beserta harga Rupiah (scope products:read).",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => run(() => client.listProducts()),
);

server.registerTool(
  "list_comments",
  {
    description:
      "Daftar komentar Instagram/Messenger yang tercatat dari webhook (scope comments:read), terbaru dulu, beserta aturan yang cocok dan jejak aksinya (DM/balasan publik/sembunyikan) serta status moderasi. Hasil: { comments }.",
    inputSchema: {
      channelAccountId: z.string().uuid().optional().describe("Saring ke satu akun channel (opsional)"),
      automationId: z.string().uuid().optional().describe("Saring ke komentar yang cocok dengan aturan ini (opsional)"),
      limit: z.number().int().min(1).max(200).optional().describe("Maks. jumlah komentar (default server 50)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ channelAccountId, automationId, limit }) =>
    run(() => client.listComments({ channelAccountId, automationId, limit })),
);

server.registerTool(
  "hide_comment",
  {
    description:
      "Sembunyikan satu komentar di Instagram/Facebook (scope comments:write). Meta dipanggil dulu; status lokal berubah hanya bila Meta menerima. [TIER TULIS — menolak kecuali server dijalankan dengan MCP_ALLOW_WRITES=1; default server read-only.]",
    inputSchema: {
      commentId: z.string().uuid().describe("Id komentar (dari list_comments)"),
    },
    annotations: { readOnlyHint: false },
  },
  async ({ commentId }) =>
    writesEnabled
      ? run(() => client.hideComment(commentId))
      : writeDisabledResult("hide_comment"),
);

server.registerTool(
  "unhide_comment",
  {
    description:
      "Tampilkan lagi satu komentar yang tersembunyi di Instagram/Facebook (scope comments:write). [TIER TULIS — menolak kecuali server dijalankan dengan MCP_ALLOW_WRITES=1; default server read-only.]",
    inputSchema: {
      commentId: z.string().uuid().describe("Id komentar (dari list_comments)"),
    },
    annotations: { readOnlyHint: false },
  },
  async ({ commentId }) =>
    writesEnabled
      ? run(() => client.unhideComment(commentId))
      : writeDisabledResult("unhide_comment"),
);

server.registerTool(
  "update_contact",
  {
    description:
      "Ubah kontak yang ada (scope contacts:write) mengikuti kontrak UpdateContactRequest: nama, tags (menggantikan seluruh daftar), pipelineStage, optInStatus, dan/atau customFields — customFields digabung per kunci di server (kunci yang dikirim menimpa, yang tidak disebut dipertahankan). [TIER TULIS — menolak kecuali server dijalankan dengan MCP_ALLOW_WRITES=1; default server read-only.]",
    inputSchema: {
      contactId: z.string().uuid().describe("Id kontak (dari list_contacts)"),
      ...withHints(UpdateContactRequestSchema.shape, {
        name: "Nama baru (opsional)",
        tags: "Daftar tag baru — menggantikan seluruh daftar lama (opsional)",
        pipelineStage: "Tahap pipeline baru (opsional)",
        optInStatus: "Status opt-in baru (opsional)",
        customFields:
          "Field kustom sebagai peta string→string (opsional; kunci 1–64 karakter, nilai maks 1000 karakter, maks 50 entri)",
      }),
    },
    annotations: { readOnlyHint: false },
  },
  async ({ contactId, name, tags, pipelineStage, optInStatus, customFields }) =>
    writesEnabled
      ? run(() =>
          client.updateContact(contactId, {
            name,
            tags,
            pipelineStage,
            optInStatus,
            customFields,
          }),
        )
      : writeDisabledResult("update_contact"),
);

// ---------------------------------------------------------------------------
// Fase 15A — permukaan BACA untuk sumber daya yang sebelumnya hanya
// dashboard (aturan sinkronisasi kontrak). Semua tool di bawah READ-ONLY
// (readOnlyHint: true) dan selalu jalan di tier default.
// ---------------------------------------------------------------------------

server.registerTool(
  "list_broadcasts",
  {
    description:
      "Daftar broadcast workspace (scope broadcasts:read), terbaru dulu, berpaginasi kursor, beserta statistik penerima per broadcast. Hasil: { broadcasts, nextCursor }.",
    inputSchema: {
      status: z
        .enum([
          "draft",
          "scheduled",
          "sending",
          "completed",
          "partially_failed",
          "failed",
          "cancelled",
        ])
        .optional()
        .describe("Saring status (opsional)"),
      cursor: z.string().min(1).max(512).optional().describe("Kursor halaman berikutnya (opsional)"),
      limit: z.number().int().min(1).max(100).optional().describe("Maks. jumlah broadcast (opsional)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ status, cursor, limit }) =>
    run(() => client.listBroadcasts({ status, cursor, limit })),
);

server.registerTool(
  "get_broadcast",
  {
    description:
      "Satu broadcast + statistik penerimanya (scope broadcasts:read).",
    inputSchema: {
      broadcastId: z.string().uuid().describe("Id broadcast (dari list_broadcasts)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ broadcastId }) => run(() => client.getBroadcast(broadcastId)),
);

server.registerTool(
  "list_flows",
  {
    description:
      "Daftar flow workspace (scope flows:read), berpaginasi kursor, graf ikut serta pada setiap flow. Hasil: { flows, nextCursor }.",
    inputSchema: {
      status: z.enum(["draft", "active", "archived"]).optional().describe("Saring status (opsional)"),
      cursor: z.string().min(1).max(512).optional().describe("Kursor halaman berikutnya (opsional)"),
      limit: z.number().int().min(1).max(100).optional().describe("Maks. jumlah flow (opsional)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ status, cursor, limit }) =>
    run(() => client.listFlows({ status, cursor, limit })),
);

server.registerTool(
  "get_flow",
  {
    description: "Satu flow + graf lengkapnya (scope flows:read).",
    inputSchema: {
      flowId: z.string().uuid().describe("Id flow (dari list_flows)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ flowId }) => run(() => client.getFlow(flowId)),
);

server.registerTool(
  "list_flow_templates",
  {
    description:
      "Katalog template flow (scope flows:read): slug, kunci nama/deskripsi dwibahasa, kategori, jumlah node, dan kebutuhan yang harus dilengkapi sebelum aktivasi.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => run(() => client.listFlowTemplates()),
);

server.registerTool(
  "list_automations",
  {
    description:
      "Daftar otomasi workspace (scope automations:read): aturan kata kunci, sequence (beserta langkahnya), dan aturan komentar. Hasil: { automations }.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => run(() => client.listAutomations()),
);

server.registerTool(
  "get_automation",
  {
    description: "Satu otomasi (scope automations:read).",
    inputSchema: {
      automationId: z.string().uuid().describe("Id otomasi (dari list_automations)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ automationId }) => run(() => client.getAutomation(automationId)),
);

server.registerTool(
  "list_agents",
  {
    description:
      "Daftar agen AI workspace (scope agents:read): nama, model, mode auto/suggest, status aktif, dan prompt sistemnya. Hasil: { agents }.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => run(() => client.listAgents()),
);

server.registerTool(
  "get_agent",
  {
    description: "Satu agen AI (scope agents:read).",
    inputSchema: {
      agentId: z.string().uuid().describe("Id agen (dari list_agents)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ agentId }) => run(() => client.getAgent(agentId)),
);

server.registerTool(
  "list_channels",
  {
    description:
      "Daftar akun channel terhubung (scope channels:read): provider, nama tampilan, status koneksi dan kesehatan operasional. Kredensial channel TIDAK pernah disertakan. Hasil: { channels }.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => run(() => client.listChannels()),
);

server.registerTool(
  "get_channel",
  {
    description: "Satu akun channel + kesehatannya (scope channels:read).",
    inputSchema: {
      channelId: z.string().uuid().describe("Id akun channel (dari list_channels)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ channelId }) => run(() => client.getChannel(channelId)),
);

server.registerTool(
  "list_whatsapp_templates",
  {
    description:
      "Cermin template WhatsApp satu akun channel (scope whatsapp_templates:read): nama, bahasa, kategori, status persetujuan Meta, dan teks badan. channelAccountId wajib (dari list_channels, provider whatsapp). Hasil: { templates }.",
    inputSchema: {
      channelAccountId: z.string().uuid().describe("Id akun channel WhatsApp"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ channelAccountId }) =>
    run(() => client.listWhatsAppTemplates({ channelAccountId })),
);

server.registerTool(
  "list_knowledge_documents",
  {
    description:
      "Daftar entri basis pengetahuan workspace (scope knowledge:read) beserta jumlah chunk retrieval tiap entri. Hasil: { documents }.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => run(() => client.listKnowledgeDocuments()),
);

server.registerTool(
  "get_knowledge_document",
  {
    description: "Satu entri basis pengetahuan (scope knowledge:read).",
    inputSchema: {
      documentId: z.string().uuid().describe("Id dokumen (dari list_knowledge_documents)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ documentId }) => run(() => client.getKnowledgeDocument(documentId)),
);

server.registerTool(
  "get_knowledge_stats",
  {
    description:
      "Statistik basis pengetahuan (scope knowledge:read): total chunk, chunk yang sudah ter-embed, dan status pencarian semantik (aktif/tidak + provider/model).",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => run(() => client.getKnowledgeStats()),
);

server.registerTool(
  "list_growth_links",
  {
    description:
      "Daftar tautan growth workspace (scope growth_links:read, Fase 13B): slug publik, channel tujuan, dan statistik turunan event (klik, tampilan picker, konversi). Hasil: { links }.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => run(() => client.listGrowthLinks()),
);

server.registerTool(
  "get_growth_link",
  {
    description: "Satu tautan growth beserta statistiknya (scope growth_links:read).",
    inputSchema: {
      linkId: z.string().uuid().describe("Id tautan growth (dari list_growth_links)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ linkId }) => run(() => client.getGrowthLink(linkId)),
);

server.registerTool(
  "list_segments",
  {
    description:
      "Daftar segmen audiens workspace (scope segments:read, Fase 13C): nama + definisi kondisi ({match, conditions}) yang dievaluasi server untuk daftar kontak & audiens broadcast. Hasil: { segments }.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => run(() => client.listSegments()),
);

server.registerTool(
  "get_segment",
  {
    description: "Satu definisi segmen audiens (scope segments:read).",
    inputSchema: {
      segmentId: z.string().uuid().describe("Id segmen (dari list_segments)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ segmentId }) => run(() => client.getSegment(segmentId)),
);

server.registerTool(
  "list_orders",
  {
    description:
      "Daftar order commerce workspace (scope orders:read, Fase 13F): order lahir dari node flow cart_checkout — baris item snapshot, total terhitung server, status mengikuti tautan bayar (pending/paid/expired/cancelled) + referensi tautan. Pembayaran masih SIMULASI sampai gerbang merchant nyata (Fase 14A). Keranjang SENGAJA tidak diekspos (keadaan sesi percakapan). Hasil: { orders }.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => run(() => client.listOrders()),
);

server.registerTool(
  "get_order",
  {
    description:
      "Satu order commerce: pembeli, item snapshot (nama, qty, harga satuan), total, status, kode/url/status tautan bayar, dan waktu lunas (scope orders:read).",
    inputSchema: {
      orderId: z.string().uuid().describe("Id order (dari list_orders)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ orderId }) => run(() => client.getOrder(orderId)),
);

server.registerTool(
  "list_appointments",
  {
    description:
      "Daftar booking janji temu workspace (scope appointments:read, Fase 13G): layanan, kontak, rentang waktu UTC, status confirmed/cancelled, sumber (flow/dashboard), dan keadaan sinkron Google Calendar. Saring opsional from/to (ISO datetime) + status. Booking dibuat lewat node flow book_appointment atau dashboard — tidak ada tool tulis janji (kurasi operator & percakapan). Hasil: { bookings }.",
    inputSchema: {
      from: z.string().datetime().optional().describe("Hanya booking mulai ≥ waktu ini (ISO)"),
      to: z.string().datetime().optional().describe("Hanya booking mulai < waktu ini (ISO)"),
      status: z.enum(["confirmed", "cancelled"]).optional().describe("Saring status booking"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ from, to, status }) =>
    run(() => client.listAppointments({ from, to, status })),
);

server.registerTool(
  "list_appointment_services",
  {
    description:
      "Daftar layanan janji temu workspace (scope appointments:read, Fase 13G): nama, durasi menit, flag aktif. Hasil: { services }.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => run(() => client.listAppointmentServices()),
);

await server.connect(new StdioServerTransport());
console.error(
  `[mcp-server] sahabat-kreator MCP server (stdio) siap — API ${baseUrl} — tier: ${
    writesEnabled
      ? "BACA+TULIS (MCP_ALLOW_WRITES=1)"
      : "READ-ONLY (tool tulis menolak; set MCP_ALLOW_WRITES=1 untuk mengizinkan)"
  }`,
);
