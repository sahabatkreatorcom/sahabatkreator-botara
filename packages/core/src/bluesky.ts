import { and, eq } from "drizzle-orm";
import {
  auditLogs,
  channelAccounts,
  type ChannelAccount,
  type Database,
} from "@sahabat-kreator/db";
import type { TenantContext } from "./tenant";
import { withTenantDb } from "./tx";

/**
 * Service domain Bluesky (gelombang Semua OAuth — connect memakai
 * FORMULIR handle + App Password; Bluesky/AT Protocol TIDAK punya
 * OAuth untuk aplikasi pihak ketiga seperti ini).
 *
 * Model akun (sama seperti yang diasumsikan adapter penerbit
 * Gelombang 1.5 sejak awal):
 * - provider `bluesky`; external_id = DID akun (hasil
 *   `createSession` saat connect memvalidasi kredensial) — adapter
 *   memakai DID ini sebagai identifier sesi penerbitan
 *   (provider_chat_id sasaran sintetis = DID).
 * - Yang tersimpan TERENKRIPSI di `access_token_encrypted` adalah
 *   APP PASSWORD Bluesky (envelope CHANNEL_TOKEN_SECRET), BUKAN
 *   token sesi: adapter menukarnya menjadi sesi XRPC segar setiap
 *   kali menerbitkan dan accessJwt tidak pernah disimpan. App
 *   password tidak berkedaluwarsa, jadi TIDAK ada lifecycle token
 *   untuk provider ini (token_type/token_expires_at tetap NULL —
 *   tidak dipindai runner mana pun); pencabutan app password di
 *   Bluesky membuat penerbitan gagal `bluesky_*` dan operator
 *   menghubungkan ulang dari Channels.
 * - public_handle = handle akun (tanpa '@'); display_name = handle
 *   yang sama (AT Protocol tidak memberi nama tampil dari sesi).
 *
 * Bluesky BUKAN channel inbox. Baris akun yang terhubung otomatis
 * menjadi sasaran /posts lewat materialisasi
 * `ensureTimelineTargets` (posts.ts) — bentuknya persis akun
 * Gelombang 1.5, jadi tidak ada perubahan di posts.
 */

export interface CreateBlueskyChannelInput {
  /** DID akun (dari respons createSession yang memvalidasi kredensial). */
  accountExternalId: string;
  /** Handle akun dari sesi (tanpa '@'); dipakai handle + nama tampil. */
  publicHandle: string;
  /** Envelope enkripsi APP PASSWORD — BUKAN password mentah. */
  encryptedAppPassword: string;
}

export async function createBlueskyChannelAccount(
  db: Database,
  ctx: Pick<TenantContext, "tenantId" | "userId"> & { userId: string },
  input: CreateBlueskyChannelInput,
): Promise<ChannelAccount> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .insert(channelAccounts)
      .values({
        tenantId: ctx.tenantId,
        provider: "bluesky",
        externalId: input.accountExternalId,
        displayName: input.publicHandle,
        status: "connected",
        // App password terenkripsi pada kolom token akun — bentuk
        // yang memang dibaca adapter penerbit (lihat header modul).
        accessTokenEncrypted: input.encryptedAppPassword,
        publicHandle: input.publicHandle,
        // Tanpa lifecycle: app password tidak berkedaluwarsa.
        tokenType: null,
        tokenExpiresAt: null,
        tokenHealth: "ok",
        errorCode: null,
      })
      .returning();

    await tx.insert(auditLogs).values({
      tenantId: ctx.tenantId,
      actorType: "user",
      actorId: ctx.userId,
      action: "channel.created",
      // Metadata aman: handle memang publik; app password tidak dicatat.
      meta: {
        channelAccountId: row.id,
        provider: "bluesky",
        publicHandle: input.publicHandle,
      },
    });

    return row;
  });
}

export interface UpdateBlueskyCredentialsInput {
  /** Envelope enkripsi app password baru; undefined = jangan ubah. */
  encryptedAppPassword?: string;
  publicHandle?: string;
  status?: ChannelAccount["status"];
  /** Kode error koneksi; undefined = jangan ubah. */
  errorCode?: string | null;
}

/**
 * Menulis ulang kredensial/status akun Bluesky yang SUDAH ada di
 * tenant ini — jalur "revive" connect formulir (pola
 * `updateTikTokChannelAccountCredentials`): akun berstatus
 * 'disconnected'/'error' dihubungkan lagi tanpa baris duplikat.
 * Menghubungkan lagi selalu mengeluarkan akun dari Sampah.
 */
export async function updateBlueskyChannelAccountCredentials(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  channelAccountId: string,
  input: UpdateBlueskyCredentialsInput,
): Promise<ChannelAccount | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const patch: Partial<ChannelAccount> = { updatedAt: new Date() };
    if (input.encryptedAppPassword !== undefined) {
      patch.accessTokenEncrypted = input.encryptedAppPassword;
      // Kredensial baru = akun sehat & bersih lagi.
      patch.tokenHealth = "ok";
      patch.errorCode = null;
    }
    if (input.publicHandle !== undefined) {
      patch.publicHandle = input.publicHandle;
      patch.displayName = input.publicHandle;
    }
    if (input.errorCode !== undefined) patch.errorCode = input.errorCode;
    if (input.status !== undefined) patch.status = input.status;
    if (input.status === "connected") {
      patch.trashedAt = null;
      // Hubungkan ulang = kesalahan koneksi sebelumnya selesai.
      patch.errorCode = null;
    }

    const [row] = await tx
      .update(channelAccounts)
      .set(patch)
      .where(
        and(
          eq(channelAccounts.tenantId, ctx.tenantId),
          eq(channelAccounts.id, channelAccountId),
        ),
      )
      .returning();
    return row ?? null;
  });
}
