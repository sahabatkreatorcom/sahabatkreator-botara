import { and, eq, ne } from "drizzle-orm";
import { channelAccounts, type Database } from "@sahabat-kreator/db";
import { fetchAndStoreProfilePhotoFromUrl } from "./avatars";
import {
  GOOGLE_DEFAULT_API_BASE,
  YOUTUBE_READONLY_SCOPE,
  YOUTUBE_UPLOAD_SCOPE,
  getValidGoogleServiceAccess,
  type GoogleDeps,
} from "./google-calendar";
import { withTenantDb } from "./tx";

/**
 * YouTube (Gelombang 2) — jembatan antara koneksi Google tenant dan
 * content schedule.
 *
 * - Sejak pemisahan Google (2026-11-12) kredensial YouTube tenant
 *   tinggal di koneksi layanan YOUTUBE-nya sendiri
 *   (`google_connections` service='youtube', consent sempit
 *   youtube.upload + youtube.readonly, klien OAuth proyek YouTube
 *   sendiri bila diisi Panel Admin) — BUKAN lagi koneksi gabungan
 *   Calendar. Refresh lewat `getValidGoogleServiceAccess(...,
 *   "youtube", ...)` memakai klien penerbit token itu. (Model lama
 *   Gelombang 2 — satu consent gabungan di
 *   `google_calendar_connections` — berakhir di migrasi 0023;
 *   koneksi gabungan lama tersemai menjadi baris youtube di sana
 *   bila scope-nya mencakup.)
 * - Akun channel `provider='youtube'` hanya membawa IDENTITAS kanal:
 *   `external_id` = channel ID (`UC…`), `display_name` = judul kanal,
 *   `public_handle` = @handle kanal (snippet.customUrl), dan foto
 *   kanal disimpan sebagai byte `profile_photos` (thumbnail snippet)
 *   — `access_token_encrypted` tetap NULL. Baris itu yang
 *   dimaterialisasi `listPostTargets` (core/posts) menjadi sasaran
 *   publikasi — adapter worker menukar refresh token koneksi
 *   YouTube menjadi access token lewat `getYouTubePublishAccess` di
 *   sini, bukan membaca token dari akun channel seperti provider
 *   lain.
 *
 * Semua fungsi di sini FAIL-SOFT (`null`/jenis hasil, bukan lemparan)
 * mengikuti model kegagalan google-calendar: YouTube yang belum
 * terhubung tidak boleh menggagalkan fitur lain.
 */

const YOUTUBE_TIMEOUT_MS = 10_000;

function apiBase(deps: GoogleDeps): string {
  return (deps.bases?.apiBase ?? GOOGLE_DEFAULT_API_BASE).replace(/\/+$/, "");
}

/** Scope yang diberikan koneksi (string spasi-terpisah dari Google). */
export function googleScopesInclude(scopes: string, scope: string): boolean {
  return scopes.split(/\s+/).includes(scope);
}

export interface YouTubeChannelIdentity {
  /** Channel ID YouTube (`UC…`) — menjadi `external_id` akun channel. */
  id: string;
  /** Judul kanal — menjadi `display_name` akun channel. */
  title: string;
  /** @handle kanal (`snippet.customUrl`); null bila kanal belum punya handle. */
  handle: string | null;
  /**
   * URL thumbnail kanal (high bila ada, else medium/default) — byte-nya
   * diunduh ke `profile_photos` oleh pemanggil; null bila snippet
   * tidak membawa thumbnail.
   */
  thumbnailUrl: string | null;
}

interface YouTubeSnippet {
  title?: unknown;
  customUrl?: unknown;
  thumbnails?: {
    high?: { url?: unknown };
    medium?: { url?: unknown };
    default?: { url?: unknown };
  };
}

