/**
 * Verifikasi aturan objek kirim Send API Meta (regresi bug balasan IG
 * `meta_graph_100` subcode 2534014 di botara.englishbooster.id).
 *
 * Bug: balasan inbox Instagram memakai id akun IG sebagai segmen path
 * Send API (`POST /{ig-user-id}/messages`). Akun terhubung lewat
 * Facebook Login memakai Page Access Token; IGSID hanya ter-resolve di
 * konteks Page, sehingga Graph menolak setiap balasan — walau webhook
 * `entry.id` memang id akun IG.
 *
 * Perbaikan memilih objek kirim per-VARIAN token (docs Meta):
 * - Page token (Facebook Login) → `me` (≈ `/{page-id}/messages`);
 * - System User token (Unified Login/SUAT) → id akun IG, karena `/me`
 *   pada varian ini adalah business integration system user, bukan
 *   akun IG ("Always use the Instagram account ID").
 *
 * Harness ini tidak menghubungi Graph: `fetchImpl` palsu merekam URL dan
 * body. Yang dibuktikan:
 *  (a) pemilihan objek murni: Page token → "me", SUAT → id akun IG,
 *      messenger/whatsapp tetap id akun tersimpan;
 *  (b) probe varian: `/me` dengan `client_business_id` (SUAT) dan `/me`
 *      yang menolak field itu (Page token, Graph 400);
 *  (c) URL kirim yang dihasilkan untuk tiap varian;
 *  (d) body tetap bentuk terdokumentasi (recipient.id, messaging_type
 *      RESPONSE, text) — tanpa field tambahan;
 *  (e) private reply komentar memakai recipient.comment_id tanpa
 *      messaging_type;
 *  (f) cache probe: panggilan berulang tidak menambah request `/me`.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/api verify:meta-send
 */
import { MetaGraphClient } from "@sahabat-kreator/channel-messenger";
import {
  pickInstagramSendObjectId,
  resolveInstagramSendObjectId,
} from "../src/modules/meta/poller";

/**
 * Bentuk minimal delivery yang dipakai resolver — hanya kunci cache
 * (channelAccountId), id akun IG, dan varian token tersimpan (lifecycle
 * 0010; null = akun warisan → jalur probe). Field lain tidak disentuh.
 */
interface MinimalDelivery {
  channelAccountId: string;
  accountExternalId: string;
  tokenType: "page_access_token" | "system_user_token" | "business_token" | null;
}

let passes = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    passes += 1;
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`GAGAL ${label}${detail ? ` (${detail})` : ""}`);
  }
}

interface Captured {
  url: string;
  body: Record<string, unknown> | null;
}

/**
 * fetch palsu: mencatat URL/body POST kirim; `meResponse` menentukan
 * jawaban `GET /me?fields=id,client_business_id` (400 = Page token).
 */
