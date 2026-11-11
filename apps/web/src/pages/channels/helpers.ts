/**
 * Fungsi bantu murni halaman Channels: label provider, cuplikan embed,
 * URL demo webchat, pemendek nilai tengah, baris handle, dan tautan
 * publik per provider.
 *
 * Semuanya bebas React dan bebas jaringan — hanya memetakan data
 * channel ke teks/URL — sehingga bisa dipakai ulang dan diuji tanpa
 * merender apa pun.
 */
import type { ChannelAccountResponse } from "@sahabat-kreator/contracts";
import type { Locale, TranslationKey } from "@sahabat-kreator/i18n";

export type Translate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

export interface ChannelsPageProps {
  t: Translate;
  locale: Locale;
}

export function providerLabel(t: Translate, provider: string): string {
  return t(`inbox.providers.${provider}` as TranslationKey);
}

export function embedSnippet(siteKey: string): string {
  const origin =
    typeof window !== "undefined" ? window.location.origin : "https://botara.my.id";
  return `<script src="${origin}/widget.js" data-site-key="${siteKey}"></script>`;
}

/** Tautan demo publik webchat — halaman yang benar-benar bisa dibuka pengunjung. */
export function demoUrl(siteKey: string): string {
  const origin =
    typeof window !== "undefined" ? window.location.origin : "https://botara.my.id";
  return `${origin}/webchat-demo?key=${siteKey}`;
}

/** Potong string panjang di tengah: `wc_kY1iy8xy…kLTw9`. */
export function truncateMiddle(value: string, head = 10, tail = 4): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** Baris @handle di bawah nama kartu; null bila tidak ada yang masuk akal. */
export function handleLine(channel: ChannelAccountResponse): string | null {
  if (channel.provider === "telegram") {
    return channel.botUsername ? `@${channel.botUsername}` : null;
  }
  if (channel.provider === "messenger" || channel.provider === "instagram") {
    // Fase 7A: handle publik Meta dari Graph; Page tanpa username
    // menampilkan Page ID-nya (terpotong rapi seperti siteKey webchat).
    return channel.publicHandle
      ? `@${channel.publicHandle}`
      : truncateMiddle(channel.externalId);
  }
  if (channel.provider === "whatsapp") {
    // Fase 7B: handle WhatsApp = nomor tampil terformat dari Graph
    // (display_phone_number di publicHandle); bukan @handle.
    return channel.publicHandle ?? truncateMiddle(channel.externalId);
  }
  if (channel.provider === "webchat") {
    // Webchat tidak punya @handle — siteKey terpotong adalah identitasnya.
    return truncateMiddle(channel.externalId);
  }
  if (
    channel.provider === "threads" ||
    channel.provider === "tiktok" ||
    channel.provider === "pinterest" ||
    channel.provider === "bluesky"
  ) {
    // Provider sasaran /posts dengan @handle publik (Threads/TikTok/
    // Pinterest username; Bluesky handle = DID tampil? bukan — yang
    // disimpan sebagai publicHandle adalah handle bsky yang terbaca).
    return channel.publicHandle
      ? `@${channel.publicHandle}`
      : truncateMiddle(channel.externalId);
  }
  if (channel.provider === "linkedin") {
    // Profil LinkedIn tidak memakai @handle di kartu — nama tampil
    // adalah identitasnya; baris handle menampilkan slug profil bila
    // ada (publicHandle), selain itu id terpotong.
    return channel.publicHandle ?? truncateMiddle(channel.externalId);
  }
  if (channel.provider === "youtube" || channel.provider === "google_business") {
    // Kanal YouTube / lokasi bisnis: nama tampil adalah identitasnya;
    // tanpa handle publik tersimpan, tampilkan id terpotong.
    return channel.publicHandle
      ? `@${channel.publicHandle}`
      : truncateMiddle(channel.externalId);
  }
  return null;
}

export interface PublicLink {
  url: string;
  display: string;
}

/**
 * Tautan publik kartu + tombol salinnya. Telegram: profil bot t.me (tetap
 * sah walau channel sedang terputus — botnya tetap ada). Webchat: tautan
 * demo, hanya saat connected (channel terputus menolak sesi baru, jadi
 * menampilkannya akan menyesatkan).
 */
export function publicLink(channel: ChannelAccountResponse): PublicLink | null {
  if (channel.provider === "telegram" && channel.botUsername) {
    return {
      url: `https://t.me/${channel.botUsername}`,
      display: `t.me/${channel.botUsername}`,
    };
  }
  // Fase 7A: tautan publik Meta hanya saat connected (pola webchat) —
  // Messenger memakai m.me/<username atau Page ID>; Instagram butuh
  // username (akun IG selalu punya) untuk ig.me/m/<username>.
  if (channel.provider === "messenger" && channel.status === "connected") {
    const slug = channel.publicHandle || channel.externalId;
    return { url: `https://m.me/${slug}`, display: `m.me/${slug}` };
  }
  if (
    channel.provider === "instagram" &&
    channel.status === "connected" &&
    channel.publicHandle
  ) {
    return {
      url: `https://ig.me/m/${channel.publicHandle}`,
      display: `ig.me/m/${channel.publicHandle}`,
    };
  }
  // Fase 7B: chip WhatsApp = wa.me/<digit nomor> (hanya digit dari
  // nomor tampil; phone_number_id BUKAN nomor telepon, jadi tanpa
  // publicHandle tidak ada chip yang jujur untuk ditampilkan).
  if (
    channel.provider === "whatsapp" &&
    channel.status === "connected" &&
    channel.publicHandle
  ) {
    const digits = channel.publicHandle.replace(/\D/g, "");
    if (digits) {
      return { url: `https://wa.me/${digits}`, display: `wa.me/${digits}` };
    }
  }
  if (channel.provider === "webchat" && channel.status === "connected") {
    const url = demoUrl(channel.externalId);
    return { url, display: url.replace(/^https?:\/\//, "") };
  }
  return null;
}
