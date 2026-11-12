import type { Database } from "@sahabat-kreator/db";
import {
  getPostTargetProvider,
  type GoogleDeps,
  type MediaObjectStore,
} from "@sahabat-kreator/core";
import { telegramPostPublisher } from "./telegram-post";
import {
  facebookPagePostPublisher,
  instagramPostPublisher,
} from "./meta-post";
import { threadsPostPublisher } from "./threads-post";
import { blueskyPostPublisher } from "./bluesky-post";
import { youtubePostPublisher } from "./youtube-post";
import { linkedinPostPublisher } from "./linkedin-post";
import { pinterestPostPublisher } from "./pinterest-post";
import { googleBusinessPostPublisher } from "./google-business-post";
import { tiktokPostPublisher } from "./tiktok-post";

/**
 * PublisherAdapter (Gelombang 0, butir 1 roadmap content schedule) —
 * satu interface penerbit per provider, dan registry yang memilihnya.
 *
 * Sebelum ini worker memanggil penerbit Telegram secara langsung:
 * menambah platform berarti mengutak-atik handler job `post.publish`.
 * Sekarang handler hanya memanggil `publishPost` di sini; platform baru
 * = satu adapter baru + satu baris registry, tanpa menyentuh handler,
 * core, maupun state machine.
 *
 * Kontrak adapter: menjalankan SELURUH alur publikasi untuk satu
 * postingan (klaim atomik → muat → dekripsi kredensial → kirim → tandai),
 * persis seperti yang dilakukan penerbit Telegram sejak Fase 23.
 * Urutan itu tidak dinegosiasikan ulang per adapter — klaim atomik +
 * pencocokan `scheduled_at` adalah satu-satunya penjaga anti kirim
 * ganda, dan ia hidup di langkah pertama alur tersebut.
 */

export interface PostPublishJobInput {
  tenantId: string;
  postId: string;
  /** ISO timestamp jam tayang yang disepakati saat penjadwalan. */
  scheduledAt: string;
}

export interface PostPublisherOptions {
  /** Material kunci enkripsi kredensial channel (env CHANNEL_TOKEN_SECRET). */
  channelTokenSecret: string | undefined;
  /** Penyimpanan objek media (volume/R2) — sama dengan yang dipakai GC. */
  mediaStore: MediaObjectStore;
  /** Base URL Bot API Telegram (env TELEGRAM_API_BASE; default api.telegram.org). */
  telegramApiBase?: string | undefined;
  /** Base URL Meta Graph API (env META_API_BASE; default graph.facebook.com). */
  metaApiBase?: string | undefined;
  /** Versi Graph ter-pin dari config platform. */
  metaGraphApiVersion?: string | undefined;
  /** Base URL Threads API (env THREADS_API_BASE; default graph.threads.net). */
  threadsApiBase?: string | undefined;
  /** Base URL entryway/PDS Bluesky (env BLUESKY_API_BASE; default bsky.social). */
  blueskyApiBase?: string | undefined;
  /**
   * Dependensi Google (klien OAuth platform + secret token + base URL)
   * — objek yang sama dengan yang dipakai sinkron Google Calendar.
   * Dipakai adapter YouTube untuk menukar refresh token koneksi
   * Google tenant menjadi access token; base URL API-nya
   * (`bases.apiBase`, env GOOGLE_API_BASE) menjadi base klien YouTube.
   */
  google?: GoogleDeps | undefined;
  /**
   * Bawaan platform untuk status privasi video YouTube (resolver
   * Panel Admin → env YOUTUBE_PRIVACY_STATUS; bawaan `private`).
   * Sejak gelombang Pilihan Privasi & AI ini hanya LAPIS BAWAAN:
   * pilihan pengguna pada postingan (`publishOptions`) menimpanya;
   * bawaan berlaku untuk postingan yang tidak memilih.
   */
  youtubePrivacyStatus?: string | undefined;
  /** Base URL LinkedIn API (env LINKEDIN_API_BASE; default api.linkedin.com). */
  linkedinApiBase?: string | undefined;
  /** Base URL Pinterest API v5 (env PINTEREST_API_BASE; default api.pinterest.com). */
  pinterestApiBase?: string | undefined;
  /**
   * Base URL Business Profile API (env GOOGLE_BUSINESS_API_BASE;
   * default mybusiness.googleapis.com — host-nya terpisah dari
   * `google.bases.apiBase` Calendar/YouTube). Kredensialnya tetap
   * dari objek `google` di atas.
   */
  googleBusinessApiBase?: string | undefined;
  /** Base URL TikTok API (env TIKTOK_API_BASE; default open.tiktokapis.com). */
  tiktokApiBase?: string | undefined;
  /**
   * Bawaan platform untuk level privasi direct post TikTok
   * (resolver Panel Admin → env TIKTOK_PRIVACY_LEVEL; bawaan
   * `SELF_ONLY`). Sejak gelombang Pilihan Privasi & AI ini hanya
   * LAPIS BAWAAN untuk postingan TANPA pilihan (lama/non-formulir):
   * pilihan pengguna pada postingan menimpanya, dan penjadwalan
   * dari formulir mewajibkan pilihan eksplisit (guidelines TikTok
   * melarang nilai terpilih duluan). Apa pun sumbernya, level tetap
   * divalidasi adapter terhadap `privacy_level_options` akun.
   */
  tiktokPrivacyLevel?: string | undefined;
  /** Jeda polling status publikasi TikTok; default 3000 ms. */
  tiktokStatusPollIntervalMs?: number | undefined;
  /** Batas polling status publikasi TikTok; default 20 kali. */
  tiktokStatusMaxPolls?: number | undefined;
  /**
   * Base URL publik yang memetakan `r2Key` media ke URL yang dapat
   * diambil provider eksternal. Media internal repo SENGAJA privat
   * (endpoint API bersesi), jadi adapter container Meta (IG/Threads)
   * dan jalur `image_url` Pinterest gagal aman tanpa konfigurasi
   * ini. Bentuk URL final: `{base}/{r2Key}` dengan tiap segmen path
   * ter-encode.
   */
  publicMediaBaseUrl?: string | undefined;
  /** Resolver URL media publik khusus — dipakai rantai uji/mock. */
  resolvePublicMediaUrl?: (
    media: { r2Key: string; mimeType: string | null; fileName: string | null },
  ) => string | null;
  /** Jeda polling status container Meta; default 3000 ms. */
  metaContainerPollIntervalMs?: number | undefined;
  /** Batas polling status container Meta; default 20 kali. */
  metaContainerMaxPolls?: number | undefined;
}

