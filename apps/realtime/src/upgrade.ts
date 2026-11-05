import type { Duplex } from "node:stream";

/**
 * Menolak upgrade WebSocket dengan respons HTTP biasa.
 *
 * `socket.end()` — BUKAN `write()` lalu `destroy()`. `destroy()`
 * membuang data yang belum ter-flush, sehingga proxy di depan kadang
 * menerima respons terpotong.
 *
 * Gejalanya menyesatkan dan pernah terjadi sungguhan: lewat nginx
 * lokal penolakan tampak normal (401), tetapi lewat Cloudflare Tunnel
 * sekitar dua dari tiga percobaan berubah menjadi **502 Bad Gateway** —
 * seolah origin mati, padahal origin justru menjawab dengan benar.
 * `Content-Length: 0` membuat respons tidak ambigu, jadi proxy tahu
 * kapan respons selesai tanpa menunggu socket ditutup.
 */
export function rejectUpgrade(socket: Duplex, statusLine: string): void {
  socket.end(
    `HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}
