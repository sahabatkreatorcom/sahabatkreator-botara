import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  profilePhotos,
  type Database,
  type ProfilePhoto,
} from "@sahabat-kreator/db";
import type { TenantContext } from "./tenant";
import { withTenantDb } from "./tx";

/**
 * Avatar asli (Fase 6D) — foto profil Telegram untuk akun channel (bot)
 * dan kontak (pengguna), disimpan sebagai byte di tabel `profile_photos`
 * dan disajikan HANYA lewat endpoint kita sendiri di balik sesi +
 * membership. Alasannya keamanan: URL file Bot API menyematkan token bot
 * (`/file/bot<token>/...`) — mengeksposnya ke klien sama dengan membocorkan
 * kredensial penuh channel. Token juga tidak pernah masuk log modul ini:
 * error jaringan fetch bisa memuat URL bertoken, jadi yang dicatat hanya
 * label tahap yang gagal, bukan objek error-nya.
 *
 * Keputusan ukuran foto: `getUserProfilePhotos` mengembalikan, per foto,
 * daftar ukuran menaik (160/320/640/...). Yang disimpan adalah ukuran
 * TERBESAR yang kedua sisinya ≤ 512px — cukup tajam untuk avatar kartu &
 * daftar (ditampilkan ≤96px) tanpa membebani DB; bila semua ukuran lebih
 * besar dari 512px diambil yang TERKECIL (paling ringan di antara yang
 * ada), dan bila semuanya lebih kecil diambil yang terbesar.
 */

export type ProfilePhotoOwnerType = ProfilePhoto["ownerType"];

/** Batas sisi foto profil yang disimpan (lihat keputusan ukuran di atas). */
export const PROFILE_PHOTO_MAX_EDGE = 512;
/** Batas keras ukuran unduhan foto (sanity — foto profil Telegram jauh di bawah ini). */
const PROFILE_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TELEGRAM_API_BASE = "https://api.telegram.org";

// ---------------------------------------------------------------------------
// Penyimpanan (konteks tenant, RLS)
// ---------------------------------------------------------------------------

/**
 * Menyimpan/menimpa foto seorang pemilik (upsert atas index unik
 * (tenant, owner_type, owner_id)). `etag` dihitung dari byte foto
 * (SHA-256 hex) untuk cache HTTP endpoint penyaji.
 */
export async function storeProfilePhoto(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  input: {
    ownerType: ProfilePhotoOwnerType;
    ownerId: string;
    contentType: string;
    data: Buffer;
  },
): Promise<ProfilePhoto> {
  const etag = createHash("sha256").update(input.data).digest("hex");
  const now = new Date();
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .insert(profilePhotos)
      .values({
        tenantId: ctx.tenantId,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        contentType: input.contentType,
        data: input.data,
        etag,
        fetchedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          profilePhotos.tenantId,
          profilePhotos.ownerType,
          profilePhotos.ownerId,
        ],
        set: {
          contentType: input.contentType,
          data: input.data,
          etag,
          fetchedAt: now,
          updatedAt: now,
        },
      })
      .returning();
    return row;
  });
}

/** Satu foto pemilik di tenant ini; null bila belum ada. */
export async function getProfilePhoto(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  ownerType: ProfilePhotoOwnerType,
  ownerId: string,
): Promise<ProfilePhoto | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(profilePhotos)
      .where(
        and(
          eq(profilePhotos.tenantId, ctx.tenantId),
          eq(profilePhotos.ownerType, ownerType),
          eq(profilePhotos.ownerId, ownerId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

/**
 * Himpunan ownerId (dari daftar yang ditanyakan) yang SUDAH punya foto —
 * untuk serializer daftar (channel/kontak/percakapan) memutuskan
 * `avatarUrl` tanpa mengambil byte foto sama sekali.
 */
export async function listProfilePhotoOwnerIds(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  ownerType: ProfilePhotoOwnerType,
  ownerIds: string[],
): Promise<Set<string>> {
  if (ownerIds.length === 0) return new Set();
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const rows = await tx
      .select({ ownerId: profilePhotos.ownerId })
      .from(profilePhotos)
      .where(
        and(
          eq(profilePhotos.tenantId, ctx.tenantId),
          eq(profilePhotos.ownerType, ownerType),
          inArray(profilePhotos.ownerId, ownerIds),
        ),
      );
    return new Set(rows.map((r) => r.ownerId));
  });
}

/**
 * Menghapus foto milik satu akun channel — dipakai purge Sampah (Fase 6I)
 * agar baris foto tidak yatim saat akunnya dihapus permanen. Foto KONTAK
 * tidak disentuh purge (kontak dipertahankan sebagai CRM tenant).
 * Mengembalikan jumlah baris terhapus.
 */
export async function deleteChannelAccountProfilePhoto(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  channelAccountId: string,
): Promise<number> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const removed = await tx
      .delete(profilePhotos)
      .where(
        and(
          eq(profilePhotos.tenantId, ctx.tenantId),
          eq(profilePhotos.ownerType, "channel_account"),
          eq(profilePhotos.ownerId, channelAccountId),
        ),
      )
      .returning({ id: profilePhotos.id });
    return removed.length;
  });
}