export interface PublishPostResult {
  published: boolean;
  /** Alasan aman untuk log (tanpa token/URL). */
  reason?: string;
}

/**
 * Resolusi URL media publik untuk API container (Instagram/Threads).
 *
 * Media repo TIDAK pernah diekspos apa adanya: object store privat dan
 * endpoint API media memeriksa sesi + tenant. Fungsi ini hanya memakai
 * resolver khusus (rantai uji / integrasi CDN bertanda tangan di luar
 * repo) atau base URL publik yang secara eksplisit dikonfigurasi
 * operator sebagai pemetaan `{base}/{r2Key}`. Tanpa keduanya ia
 * mengembalikan null dan adapter gagal SEBELUM memanggil provider —
 * bukan menebak URL internal yang pasti ditolak provider.
 */
export function resolvePostPublicMediaUrl(
  opts: PostPublisherOptions,
  media: { r2Key: string; mimeType: string | null; fileName: string | null },
): string | null {
  const custom = opts.resolvePublicMediaUrl?.(media);
  if (custom) return custom;
  if (!opts.publicMediaBaseUrl) return null;
  const base = opts.publicMediaBaseUrl.replace(/\/+$/, "");
  const path = media.r2Key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${base}/${path}`;
}

export interface PostPublisherAdapter {
  /** Nilai provider pada percakapan sasaran (mis. `telegram`). */
  readonly provider: string;
  publish(
    db: Database,
    input: PostPublishJobInput,
    opts: PostPublisherOptions,
  ): Promise<PublishPostResult>;
}

/** Registry adapter. Urutan tidak berarti; kunci pemilihan adalah provider. */
const POST_PUBLISHERS: readonly PostPublisherAdapter[] = [
  telegramPostPublisher,
  facebookPagePostPublisher,
  instagramPostPublisher,
  threadsPostPublisher,
  blueskyPostPublisher,
  youtubePostPublisher,
  linkedinPostPublisher,
  pinterestPostPublisher,
  googleBusinessPostPublisher,
  tiktokPostPublisher,
];

export function getPostPublisher(
  provider: string,
): PostPublisherAdapter | undefined {
  return POST_PUBLISHERS.find((adapter) => adapter.provider === provider);
}

/**
 * Pintu masuk handler job `post.publish`: pilih adapter dari provider
 * sasaran postingan, lalu serahkan seluruh alur ke adapter itu.
 *
 * Provider dibaca lewat intipan read-only di core (`getPostTargetProvider`)
 * — BUKAN klaim. Klaim tetap terjadi di dalam adapter, jadi postingan yang
 * dibatalkan/dijadwal ulang di antara intipan dan klaim tetap aman.
 */
export async function publishPost(
  db: Database,
  input: PostPublishJobInput,
  opts: PostPublisherOptions,
): Promise<PublishPostResult> {
  const provider = await getPostTargetProvider(db, {
    tenantId: input.tenantId,
    postId: input.postId,
  });
  if (!provider) {
    console.error(`[post] ${input.postId} tidak ditemukan — job dilewati`);
    return { published: false, reason: "not_found" };
  }
  const adapter = getPostPublisher(provider);
  if (!adapter) {
    // Tidak terjangkau selama `schedulePost` di core hanya mengizinkan
    // provider yang punya adapter — penjadwalan provider lain ditolak
    // di sana. Bila suatu hari sampai di sini, postingan DIBIARKAN pada
    // statusnya: menandainya gagal dari dispatcher akan mengklaim
    // kegagalan yang bukan milik alur adapter mana pun.
    console.error(
      `[post] ${input.postId} provider=${provider} belum punya PublisherAdapter — job dilewati`,
    );
    return { published: false, reason: "provider_unsupported" };
  }
  return adapter.publish(db, input, opts);
}
