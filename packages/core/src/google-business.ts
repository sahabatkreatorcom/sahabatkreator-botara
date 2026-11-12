import { and, eq, notInArray } from "drizzle-orm";
import { channelAccounts, type Database } from "@sahabat-kreator/db";
import {
  GOOGLE_BUSINESS_MANAGE_SCOPE,
  getValidGoogleServiceAccess,
  type GoogleDeps,
} from "./google-calendar";
import { googleScopesInclude } from "./youtube";
import { withTenantDb } from "./tx";

/**
 * Google Business Profile (Gelombang 3) — jembatan antara koneksi
 * Google tenant dan content schedule, saudara kandung core/youtube.
 *
 * - Sejak pemisahan Google (2026-11-12) kredensial Business tenant
 *   tinggal di koneksi layanan BUSINESS-nya sendiri
 *   (`google_connections` service='business', consent sempit
 *   business.manage, klien OAuth proyek Business sendiri bila diisi
 *   Panel Admin) — BUKAN lagi koneksi gabungan Calendar. Refresh
 *   lewat `getValidGoogleServiceAccess(..., "business", ...)`
 *   memakai klien penerbit token itu. (Model lama Gelombang 3 —
 *   satu consent gabungan — berakhir di migrasi 0023; koneksi
 *   gabungan lama tersemai menjadi baris business di sana bila
 *   scope-nya mencakup.)
 * - Akun channel `provider='google_business'` hanya membawa
 *   IDENTITAS LOKASI: `external_id` = nama resource lokasi
 *   (`accounts/{accountId}/locations/{locationId}`), `display_name` =
 *   nama lokasi, `access_token_encrypted` tetap NULL. Satu koneksi
 *   Google bisa mengelola BANYAK lokasi — karena itu sinkronisasi di
 *   sini berbentuk HIMPUNAN (satu baris per lokasi), berbeda dari
 *   YouTube yang satu koneksi = satu kanal. Baris itulah yang
 *   dimaterialisasi `listPostTargets` (core/posts) menjadi sasaran
 *   postingan lokal; adapter worker menukar refresh token koneksi
 *   Google menjadi access token lewat
 *   `getGoogleBusinessPublishAccess` di sini, bukan membaca token
 *   dari akun channel.
 *
 * Semua fungsi di sini FAIL-SOFT (`null`/jenis hasil, bukan lemparan)
 * mengikuti model kegagalan google-calendar/youtube: Google Business
 * yang belum terhubung — atau yang kuota API-nya masih 0 karena
 * pengajuan akses pemilik belum disetujui Google — tidak boleh
 * menggagalkan fitur lain.
 */

export const GOOGLE_BUSINESS_DEFAULT_BASE =
  "https://mybusiness.googleapis.com";
export const GOOGLE_ACCOUNT_MANAGEMENT_DEFAULT_BASE =
  "https://mybusinessaccountmanagement.googleapis.com";

const GOOGLE_BUSINESS_TIMEOUT_MS = 10_000;

function businessBase(deps: GoogleDeps): string {
  return (deps.bases?.businessBase ?? GOOGLE_BUSINESS_DEFAULT_BASE).replace(
    /\/+$/,
    "",
  );
}

function accountManagementBase(deps: GoogleDeps): string {
  return (
    deps.bases?.accountManagementBase ??
    GOOGLE_ACCOUNT_MANAGEMENT_DEFAULT_BASE
  ).replace(/\/+$/, "");
}

export interface GoogleBusinessLocationIdentity {
  /** Nama resource lokasi (`accounts/{a}/locations/{l}`) — menjadi `external_id` akun channel. */
  name: string;
  /** Nama lokasi — menjadi `display_name` akun channel. */
  title: string;
}

interface AccountsResponse {
  accounts?: Array<{ name?: unknown }>;
}

interface LocationsResponse {
  locations?: Array<{ name?: unknown; title?: unknown }>;
}

