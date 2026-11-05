/**
 * Uji integrasi @sahabat-kreator/sdk terhadap API publik v1 yang LIVE
 * (Fase 5B). Bukan unit test: skrip ini memanggil staging/production asli
 * dengan API key uji, membuktikan client bekerja apa adanya dari sudut
 * pandang konsumen eksternal.
 *
 * Env yang dibaca (kunci TIDAK PERNAH dicetak — hanya prefix):
 *   SAHABAT_KREATOR_API_KEY   (wajib) kunci tenant uji
 *   SAHABAT_KREATOR_BASE_URL  (opsional) default https://botara.my.id
 *
 * Jalankan:  pnpm --filter @sahabat-kreator/sdk verify:sdk
 * Exit code 0 = semua lulus; 1 = ada kegagalan.
 */
import {
  SahabatKreatorApiError,
  SahabatKreatorClient,
} from "../src/index.js";

const apiKey = process.env.SAHABAT_KREATOR_API_KEY;
if (!apiKey) {
  console.error("SAHABAT_KREATOR_API_KEY wajib diisi (kunci tenant uji).");
  process.exit(2);
}
const baseUrl = process.env.SAHABAT_KREATOR_BASE_URL ?? "https://botara.my.id";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const client = new SahabatKreatorClient({ baseUrl, apiKey });

const me = await client.me();
check("me() mengembalikan tenant", typeof me.tenantId === "string" && me.tenantId.length > 0, `tenant="${me.tenantName}" scopes=${me.scopes.join(",")}`);

const contacts = await client.listContacts({ limit: 5 });
check("listContacts() berhasil", Array.isArray(contacts.contacts) && typeof contacts.total === "number", `total=${contacts.total}`);

// Fase 10B: permukaan komentar (scope comments:read pada kunci uji).
// Kunci tanpa scope itu menerima API_KEY_SCOPE_DENIED bertipe — keduanya
// membuktikan endpoint + metode SDK terhubung; keberhasilan penuh hanya
// untuk kunci berscope komentar.
try {
  const comments = await client.listComments({ limit: 5 });
  check("listComments() berhasil", Array.isArray(comments.comments), `count=${comments.comments.length}`);
} catch (err) {
  const isTyped = err instanceof SahabatKreatorApiError;
  check(
    "listComments() terhubung (atau ditolak scope secara bertipe)",
    isTyped && err.code === "API_KEY_SCOPE_DENIED",
    isTyped ? `code=${err.code}` : `error tak bertipe: ${String(err)}`,
  );
}

// Fase 13A: customFields tertulis lewat SDK — buat membawa field, PATCH
// menimpa per kunci dan mempertahankan kunci lain (semantik gabung
// server). Kunci tanpa contacts:write menerima API_KEY_SCOPE_DENIED
// bertipe — itu pun membuktikan metode terhubung (pola listComments).
try {
  const stamp = Date.now();
  const createdContact = await client.createContact({
    name: `SDK Uji 13A ${stamp}`,
    customFields: { kota: "Bandung", sumber: "verify-sdk" },
  });
  check(
    "createContact(customFields) tersimpan",
    createdContact.customFields?.kota === "Bandung" &&
      createdContact.customFields?.sumber === "verify-sdk",
    `id=${createdContact.id}`,
  );
  const updatedContact = await client.updateContact(createdContact.id, {
    customFields: { kota: "Jakarta" },
  });
  check(
    "updateContact(customFields) gabung per kunci",
    updatedContact.customFields?.kota === "Jakarta" &&
      updatedContact.customFields?.sumber === "verify-sdk",
    `id=${updatedContact.id}`,
  );
} catch (err) {
  const isTyped = err instanceof SahabatKreatorApiError;
  check(
    "createContact/updateContact terhubung (atau ditolak scope secara bertipe)",
    isTyped && err.code === "API_KEY_SCOPE_DENIED",
    isTyped ? `code=${err.code}` : `error tak bertipe: ${String(err)}`,
  );
}