function fakeFetch(
  captured: Captured[],
  meResponse: { status: number; body: unknown },
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const bodyText = typeof init?.body === "string" ? init.body : null;
    if (url.includes("/me?")) {
      return new Response(JSON.stringify(meResponse.body), {
        status: meResponse.status,
        headers: { "content-type": "application/json" },
      });
    }
    captured.push({
      url,
      body: bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : null,
    });
    return new Response(JSON.stringify({ message_id: "m_1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

const IG_ACCOUNT_ID = "17841402278755050";
const PAGE_ID = "324610680739039";
const IGSID = "1479611567648178";

async function main(): Promise<void> {
  // (a) pemilihan objek murni.
  check(
    "instagram Page token → 'me'",
    pickInstagramSendObjectId(false, IG_ACCOUNT_ID) === "me",
  );
  check(
    "instagram SUAT → id akun IG",
    pickInstagramSendObjectId(true, IG_ACCOUNT_ID) === IG_ACCOUNT_ID,
  );

  // (b)+(c)+(f) Page token: /me menolak client_business_id → kirim 'me'.
  {
    const captured: Captured[] = [];
    let meCalls = 0;
    const client = new MetaGraphClient({
      apiVersion: "v26.0",
      accessToken: "token-uji",
      fetchImpl: (input, init) => {
        const url = String(input);
        if (url.includes("/me?")) {
          meCalls += 1;
          return Promise.resolve(
            new Response(JSON.stringify({ error: { code: 100 } }), {
              status: 400,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        const bodyText = typeof init?.body === "string" ? init.body : null;
        captured.push({
          url,
          body: bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : null,
        });
        return Promise.resolve(
          new Response(JSON.stringify({ message_id: "m_1" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      },
    });
    const delivery: MinimalDelivery = {
      channelAccountId: "acc-page-token",
      accountExternalId: IG_ACCOUNT_ID,
      // Akun warisan (sebelum lifecycle 0010): varian NULL → jalur probe.
      tokenType: null,
    };
    const target1 = await resolveInstagramSendObjectId(client, delivery);
    const target2 = await resolveInstagramSendObjectId(client, delivery);
    check("page token: resolusi → 'me'", target1 === "me", target1);
    check(
      "cache: resolusi ulang konsisten",
      target2 === "me",
      target2,
    );
    await client.sendMessage({
      accountExternalId: target1,
      recipientExternalId: IGSID,
      text: "halo",
    });
    check(
      "page token: path /v26.0/me/messages",
      captured[0]?.url.endsWith("/v26.0/me/messages") === true,
      captured[0]?.url,
    );
    // Probe /me tepat SEKALI walau resolusi dipanggil dua kali; POST
    // kirim juga tepat satu (tidak ada pengiriman ganda).
    check(
      "cache: probe /me sekali, POST kirim sekali",
      meCalls === 1 && captured.length === 1,
      `me=${meCalls} post=${captured.length}`,
    );
    const body = captured[0]?.body ?? null;
    check(
      "page token: body hanya recipient/messaging_type/message",
      body !== null &&
        Object.keys(body).sort().join(",") ===
          "message,messaging_type,recipient" &&
        JSON.stringify(body.recipient) === JSON.stringify({ id: IGSID }) &&
        body.messaging_type === "RESPONSE" &&
        JSON.stringify(body.message) === JSON.stringify({ text: "halo" }),
      JSON.stringify(body),
    );
  }

  // SUAT: /me memuat client_business_id → kirim ke id akun IG.
  {
    const captured: Captured[] = [];
    const client = new MetaGraphClient({
      apiVersion: "v26.0",
      accessToken: "token-uji",
      fetchImpl: fakeFetch(captured, {
        status: 200,
        body: { id: "su_user_1", client_business_id: "7567009423375835" },
      }),
    });
    const delivery: MinimalDelivery = {
      channelAccountId: "acc-suat",
      accountExternalId: IG_ACCOUNT_ID,
      tokenType: null,
    };
    const target = await resolveInstagramSendObjectId(client, delivery);
    check("SUAT: resolusi → id akun IG", target === IG_ACCOUNT_ID, target);
    await client.sendMessage({
      accountExternalId: target,
      recipientExternalId: IGSID,
      text: "halo",
    });
    check(
      "SUAT: path /v26.0/{ig-id}/messages",
      captured[0]?.url.endsWith(`/v26.0/${IG_ACCOUNT_ID}/messages`) === true,
      captured[0]?.url,
    );
  }

  // (d) Messenger: Page ID tetap segmen path (kirim langsung via klien).
  {
    const captured: Captured[] = [];
    const client = new MetaGraphClient({
      apiVersion: "v26.0",
      accessToken: "token-uji",
      fetchImpl: fakeFetch(captured, { status: 400, body: {} }),
    });
    await client.sendMessage({
      accountExternalId: PAGE_ID,
      recipientExternalId: "30060866946872275",
      text: "halo",
    });
    check(
      "messenger: path /v26.0/{page-id}/messages",
      captured[0]?.url.endsWith(`/v26.0/${PAGE_ID}/messages`) === true,
      captured[0]?.url,
    );
  }

  // (e) Private reply komentar: recipient.comment_id tanpa messaging_type.
  {
    const captured: Captured[] = [];
    const client = new MetaGraphClient({
      apiVersion: "v26.0",
      accessToken: "token-uji",
      fetchImpl: fakeFetch(captured, { status: 400, body: {} }),
    });
    await client.sendMessage({
      accountExternalId: "me",
      recipientExternalId: IGSID,
      text: "balasan privat",
      recipientCommentId: "comment_1",
    });
    const body = captured[0]?.body ?? null;
    check(
      "comment-to-DM: recipient.comment_id tanpa messaging_type",
      body !== null &&
        JSON.stringify(body.recipient) ===
          JSON.stringify({ comment_id: "comment_1" }) &&
        !("messaging_type" in body),
      JSON.stringify(body),
    );
  }

  console.log(`\nverify-meta-send: ${passes} PASS, ${failures} FAIL`);
  if (failures > 0) process.exitCode = 1;
}

await main();