async function getJson(
  url: string,
  accessToken: string,
): Promise<unknown | null> {
  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(GOOGLE_BUSINESS_TIMEOUT_MS),
      headers: { Authorization: "Bearer " + accessToken },
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

/**
 * Semua lokasi yang dikelola akun Google di balik access token ini:
 * daftar akun dari Account Management API, lalu daftar lokasi tiap
 * akun dari Business Information API (`readMask=name,title` — hanya
 * identitas yang dibutuhkan sasaran). Null bila token ditolak atau
 * provider tak terjangkau; array kosong berarti akun tidak mengelola
 * lokasi mana pun. Dipanggil hanya saat sinkronisasi akun, TIDAK
 * pernah dari jalur publikasi.
 */
export async function fetchGoogleBusinessLocations(
  deps: GoogleDeps,
  accessToken: string,
): Promise<GoogleBusinessLocationIdentity[] | null> {
  const accountsBody = (await getJson(
    `${accountManagementBase(deps)}/v1/accounts`,
    accessToken,
  )) as AccountsResponse | null;
  if (!accountsBody) return null;
  const accountNames = (accountsBody.accounts ?? [])
    .map((account) => account.name)
    .filter((name): name is string => typeof name === "string" && !!name);

  const locations: GoogleBusinessLocationIdentity[] = [];
  for (const accountName of accountNames) {
    const body = (await getJson(
      `${businessBase(deps)}/v1/${accountName}/locations?readMask=name,title`,
      accessToken,
    )) as LocationsResponse | null;
    if (!body) return null;
    for (const location of body.locations ?? []) {
      if (typeof location.name !== "string" || !location.name) continue;
      locations.push({
        name: location.name,
        title:
          typeof location.title === "string" && location.title
            ? location.title
            : location.name,
      });
    }
  }
  return locations;
}

/**
 * Sinkronkan akun lokasi google_business tenant dari koneksi
 * Business-nya: ambil access token layanan business yang sah, baca
 * semua lokasi (`business.manage` wajib — tanpa scope itu daftar
 * lokasi tidak bisa diketahui), lalu upsert satu baris
 * `channel_accounts` per lokasi. Baris google_business LAIN milik
 * tenant yang tidak lagi muncul pada daftar segar diturunkan ke
 * `disconnected`: himpunan lokasi aktif selalu mencerminkan koneksi
 * Business saat ini.
 *
 * Dipanggil dari callback OAuth Google layanan business tepat
 * setelah koneksi business disimpan. Mengembalikan daftar lokasi,
 * atau null bila sinkron tidak bisa dilakukan (belum terhubung,
 * scope kurang, provider tak terjangkau) — pemanggil mengabaikan
 * null.
 */
export async function syncGoogleBusinessLocationAccounts(
  db: Database,
  tenantId: string,
  deps: GoogleDeps,
): Promise<GoogleBusinessLocationIdentity[] | null> {
  const access = await getValidGoogleServiceAccess(db, tenantId, "business", deps);
  if (!access) return null;
  if (
    !googleScopesInclude(access.connection.scopes, GOOGLE_BUSINESS_MANAGE_SCOPE)
  ) {
    return null;
  }
  const locations = await fetchGoogleBusinessLocations(
    deps,
    access.accessToken,
  );
  if (!locations) return null;

  await withTenantDb(db, tenantId, async (tx) => {
    for (const location of locations) {
      const [existing] = await tx
        .select({ id: channelAccounts.id })
        .from(channelAccounts)
        .where(
          and(
            eq(channelAccounts.tenantId, tenantId),
            eq(channelAccounts.provider, "google_business"),
            eq(channelAccounts.externalId, location.name),
          ),
        )
        .limit(1);
      if (existing) {
        await tx
          .update(channelAccounts)
          .set({
            displayName: location.title,
            status: "connected",
            errorCode: null,
            updatedAt: new Date(),
          })
          .where(eq(channelAccounts.id, existing.id));
      } else {
        await tx.insert(channelAccounts).values({
          tenantId,
          provider: "google_business",
          externalId: location.name,
          displayName: location.title,
          status: "connected",
        });
      }
    }
    // Lokasi yang hilang dari daftar segar (dilepas dari akun Google
    // / koneksi berganti) tidak boleh tetap menjadi sasaran aktif.
    // Daftar segar KOSONG berarti akun tidak lagi mengelola lokasi:
    // kondisi nama dikecualikan gugur dan semua baris lokasi tenant
    // turun ke disconnected.
    const freshNames = locations.map((location) => location.name);
    await tx
      .update(channelAccounts)
      .set({ status: "disconnected", updatedAt: new Date() })
      .where(
        and(
          eq(channelAccounts.tenantId, tenantId),
          eq(channelAccounts.provider, "google_business"),
          eq(channelAccounts.status, "connected"),
          ...(freshNames.length > 0
            ? [notInArray(channelAccounts.externalId, freshNames)]
            : []),
        ),
      );
  });
  return locations;
}

export type GoogleBusinessPublishAccess =
  | { kind: "ok"; accessToken: string }
  /** Tidak ada koneksi Google yang bisa dipakai (belum terhubung / refresh mati / klien platform belum terkonfigurasi). */
  | { kind: "not_connected" }
  /** Terhubung, tetapi consent koneksi business belum mencakup `business.manage` — pemilik perlu menghubungkan ulang Google Business. */
  | { kind: "scope_missing" };

/**
 * Access token untuk SATU publikasi Google Business: refresh token
 * koneksi layanan BUSINESS ditukar/dipakai ulang lewat
 * `getValidGoogleServiceAccess(..., "business", ...)` (access token
 * TIDAK pernah disimpan oleh pemanggil). Scope diperiksa dari
 * daftar scope yang diberikan pada koneksi business — refresh tidak
 * mengubah scope grant asal. Koneksi Calendar/YouTube tenant TIDAK
 * bisa menerbitkan Business Profile (pemisahan layanan).
 */
export async function getGoogleBusinessPublishAccess(
  db: Database,
  tenantId: string,
  deps: GoogleDeps,
): Promise<GoogleBusinessPublishAccess> {
  const access = await getValidGoogleServiceAccess(db, tenantId, "business", deps);
  if (!access) return { kind: "not_connected" };
  if (
    !googleScopesInclude(access.connection.scopes, GOOGLE_BUSINESS_MANAGE_SCOPE)
  ) {
    return { kind: "scope_missing" };
  }
  return { kind: "ok", accessToken: access.accessToken };
}
