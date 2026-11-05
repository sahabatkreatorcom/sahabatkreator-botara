/**
 * Uji integrasi CLI `sk` (Fase 14D) — BUKAN unit test. Skrip ini
 * menjalankan BINARY HASIL BUILD (apps/cli/bin/sk.js → dist/index.js)
 * sebagai proses anak terhadap API publik v1 yang hidup, membuktikan
 * CLI bekerja apa adanya dari sudut pandang pengguna terminal:
 * konfigurasi (env > berkas), perintah baca per keluarga sumber daya,
 * satu alur tulis ujung-ke-ujung, keluaran --json yang ter-parse,
 * penolakan scope & kunci salah yang jujur, dan bantuan.
 *
 * Env yang dibaca (kunci TIDAK PERNAH dicetak — hanya penanda):
 *   SK_API_KEY             (wajib) kunci FULL-scope tenant uji
 *   SK_API_KEY_LIMITED     (opsional) kunci contacts:read saja untuk
 *                          uji penolakan scope; kosong = uji dilewati
 *   SK_BASE_URL            (wajib di rantai) origin API chain
 *   SK_TEST_SEGMENT_ID     (opsional) segmen yang ditanam rantai —
 *                          mengaktifkan uji `segments get`
 *   SK_TEST_PRODUCT_NAME   (opsional) nama produk yang ditanam rantai
 *   SK_TEST_CONVERSATION_ID (opsional) percakapan webchat rantai —
 *                          mengaktifkan uji messages list/send
 *   SK_CLI_RUNTIME         (opsional) executable menjalankan binary
 *                          (default "node"; server staging: path bun)
 *
 * Prasyarat: CLI sudah di-build (`pnpm --filter @sahabat-kreator/cli build`).
 * Jalankan:  pnpm --filter @sahabat-kreator/cli verify:cli
 * Exit code 0 = semua lulus; 1 = ada kegagalan; 2 = env kurang.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fullKey = process.env.SK_API_KEY;
const baseUrl = process.env.SK_BASE_URL;
if (!fullKey || !baseUrl) {
  console.error("SK_API_KEY dan SK_BASE_URL wajib diisi (rantai Fase 14D).");
  process.exit(2);
}
const limitedKey = process.env.SK_API_KEY_LIMITED;
const runtime = process.env.SK_CLI_RUNTIME ?? "node";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const binPath = path.join(packageRoot, "bin", "sk.js");
if (!existsSync(path.join(packageRoot, "dist", "index.js"))) {
  console.error(
    "dist CLI tidak ditemukan — jalankan dulu: pnpm --filter @sahabat-kreator/cli build",
  );
  process.exit(2);
}

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) passes += 1;
  else failures += 1;
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(
  argv: string[],
  envOverrides: Record<string, string | undefined> = {},
): RunResult {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const res = spawnSync(runtime, [binPath, ...argv], {
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function runJson<T>(
  argv: string[],
  envOverrides: Record<string, string | undefined> = {},
): { res: RunResult; json: T | null } {
  const res = run([...argv, "--json"], envOverrides);
  let json: T | null = null;
  try {
    json = JSON.parse(res.stdout) as T;
  } catch {
    json = null;
  }
  return { res, json };
}

const stamp = Date.now();
const contactName = `CLI Uji 14D ${stamp}`;

// ------------------------------------------------------------ bantuan
{
  const root = run(["--help"]);
  check(
    "--help root: exit 0 + indeks perintah",
    root.status === 0 &&
      root.stdout.includes("whoami") &&
      root.stdout.includes("contacts list") &&
      root.stdout.includes("appointments services"),
  );
  const cmdHelp = run(["contacts", "list", "--help"]);
  check(
    "contacts list --help: pemakaian + flag",
    cmdHelp.status === 0 &&
      cmdHelp.stdout.includes("sk contacts list") &&
      cmdHelp.stdout.includes("--search") &&
      cmdHelp.stdout.includes("contacts:read"),
  );
  const sendHelp = run(["messages", "send", "--help"]);
  check(
    "messages send --help: --text wajib + scope tulis",
    sendHelp.status === 0 &&
      sendHelp.stdout.includes("--text") &&
      sendHelp.stdout.includes("messages:write"),
  );
  const unknown = run(["tidak-ada"]);
  check(
    "perintah asing → exit 2",
    unknown.status === 2 && unknown.stderr.includes("unknown command"),
  );
  const badFlag = run(["contacts", "list", "--bogus"]);
  check(
    "flag asing → exit 2 (parser ketat)",
    badFlag.status === 2 && badFlag.stderr.includes("unknown flag"),
  );
}

// ------------------------------------------------------------ whoami
{
  const human = run(["whoami"]);
  check(
    "whoami: exit 0, tenant + scope tampil, kunci TIDAK tercetak utuh",
    human.status === 0 &&
      human.stdout.includes("scopes:") &&
      human.stdout.includes("contacts:read") &&
      human.stdout.includes("sk_live_…") &&
      !human.stdout.includes(fullKey),
  );
  const { res, json } = runJson<{ tenantId: string; scopes: string[] }>([
    "whoami",
  ]);
  check(
    "whoami --json: ter-parse, tenantId + scope tulis ada",
    res.status === 0 &&
      json !== null &&
      typeof json.tenantId === "string" &&
      json.tenantId.length > 0 &&
      json.scopes.includes("messages:write"),
    json ? `scopes=${json.scopes.length}` : "json null",
  );
}

// ------------------------------------------------- tulis ujung-ke-ujung
let createdId = "";
{
  const { res, json } = runJson<{
    id: string;
    customFields?: Record<string, unknown>;
  }>([
    "contacts",
    "create",
    "--name",
    contactName,
    "--tag",
    "cli-verify",
    "--field",
    "kota=Bandung",
    "--field",
    "sumber=verify-cli",
  ]);
  check(
    "contacts create: tersimpan + customFields utuh",
    res.status === 0 &&
      json !== null &&
      typeof json.id === "string" &&
      json.customFields?.kota === "Bandung" &&
      json.customFields?.sumber === "verify-cli",
    json ? `id=${json.id}` : `stderr=${res.stderr.trim()}`,
  );
  createdId = json?.id ?? "";

  const found = runJson<{ contacts: { id: string }[]; total: number }>([
    "contacts",
    "list",
    "--search",
    contactName,
  ]);
  check(
    "contacts list --search: kontak baru terlihat",
    found.res.status === 0 &&
      found.json !== null &&
      found.json.contacts.some((c) => c.id === createdId) &&
      found.json.total >= 1,
  );

  const upd = runJson<{ customFields?: Record<string, unknown> }>([
    "contacts",
    "update",
    createdId,
    "--field",
    "kota=Jakarta",
  ]);
  check(
    "contacts update: gabung per kunci (kota berubah, sumber bertahan)",
    upd.res.status === 0 &&
      upd.json?.customFields?.kota === "Jakarta" &&
      upd.json?.customFields?.sumber === "verify-cli",
  );

  const humanList = run(["contacts", "list", "--search", contactName]);
  check(
    "contacts list (manusia): baris kontak tercetak sebagai tabel",
    humanList.status === 0 && humanList.stdout.includes(contactName),
  );
}

// ------------------------------------------------- baca per keluarga
async function checkList(
  name: string,
  argv: string[],
  arrayKey: string,
): Promise<Record<string, unknown>[]> {
  const { res, json } = runJson<Record<string, unknown>>([...argv]);
  const rows = json?.[arrayKey];
  check(
    name,
    res.status === 0 && Array.isArray(rows),
    Array.isArray(rows) ? `count=${rows.length}` : `stderr=${res.stderr.trim()}`,
  );
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

const products = await checkList("products list", ["products", "list"], "products");
if (process.env.SK_TEST_PRODUCT_NAME) {
  check(
    "products list: produk tanam rantai terlihat",
    products.some((p) => p.name === process.env.SK_TEST_PRODUCT_NAME),
  );
}

const segments = await checkList("segments list", ["segments", "list"], "segments");
if (process.env.SK_TEST_SEGMENT_ID) {
  const { res, json } = runJson<{ id: string; definition: { match: string } }>([
    "segments",
    "get",
    process.env.SK_TEST_SEGMENT_ID,
  ]);
  check(
    "segments get: konsisten dengan yang ditanam",
    res.status === 0 &&
      json?.id === process.env.SK_TEST_SEGMENT_ID &&
      typeof json?.definition?.match === "string",
  );
} else if (segments.length > 0) {
  check("segments get (tanpa tanam): dilewati — daftar kosong wajar", true, "skip");
}

await checkList("orders list", ["orders", "list"], "orders");
await checkList(
  "appointments list",
  ["appointments", "list"],
  "bookings",
);
await checkList(
  "appointments services",
  ["appointments", "services"],
  "services",
);
await checkList("growth-links list", ["growth-links", "list"], "links");
await checkList("broadcasts list", ["broadcasts", "list"], "broadcasts");
await checkList("conversations list", ["conversations", "list"], "conversations");
await checkList("comments list", ["comments", "list"], "comments");
await checkList("agents list", ["agents", "list"], "agents");
await checkList("automations list", ["automations", "list"], "automations");
await checkList("kb list", ["kb", "list"], "documents");

{
  const { res, json } = runJson<{ flows: unknown[]; nextCursor: unknown }>([
    "flows",
    "list",
  ]);
  check(
    "flows list: amplop berkursor utuh",
    res.status === 0 && Array.isArray(json?.flows) && json !== null && "nextCursor" in json,
  );
  const tpl = runJson<{ templates: { slug: string }[] }>([
    "flow-templates",
    "list",
  ]);
  check(
    "flow-templates list: katalog kontrak termuat",
    tpl.res.status === 0 &&
      (tpl.json?.templates.length ?? 0) > 0 &&
      tpl.json!.templates.some((t) => t.slug === "sambutan-tag-minat"),
    `count=${tpl.json?.templates.length ?? 0}`,
  );
  const stats = runJson<{ totalChunks: number; embeddedChunks: number }>([
    "kb",
    "stats",
  ]);
  check(
    "kb stats: angka chunk terbaca",
    stats.res.status === 0 &&
      typeof stats.json?.totalChunks === "number" &&
      typeof stats.json?.embeddedChunks === "number",
  );
}

// --------------------------------------- percakapan & pesan (bila ada)
const conversationId = process.env.SK_TEST_CONVERSATION_ID;
if (conversationId) {
  const before = runJson<{ messages: { contentText: string }[] }>([
    "messages",
    "list",
    conversationId,
  ]);
  check(
    "messages list: riwayat percakapan rantai terbaca",
    before.res.status === 0 && Array.isArray(before.json?.messages),
    `count=${before.json?.messages.length ?? 0}`,
  );
  const sentText = `Halo dari verify-cli ${stamp}`;
  const sent = runJson<{ id: string; contentText: string }>([
    "messages",
    "send",
    conversationId,
    "--text",
    sentText,
  ]);
  check(
    "messages send: terkirim ujung-ke-ujung",
    sent.res.status === 0 && sent.json?.contentText === sentText,
    sent.json ? `id=${sent.json.id}` : `stderr=${sent.res.stderr.trim()}`,
  );
  const after = runJson<{ messages: { contentText: string }[] }>([
    "messages",
    "list",
    conversationId,
  ]);
  check(
    "messages list: pesan terkirim muncul di riwayat",
    after.json?.messages.some((m) => m.contentText === sentText) ?? false,
  );
}

// ------------------------------- whatsapp-templates terhadap akun webchat
{
  // Akun webchat BUKAN akun WhatsApp: gerbang API menolak secara
  // bertipe. Yang dibuktikan: perintah terhubung + penolakan jujur
  // (exit 1 + kode kontrak), BUKAN keberhasilan semu.
  const { json: channels } = runJson<{ channels: { id: string }[] }>([
    "channels",
    "list",
  ]);
  const channelId = channels?.channels?.[0]?.id;
  check(
    "channels list: akun webchat rantai terbaca",
    typeof channelId === "string",
  );
  if (channelId) {
    const got = runJson<{ id: string }>(["channels", "get", channelId]);
    check(
      "channels get: konsisten dengan daftar",
      got.res.status === 0 && got.json?.id === channelId,
    );
    const wt = run([
      "whatsapp-templates",
      "list",
      "--channel-account-id",
      channelId,
    ]);
    check(
      "whatsapp-templates list (akun non-WA): ditolak bertipe, exit 1",
      wt.status === 1 && /Error: [A-Z][A-Z0-9_]+/.test(wt.stderr),
      wt.stderr.trim().split("\n")[0] ?? "",
    );
  }
  const missing = run(["whatsapp-templates", "list"]);
  check(
    "whatsapp-templates list tanpa --channel-account-id → exit 2",
    missing.status === 2,
  );
}

// ------------------------------------------------- penolakan & konfigurasi
if (limitedKey) {
  const denied = run(["contacts", "create", "--name", "Harus Ditolak"], {
    SK_API_KEY: limitedKey,
  });
  check(
    "scope: kunci read-only membuat kontak → API_KEY_SCOPE_DENIED + exit 1",
    denied.status === 1 && denied.stderr.includes("API_KEY_SCOPE_DENIED"),
  );
  const deniedRead = run(["products", "list"], { SK_API_KEY: limitedKey });
  check(
    "scope: kunci tanpa products:read → API_KEY_SCOPE_DENIED + exit 1",
    deniedRead.status === 1 && deniedRead.stderr.includes("API_KEY_SCOPE_DENIED"),
  );
  const allowed = run(["contacts", "list", "--limit", "1"], {
    SK_API_KEY: limitedKey,
  });
  check(
    "scope: kunci read-only tetap bisa membaca kontaknya (exit 0)",
    allowed.status === 0,
  );
} else {
  check("scope: SK_API_KEY_LIMITED kosong — uji penolakan dilewati", true, "skip");
}

{
  const bad = run(["whoami"], {
    SK_API_KEY: `sk_live_${"x".repeat(43)}`,
  });
  check(
    "kunci salah → API_KEY_INVALID + exit 1",
    bad.status === 1 && bad.stderr.includes("API_KEY_INVALID"),
  );

  const emptyHome = mkdtempSync(path.join(tmpdir(), "sk-cli-empty-"));
  const noKey = run(["whoami"], {
    SK_API_KEY: undefined,
    SK_BASE_URL: baseUrl,
    HOME: emptyHome,
    XDG_CONFIG_HOME: path.join(emptyHome, ".config"),
  });
  check(
    "tanpa kunci di mana pun → exit 2 + panduan konfigurasi",
    noKey.status === 2 && noKey.stderr.includes("No API key configured"),
  );

  const cfgHome = mkdtempSync(path.join(tmpdir(), "sk-cli-cfg-"));
  const cfgDir = path.join(cfgHome, ".config", "sahabat-kreator");
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(
    path.join(cfgDir, "config.json"),
    JSON.stringify({ baseUrl, apiKey: fullKey }),
  );
  const viaFile = run(["whoami"], {
    SK_API_KEY: undefined,
    SK_BASE_URL: undefined,
    HOME: cfgHome,
    XDG_CONFIG_HOME: path.join(cfgHome, ".config"),
  });
  check(
    "konfigurasi dari berkas: whoami berhasil tanpa env kunci",
    viaFile.status === 0 && viaFile.stdout.includes("config file"),
    viaFile.stderr.trim().split("\n")[0] ?? "",
  );

  writeFileSync(
    path.join(cfgDir, "config.json"),
    JSON.stringify({ baseUrl, apiKey: `sk_live_${"y".repeat(43)}` }),
  );
  const envWins = run(["whoami"], {
    HOME: cfgHome,
    XDG_CONFIG_HOME: path.join(cfgHome, ".config"),
  });
  check(
    "precedence: SK_API_KEY (env) menang atas berkas (kunci berkas salah)",
    envWins.status === 0 && envWins.stdout.includes("SK_API_KEY"),
  );

  const dead = run(["whoami", "--base-url", "http://127.0.0.1:9"], {
    SK_BASE_URL: baseUrl,
  });
  check(
    "--base-url bendera dipakai (titik mati → error jaringan, exit 1)",
    dead.status === 1 && dead.stderr.includes("INTERNAL_ERROR"),
  );
  const flagWins = run(["whoami"], { SK_BASE_URL: "http://127.0.0.1:9" });
  check(
    "SK_BASE_URL menang atas bawaan (titik mati → exit 1)",
    flagWins.status === 1,
  );
}

console.log(
  failures === 0
    ? `\nSEMUA LULUS (${passes} PASS)`
    : `\n${failures} KEGAGALAN (${passes} PASS)`,
);
process.exit(failures === 0 ? 0 : 1);
