/**
 * Verifikasi GELOMBANG G13 — pelengkap Wacrm (butir 4–11 yang dibangun).
 * Di atas PGlite + server Graph/Telegram tiruan lokal. Yang dibuktikan:
 *
 *  [1] Katalog penerjemah error (kontrak, murni): kode Meta/Telegram/
 *      lokal terpetakan ke kunci i18n yang benar; kode asing → generik
 *      jujur per keluarga; string kosong → unknown.
 *  [2] Parser webhook WhatsApp: pesan `reaction` menjadi peristiwa
 *      reactions (bukan pesan), status failed membawa errorTitle +
 *      errorDetails dari errors[0].
 *  [3] Klien WhatsApp: getPhoneNumberHealth memetakan field Graph
 *      (throughput objek → level; field absen → null jujur); error
 *      Graph membawa graphCode + subcode + fbtraceId; sendReaction
 *      membentuk payload type:"reaction" yang benar.
 *  [4] Checklist Dashboard (core): langkah menyala satu per satu dari
 *      data nyata (channel → agent → conversation → automation →
 *      team), allDone hanya saat semua beres.
 *  [5] KPI waktu balas (core): median manusia vs AI per definisi
 *      (inbound → outbound PERTAMA sesudahnya, kelas dari pengirim
 *      outbound), periode berjalan vs sebelumnya; inbound tanpa
 *      balasan tidak menyumbang sampel.
 *  [6] Kehadiran tim (core): heartbeat pertama menulis last_seen_at,
 *      heartbeat di dalam jendela jinakkan TIDAK menulis ulang, lewat
 *      jendela menulis lagi; listTeamMembers mengekspos lastSeenAt.
 *  [7] Detail error pesan gagal (core): markOutboundMessageFailed
 *      menyimpan error_detail (deskripsi terpotong 500), tanpa argumen
 *      detail kolom tak tersentuh; jalur status WhatsApp menulis
 *      error_detail + kode meta_graph_<n> dari webhook.
 *  [8] Reaksi (core): satu reaksi aktif per aktor (ganti, bukan
 *      menumpuk), cabut bersih, ringkasan mine/byContact benar;
 *      reaksi kontak masuk tercatat pada target provider_message_id;
 *      target tak dikenal → target_not_found.
 *  [9] Reaksi (HTTP): provider tanpa API reaksi (messenger) → 422
 *      REACTION_NOT_SUPPORTED tanpa baris tersimpan; WhatsApp →
 *      panggilan Graph reaction terkirim DULU baru tersimpan;
 *      Telegram → setMessageReaction terpanggil dengan payload benar.
 * [10] Kesehatan nomor (HTTP): akun WhatsApp terhubung → available
 *      true + field Graph; akun non-WhatsApp → available false
 *      not_whatsapp (bukan error HTTP).
 *
 * Butir 1–3 audit (lencana AI, panel gagal, quote-reply) TERBUKTI ADA
 * dari fase sebelumnya dan tidak dibangun ulang di gelombang ini;
 * butir 4 (banner) + 10 (perekam suara) adalah permukaan web murni di
 * atas mekanisme yang dibuktikan di sini ([8]/[9] untuk reaksi).
 *
 * Jalankan: pnpm --filter @sahabat-kreator/api verify:wacrm-extras
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import * as schema from "@sahabat-kreator/db/schema";
import type { Database } from "@sahabat-kreator/db";
import {
  messageErrorI18nKey,
  parseMessageErrorCode,
  PROVIDER_REACTION_SUPPORTED,
} from "@sahabat-kreator/contracts";
import {
  applyUserReaction,
  applyWhatsAppMessageStatus,
  encryptChannelSecret,
  getDashboardSummary,
  getReplyTimeReport,
  listTeamMembers,
  markOutboundMessageFailed,
  medianSeconds,
  recordContactReaction,
  summarizeMessageReactions,
  touchUserPresence,
} from "@sahabat-kreator/core";
import {
  parseWhatsAppWebhookEvents,
  WhatsAppCloudClient,
  WhatsAppGraphError,
} from "@sahabat-kreator/channel-whatsapp";
import type { AuthBundle } from "../src/auth";
import type { AppVariables } from "../src/http";
import { createChannelsRoutes } from "../src/modules/channels/routes";
import { createInboxRoutes } from "../src/modules/inbox/routes";

let passes = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) passes += 1;
  else process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Server tiruan Graph + Telegram: mencatat panggilan; mode error Graph
// bisa dinyalakan untuk membuktikan fbtrace/subcode.
// ---------------------------------------------------------------------------
interface RecordedCall {
  method: string;
  url: string;
  body: unknown;
}
const calls: RecordedCall[] = [];
let graphErrorMode = false;

const mockServer: Server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c as Buffer));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    const url = req.url ?? "";
    calls.push({ method: req.method ?? "", url, body });
    res.setHeader("content-type", "application/json");
    if (url.includes("/setMessageReaction")) {
      res.end(JSON.stringify({ ok: true, result: true }));
      return;
    }
    if (graphErrorMode) {
      res.statusCode = 400;
      res.end(
        JSON.stringify({
          error: {
            message: "(#131047) Re-engagement message",
            type: "OAuthException",
            code: 131047,
            error_subcode: 2494071,
            fbtrace_id: "TRACE-UJI-1",
          },
        }),
      );
      return;
    }
    if (req.method === "GET" && url.includes("PNID-SEPI")) {
      // Nomor tanpa riwayat: Meta hanya mengembalikan sebagian field.
      res.end(JSON.stringify({ id: "PNID-SEPI", quality_rating: "YELLOW" }));
      return;
    }
    if (req.method === "GET" && url.includes("fields=quality_rating")) {
      res.end(
        JSON.stringify({
          id: "PNID-UJI",
          quality_rating: "GREEN",
          messaging_limit_tier: "TIER_1000",
          throughput: { level: "STANDARD" },
          name_status: "APPROVED",
          code_verification_status: "VERIFIED",
        }),
      );
      return;
    }
    if (req.method === "POST" && url.includes("/messages")) {
      res.end(JSON.stringify({ messages: [{ id: "wamid.BARU" }] }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { message: "unknown" } }));
  });
});
await new Promise<void>((resolve) =>
  mockServer.listen(0, "127.0.0.1", () => resolve()),
);
const mockAddr = mockServer.address();
assert(mockAddr && typeof mockAddr === "object");
const mockBase = `http://127.0.0.1:${mockAddr.port}`;

// ---------------------------------------------------------------------------
// [1] Katalog penerjemah error (murni)
// ---------------------------------------------------------------------------
{
  check(
    "[1] parse meta_graph_131047",
    parseMessageErrorCode("meta_graph_131047")?.family === "meta" &&
      parseMessageErrorCode("meta_graph_131047")?.graphCode === 131047,
  );
  check(
    "[1] meta_graph_131047 (jendela 24 jam) → windowExpired",
    messageErrorI18nKey("meta_graph_131047") ===
      "messageErrors.meta.windowExpired",
  );
  check(
    "[1] meta_graph_131031 → accountLocked",
    messageErrorI18nKey("meta_graph_131031") ===
      "messageErrors.meta.accountLocked",
  );
  check(
    "[1] graph_190 (jalur Messenger) → tokenInvalid",
    messageErrorI18nKey("graph_190") === "messageErrors.meta.tokenInvalid",
  );
  check(
    "[1] meta_graph_130429 → rateLimit",
    messageErrorI18nKey("meta_graph_130429") ===
      "messageErrors.meta.rateLimit",
  );
  check(
    "[1] meta_graph_131056 → pairRateLimit",
    messageErrorI18nKey("meta_graph_131056") ===
      "messageErrors.meta.pairRateLimit",
  );
  check(
    "[1] kode Meta asing → generic jujur",
    messageErrorI18nKey("meta_graph_999999") === "messageErrors.meta.generic",
  );
  check(
    "[1] telegram_http_403 → telegram.blocked",
    messageErrorI18nKey("telegram_http_403") ===
      "messageErrors.telegram.blocked",
  );
  check(
    "[1] telegram_http_400 → telegram.badRequest",
    messageErrorI18nKey("telegram_http_400") ===
      "messageErrors.telegram.badRequest",
  );
  check(
    "[1] whatsapp_empty_text (lokal) → local.emptyText",
    messageErrorI18nKey("whatsapp_empty_text") ===
      "messageErrors.local.emptyText",
  );
  check(
    "[1] network_error → network",
    messageErrorI18nKey("network_error") === "messageErrors.network",
  );
  check(
    "[1] kode asing → unknown; kode kosong → null",
    messageErrorI18nKey("kode_aneh") === "messageErrors.unknown" &&
      messageErrorI18nKey("") === null &&
      messageErrorI18nKey(null) === null,
  );
  check(
    "[1] peta kemampuan reaksi: WA+Telegram saja",
    PROVIDER_REACTION_SUPPORTED["whatsapp"] === true &&
      PROVIDER_REACTION_SUPPORTED["telegram"] === true &&
      PROVIDER_REACTION_SUPPORTED["messenger"] === false &&
      PROVIDER_REACTION_SUPPORTED["instagram"] === false &&
      PROVIDER_REACTION_SUPPORTED["webchat"] === false &&
      PROVIDER_REACTION_SUPPORTED["threads"] === false,
  );
}

// ---------------------------------------------------------------------------
// [2] Parser webhook WhatsApp — reaksi + detail status
// ---------------------------------------------------------------------------
{
  const events = parseWhatsAppWebhookEvents({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA-UJI",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "62812000999",
                phone_number_id: "PNID-UJI",
              },
              messages: [
                {
                  from: "628111222333",
                  id: "wamid.REAKSI1",
                  timestamp: "1730000000",
                  type: "reaction",
                  reaction: { message_id: "wamid.ASAL", emoji: "❤️" },
                },
                {
                  from: "628111222333",
                  id: "wamid.TEKS1",
                  timestamp: "1730000001",
                  type: "text",
                  text: { body: "halo" },
                },
              ],
              statuses: [
                {
                  id: "wamid.KELUAR1",
                  status: "failed",
                  timestamp: "1730000002",
                  recipient_id: "628111222333",
                  errors: [
                    {
                      code: 131047,
                      title: "Re-engagement message",
                      message: "Re-engagement message",
                      error_data: {
                        details:
                          "Message failed to send because more than 24 hours have passed",
                      },
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    ],
  });
  check(
    "[2] reaksi menjadi peristiwa reactions, BUKAN pesan",
    events.reactions.length === 1 && events.messages.length === 1,
    `reactions=${events.reactions.length} messages=${events.messages.length}`,
  );
  check(
    "[2] peristiwa reaksi membawa target + emoji + pengirim",
    events.reactions[0]?.targetMessageId === "wamid.ASAL" &&
      events.reactions[0]?.emoji === "❤️" &&
      events.reactions[0]?.senderWaId === "628111222333",
  );
  check(
    "[2] status failed membawa errorTitle + errorDetails",
    events.statuses[0]?.errorTitle === "Re-engagement message" &&
      (events.statuses[0]?.errorDetails ?? "").includes("24 hours"),
    events.statuses[0]?.errorDetails ?? "",
  );
}

// ---------------------------------------------------------------------------
// [3] Klien WhatsApp — health + error Graph + sendReaction
// ---------------------------------------------------------------------------
{
  const client = new WhatsAppCloudClient({
    baseUrl: mockBase,
    apiVersion: "v26.0",
    accessToken: "token-uji",
  });
  const health = await client.getPhoneNumberHealth("PNID-UJI");
  check(
    "[3] health: field Graph terpetakan (throughput objek → level)",
    health.qualityRating === "GREEN" &&
      health.messagingLimitTier === "TIER_1000" &&
      health.throughputLevel === "STANDARD" &&
      health.nameStatus === "APPROVED" &&
      health.codeVerificationStatus === "VERIFIED",
  );
  const sparse = await client.getPhoneNumberHealth("PNID-SEPI");
  check(
    "[3] health: field absen → null jujur, bukan karangan",
    sparse.qualityRating === "YELLOW" &&
      sparse.messagingLimitTier === null &&
      sparse.throughputLevel === null &&
      sparse.nameStatus === null,
  );

  graphErrorMode = true;
  let caught: unknown = null;
  try {
    await client.getPhoneNumberHealth("PNID-UJI");
  } catch (err) {
    caught = err;
  } finally {
    graphErrorMode = false;
  }
  check(
    "[3] error Graph membawa code + subcode + fbtraceId",
    caught instanceof WhatsAppGraphError &&
      caught.graphCode === 131047 &&
      caught.graphSubcode === 2494071 &&
      caught.fbtraceId === "TRACE-UJI-1",
    caught instanceof WhatsAppGraphError ? caught.fbtraceId ?? "" : "",
  );

  calls.length = 0;
  await client.sendReaction({
    phoneNumberId: "PNID-UJI",
    to: "628111222333",
    messageId: "wamid.ASAL",
    emoji: "👍",
  });
  const reactionCall = calls.find((c) => c.url.includes("/messages"));
  const reactionBody = reactionCall?.body as {
    type?: string;
    reaction?: { message_id?: string; emoji?: string };
  } | null;
  check(
    "[3] sendReaction: payload type reaction + message_id + emoji",
    reactionBody?.type === "reaction" &&
      reactionBody?.reaction?.message_id === "wamid.ASAL" &&
      reactionBody?.reaction?.emoji === "👍",
  );
}

// ---------------------------------------------------------------------------
// DB uji (PGlite + semua migrasi, termasuk 0036)
// ---------------------------------------------------------------------------
const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, "../../../packages/db/migrations");
const client = new PGlite({ extensions: { vector, btree_gist } });
const files = (await readdir(migrationsDir))
  .filter((f) => f.endsWith(".sql"))
  .sort();
for (const file of files) {
  const sqlText = await readFile(path.join(migrationsDir, file), "utf8");
  await client.exec(sqlText.replaceAll("--> statement-breakpoint", ""));
}
console.log(`[setup] migrasi teraplikasi: ${files.length} file`);
const db = drizzle(client, { schema }) as unknown as Database;

const TENANT = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WA_ACC = "31000000-0000-4000-8000-000000000001";
const TG_ACC = "31000000-0000-4000-8000-000000000002";
const MSG_ACC = "31000000-0000-4000-8000-000000000003";
const TOKEN_SECRET = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";

await client.query(
  `INSERT INTO tenants (id, name, slug) VALUES ($1, 'Tenant A', 'tenant-a'), ($2, 'Tenant B', 'tenant-b')`,
  [TENANT, TENANT_B],
);
await client.query(
  `INSERT INTO users (id, email, name) VALUES ($1, 'owner@sk.test', 'Pemilik'), ($2, 'member@sk.test', 'Anggota')`,
  [OWNER, MEMBER],
);
// Tenant A: owner + member (langkah team beres dari awal di A).
// Tenant B: owner sendirian (langkah team BELUM beres di B).
await client.query(
  `INSERT INTO tenant_members (tenant_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'agent'), ($4, $2, 'owner')`,
  [TENANT, OWNER, MEMBER, TENANT_B],
);

// ---------------------------------------------------------------------------
// [4] Checklist Dashboard — menyala dari data nyata
// ---------------------------------------------------------------------------
{
  const stepOf = (
    s: Awaited<ReturnType<typeof getDashboardSummary>>,
    key: string,
  ) => s.setup.steps.find((x) => x.key === key)?.done;

  let summary = await getDashboardSummary(db, { tenantId: TENANT_B });
  check(
    "[4] tenant kosong: semua langkah mati kecuali tak ada, allDone=false",
    summary.setup.allDone === false &&
      stepOf(summary, "channel") === false &&
      stepOf(summary, "agent") === false &&
      stepOf(summary, "conversation") === false &&
      stepOf(summary, "automation") === false &&
      stepOf(summary, "team") === false &&
      summary.setup.completedCount === 0 &&
      summary.setup.totalCount === 5,
  );

  await client.query(
    `INSERT INTO channel_accounts (id, tenant_id, provider, external_id, display_name, status, access_token_encrypted)
     VALUES ($1, $2, 'whatsapp', 'PNID-UJI', 'WA Uji', 'connected', $3)`,
    ["31000000-0000-4000-8000-0000000000b1", TENANT_B, encryptChannelSecret(TOKEN_SECRET, "token-uji")],
  );
  summary = await getDashboardSummary(db, { tenantId: TENANT_B });
  check(
    "[4] channel terhubung → langkah channel menyala",
    stepOf(summary, "channel") === true && summary.setup.completedCount === 1,
  );

  await client.query(
    `INSERT INTO agents (tenant_id, name) VALUES ($1, 'Agen Uji')`,
    [TENANT_B],
  );
  await client.query(
    `INSERT INTO automations (tenant_id, name) VALUES ($1, 'Otomasi Uji')`,
    [TENANT_B],
  );
  summary = await getDashboardSummary(db, { tenantId: TENANT_B });
  check(
    "[4] agent + automation dibuat → kedua langkah menyala",
    stepOf(summary, "agent") === true && stepOf(summary, "automation") === true,
  );

  const CONTACT_B = "51000000-0000-4000-8000-000000000001";
  const CONV_B = "41000000-0000-4000-8000-000000000001";
  await client.query(
    `INSERT INTO contacts (id, tenant_id, name) VALUES ($1, $2, 'Pelanggan B')`,
    [CONTACT_B, TENANT_B],
  );
  await client.query(
    `INSERT INTO conversations (id, tenant_id, channel_account_id, contact_id, provider)
     VALUES ($1, $2, $3, $4, 'whatsapp')`,
    [CONV_B, TENANT_B, "31000000-0000-4000-8000-0000000000b1", CONTACT_B],
  );
  summary = await getDashboardSummary(db, { tenantId: TENANT_B });
  check(
    "[4] percakapan pertama → langkah conversation menyala",
    stepOf(summary, "conversation") === true,
  );

  await client.query(
    `INSERT INTO tenant_members (tenant_id, user_id, role) VALUES ($1, $2, 'agent')`,
    [TENANT_B, MEMBER],
  );
  summary = await getDashboardSummary(db, { tenantId: TENANT_B });
  check(
    "[4] member kedua bergabung → team menyala + allDone=true",
    stepOf(summary, "team") === true &&
      summary.setup.allDone === true &&
      summary.setup.completedCount === 5,
  );
}

// ---------------------------------------------------------------------------
// Benih percakapan + pesan tenant A untuk [5], [7], [8], [9]
// ---------------------------------------------------------------------------
const CONTACT = "51000000-0000-4000-8000-000000000101";
const CONV_WA = "41000000-0000-4000-8000-000000000101";
const CONV_TG = "41000000-0000-4000-8000-000000000102";
const CONV_MSG = "41000000-0000-4000-8000-000000000103";
await client.query(
  `INSERT INTO channel_accounts (id, tenant_id, provider, external_id, display_name, status, access_token_encrypted)
   VALUES ($1, $2, 'whatsapp', 'PNID-UJI-A', 'WA Uji', 'connected', $3),
          ($4, $2, 'telegram', '424242', 'TG Uji', 'connected', $3),
          ($5, $2, 'messenger', 'PAGE-UJI', 'MSG Uji', 'connected', $3)`,
  [
    WA_ACC,
    TENANT,
    encryptChannelSecret(TOKEN_SECRET, "token-uji"),
    TG_ACC,
    MSG_ACC,
  ],
);
await client.query(
  `INSERT INTO contacts (id, tenant_id, name) VALUES ($1, $2, 'Pelanggan A')`,
  [CONTACT, TENANT],
);
await client.query(
  `INSERT INTO conversations (id, tenant_id, channel_account_id, contact_id, provider, provider_chat_id)
   VALUES ($1, $3, $4, $5, 'whatsapp', NULL),
          ($2, $3, $6, $5, 'telegram', '4242'),
          ($7, $3, $8, $5, 'messenger', 'psid-1')`,
  [CONV_WA, CONV_TG, TENANT, WA_ACC, CONTACT, TG_ACC, CONV_MSG, MSG_ACC],
);
await client.query(
  `INSERT INTO channel_identities (tenant_id, contact_id, channel_account_id, provider, external_user_id)
   VALUES ($1, $2, $3, 'whatsapp', '628111222333'),
          ($1, $2, $4, 'telegram', '4242'),
          ($1, $2, $5, 'messenger', 'psid-1')`,
  [TENANT, CONTACT, WA_ACC, TG_ACC, MSG_ACC],
);

async function insertMessage(input: {
  id: string;
  conversationId: string;
  direction: "inbound" | "outbound";
  senderType: "contact" | "user" | "agent" | "system";
  createdAt: string;
  status?: string;
  providerMessageId?: string;
}): Promise<void> {
  await client.query(
    `INSERT INTO messages (id, tenant_id, conversation_id, direction, sender_type, type, status, content_text, provider_message_id, created_at)
     VALUES ($1, $2, $3, $4, $5, 'text', $6, 'isi uji', $7, $8)`,
    [
      input.id,
      TENANT,
      input.conversationId,
      input.direction,
      input.senderType,
      input.status ?? "sent",
      input.providerMessageId ?? null,
      input.createdAt,
    ],
  );
}

// ---------------------------------------------------------------------------
// [5] KPI waktu balas — median per kelas pengirim, dua periode
// ---------------------------------------------------------------------------
{
  const NOW = new Date("2026-11-13T12:00:00.000Z");
  const iso = (d: Date) => d.toISOString();
  const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
  // Periode berjalan (30 hari): inbound → balasan manusia 120 dtk.
  await insertMessage({ id: "61000000-0000-4000-8000-000000000001", conversationId: CONV_WA, direction: "inbound", senderType: "contact", createdAt: iso(minsAgo(60)) });
  await insertMessage({ id: "61000000-0000-4000-8000-000000000002", conversationId: CONV_WA, direction: "outbound", senderType: "user", createdAt: iso(new Date(minsAgo(60).getTime() + 120_000)) });
  // Inbound → balasan AI 30 dtk; outbound KEDUA manusia sesudahnya
  // TIDAK boleh mengubah atribusi (yang dihitung balasan PERTAMA).
  await insertMessage({ id: "61000000-0000-4000-8000-000000000003", conversationId: CONV_WA, direction: "inbound", senderType: "contact", createdAt: iso(minsAgo(50)) });
  await insertMessage({ id: "61000000-0000-4000-8000-000000000004", conversationId: CONV_WA, direction: "outbound", senderType: "agent", createdAt: iso(new Date(minsAgo(50).getTime() + 30_000)) });
  await insertMessage({ id: "61000000-0000-4000-8000-000000000005", conversationId: CONV_WA, direction: "outbound", senderType: "user", createdAt: iso(new Date(minsAgo(50).getTime() + 900_000)) });
  // Inbound tanpa balasan (paling akhir, sesudah semua outbound):
  // tidak menyumbang sampel apa pun.
  await insertMessage({ id: "61000000-0000-4000-8000-000000000006", conversationId: CONV_WA, direction: "inbound", senderType: "contact", createdAt: iso(minsAgo(10)) });
  // Periode sebelumnya (40 hari lalu): inbound → manusia 600 dtk.
  await insertMessage({ id: "61000000-0000-4000-8000-000000000007", conversationId: CONV_WA, direction: "inbound", senderType: "contact", createdAt: iso(minsAgo(40 * 24 * 60)) });
  await insertMessage({ id: "61000000-0000-4000-8000-000000000008", conversationId: CONV_WA, direction: "outbound", senderType: "user", createdAt: iso(new Date(minsAgo(40 * 24 * 60).getTime() + 600_000)) });

  const report = await getReplyTimeReport(db, { tenantId: TENANT }, { days: 30, now: NOW });
  check(
    "[5] median manusia periode berjalan = 120 dtk, 1 sampel",
    report.human.current.medianSeconds === 120 && report.human.current.samples === 1,
    JSON.stringify(report.human.current),
  );
  check(
    "[5] median AI periode berjalan = 30 dtk (balasan PERTAMA yang dihitung)",
    report.agent.current.medianSeconds === 30 && report.agent.current.samples === 1,
    JSON.stringify(report.agent.current),
  );
  check(
    "[5] periode sebelumnya: manusia 600 dtk; AI tanpa sampel → median null",
    report.human.previous.medianSeconds === 600 &&
      report.agent.previous.medianSeconds === null &&
      report.agent.previous.samples === 0,
  );
  check(
    "[5] medianSeconds murni: ganjil/genap/kosong",
    medianSeconds([5]) === 5 && medianSeconds([10, 20]) === 15 && medianSeconds([]) === null,
  );
}

// ---------------------------------------------------------------------------
// [6] Kehadiran tim — jinakkan heartbeat
// ---------------------------------------------------------------------------
{
  const t0 = new Date("2026-11-13T12:00:00.000Z");
  await touchUserPresence(db, OWNER, t0);
  let rows = await listTeamMembers(db, { tenantId: TENANT });
  const owner1 = rows.find((m) => m.userId === OWNER);
  check(
    "[6] heartbeat pertama menulis lastSeenAt",
    owner1?.lastSeenAt?.toISOString() === t0.toISOString(),
    owner1?.lastSeenAt?.toISOString() ?? "null",
  );
  await touchUserPresence(db, OWNER, new Date(t0.getTime() + 10_000));
  rows = await listTeamMembers(db, { tenantId: TENANT });
  check(
    "[6] heartbeat +10 dtk di dalam jendela jinakkan → TIDAK menulis ulang",
    rows.find((m) => m.userId === OWNER)?.lastSeenAt?.toISOString() ===
      t0.toISOString(),
  );
  const t1 = new Date(t0.getTime() + 60_000);
  await touchUserPresence(db, OWNER, t1);
  rows = await listTeamMembers(db, { tenantId: TENANT });
  check(
    "[6] heartbeat +60 dtk (lewat jendela) → lastSeenAt maju",
    rows.find((m) => m.userId === OWNER)?.lastSeenAt?.toISOString() ===
      t1.toISOString(),
  );
  check(
    "[6] member tanpa heartbeat → lastSeenAt null (belum pernah terlihat)",
    rows.find((m) => m.userId === MEMBER)?.lastSeenAt === null,
  );
}

// ---------------------------------------------------------------------------
// [7] error_detail pesan gagal — core + jalur status WhatsApp
// ---------------------------------------------------------------------------
{
  const MSG_FAIL_1 = "61000000-0000-4000-8000-000000000101";
  await insertMessage({ id: MSG_FAIL_1, conversationId: CONV_WA, direction: "outbound", senderType: "user", createdAt: "2026-11-13T11:00:00.000Z", status: "queued" });
  const longDescription = "x".repeat(600);
  const updated = await markOutboundMessageFailed(
    db,
    { tenantId: TENANT },
    MSG_FAIL_1,
    "meta-poller",
    "meta_graph_131047",
    { description: longDescription, subcode: 2494071, fbtraceId: "TRACE-UJI-1" },
  );
  check(
    "[7] markOutboundMessageFailed menyimpan error_detail (deskripsi terpotong 500)",
    updated?.status === "failed" &&
      updated?.errorCode === "meta_graph_131047" &&
      updated?.errorDetail?.description?.length === 500 &&
      updated?.errorDetail?.subcode === 2494071 &&
      updated?.errorDetail?.fbtraceId === "TRACE-UJI-1",
  );

  const MSG_FAIL_2 = "61000000-0000-4000-8000-000000000102";
  await insertMessage({ id: MSG_FAIL_2, conversationId: CONV_WA, direction: "outbound", senderType: "user", createdAt: "2026-11-13T11:01:00.000Z", status: "queued" });
  const updated2 = await markOutboundMessageFailed(
    db,
    { tenantId: TENANT },
    MSG_FAIL_2,
    "telegram-poller",
    "telegram_http_403",
  );
  check(
    "[7] tanpa argumen detail → error_detail tetap null (tak tersentuh)",
    updated2?.status === "failed" && updated2?.errorDetail === null,
  );

  // Jalur webhook status WhatsApp: pesan terkirim lalu Meta lapor gagal.
  const MSG_WA_STATUS = "61000000-0000-4000-8000-000000000103";
  await insertMessage({
    id: MSG_WA_STATUS,
    conversationId: CONV_WA,
    direction: "outbound",
    senderType: "user",
    createdAt: "2026-11-13T11:02:00.000Z",
    status: "sent",
    providerMessageId: "meta:PNID-UJI-A:wamid.KELUAR1",
  });
  await applyWhatsAppMessageStatus(
    db,
    { id: WA_ACC, tenantId: TENANT, externalId: "PNID-UJI-A" },
    {
      providerMessageId: "wamid.KELUAR1",
      status: "failed",
      graphErrorCode: 131047,
      errorTitle: "Re-engagement message",
      errorDetails: "More than 24 hours have passed",
    },
  );
  const row = await client.query<{ status: string; error_code: string | null; error_detail: { description?: string } | null }>(
    `SELECT status, error_code, error_detail FROM messages WHERE id = $1`,
    [MSG_WA_STATUS],
  );
  check(
    "[7] status webhook failed → kode meta_graph_131047 + error_detail dari errors[0]",
    row.rows[0]?.status === "failed" &&
      row.rows[0]?.error_code === "meta_graph_131047" &&
      (row.rows[0]?.error_detail?.description ?? "").includes("24 hours"),
    JSON.stringify(row.rows[0]),
  );
}

// ---------------------------------------------------------------------------
// [8] Reaksi — core
// ---------------------------------------------------------------------------
const MSG_IN_WA = "61000000-0000-4000-8000-000000000201";
{
  await insertMessage({
    id: MSG_IN_WA,
    conversationId: CONV_WA,
    direction: "inbound",
    senderType: "contact",
    createdAt: "2026-11-13T11:10:00.000Z",
    providerMessageId: "wamid.MASUK1",
  });

  const first = await applyUserReaction(
    db,
    { tenantId: TENANT, userId: OWNER },
    { messageId: MSG_IN_WA, emoji: "👍" },
  );
  check(
    "[8] reaksi pertama tersimpan + ringkasan mine",
    first.kind === "ok" &&
      first.reactions.length === 1 &&
      first.reactions[0]?.emoji === "👍" &&
      first.reactions[0]?.mine === true &&
      first.reactions[0]?.byTeam === true,
  );
  const replaced = await applyUserReaction(
    db,
    { tenantId: TENANT, userId: OWNER },
    { messageId: MSG_IN_WA, emoji: "❤️" },
  );
  check(
    "[8] reaksi kedua dari aktor sama MENGGANTI (satu aktif per aktor)",
    replaced.kind === "ok" &&
      replaced.reactions.length === 1 &&
      replaced.reactions[0]?.emoji === "❤️",
  );

  const contactResult = await recordContactReaction(
    db,
    { tenantId: TENANT },
    { targetProviderMessageId: "wamid.MASUK1", senderExternalId: "628111222333", emoji: "😂" },
  );
  check("[8] reaksi kontak masuk tercatat", contactResult.kind === "ok");
  const summaries = await summarizeMessageReactions(
    db,
    { tenantId: TENANT },
    [MSG_IN_WA],
    OWNER,
  );
  const forMsg = summaries.get(MSG_IN_WA) ?? [];
  check(
    "[8] ringkasan gabungan: reaksi tim + kontak terpisah benar",
    forMsg.length === 2 &&
      forMsg.some((r) => r.emoji === "❤️" && r.mine && r.byTeam) &&
      forMsg.some((r) => r.emoji === "😂" && r.byContact && !r.mine),
    JSON.stringify(forMsg),
  );

  const removed = await recordContactReaction(
    db,
    { tenantId: TENANT },
    { targetProviderMessageId: "wamid.MASUK1", senderExternalId: "628111222333", emoji: "" },
  );
  const afterRemoval = await summarizeMessageReactions(
    db,
    { tenantId: TENANT },
    [MSG_IN_WA],
    OWNER,
  );
  check(
    "[8] emoji kosong dari kontak = cabut reaksinya",
    removed.kind === "ok" &&
      (afterRemoval.get(MSG_IN_WA) ?? []).every((r) => r.emoji !== "😂"),
  );

  const unknown = await recordContactReaction(
    db,
    { tenantId: TENANT },
    { targetProviderMessageId: "wamid.TIDAK-ADA", senderExternalId: "628111222333", emoji: "👍" },
  );
  check(
    "[8] target tak dikenal → target_not_found (tak ada baris karangan)",
    unknown.kind === "target_not_found",
  );

  const cleared = await applyUserReaction(
    db,
    { tenantId: TENANT, userId: OWNER },
    { messageId: MSG_IN_WA, emoji: null },
  );
  check(
    "[8] emoji null = cabut reaksi saya sampai bersih",
    cleared.kind === "ok" && cleared.reactions.length === 0,
  );
}

// ---------------------------------------------------------------------------
// [9] Reaksi HTTP + [10] kesehatan nomor HTTP
// ---------------------------------------------------------------------------
const MSG_IN_TG = "61000000-0000-4000-8000-000000000202";
const MSG_IN_MSG = "61000000-0000-4000-8000-000000000203";
await insertMessage({
  id: MSG_IN_TG,
  conversationId: CONV_TG,
  direction: "inbound",
  senderType: "contact",
  createdAt: "2026-11-13T11:20:00.000Z",
  providerMessageId: "777",
});
await insertMessage({
  id: MSG_IN_MSG,
  conversationId: CONV_MSG,
  direction: "inbound",
  senderType: "contact",
  createdAt: "2026-11-13T11:21:00.000Z",
  providerMessageId: "mid.123",
});

const bundle = { db } as unknown as AuthBundle;
function testApp(): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("appUser", { id: OWNER } as unknown as AppVariables["appUser"]);
    await next();
  });
  app.route(
    "/api",
    createInboxRoutes(bundle, null, undefined, {
      channelTokenSecret: TOKEN_SECRET,
      metaApiBase: mockBase,
      telegramApiBase: mockBase,
    }),
  );
  app.route(
    "/api",
    createChannelsRoutes(bundle, {
      channelTokenSecret: TOKEN_SECRET,
      metaApiBase: mockBase,
    }),
  );
  return app;
}
const app = testApp();

async function reactionPost(
  conversationId: string,
  messageId: string,
  emoji: string | null,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.request(
    `/api/tenants/${TENANT}/conversations/${conversationId}/messages/${messageId}/reaction`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ emoji }),
    },
  );
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
  };
}

{
  // Messenger: tidak ada API reaksi bisnis → 422 + tidak ada baris.
  const before = await client.query(
    `SELECT count(*)::int AS n FROM message_reactions WHERE message_id = $1`,
    [MSG_IN_MSG],
  );
  const res = await reactionPost(CONV_MSG, MSG_IN_MSG, "👍");
  const errBody = res.json as { error?: { code?: string } };
  const after = await client.query(
    `SELECT count(*)::int AS n FROM message_reactions WHERE message_id = $1`,
    [MSG_IN_MSG],
  );
  check(
    "[9] messenger → 422 REACTION_NOT_SUPPORTED, nol baris tersimpan",
    res.status === 422 &&
      errBody.error?.code === "REACTION_NOT_SUPPORTED" &&
      before.rows[0]?.n === 0 &&
      after.rows[0]?.n === 0,
    `status=${res.status} code=${errBody.error?.code ?? ""}`,
  );

  // WhatsApp: Graph reaction terkirim, lalu ringkasan tersimpan.
  calls.length = 0;
  const wa = await reactionPost(CONV_WA, MSG_IN_WA, "👍");
  const waBody = wa.json as {
    reactions?: Array<{ emoji: string; mine: boolean }>;
  };
  const sendCall = calls.find(
    (c) => c.method === "POST" && c.url.includes("/messages"),
  );
  const sendBody = sendCall?.body as {
    type?: string;
    to?: string;
    reaction?: { message_id?: string; emoji?: string };
  } | null;
  check(
    "[9] WhatsApp → 200; Graph menerima reaction ke wamid + wa_id kontak",
    wa.status === 200 &&
      sendBody?.type === "reaction" &&
      sendBody?.to === "628111222333" &&
      sendBody?.reaction?.message_id === "wamid.MASUK1" &&
      sendBody?.reaction?.emoji === "👍",
    `status=${wa.status}`,
  );
  check(
    "[9] WhatsApp → ringkasan respons memuat reaksi saya",
    (waBody.reactions ?? []).some((r) => r.emoji === "👍" && r.mine),
  );

  // Klik emoji yang sama lagi = cabut (semantik toggle di endpoint).
  const waOff = await reactionPost(CONV_WA, MSG_IN_WA, "👍");
  const offBody = waOff.json as { reactions?: unknown[] };
  const stored = await client.query(
    `SELECT count(*)::int AS n FROM message_reactions WHERE message_id = $1`,
    [MSG_IN_WA],
  );
  check(
    "[9] emoji sama diklik lagi → reaksi tercabut (respons + DB kosong)",
    waOff.status === 200 &&
      (offBody.reactions ?? []).length === 0 &&
      stored.rows[0]?.n === 0,
  );

  // Telegram: setMessageReaction dengan chat_id percakapan + id numerik.
  calls.length = 0;
  const tg = await reactionPost(CONV_TG, MSG_IN_TG, "❤️");
  const tgCall = calls.find((c) => c.url.includes("/setMessageReaction"));
  const tgBody = tgCall?.body as {
    chat_id?: string;
    message_id?: number;
    reaction?: Array<{ type?: string; emoji?: string }>;
  } | null;
  check(
    "[9] Telegram → 200; setMessageReaction terpanggil dengan payload benar",
    tg.status === 200 &&
      (tgCall?.url ?? "").includes("/bottoken-uji/") &&
      tgBody?.chat_id === "4242" &&
      tgBody?.message_id === 777 &&
      tgBody?.reaction?.[0]?.emoji === "❤️",
    `status=${tg.status} url=${tgCall?.url ?? ""}`,
  );
}

{
  const healthRes = await app.request(
    `/api/tenants/${TENANT}/channels/${WA_ACC}/whatsapp-health`,
  );
  const healthJson = (await healthRes.json()) as {
    available?: boolean;
    qualityRating?: string | null;
    messagingLimitTier?: string | null;
    errorCode?: string | null;
  };
  check(
    "[10] health HTTP: WA terhubung → available + rating/tier Graph",
    healthRes.status === 200 &&
      healthJson.available === true &&
      healthJson.qualityRating === "GREEN" &&
      healthJson.messagingLimitTier === "TIER_1000" &&
      healthJson.errorCode === null,
    JSON.stringify(healthJson),
  );

  const notWaRes = await app.request(
    `/api/tenants/${TENANT}/channels/${MSG_ACC}/whatsapp-health`,
  );
  const notWaJson = (await notWaRes.json()) as {
    available?: boolean;
    errorCode?: string | null;
  };
  check(
    "[10] health HTTP: akun messenger → available:false not_whatsapp (bukan error)",
    notWaRes.status === 200 &&
      notWaJson.available === false &&
      notWaJson.errorCode === "not_whatsapp",
  );
}

console.log(`\n[verify:wacrm-extras] ${passes} PASS`);
mockServer.close();
await client.close();
