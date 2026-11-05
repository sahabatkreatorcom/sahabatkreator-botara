import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rejectUpgrade } from "./upgrade";

/**
 * Penolakan upgrade harus TERBACA UTUH oleh klien.
 *
 * Ini bukan detail kosmetik. Implementasi lama memakai
 * `socket.write(...)` lalu `socket.destroy()`; `destroy()` membuang
 * data yang belum ter-flush sehingga proxy di depan kadang menerima
 * respons terpotong. Akibatnya nyata dan pernah terjadi: penolakan
 * 401 yang benar berubah menjadi 502 Bad Gateway lewat Cloudflare
 * Tunnel, kira-kira dua dari tiga percobaan, sehingga dashboard
 * terlihat seperti server mati.
 *
 * Test ini memakai server HTTP dan soket TCP sungguhan, lalu membaca
 * respons mentah — persis yang dilakukan proxy.
 */

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end("{}");
  });
  server.on("upgrade", (_req, socket) => {
    rejectUpgrade(socket, "401 Unauthorized");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

/** Kirim handshake upgrade mentah dan kumpulkan seluruh respons. */
function upgradeAndRead(): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        "GET /dashboard HTTP/1.1\r\n" +
          `Host: 127.0.0.1:${port}\r\n` +
          "Connection: Upgrade\r\n" +
          "Upgrade: websocket\r\n" +
          "Sec-WebSocket-Version: 13\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
      );
    });
    let raw = "";
    socket.on("data", (chunk) => {
      raw += chunk.toString("latin1");
    });
    socket.on("end", () => resolve(raw));
    socket.on("error", reject);
    socket.setTimeout(5_000, () => {
      socket.destroy();
      resolve(raw);
    });
  });
}

describe("penolakan upgrade WebSocket", () => {
  it("mengirim status HTTP yang lengkap, bukan socket yang diputus", async () => {
    const raw = await upgradeAndRead();
    expect(raw).toMatch(/^HTTP\/1\.1 401 Unauthorized\r\n/);
  });

  it("menyatakan panjang isi supaya proxy tahu responsnya selesai", async () => {
    // Inilah yang hilang pada implementasi lama, dan yang membuat
    // proxy menyimpulkan "respons terpotong" lalu melaporkan 502.
    const raw = await upgradeAndRead();
    expect(raw).toContain("Content-Length: 0");
  });

  it("menutup koneksi dan tidak mengirim isi apa pun", async () => {
    const raw = await upgradeAndRead();
    const [head, ...rest] = raw.split("\r\n\r\n");
    expect(head).toContain("Connection: close");
    expect(rest.join("\r\n\r\n")).toBe("");
  });

  it("dapat dipakai untuk status apa pun yang ditolak server", async () => {
    // 400 untuk URL cacat, 403 untuk akun channel yang terputus.
    const seen: string[] = [];
    const handler = (_req: unknown, socket: Parameters<typeof rejectUpgrade>[0]) => {
      rejectUpgrade(socket, "403 Forbidden");
    };
    const local = createServer();
    local.on("upgrade", handler);
    await new Promise<void>((resolve) => {
      local.listen(0, "127.0.0.1", resolve);
    });
    const localPort = (local.address() as AddressInfo).port;

    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect(localPort, "127.0.0.1", () => {
        socket.write(
          "GET /webchat HTTP/1.1\r\n" +
            `Host: 127.0.0.1:${localPort}\r\n` +
            "Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
        );
      });
      let data = "";
      socket.on("data", (c) => {
        data += c.toString("latin1");
      });
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
    });
    seen.push(raw);
    await new Promise<void>((resolve) => {
      local.close(() => resolve());
    });

    expect(seen[0]).toMatch(/^HTTP\/1\.1 403 Forbidden\r\n/);
  });
});