function pickThumbnailUrl(snippet: YouTubeSnippet | undefined): string | null {
  const thumbs = snippet?.thumbnails;
  for (const candidate of [thumbs?.high?.url, thumbs?.medium?.url, thumbs?.default?.url]) {
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return null;
}

/**
 * Kanal milik akun Google di balik access token ini
 * (`channels.list?mine=true`, 1 unit kuota — dipanggil hanya saat
 * sinkronisasi akun / backfill profil, TIDAK pernah dari jalur
 * publikasi). Snippet-nya membawa identitas lengkap kartu Channels:
 * judul, @handle (`customUrl`), dan thumbnail. Null bila token
 * ditolak, akun tidak punya kanal, atau provider tak terjangkau.
 */
export async function fetchYouTubeOwnChannel(
  deps: GoogleDeps,
  accessToken: string,
): Promise<YouTubeChannelIdentity | null> {
  let res: Response;
  try {
    res = await fetch(
      `${apiBase(deps)}/youtube/v3/channels?part=snippet&mine=true`,
      {
        signal: AbortSignal.timeout(YOUTUBE_TIMEOUT_MS),
        headers: { Authorization: "Bearer " + accessToken },
      },
    );
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const body = (await res.json().catch(() => ({}))) as {
    items?: Array<{ id?: unknown; snippet?: YouTubeSnippet }>;
  };
  const item = Array.isArray(body.items) ? body.items[0] : undefined;
  if (!item || typeof item.id !== "string") return null;
  return {
    id: item.id,
    title:
      typeof item.snippet?.title === "string" && item.snippet.title
        ? item.snippet.title
        : item.id,
    handle:
      typeof item.snippet?.customUrl === "string" && item.snippet.customUrl
        ? item.snippet.customUrl
        : null,
    thumbnailUrl: pickThumbnailUrl(item.snippet),
  };
}

/**
 * Sinkronkan akun channel youtube tenant dari koneksi YouTube-nya:
 * ambil access token layanan youtube yang sah, baca kanal
 * (`youtube.readonly` wajib — tanpa scope itu channel ID tidak bisa
 * diketahui), lalu upsert baris `channel_accounts` provider youtube
 * (judul + @handle) dan simpan foto kanal dari thumbnail snippet.
 * Baris youtube LAIN milik tenant yang sama (kanal berganti)
 * diturunkan ke `disconnected`: satu koneksi YouTube = satu kanal
 * aktif.
 *
 * Dipanggil dari callback OAuth Google layanan youtube tepat
 * setelah koneksi youtube disimpan. Mengembalikan identitas kanal,
 * atau null bila sinkron tidak bisa dilakukan (belum terhubung,
 * scope kurang, akun tanpa kanal) — pemanggil mengabaikan null.
 * Pengambilan foto FAIL-SOFT total (helper avatars): gagal unduh
 * tidak menggagalkan sinkron; backfill daftar channel mencoba lagi.
 */
export async function syncYouTubeChannelAccount(
  db: Database,
  tenantId: string,
  deps: GoogleDeps,
): Promise<YouTubeChannelIdentity | null> {
  const access = await getValidGoogleServiceAccess(db, tenantId, "youtube", deps);
  if (!access) return null;
  if (
    !googleScopesInclude(access.connection.scopes, YOUTUBE_READONLY_SCOPE)
  ) {
    return null;
  }
  const channel = await fetchYouTubeOwnChannel(deps, access.accessToken);
  if (!channel) return null;

  const accountId = await withTenantDb(db, tenantId, async (tx) => {
    const [existing] = await tx
      .select({ id: channelAccounts.id })
      .from(channelAccounts)
      .where(
        and(
          eq(channelAccounts.tenantId, tenantId),
          eq(channelAccounts.provider, "youtube"),
          eq(channelAccounts.externalId, channel.id),
        ),
      )
      .limit(1);
    let id: string;
    if (existing) {
      id = existing.id;
      await tx
        .update(channelAccounts)
        .set({
          displayName: channel.title,
          // Handle hanya ditimpa bila Google mengembalikan nilai —
          // snippet tanpa customUrl tidak menghapus handle lama.
          ...(channel.handle ? { publicHandle: channel.handle } : {}),
          status: "connected",
          errorCode: null,
          updatedAt: new Date(),
        })
        .where(eq(channelAccounts.id, existing.id));
    } else {
      const [inserted] = await tx
        .insert(channelAccounts)
        .values({
          tenantId,
          provider: "youtube",
          externalId: channel.id,
          displayName: channel.title,
          publicHandle: channel.handle,
          status: "connected",
        })
        .returning({ id: channelAccounts.id });
      id = inserted!.id;
    }
    await tx
      .update(channelAccounts)
      .set({ status: "disconnected", updatedAt: new Date() })
      .where(
        and(
          eq(channelAccounts.tenantId, tenantId),
          eq(channelAccounts.provider, "youtube"),
          ne(channelAccounts.externalId, channel.id),
          eq(channelAccounts.status, "connected"),
        ),
      );
    return id;
  });

  // Foto kanal: byte thumbnail disimpan ke profile_photos agar kartu
  // Channels tidak lagi placeholder (keluhan pemilik 2026-11-12 —
  // sinkron lama hanya membaca id + judul). Fail-soft: false diabaikan.
  if (channel.thumbnailUrl) {
    await fetchAndStoreProfilePhotoFromUrl(db, {
      tenantId,
      channelAccountId: accountId,
      pictureUrl: channel.thumbnailUrl,
    });
  }
  return channel;
}

/**
 * Backfill profil SATU akun youtube yang sudah terhubung (pasangan
 * `syncYouTubeChannelAccount` untuk akun warisan yang tersinkron
 * sebelum foto/handle diambil): baca kanal dari koneksi youtube
 * tenant, pastikan baris yang diminta memang kanal itu, lengkapi
 * @handle (+ judul bila kosong), lalu simpan foto kanalnya.
 *
 * Dipakai backfill malas daftar channel di API (akun 'connected'
 * tanpa foto) — akun hasil penyemaian migrasi 0023 dan akun yang
 * foto connect-nya gagal unduh mendapat avatar TANPA reconnect.
 * Mengembalikan true bila foto tersimpan; false untuk semua keadaan
 * lain (belum terhubung, scope kurang, kanal berganti, thumbnail
 * tidak ada/gagal) — pemanggil menjadwalkannya ulang lain waktu.
 */
export async function backfillYouTubeChannelProfile(
  db: Database,
  tenantId: string,
  channelAccountId: string,
  deps: GoogleDeps,
): Promise<boolean> {
  const access = await getValidGoogleServiceAccess(db, tenantId, "youtube", deps);
  if (!access) return false;
  if (
    !googleScopesInclude(access.connection.scopes, YOUTUBE_READONLY_SCOPE)
  ) {
    return false;
  }
  const channel = await fetchYouTubeOwnChannel(deps, access.accessToken);
  if (!channel) return false;

  const matches = await withTenantDb(db, tenantId, async (tx) => {
    const [row] = await tx
      .select({
        id: channelAccounts.id,
        externalId: channelAccounts.externalId,
        displayName: channelAccounts.displayName,
        publicHandle: channelAccounts.publicHandle,
      })
      .from(channelAccounts)
      .where(
        and(
          eq(channelAccounts.tenantId, tenantId),
          eq(channelAccounts.id, channelAccountId),
          eq(channelAccounts.provider, "youtube"),
          eq(channelAccounts.status, "connected"),
        ),
      )
      .limit(1);
    // Koneksi kini menunjuk kanal LAIN: baris ini bukan pemilik
    // profil segar itu — jangan menempelkan foto kanal lain.
    if (!row || row.externalId !== channel.id) return false;
    const patch: { publicHandle?: string; displayName?: string } = {};
    if (channel.handle && row.publicHandle !== channel.handle) {
      patch.publicHandle = channel.handle;
    }
    if (!row.displayName && channel.title) {
      patch.displayName = channel.title;
    }
    if (Object.keys(patch).length > 0) {
      await tx
        .update(channelAccounts)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(channelAccounts.id, row.id));
    }
    return true;
  });
  if (!matches || !channel.thumbnailUrl) return false;
  return fetchAndStoreProfilePhotoFromUrl(db, {
    tenantId,
    channelAccountId,
    pictureUrl: channel.thumbnailUrl,
  });
}

export type YouTubePublishAccess =
  | { kind: "ok"; accessToken: string }
  /** Tidak ada koneksi Google yang bisa dipakai (belum terhubung / refresh mati / klien platform belum terkonfigurasi). */
  | { kind: "not_connected" }
  /** Terhubung, tetapi consent koneksi youtube belum mencakup `youtube.upload` — pemilik perlu menghubungkan ulang YouTube. */
  | { kind: "scope_missing" };

/**
 * Access token untuk SATU publikasi YouTube: refresh token koneksi
 * layanan YOUTUBE ditukar/dipakai ulang lewat
 * `getValidGoogleServiceAccess(..., "youtube", ...)` (access token
 * TIDAK pernah disimpan oleh pemanggil; yang berumur panjang hanya
 * refresh token terenkripsi di koneksi youtube). Scope diperiksa
 * dari daftar scope yang diberikan pada koneksi youtube — refresh
 * tidak mengubah scope grant asal. Koneksi Calendar tenant TIDAK
 * lagi bisa menerbitkan YouTube (pemisahan layanan).
 */
export async function getYouTubePublishAccess(
  db: Database,
  tenantId: string,
  deps: GoogleDeps,
): Promise<YouTubePublishAccess> {
  const access = await getValidGoogleServiceAccess(db, tenantId, "youtube", deps);
  if (!access) return { kind: "not_connected" };
  if (!googleScopesInclude(access.connection.scopes, YOUTUBE_UPLOAD_SCOPE)) {
    return { kind: "scope_missing" };
  }
  return { kind: "ok", accessToken: access.accessToken };
}