// ---------------------------------------------------------------------------
// Pengambilan dari Telegram Bot API
// ---------------------------------------------------------------------------

interface TelegramPhotoSize {
  file_id: string;
  width: number;
  height: number;
}

/** Memilih ukuran foto sesuai keputusan di header modul. */
export function pickTelegramPhotoSize(
  sizes: TelegramPhotoSize[],
): TelegramPhotoSize | null {
  const valid = sizes.filter(
    (s) =>
      typeof s.file_id === "string" &&
      typeof s.width === "number" &&
      typeof s.height === "number",
  );
  if (valid.length === 0) return null;
  const sorted = [...valid].sort((a, b) => a.width - b.width);
  const withinCap = sorted.filter(
    (s) => s.width <= PROFILE_PHOTO_MAX_EDGE && s.height <= PROFILE_PHOTO_MAX_EDGE,
  );
  if (withinCap.length > 0) return withinCap[withinCap.length - 1];
  return sorted[0];
}

function contentTypeForTelegramFile(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  // Foto profil Telegram pada praktiknya selalu JPEG.
  return "image/jpeg";
}

export interface FetchTelegramProfilePhotoInput {
  tenantId: string;
  /** Token bot MENTAH — pemanggil yang mendekripsi (route connect memegangnya langsung). */
  botToken: string;
  /** Base URL Bot API (env TELEGRAM_API_BASE; default api.telegram.org). */
  telegramApiBase?: string;
  /** Id numerik pengguna Telegram (id bot untuk foto bot, id pengirim untuk kontak). */
  telegramUserId: string;
  ownerType: ProfilePhotoOwnerType;
  ownerId: string;
  /** Batas waktu per panggilan HTTP (default 5 dtk — jalur ini best-effort). */
  timeoutMs?: number;
}

/**
 * Mengambil foto profil Telegram seorang pengguna lewat Bot API akun
 * channel dan menyimpannya: `getUserProfilePhotos` → pilih ukuran →
 * `getFile` → unduh byte dari jalur file → upsert ke `profile_photos`.
 *
 * Mengembalikan true bila foto tersimpan; false untuk SEMUA kegagalan
 * maupun keadaan "pengguna tidak punya foto" — fungsi ini TIDAK PERNAH
 * melempar, karena semua pemicunya best-effort (connect, webhook, backfill
 * daftar): foto yang gagal tidak boleh menggagalkan alur utamanya.
 */
export async function fetchAndStoreTelegramProfilePhoto(
  db: Database,
  input: FetchTelegramProfilePhotoInput,
): Promise<boolean> {
  const base = (input.telegramApiBase ?? DEFAULT_TELEGRAM_API_BASE).replace(
    /\/+$/,
    "",
  );
  const timeoutMs = input.timeoutMs ?? 5_000;
  try {
    const callApi = async <T>(method: string, params: Record<string, unknown>): Promise<T | null> => {
      const response = await fetch(`${base}/bot${input.botToken}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return null;
      const body = (await response.json()) as {
        ok?: boolean;
        result?: T;
      };
      return body.ok === true && body.result !== undefined ? body.result : null;
    };

    const photos = await callApi<{
      total_count: number;
      photos: TelegramPhotoSize[][];
    }>("getUserProfilePhotos", { user_id: Number(input.telegramUserId) });
    if (!photos || photos.total_count === 0 || !photos.photos?.[0]) {
      return false; // pengguna memang tidak punya foto profil
    }
    const size = pickTelegramPhotoSize(photos.photos[0]);
    if (!size) return false;

    const file = await callApi<{ file_path?: string }>("getFile", {
      file_id: size.file_id,
    });
    if (!file?.file_path) return false;

    const download = await fetch(
      `${base}/file/bot${input.botToken}/${file.file_path}`,
      { signal: AbortSignal.timeout(timeoutMs) },
    );
    if (!download.ok) return false;
    const bytes = Buffer.from(await download.arrayBuffer());
    if (bytes.length === 0 || bytes.length > PROFILE_PHOTO_MAX_BYTES) {
      return false;
    }

    await storeProfilePhoto(db, { tenantId: input.tenantId }, {
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      contentType: contentTypeForTelegramFile(file.file_path),
      data: bytes,
    });
    return true;
  } catch {
    // SENGAJA tanpa objek error: pesan error fetch bisa memuat URL
    // bertoken. Cukup label tahap di pemanggil bila perlu.
    console.error(
      `[avatars] pengambilan foto profil telegram gagal (owner ${input.ownerType}:${input.ownerId})`,
    );
    return false;
  }
}
