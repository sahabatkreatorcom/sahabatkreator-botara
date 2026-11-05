# @sahabat-kreator/sdk

Client TypeScript tipis untuk **API publik v1** Sahabat Kreator (Fase 5B).
Semua tipe request/response berasal dari `@sahabat-kreator/contracts` —
sumber kebenaran tunggal — sehingga SDK tidak pernah drift dari API.
Tanpa dependensi runtime: memakai `fetch` bawaan (Node 18+, browser
modern, Bun, Deno).

## Instalasi & pemakaian

```ts
import { SahabatKreatorClient, SahabatKreatorApiError } from "@sahabat-kreator/sdk";

const client = new SahabatKreatorClient({
  // Origin API, tanpa path. Client memanggil {baseUrl}/api/v1/...
  baseUrl: "https://botara.my.id",
  // API key tenant (sk_live_...) — buat dari dashboard Settings → API Keys.
  // Perlakukan sebagai rahasia: simpan di env/secret store, jangan commit.
  apiKey: process.env.SAHABAT_KREATOR_API_KEY!,
});

const me = await client.me();                 // { tenantId, tenantName, scopes }
const { contacts, total } = await client.listContacts({ search: "budi", limit: 20 });
const contact = await client.createContact({ name: "Budi", email: "budi@example.com" });
const { conversations } = await client.listConversations();
const { messages } = await client.listMessages(conversations[0]!.id, { limit: 50 });
const sent = await client.sendMessage(conversations[0]!.id, "Halo! Ada yang bisa dibantu?");
const { products } = await client.listProducts();
```

Tenant tidak pernah disebut di URL — server menurunkannya dari API key.
Scope kunci membatasi metode: `contacts:read`, `contacts:write`,
`conversations:read`, `messages:write`, `products:read`.

## Error

Semua kegagalan API dilempar sebagai `SahabatKreatorApiError` yang membawa
kode kontrak dan status HTTP — bercabanglah pada `code`, bukan kalimat:

```ts
try {
  await client.sendMessage(conversationId, "Halo");
} catch (err) {
  if (err instanceof SahabatKreatorApiError && err.code === "API_KEY_SCOPE_DENIED") {
    // kunci tidak punya scope messages:write
  }
  throw err;
}
```

## Verifikasi terhadap server live

```bash
SAHABAT_KREATOR_API_KEY=sk_live_... pnpm --filter @sahabat-kreator/sdk verify:sdk
```

Membuktikan `me()` + `listContacts()` dengan kunci uji dan jalur error
kunci-salah (`API_KEY_INVALID`). Kunci hanya dibaca dari env dan tidak
pernah dicetak utuh.