// Fase 15A: permukaan BACA baru (broadcast, flow, template flow,
// otomasi, agen, channel, basis pengetahuan). Pola toleran yang sama
// seperti listComments: keberhasilan penuh untuk kunci berscope baca
// baru; kunci tanpa scope itu menerima API_KEY_SCOPE_DENIED bertipe —
// keduanya membuktikan endpoint + metode SDK terhubung.
async function checkRead<T>(
  name: string,
  fn: () => Promise<T>,
  validate: (value: T) => boolean,
  detail: (value: T) => string,
): Promise<void> {
  try {
    const value = await fn();
    check(name, validate(value), detail(value));
  } catch (err) {
    const isTyped = err instanceof SahabatKreatorApiError;
    check(
      `${name} (atau ditolak scope secara bertipe)`,
      isTyped && err.code === "API_KEY_SCOPE_DENIED",
      isTyped ? `code=${err.code}` : `error tak bertipe: ${String(err)}`,
    );
  }
}

await checkRead(
  "listBroadcasts() berhasil",
  () => client.listBroadcasts({ limit: 5 }),
  (v) => Array.isArray(v.broadcasts) && "nextCursor" in v,
  (v) => `count=${v.broadcasts.length}`,
);
await checkRead(
  "listFlows() berhasil",
  () => client.listFlows({ limit: 5 }),
  (v) => Array.isArray(v.flows) && "nextCursor" in v,
  (v) => `count=${v.flows.length}`,
);
await checkRead(
  "listFlowTemplates() memuat katalog kontrak",
  () => client.listFlowTemplates(),
  (v) => v.templates.some((t) => t.slug === "sambutan-tag-minat"),
  (v) => `count=${v.templates.length}`,
);
await checkRead(
  "listAutomations() berhasil",
  () => client.listAutomations(),
  (v) => Array.isArray(v.automations),
  (v) => `count=${v.automations.length}`,
);
await checkRead(
  "listAgents() berhasil",
  () => client.listAgents(),
  (v) => Array.isArray(v.agents),
  (v) => `count=${v.agents.length}`,
);
await checkRead(
  "listChannels() berhasil",
  () => client.listChannels(),
  (v) => Array.isArray(v.channels),
  (v) => `count=${v.channels.length}`,
);
await checkRead(
  "listKnowledgeDocuments() berhasil",
  () => client.listKnowledgeDocuments(),
  (v) => Array.isArray(v.documents),
  (v) => `count=${v.documents.length}`,
);
await checkRead(
  "getKnowledgeStats() berhasil",
  () => client.getKnowledgeStats(),
  (v) => typeof v.totalChunks === "number" && typeof v.embeddedChunks === "number",
  (v) => `chunks=${v.embeddedChunks}/${v.totalChunks} semantic=${v.semanticSearch.active}`,
);
// Fase 13B: growth links — daftar + get pertama bila ada.
let growthFirstId: string | null = null;
let growthFirstSlug: string | null = null;
try {
  const list = await client.listGrowthLinks();
  check(
    "listGrowthLinks() berhasil",
    Array.isArray(list.links),
    `count=${list.links.length}`,
  );
  growthFirstId = list.links[0]?.id ?? null;
  growthFirstSlug = list.links[0]?.slug ?? null;
} catch (err) {
  const isTyped = err instanceof SahabatKreatorApiError;
  check(
    "listGrowthLinks() (atau ditolak scope secara bertipe)",
    isTyped && err.code === "API_KEY_SCOPE_DENIED",
    isTyped ? `code=${err.code}` : `error tak bertipe: ${String(err)}`,
  );
}
if (growthFirstId) {
  await checkRead(
    "getGrowthLink(id) konsisten dengan daftar",
    () => client.getGrowthLink(growthFirstId!),
    (v) => v.id === growthFirstId && v.slug === growthFirstSlug && typeof v.stats.clicks === "number",
    (v) => `slug=${v.slug} clicks=${v.stats.clicks}`,
  );
}

