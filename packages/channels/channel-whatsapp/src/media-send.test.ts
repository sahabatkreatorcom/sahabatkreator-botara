import { afterEach, describe, expect, it, vi } from "vitest";
import { WhatsAppCloudClient } from "./index";

/**
 * Kirim media keluar (Fase 18B).
 *
 * Dua panggilan Graph terjadi berurutan: unggah berkas
 * (`POST /{pn}/media`) lalu kirim pesan (`POST /{pn}/messages`). Yang
 * dijaga di sini adalah BENTUK keduanya — kesalahan bentuk tidak
 * terlihat di test core (yang berhenti di baris antrean) dan di
 * produksi muncul sebagai `failed` dengan kode Graph yang tidak
 * menjelaskan apa pun.
 */

interface Captured {
  url: string;
  method: string;
  body: unknown;
  isForm: boolean;
}

function clientWithCapture(): {
  client: WhatsAppCloudClient;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const isForm = init?.body instanceof FormData;
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: isForm ? init?.body : JSON.parse(String(init?.body ?? "{}")),
        isForm,
      });
      if (String(url).endsWith("/media")) {
        return new Response(JSON.stringify({ id: "media-unggah-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ messages: [{ id: "wamid.uji" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  const client = new WhatsAppCloudClient({ accessToken: "token-uji" });
  return { client, calls };
}

describe("sendMediaMessage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mengunggah lebih dulu, lalu mengirim memakai media id hasil unggahan", async () => {
    const { client, calls } = clientWithCapture();
    const result = await client.sendMediaMessage({
      phoneNumberId: "pn-1",
      to: "628111",
      kind: "image",
      data: Buffer.from("gambar"),
      mimeType: "image/jpeg",
      caption: "Lihat ini",
    });
    expect(result.providerMessageId).toBe("wamid.uji");
    expect(calls).toHaveLength(2);

    // 1. Unggahan: multipart, bukan JSON — Meta menolak JSON di sini.
    expect(calls[0]!.url).toContain("/pn-1/media");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.isForm).toBe(true);

    // 2. Kirim: memakai id hasil unggahan, BUKAN byte berkasnya.
    const sent = calls[1]!.body as {
      type?: string;
      image?: { id?: string; caption?: string };
    };
    expect(calls[1]!.url).toContain("/pn-1/messages");
    expect(sent.type).toBe("image");
    expect(sent.image?.id).toBe("media-unggah-1");
    expect(sent.image?.caption).toBe("Lihat ini");
  });

  it("membuang caption untuk audio — Cloud API tidak punya caption audio", async () => {
    const { client, calls } = clientWithCapture();
    await client.sendMediaMessage({
      phoneNumberId: "pn-1",
      to: "628111",
      kind: "audio",
      data: Buffer.from("suara"),
      mimeType: "audio/ogg",
      // Caption ini HARUS dibuang: meneruskannya membuat Meta menolak
      // seluruh pesan, bukan mengabaikan field-nya.
      caption: "catatan suara",
    });
    const sent = calls[1]!.body as { audio?: { caption?: string } };
    expect(sent.audio?.caption).toBeUndefined();
  });

  it("menyertakan nama berkas untuk dokumen", async () => {
    const { client, calls } = clientWithCapture();
    await client.sendMediaMessage({
      phoneNumberId: "pn-1",
      to: "628111",
      kind: "document",
      data: Buffer.from("pdf"),
      mimeType: "application/pdf",
      fileName: "invoice.pdf",
    });
    const sent = calls[1]!.body as {
      document?: { id?: string; filename?: string };
    };
    expect(sent.document?.filename).toBe("invoice.pdf");
  });

  it("melempar saat unggahan ditolak provider", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code: 131053, message: "media upload error" } }),
            { status: 400, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const client = new WhatsAppCloudClient({ accessToken: "token-uji" });
    await expect(
      client.sendMediaMessage({
        phoneNumberId: "pn-1",
        to: "628111",
        kind: "image",
        data: Buffer.from("x"),
        mimeType: "image/jpeg",
      }),
    ).rejects.toMatchObject({ graphCode: 131053 });
  });
});

describe("downloadMedia", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("menolak berkas di atas batas SEBELUM mengunduh isinya", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        if (String(url).includes("/media-1") && !String(url).includes("cdn")) {
          return new Response(
            JSON.stringify({
              url: "https://cdn.example/media-1",
              mime_type: "video/mp4",
              file_size: 30_000_000,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("bytes", { status: 200 });
      }),
    );
    const client = new WhatsAppCloudClient({ accessToken: "token-uji" });
    await expect(
      client.downloadMedia("media-1", { maxBytes: 25_000_000 }),
    ).rejects.toMatchObject({ description: "media_too_large" });
    // Hanya satu panggilan: metadata. Byte-nya tidak pernah diminta —
    // itulah inti penjagaan ukuran.
    expect(calls).toHaveLength(1);
  });

  it("mengunduh dengan header Authorization ke URL sementara", async () => {
    let downloadedHeaders: RequestInit["headers"] | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes("cdn")) {
          downloadedHeaders = init?.headers;
          return new Response("isi", {
            status: 200,
            headers: { "content-type": "image/jpeg" },
          });
        }
        return new Response(
          JSON.stringify({
            url: "https://cdn.example/media-2",
            mime_type: "image/jpeg",
            file_size: 4,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const client = new WhatsAppCloudClient({ accessToken: "token-uji" });
    const got = await client.downloadMedia("media-2");
    expect(got.data.toString()).toBe("isi");
    expect(got.mimeType).toBe("image/jpeg");
    // URL sementara tetap menuntut token: tanpa header ini unduhannya 401.
    expect(JSON.stringify(downloadedHeaders)).toContain("Bearer token-uji");
  });
});
