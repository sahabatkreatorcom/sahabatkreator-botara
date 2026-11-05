/**
 * Uji integrasi MCP server Sahabat Kreator (Fase 5B) — BUKAN unit test dan
 * BUKAN bagian suite Playwright. Skrip ini:
 *   (a) memulai apps/mcp-server hasil build (dist/index.js) sebagai proses
 *       anak lewat transport stdio,
 *   (b) memakainya dengan klien MCP resmi (Client dari
 *       @modelcontextprotocol/sdk) — initialize, tools/list, tools/call —
 *       terhadap API publik v1 yang LIVE.
 *
 * Tiering keamanan (Fase 9B) diuji eksplisit dalam TIGA sesi:
 *   A) default TANPA MCP_ALLOW_WRITES: baca berhasil, tool tulis
 *      DITOLAK di lapisan MCP (pesan menyebut MCP_ALLOW_WRITES);
 *   B) MCP_ALLOW_WRITES=1: tool tulis berhasil end-to-end;
 *   C) kunci terbatas + MCP_ALLOW_WRITES=1: permintaan lolos tier MCP
 *      lalu DITOLAK API oleh scope kunci (API_KEY_SCOPE_DENIED) —
 *      kedua lapisan independen.
 *
 * Env yang dibaca (kunci TIDAK PERNAH dicetak — hanya prefix):
 *   SAHABAT_KREATOR_API_KEY           (wajib) kunci FULL-scope tenant uji
 *   SAHABAT_KREATOR_API_KEY_LIMITED   (opsional) kunci scope-read default
 *                                     untuk uji negatif scope; bila kosong
 *                                     uji negatif dilewati (SKIP)
 *   SAHABAT_KREATOR_BASE_URL          (opsional) default https://botara.my.id
 *   SAHABAT_KREATOR_TEST_CONVERSATION_ID (opsional) percakapan tujuan
 *                                     send_message; bila kosong dipakai
 *                                     percakapan pertama tenant. Bila tenant
 *                                     tidak punya percakapan sama sekali,
 *                                     uji send_message GAGAL (skrip ini
 *                                     adalah bukti end-to-end, bukan smoke)
 *   SAHABAT_KREATOR_MCP_COMMAND       (opsional) executable untuk menjalankan
 *                                     dist server (default "node"; di server
 *                                     staging yang hanya punya Bun, isi path
 *                                     bun — dist server adalah ESM murni).
 *
 * Prasyarat: server sudah di-build (`pnpm --filter @sahabat-kreator/mcp-server build`).
 * Jalankan:  pnpm --filter @sahabat-kreator/mcp-server verify:mcp
 * Exit code 0 = semua lulus; 1 = ada kegagalan; 2 = env kurang.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const fullKey = process.env.SAHABAT_KREATOR_API_KEY;
if (!fullKey) {
  console.error("SAHABAT_KREATOR_API_KEY wajib diisi (kunci full-scope tenant uji).");
  process.exit(2);
}
const limitedKey = process.env.SAHABAT_KREATOR_API_KEY_LIMITED;
const baseUrl = process.env.SAHABAT_KREATOR_BASE_URL ?? "https://botara.my.id";
const testConversationId = process.env.SAHABAT_KREATOR_TEST_CONVERSATION_ID;

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const serverEntry = path.join(packageRoot, "dist", "index.js");
if (!existsSync(serverEntry)) {
  console.error(
    `dist server tidak ditemukan (${serverEntry}) — jalankan dulu: pnpm --filter @sahabat-kreator/mcp-server build`,
  );
  process.exit(2);
}

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}
function skip(name: string, why: string): void {
  console.log(`SKIP  ${name} — ${why}`);
}

interface ToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
}

function resultText(result: ToolResult): string {
  return result.content?.find((c) => c.type === "text")?.text ?? "";
}
function resultJson<T>(result: ToolResult): T | null {
  try {
    return JSON.parse(resultText(result)) as T;
  } catch {
    return null;
  }
}

async function connect(apiKey: string, allowWrites = false): Promise<Client> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  env.SAHABAT_KREATOR_API_KEY = apiKey;
  env.SAHABAT_KREATOR_BASE_URL = baseUrl;
  // Tier tulis dikendalikan EKSPLISIT oleh skrip, bukan env sekitar:
  // sesi default harus benar-benar tanpa MCP_ALLOW_WRITES.
  if (allowWrites) env.MCP_ALLOW_WRITES = "1";
  else delete env.MCP_ALLOW_WRITES;
  const transport = new StdioClientTransport({
    command: process.env.SAHABAT_KREATOR_MCP_COMMAND ?? "node",
    args: [serverEntry],
    env,
    stderr: "inherit",
  });
  const client = new Client({ name: "verify-mcp", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

const EXPECTED_TOOLS = [
  "whoami",
  "list_contacts",
  "create_contact",
  "update_contact",
  "list_conversations",
  "list_messages",
  "send_message",
  "list_products",
  // Fase 10B: permukaan komentar (aturan sinkronisasi kontrak).
  "list_comments",
  "hide_comment",
  "unhide_comment",
  // Fase 15A: permukaan BACA baru (aturan sinkronisasi kontrak).
  "list_broadcasts",
  "get_broadcast",
  "list_flows",
  "get_flow",
  "list_flow_templates",
  "list_automations",
  "get_automation",
  "list_agents",
  "get_agent",
  "list_channels",
  "get_channel",
  "list_whatsapp_templates",
  "list_knowledge_documents",
  "get_knowledge_document",
  "get_knowledge_stats",
  // Fase 13B: growth links — permukaan BACA.
  "list_growth_links",
  "get_growth_link",
  // Fase 13C: segmen — permukaan BACA.
  "list_segments",
  "get_segment",
  "list_orders",
  "get_order",
  // Fase 13G: janji temu — permukaan BACA.
  "list_appointments",
  "list_appointment_services",
];

const uniqueNameRef = { name: `MCP Uji ${Date.now()}` };

const client = await connect(fullKey);
try {
  const serverInfo = client.getServerVersion();
  check(
    "initialize OK",
    serverInfo?.name === "sahabat-kreator",
    `server=${serverInfo?.name}@${serverInfo?.version}`,
  );

  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  check(
    `tools/list memuat ${EXPECTED_TOOLS.length} tools`,
    JSON.stringify(names) === JSON.stringify([...EXPECTED_TOOLS].sort()),
    names.join(","),
  );

  const hintOf = (name: string) =>
    tools.tools.find((t) => t.name === name)?.annotations?.readOnlyHint;
  check(
    "annotations tier: baca readOnlyHint=true, tulis=false (Fase 9B)",
    hintOf("whoami") === true &&
      hintOf("list_contacts") === true &&
      hintOf("list_products") === true &&
      hintOf("list_comments") === true &&
      // Fase 15A: seluruh permukaan baru adalah BACA.
      hintOf("list_broadcasts") === true &&
      hintOf("get_broadcast") === true &&
      hintOf("list_flows") === true &&
      hintOf("get_flow") === true &&
      hintOf("list_flow_templates") === true &&
      hintOf("list_automations") === true &&
      hintOf("get_automation") === true &&
      hintOf("list_agents") === true &&
      hintOf("get_agent") === true &&
      hintOf("list_channels") === true &&
      hintOf("get_channel") === true &&
      hintOf("list_whatsapp_templates") === true &&
      hintOf("list_knowledge_documents") === true &&
      hintOf("get_knowledge_document") === true &&
      hintOf("get_knowledge_stats") === true &&
      // Fase 13B: growth links adalah BACA.
      hintOf("list_growth_links") === true &&
      hintOf("get_growth_link") === true &&
      // Fase 13C: segmen adalah BACA.
      hintOf("list_segments") === true &&
      hintOf("get_segment") === true &&
      // Fase 13F: order adalah BACA.
      hintOf("list_orders") === true &&
      hintOf("get_order") === true &&
      // Fase 13G: janji temu adalah BACA.
      hintOf("list_appointments") === true &&
      hintOf("list_appointment_services") === true &&
      hintOf("create_contact") === false &&
      hintOf("update_contact") === false &&
      hintOf("send_message") === false &&
      hintOf("hide_comment") === false &&
      hintOf("unhide_comment") === false,
    `create_contact=${String(hintOf("create_contact"))} update_contact=${String(hintOf("update_contact"))} send_message=${String(hintOf("send_message"))} hide_comment=${String(hintOf("hide_comment"))}`,
  );

  const whoami = await call(client, "whoami");
  const me = resultJson<{ tenantId: string; tenantName: string; scopes: string[] }>(whoami);
  check(
    "whoami → tenant benar",
    !whoami.isError && !!me && me.tenantId.length > 0 && me.tenantName.length > 0,
    me ? `tenant="${me.tenantName}" scopes=${me.scopes.join(",")}` : resultText(whoami),
  );

  const contactsResult = await call(client, "list_contacts", { limit: 5 });
  const contacts = resultJson<{ contacts: unknown[]; total: number }>(contactsResult);
  check(
    "list_contacts",
    !contactsResult.isError && !!contacts && Array.isArray(contacts.contacts),
    contacts ? `total=${contacts.total}` : resultText(contactsResult),
  );

  // --- Tier READ-ONLY (default): tool tulis DITOLAK di lapisan MCP ----
  const rejectedCreate = await call(client, "create_contact", { name: uniqueNameRef.name });
  check(
    "tanpa MCP_ALLOW_WRITES: create_contact DITOLAK (menyebut MCP_ALLOW_WRITES)",
    rejectedCreate.isError === true &&
      resultText(rejectedCreate).includes("MCP_ALLOW_WRITES"),
    resultText(rejectedCreate).slice(0, 120),
  );

  const convResult = await call(client, "list_conversations");
  const convs = resultJson<{ conversations: Array<{ id: string }> }>(convResult);
  check(
    "list_conversations",
    !convResult.isError && !!convs && Array.isArray(convs.conversations),
    convs ? `count=${convs.conversations.length}` : resultText(convResult),
  );

  const conversationId = testConversationId ?? convs?.conversations[0]?.id;
  if (!conversationId) {
    check(
      "send_message",
      false,
      "tenant tidak punya percakapan — buat percakapan webchat uji dulu (lihat README)",
    );
  } else {
    const historyResult = await call(client, "list_messages", {
      conversationId,
      limit: 50,
    });
    const history = resultJson<{ messages: unknown[] }>(historyResult);
    check(
      "list_messages",
      !historyResult.isError && !!history && Array.isArray(history.messages),
      history ? `count=${history.messages.length}` : resultText(historyResult),
    );

    const rejectedSend = await call(client, "send_message", {
      conversationId,
      text: "pesan ini harus ditolak tier read-only",
    });
    check(
      "tanpa MCP_ALLOW_WRITES: send_message DITOLAK (menyebut MCP_ALLOW_WRITES)",
      rejectedSend.isError === true &&
        resultText(rejectedSend).includes("MCP_ALLOW_WRITES"),
      resultText(rejectedSend).slice(0, 120),
    );
  }

  const productsResult = await call(client, "list_products");
  const products = resultJson<{ products: unknown[] }>(productsResult);
  check(
    "list_products",
    !productsResult.isError && !!products && Array.isArray(products.products),
    products ? `count=${products.products.length}` : resultText(productsResult),
  );

  // Fase 10B: permukaan komentar — baca jalan di tier read-only; tulis
  // (hide_comment) menolak tanpa MCP_ALLOW_WRITES seperti tool tulis lain.
  const commentsResult = await call(client, "list_comments", { limit: 5 });
  const commentsList = resultJson<{ comments: unknown[] }>(commentsResult);
  check(
    "list_comments",
    !commentsResult.isError && !!commentsList && Array.isArray(commentsList.comments),
    commentsList
      ? `count=${commentsList.comments.length}`
      : resultText(commentsResult),
  );

  const rejectedHide = await call(client, "hide_comment", {
    commentId: "00000000-0000-4000-8000-000000000000",
  });
  check(
    "tanpa MCP_ALLOW_WRITES: hide_comment DITOLAK (menyebut MCP_ALLOW_WRITES)",
    rejectedHide.isError === true &&
      resultText(rejectedHide).includes("MCP_ALLOW_WRITES"),
    resultText(rejectedHide).slice(0, 120),
  );

  // Fase 15A: update_contact adalah tool TULIS baru — menolak di tier
  // read-only sama seperti tool tulis lain.
  const rejectedUpdate = await call(client, "update_contact", {
    contactId: "00000000-0000-4000-8000-000000000000",
    customFields: { kota: "Bandung" },
  });
  check(
    "tanpa MCP_ALLOW_WRITES: update_contact DITOLAK (menyebut MCP_ALLOW_WRITES)",
    rejectedUpdate.isError === true &&
      resultText(rejectedUpdate).includes("MCP_ALLOW_WRITES"),
    resultText(rejectedUpdate).slice(0, 120),
  );

  // Fase 15A: permukaan BACA baru — semua jalan di tier read-only.
  const broadcastsResult = await call(client, "list_broadcasts", { limit: 5 });
  const broadcastsList = resultJson<{ broadcasts: unknown[]; nextCursor: unknown }>(broadcastsResult);
  check(
    "list_broadcasts",
    !broadcastsResult.isError && !!broadcastsList && Array.isArray(broadcastsList.broadcasts),
    broadcastsList
      ? `count=${broadcastsList.broadcasts.length}`
      : resultText(broadcastsResult),
  );

  const flowsResult = await call(client, "list_flows", { limit: 5 });
  const flowsList = resultJson<{ flows: unknown[]; nextCursor: unknown }>(flowsResult);
  check(
    "list_flows",
    !flowsResult.isError && !!flowsList && Array.isArray(flowsList.flows),
    flowsList ? `count=${flowsList.flows.length}` : resultText(flowsResult),
  );

  const templatesResult = await call(client, "list_flow_templates");
  const templatesList = resultJson<{ templates: Array<{ slug: string }> }>(templatesResult);
  check(
    "list_flow_templates memuat katalog kontrak",
    !templatesResult.isError &&
      !!templatesList &&
      templatesList.templates.some((t) => t.slug === "sambutan-tag-minat"),
    templatesList
      ? `count=${templatesList.templates.length}`
      : resultText(templatesResult),
  );

  const automationsResult = await call(client, "list_automations");
  const automationsList = resultJson<{ automations: unknown[] }>(automationsResult);
  check(
    "list_automations",
    !automationsResult.isError && !!automationsList && Array.isArray(automationsList.automations),
    automationsList
      ? `count=${automationsList.automations.length}`
      : resultText(automationsResult),
  );

  const agentsResult = await call(client, "list_agents");
  const agentsList = resultJson<{ agents: unknown[] }>(agentsResult);
  check(
    "list_agents",
    !agentsResult.isError && !!agentsList && Array.isArray(agentsList.agents),
    agentsList ? `count=${agentsList.agents.length}` : resultText(agentsResult),
  );

  const channelsResult = await call(client, "list_channels");
  const channelsList = resultJson<{ channels: unknown[] }>(channelsResult);
  check(
    "list_channels",
    !channelsResult.isError && !!channelsList && Array.isArray(channelsList.channels),
    channelsList
      ? `count=${channelsList.channels.length}`
      : resultText(channelsResult),
  );

  const kbDocsResult = await call(client, "list_knowledge_documents");
  const kbDocsList = resultJson<{ documents: unknown[] }>(kbDocsResult);
  check(
    "list_knowledge_documents",
    !kbDocsResult.isError && !!kbDocsList && Array.isArray(kbDocsList.documents),
    kbDocsList ? `count=${kbDocsList.documents.length}` : resultText(kbDocsResult),
  );

  const kbStatsResult = await call(client, "get_knowledge_stats");
  const kbStats = resultJson<{ totalChunks: number; embeddedChunks: number }>(kbStatsResult);
  check(
    "get_knowledge_stats",
    !kbStatsResult.isError && !!kbStats && typeof kbStats.totalChunks === "number",
    kbStats
      ? `chunks=${kbStats.embeddedChunks}/${kbStats.totalChunks}`
      : resultText(kbStatsResult),
  );

  // Fase 13B: growth links (BACA) — daftar + get pertama bila ada.
  const growthResult = await call(client, "list_growth_links");
  const growthList = resultJson<{
    links: Array<{ id: string; slug: string; stats: { clicks: number } }>;
  }>(growthResult);
  check(
    "list_growth_links",
    !growthResult.isError && !!growthList && Array.isArray(growthList.links),
    growthList ? `count=${growthList.links.length}` : resultText(growthResult),
  );
  if (growthList && growthList.links.length > 0) {
    const first = growthList.links[0]!;
    const oneResult = await call(client, "get_growth_link", { linkId: first.id });
    const one = resultJson<{ id: string; slug: string }>(oneResult);
    check(
      "get_growth_link konsisten dengan daftar",
      !oneResult.isError && !!one && one.id === first.id && one.slug === first.slug,
      one ? `slug=${one.slug}` : resultText(oneResult),
    );
  }

  // Fase 13C: segmen (BACA) — daftar + get pertama bila ada.
  const segmentsResult = await call(client, "list_segments");
  const segmentsList = resultJson<{
    segments: Array<{ id: string; name: string }>;
  }>(segmentsResult);
  check(
    "list_segments",
    !segmentsResult.isError && !!segmentsList && Array.isArray(segmentsList.segments),
    segmentsList ? `count=${segmentsList.segments.length}` : resultText(segmentsResult),
  );
  if (segmentsList && segmentsList.segments.length > 0) {
    const first = segmentsList.segments[0]!;
    const oneResult = await call(client, "get_segment", { segmentId: first.id });
    const one = resultJson<{ id: string; name: string }>(oneResult);
    check(
      "get_segment konsisten dengan daftar",
      !oneResult.isError && !!one && one.id === first.id && one.name === first.name,
      one ? `name=${one.name}` : resultText(oneResult),
    );
  }

  // Fase 13F: order (BACA) — daftar + get pertama bila ada.
  const ordersResult = await call(client, "list_orders");
  const ordersList = resultJson<{
    orders: Array<{ id: string; totalIdr: number; status: string }>;
  }>(ordersResult);
  check(
    "list_orders",
    !ordersResult.isError && !!ordersList && Array.isArray(ordersList.orders),
    ordersList ? `count=${ordersList.orders.length}` : resultText(ordersResult),
  );
  if (ordersList && ordersList.orders.length > 0) {
    const first = ordersList.orders[0]!;
    const oneResult = await call(client, "get_order", { orderId: first.id });
    const one = resultJson<{ id: string; totalIdr: number }>(oneResult);
    check(
      "get_order konsisten dengan daftar",
      !oneResult.isError && !!one && one.id === first.id && one.totalIdr === first.totalIdr,
      one ? `total=${one.totalIdr}` : resultText(oneResult),
    );
  }

  // Fase 13G: janji temu (BACA) — daftar booking + daftar layanan.
  const apptResult = await call(client, "list_appointments");
  const apptList = resultJson<{ bookings: Array<{ id: string }> }>(apptResult);
  check(
    "list_appointments",
    !apptResult.isError && !!apptList && Array.isArray(apptList.bookings),
    apptList ? `count=${apptList.bookings.length}` : resultText(apptResult),
  );
  const svcResult = await call(client, "list_appointment_services");
  const svcList = resultJson<{ services: Array<{ id: string }> }>(svcResult);
  check(
    "list_appointment_services",
    !svcResult.isError && !!svcList && Array.isArray(svcList.services),
    svcList ? `count=${svcList.services.length}` : resultText(svcResult),
  );
} finally {
  await client.close();
}

// --- Tier BACA+TULIS: sesi kedua dengan MCP_ALLOW_WRITES=1 ---------------
const writer = await connect(fullKey, true);
try {
  const createdResult = await call(writer, "create_contact", {
    name: uniqueNameRef.name,
    customFields: { sumber: "verify-mcp", kota: "Bandung" },
  });
  const created = resultJson<{
    id: string;
    name: string;
    customFields?: Record<string, unknown>;
  }>(createdResult);
  check(
    "MCP_ALLOW_WRITES=1: create_contact berhasil",
    !createdResult.isError && !!created && created.name === uniqueNameRef.name,
    created ? `id=${created.id}` : resultText(createdResult),
  );
  check(
    "MCP_ALLOW_WRITES=1: create_contact customFields tersimpan (Fase 13A)",
    !!created &&
      created.customFields?.sumber === "verify-mcp" &&
      created.customFields?.kota === "Bandung",
    created ? `customFields=${JSON.stringify(created.customFields)}` : "",
  );

  const searchResult = await call(writer, "list_contacts", { search: uniqueNameRef.name });
  const found = resultJson<{ contacts: Array<{ id: string }> }>(searchResult);
  check(
    "kontak baru muncul di list_contacts",
    !!found && !!created && found.contacts.some((c) => c.id === created.id),
  );

  // Fase 15A: update_contact (tier TULIS) — customFields digabung per
  // kunci: kota menimpa, sumber dari create_contact dipertahankan.
  if (created) {
    const updatedResult = await call(writer, "update_contact", {
      contactId: created.id,
      customFields: { kota: "Jakarta" },
    });
    const updated = resultJson<{
      id: string;
      customFields?: Record<string, unknown>;
    }>(updatedResult);
    check(
      "MCP_ALLOW_WRITES=1: update_contact customFields gabung per kunci (Fase 15A)",
      !updatedResult.isError &&
        !!updated &&
        updated.customFields?.kota === "Jakarta" &&
        updated.customFields?.sumber === "verify-mcp",
      updated
        ? `customFields=${JSON.stringify(updated.customFields)}`
        : resultText(updatedResult),
    );
  } else {
    check("MCP_ALLOW_WRITES=1: update_contact customFields gabung per kunci (Fase 15A)", false, "create_contact gagal — tidak ada kontak untuk diubah");
  }

  const convsW = resultJson<{ conversations: Array<{ id: string }> }>(
    await call(writer, "list_conversations"),
  );
  const conversationIdW = testConversationId ?? convsW?.conversations[0]?.id;
  if (!conversationIdW) {
    check("MCP_ALLOW_WRITES=1: send_message", false, "tidak ada percakapan uji");
  } else {
    const marker = `Pesan uji MCP ${Date.now()}`;
    const sendResult = await call(writer, "send_message", {
      conversationId: conversationIdW,
      text: marker,
    });
    const sent = resultJson<{ contentText: string; status: string }>(sendResult);
    check(
      "MCP_ALLOW_WRITES=1: send_message terkirim (queued/sent)",
      !sendResult.isError &&
        !!sent &&
        sent.contentText === marker &&
        (sent.status === "queued" || sent.status === "sent"),
      sent ? `status=${sent.status}` : resultText(sendResult),
    );

    const afterResult = await call(writer, "list_messages", {
      conversationId: conversationIdW,
      limit: 50,
    });
    const after = resultJson<{ messages: Array<{ contentText: string | null }> }>(afterResult);
    check(
      "pesan MCP terbaca kembali via list_messages",
      !!after && after.messages.some((m) => m.contentText === marker),
    );
  }
} finally {
  await writer.close();
}

// --- Uji negatif scope: kunci read-only tidak boleh menulis -----------------
// Sesi ini berjalan dengan MCP_ALLOW_WRITES=1 agar permintaan LOLOS tier
// MCP dan benar-benar diuji di lapisan scope API (lapisan independen).
if (!limitedKey) {
  skip("uji negatif scope", "SAHABAT_KREATOR_API_KEY_LIMITED tidak diisi");
} else {
  const limited = await connect(limitedKey, true);
  try {
    const tools = await limited.listTools();
    check(
      "kunci terbatas: tools/list tetap jalan",
      tools.tools.length === EXPECTED_TOOLS.length,
    );

    const conversationId =
      testConversationId ??
      resultJson<{ conversations: Array<{ id: string }> }>(
        await call(limited, "list_conversations"),
      )?.conversations[0]?.id;
    if (!conversationId) {
      skip("kunci terbatas: send_message ditolak", "tidak ada percakapan uji");
    } else {
      const denied = await call(limited, "send_message", {
        conversationId,
        text: "pesan ini tidak boleh terkirim",
      });
      check(
        "kunci tanpa messages:write → tool error API_KEY_SCOPE_DENIED (bukan crash)",
        denied.isError === true &&
          resultText(denied).includes("API_KEY_SCOPE_DENIED"),
        resultText(denied).slice(0, 120),
      );
    }

    const deniedCreate = await call(limited, "create_contact", {
      name: "Tidak Boleh Terbentuk",
    });
    check(
      "kunci tanpa contacts:write → tool error API_KEY_SCOPE_DENIED",
      deniedCreate.isError === true &&
        resultText(deniedCreate).includes("API_KEY_SCOPE_DENIED"),
    );
  } finally {
    await limited.close();
  }
}

console.log(failures === 0 ? "\nSEMUA LULUS" : `\n${failures} KEGAGALAN`);
process.exit(failures === 0 ? 0 : 1);
