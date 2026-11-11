import { and, eq, ne } from "drizzle-orm";
import { channelAccounts, type Database } from "@sahabat-kreator/db";
import {
  GOOGLE_DEFAULT_API_BASE,
  YOUTUBE_READONLY_SCOPE,
  YOUTUBE_UPLOAD_SCOPE,
  getValidGoogleAccess,
  type GoogleDeps,
} from "./google-calendar";
import { withTenantDb } from "./tx";

/**
 * YouTube (Gelombang 2) — jembatan antara koneksi Google tenant dan
 * content schedule. Modul ini TIDAK membuat jalur OAuth kedua:
 *
 * - Koneksi Google (Fase 13G, `google_calendar_connections`) adalah
 *   SATU-SATUNYA tempat kredensial Google tenant tinggal — access +
 *   refresh token terenkripsi, klien OAuth milik platform, refresh
 *   lewat `getValidGoogleAccess` yang sama dengan Google Calendar.
 *   Sejak gelombang ini `GOOGLE_OAUTH_SCOPES` juga meminta
 *   `youtube.upload` + `youtube.readonly`, jadi satu consent melayani
 *   kalender dan kanal.
 * - Akun channel `provider='youtube'` hanya membawa IDENTITAS kanal:
 *   `external_id` = channel ID (`UC…`), `display_name` = judul kanal,
 *   `access_token_encrypted` tetap NULL. Baris itu yang
 *   dimaterialisasi `listPostTargets` (core/posts) menjadi sasaran
 *   publikasi — adapter worker menukar refresh token koneksi Google
 *   menjadi access token lewat `getYouTubePublishAccess` di sini,
 *   bukan membaca token dari akun channel seperti provider lain.
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
}

/**
 * Kanal milik akun Google di balik access token ini
 * (`channels.list?mine=true`, 1 unit kuota — dipanggil hanya saat
 * sinkronisasi akun, TIDAK pernah dari jalur publikasi). Null bila
 * token ditolak, akun tidak punya kanal, atau provider tak terjangkau.
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
    items?: Array<{ id?: unknown; snippet?: { title?: unknown } }>;
  };
  const item = Array.isArray(body.items) ? body.items[0] : undefined;
  if (!item || typeof item.id !== "string") return null;
  return {
    id: item.id,
    title:
      typeof item.snippet?.title === "string" && item.snippet.title
        ? item.snippet.title
        : item.id,
  };
}

/**
 * Sinkronkan akun channel youtube tenant dari koneksi Googlenya:
 * ambil access token yang sah, baca kanal (`youtube.readonly`
 * wajib — tanpa scope itu channel ID tidak bisa diketahui), lalu
 * upsert baris `channel_accounts` provider youtube. Baris youtube
 * LAIN milik tenant yang sama (kanal berganti) diturunkan ke
 * `disconnected`: satu koneksi Google = satu kanal aktif.
 *
 * Dipanggil dari callback OAuth Google (modul janji temu) tepat
 * setelah koneksi disimpan. Mengembalikan identitas kanal, atau null
 * bila sinkron tidak bisa dilakukan (belum terhubung, scope kurang,
 * akun tanpa kanal) — pemanggil mengabaikan null.
 */
export async function syncYouTubeChannelAccount(
  db: Database,
  tenantId: string,
  deps: GoogleDeps,
): Promise<YouTubeChannelIdentity | null> {
  const access = await getValidGoogleAccess(db, tenantId, deps);
  if (!access) return null;
  if (
    !googleScopesInclude(access.connection.scopes, YOUTUBE_READONLY_SCOPE)
  ) {
    return null;
  }
  const channel = await fetchYouTubeOwnChannel(deps, access.accessToken);
  if (!channel) return null;

  await withTenantDb(db, tenantId, async (tx) => {
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
    if (existing) {
      await tx
        .update(channelAccounts)
        .set({
          displayName: channel.title,
          status: "connected",
          errorCode: null,
          updatedAt: new Date(),
        })
        .where(eq(channelAccounts.id, existing.id));
    } else {
      await tx.insert(channelAccounts).values({
        tenantId,
        provider: "youtube",
        externalId: channel.id,
        displayName: channel.title,
        status: "connected",
      });
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
  });
  return channel;
}

export type YouTubePublishAccess =
  | { kind: "ok"; accessToken: string }
  /** Tidak ada koneksi Google yang bisa dipakai (belum terhubung / refresh mati / klien platform belum terkonfigurasi). */
  | { kind: "not_connected" }
  /** Terhubung, tetapi consent lama belum mencakup `youtube.upload` — pemilik perlu menghubungkan ulang Google. */
  | { kind: "scope_missing" };

/**
 * Access token untuk SATU publikasi YouTube: refresh token koneksi
 * Google ditukar/dipakai ulang lewat `getValidGoogleAccess` yang sama
 * dengan Calendar (access token TIDAK pernah disimpan oleh pemanggil;
 * yang berumur panjang hanya refresh token terenkripsi di koneksi).
 * Scope diperiksa dari daftar scope yang diberikan pada koneksi —
 * refresh tidak mengubah scope grant asal.
 */
export async function getYouTubePublishAccess(
  db: Database,
  tenantId: string,
  deps: GoogleDeps,
): Promise<YouTubePublishAccess> {
  const access = await getValidGoogleAccess(db, tenantId, deps);
  if (!access) return { kind: "not_connected" };
  if (!googleScopesInclude(access.connection.scopes, YOUTUBE_UPLOAD_SCOPE)) {
    return { kind: "scope_missing" };
  }
  return { kind: "ok", accessToken: access.accessToken };
}