// Fase 13C: segmen — daftar + get pertama bila ada.
let segmentFirstId: string | null = null;
try {
  const list = await client.listSegments();
  check(
    "listSegments() berhasil",
    Array.isArray(list.segments),
    `count=${list.segments.length}`,
  );
  segmentFirstId = list.segments[0]?.id ?? null;
} catch (err) {
  const isTyped = err instanceof SahabatKreatorApiError;
  check(
    "listSegments() (atau ditolak scope secara bertipe)",
    isTyped && err.code === "API_KEY_SCOPE_DENIED",
    isTyped ? `code=${err.code}` : `error tak bertipe: ${String(err)}`,
  );
}
if (segmentFirstId) {
  await checkRead(
    "getSegment(id) konsisten dengan daftar",
    () => client.getSegment(segmentFirstId!),
    (v) => v.id === segmentFirstId && typeof v.definition.match === "string",
    (v) => `name=${v.name}`,
  );
}

// Fase 13F: order commerce — daftar + get pertama bila ada (pola
// toleran yang sama; kunci tanpa orders:read menerima penolakan
// bertipe). Order lahir dari checkout flow, jadi daftar bisa kosong.
let orderFirstId: string | null = null;
try {
  const list = await client.listOrders();
  check(
    "listOrders() berhasil",
    Array.isArray(list.orders),
    `count=${list.orders.length}`,
  );
  orderFirstId = list.orders[0]?.id ?? null;
} catch (err) {
  const isTyped = err instanceof SahabatKreatorApiError;
  check(
    "listOrders() (atau ditolak scope secara bertipe)",
    isTyped && err.code === "API_KEY_SCOPE_DENIED",
    isTyped ? `code=${err.code}` : `error tak bertipe: ${String(err)}`,
  );
}
if (orderFirstId) {
  await checkRead(
    "getOrder(id) konsisten dengan daftar",
    () => client.getOrder(orderFirstId!),
    (v) => v.id === orderFirstId && Array.isArray(v.items) && typeof v.totalIdr === "number",
    (v) => `total=${v.totalIdr} status=${v.status}`,
  );
}

// Fase 13G: janji temu — daftar booking + daftar layanan (pola
// toleran yang sama; kunci tanpa appointments:read menerima
// penolakan bertipe). Booking lahir dari flow/dashboard, jadi
// daftar bisa kosong di tenant uji.
try {
  const list = await client.listAppointments();
  check(
    "listAppointments() berhasil",
    Array.isArray(list.bookings),
    `count=${list.bookings.length}`,
  );
} catch (err) {
  const isTyped = err instanceof SahabatKreatorApiError;
  check(
    "listAppointments() (atau ditolak scope secara bertipe)",
    isTyped && err.code === "API_KEY_SCOPE_DENIED",
    isTyped ? `code=${err.code}` : `error tak bertipe: ${String(err)}`,
  );
}
try {
  const list = await client.listAppointmentServices();
  check(
    "listAppointmentServices() berhasil",
    Array.isArray(list.services),
    `count=${list.services.length}`,
  );
} catch (err) {
  const isTyped = err instanceof SahabatKreatorApiError;
  check(
    "listAppointmentServices() (atau ditolak scope secara bertipe)",
    isTyped && err.code === "API_KEY_SCOPE_DENIED",
    isTyped ? `code=${err.code}` : `error tak bertipe: ${String(err)}`,
  );
}

// Jalur error: kunci acak → SahabatKreatorApiError dengan code API_KEY_INVALID.
const badClient = new SahabatKreatorClient({
  baseUrl,
  apiKey: `sk_live_${"x".repeat(43)}`,
});
try {
  await badClient.me();
  check("kunci salah ditolak", false, "me() tidak melempar error");
} catch (err) {
  const isTyped = err instanceof SahabatKreatorApiError;
  check(
    "kunci salah → SahabatKreatorApiError API_KEY_INVALID",
    isTyped && err.code === "API_KEY_INVALID" && err.status === 401,
    isTyped ? `code=${err.code} status=${err.status}` : `error tak bertipe: ${String(err)}`,
  );
}

console.log(failures === 0 ? "\nSEMUA LULUS" : `\n${failures} KEGAGALAN`);
process.exit(failures === 0 ? 0 : 1);
