import { and, asc, count, eq, sum } from "drizzle-orm";
import {
  auditLogs,
  discountCodes,
  discountRedemptions,
  type Database,
  type DiscountCode,
} from "@sahabat-kreator/db";
import type {
  CreateDiscountCodeRequest,
  DiscountRejectReason,
  UpdateDiscountCodeRequest,
} from "@sahabat-kreator/contracts";
import type { TenantContext } from "./tenant";
import { withTenantDb, type DbTx } from "./tx";

/**
 * Service domain Kode Diskon & Penukaran (Gelombang G14).
 *
 * Keputusan yang dijaga di sini:
 * - Kode disimpan TERNORMALISASI huruf besar; semua pencarian
 *   menormalkan lebih dulu (pelanggan mengetik bebas huruf besar/
 *   kecil + spasi tepi). Pola sah ditegakkan kontrak + pemeriksaan
 *   `normalizeDiscountCode` mengembalikan null untuk pola tak sah.
 * - Commerce repo IDR-only: kind 'fixed' adalah nominal Rupiah yang
 *   mengikuti mata uang pesanan — tidak ada mata uang per kode.
 * - Persen dibulatkan ke BAWAH (floor) ke Rupiah penuh; nominal
 *   dibatasi subtotal. Diskon tidak pernah negatif dan tidak pernah
 *   melebihi subtotal.
 * - BATAS dihitung dari baris penukaran berstatus 'redeemed' saja.
 *   Order yang berakhir expired/cancelled melepas penukarannya
 *   (releaseRedemptionsForOrderTx, dipanggil hook penyelesaian
 *   order) → kuota kembali. Order paid mempertahankan penukarannya.
 * - KLAIM ATOMIK: claimDiscountTx mengunci baris kode dengan
 *   SELECT … FOR UPDATE di dalam transaksi pemanggil, lalu MENGHITUNG
 *   ULANG jumlah penukaran sebelum INSERT — dua checkout bersamaan
 *   yang memperebutkan satu sisa kuota terserialisasi pada kunci
 *   baris itu; tepat satu yang lolos, sisanya menerima alasan
 *   'exhausted'/'contact_limit' yang jujur.
 */

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,63}$/;

/** Normalisasi teks kode (trim + huruf besar); null bila pola tak sah. */
export function normalizeDiscountCode(raw: string): string | null {
  const normalized = raw.trim().toUpperCase();
  return CODE_PATTERN.test(normalized) ? normalized : null;
}

/** Jumlah diskon (Rupiah penuh) untuk subtotal tertentu. */
export function computeDiscountAmountIdr(
  row: Pick<DiscountCode, "kind" | "value">,
  subtotalIdr: number,
): number {
  if (subtotalIdr <= 0) return 0;
  const raw =
    row.kind === "percent"
      ? Math.floor((subtotalIdr * row.value) / 100)
      : row.value;
  return Math.max(0, Math.min(raw, subtotalIdr));
}

async function countRedemptionsTx(
  tx: DbTx,
  tenantId: string,
  discountCodeId: string,
  contactId?: string,
): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(discountRedemptions)
    .where(
      and(
        eq(discountRedemptions.tenantId, tenantId),
        eq(discountRedemptions.discountCodeId, discountCodeId),
        eq(discountRedemptions.status, "redeemed"),
        ...(contactId
          ? [eq(discountRedemptions.contactId, contactId)]
          : []),
      ),
    );
  return Number(row?.n ?? 0);
}

/**
 * Validasi sebuah baris kode terhadap konteks checkout. Urutan
 * pemeriksaan tetap: aktif → jendela → minimum → batas total →
 * batas per kontak; alasan pertama yang gagal adalah yang dilaporkan.
 */
function validateDiscountRow(
  row: DiscountCode,
  input: { subtotalIdr: number; totalRedeemed: number; contactRedeemed: number },
  now: Date,
): DiscountRejectReason | null {
  if (!row.isActive) return "inactive";
  if (row.startsAt && now < row.startsAt) return "not_started";
  if (row.endsAt && now >= row.endsAt) return "expired";
  if (input.subtotalIdr < row.minOrderIdr) return "below_minimum";
  if (row.maxRedemptions !== null && input.totalRedeemed >= row.maxRedemptions)
    return "exhausted";
  if (
    row.maxPerContact !== null &&
    input.contactRedeemed >= row.maxPerContact
  )
    return "contact_limit";
  return null;
}

export type DiscountPreview =
  | {
      kind: "ok";
      code: DiscountCode;
      discountAmountIdr: number;
      totalIdr: number;
    }
  | { kind: "invalid"; reason: DiscountRejectReason };

/**
 * Pratinjau TANPA klaim (baca saja): dipakai node flow cart_checkout
 * untuk mengetahui total sesudah diskon SEBELUM sesi checkout
 * provider disiapkan di luar transaksi. Hasilnya advisori — klaim
 * yang mengikat selalu diulang secara atomik oleh claimDiscountTx
 * di dalam transaksi checkout.
 */
export async function previewDiscount(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  input: { code: string; contactId: string; subtotalIdr: number },
): Promise<DiscountPreview> {
  const normalized = normalizeDiscountCode(input.code);
  if (!normalized) return { kind: "invalid", reason: "not_found" };
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(discountCodes)
      .where(
        and(
          eq(discountCodes.tenantId, ctx.tenantId),
          eq(discountCodes.code, normalized),
        ),
      )
      .limit(1);
    if (!row) return { kind: "invalid" as const, reason: "not_found" as const };
    const [totalRedeemed, contactRedeemed] = await Promise.all([
      countRedemptionsTx(tx, ctx.tenantId, row.id),
      countRedemptionsTx(tx, ctx.tenantId, row.id, input.contactId),
    ]);
    const reason = validateDiscountRow(
      row,
      { subtotalIdr: input.subtotalIdr, totalRedeemed, contactRedeemed },
      new Date(),
    );
    if (reason) return { kind: "invalid" as const, reason };
    const discountAmountIdr = computeDiscountAmountIdr(row, input.subtotalIdr);
    return {
      kind: "ok" as const,
      code: row,
      discountAmountIdr,
      totalIdr: input.subtotalIdr - discountAmountIdr,
    };
  });
}

export type DiscountClaim =
  | {
      kind: "ok";
      code: DiscountCode;
      discountAmountIdr: number;
    }
  | { kind: "invalid"; reason: DiscountRejectReason };

/**
 * Klaim diskon yang lolos pratinjau tetapi GAGAL saat klaim atomik di
 * dalam transaksi checkout (balapan kuota terakhir / kode dinonaktifkan
 * di tengah jalan), sementara sesi checkout provider SUDAH disiapkan
 * dengan total sesudah diskon. Checkout tidak boleh lanjut: tautan
 * akan lahir dengan jumlah yang tidak cocok dengan sesinya. Transaksi
 * dibatalkan seluruhnya (keranjang tetap terbuka) dan pemanggil
 * melaporkan kegagalan secara jujur agar pelanggan bisa mencoba lagi.
 */
export class DiscountClaimLostError extends Error {
  readonly reason: DiscountRejectReason;
  constructor(reason: DiscountRejectReason) {
    super(`Klaim kode diskon gagal saat checkout: ${reason}`);
    this.name = "DiscountClaimLostError";
    this.reason = reason;
  }
}

/**
 * Klaim penukaran ATOMIK dalam transaksi pemanggil (checkout):
 * kunci baris kode FOR UPDATE → hitung ulang → validasi → INSERT
 * baris penukaran yang terhubung ke order + kontak. Pemanggil
 * bertanggung jawab memakai discountAmountIdr hasil klaim ini
 * (bukan hasil pratinjau) untuk total order & tautan bayarnya.
 */
export async function claimDiscountTx(
  tx: DbTx,
  tenantId: string,
  input: {
    code: string;
    contactId: string;
    orderId: string;
    subtotalIdr: number;
  },
): Promise<DiscountClaim> {
  const normalized = normalizeDiscountCode(input.code);
  if (!normalized) return { kind: "invalid", reason: "not_found" };
  const [row] = await tx
    .select()
    .from(discountCodes)
    .where(
      and(
        eq(discountCodes.tenantId, tenantId),
        eq(discountCodes.code, normalized),
      ),
    )
    .limit(1)
    .for("update");
  if (!row) return { kind: "invalid", reason: "not_found" };
  const totalRedeemed = await countRedemptionsTx(tx, tenantId, row.id);
  const contactRedeemed = await countRedemptionsTx(
    tx,
    tenantId,
    row.id,
    input.contactId,
  );
  const reason = validateDiscountRow(
    row,
    { subtotalIdr: input.subtotalIdr, totalRedeemed, contactRedeemed },
    new Date(),
  );
  if (reason) return { kind: "invalid", reason };
  const discountAmountIdr = computeDiscountAmountIdr(row, input.subtotalIdr);
  await tx.insert(discountRedemptions).values({
    tenantId,
    discountCodeId: row.id,
    orderId: input.orderId,
    contactId: input.contactId,
    code: row.code,
    discountAmountIdr,
    status: "redeemed",
  });
  return { kind: "ok", code: row, discountAmountIdr };
}

/**
 * Lepas penukaran sebuah order (transaksi pemanggil): dipanggil hook
 * penyelesaian order saat order berakhir expired/cancelled. Hanya
 * baris 'redeemed' yang bertransisi — idempoten terhadap peristiwa
 * penyelesaian yang berulang.
 */
export async function releaseRedemptionsForOrderTx(
  tx: DbTx,
  tenantId: string,
  orderId: string,
): Promise<void> {
  await tx
    .update(discountRedemptions)
    .set({ status: "released", releasedAt: new Date() })
    .where(
      and(
        eq(discountRedemptions.tenantId, tenantId),
        eq(discountRedemptions.orderId, orderId),
        eq(discountRedemptions.status, "redeemed"),
      ),
    );
}

// ---------------------------------------------------------------------------
// CRUD kode (permukaan dashboard)
// ---------------------------------------------------------------------------

export interface DiscountCodeWithStats extends DiscountCode {
  redemptionCount: number;
  releasedCount: number;
  totalDiscountIdr: number;
}

async function attachStatsTx(
  tx: DbTx,
  tenantId: string,
  rows: DiscountCode[],
): Promise<DiscountCodeWithStats[]> {
  if (rows.length === 0) return [];
  const stats = await tx
    .select({
      discountCodeId: discountRedemptions.discountCodeId,
      status: discountRedemptions.status,
      n: count(),
      total: sum(discountRedemptions.discountAmountIdr),
    })
    .from(discountRedemptions)
    .where(eq(discountRedemptions.tenantId, tenantId))
    .groupBy(
      discountRedemptions.discountCodeId,
      discountRedemptions.status,
    );
  const byCode = new Map<
    string,
    { redemptionCount: number; releasedCount: number; totalDiscountIdr: number }
  >();
  for (const s of stats) {
    const entry = byCode.get(s.discountCodeId) ?? {
      redemptionCount: 0,
      releasedCount: 0,
      totalDiscountIdr: 0,
    };
    if (s.status === "redeemed") {
      entry.redemptionCount = Number(s.n);
      entry.totalDiscountIdr = Number(s.total ?? 0);
    } else {
      entry.releasedCount = Number(s.n);
    }
    byCode.set(s.discountCodeId, entry);
  }
  return rows.map((row) => ({
    ...row,
    ...(byCode.get(row.id) ?? {
      redemptionCount: 0,
      releasedCount: 0,
      totalDiscountIdr: 0,
    }),
  }));
}

export type CreateDiscountCodeResult =
  | { kind: "ok"; code: DiscountCodeWithStats }
  | { kind: "duplicate" };

export async function createDiscountCode(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  input: CreateDiscountCodeRequest,
  actor: { actorType: "user"; actorId: string },
): Promise<CreateDiscountCodeResult> {
  const normalized = normalizeDiscountCode(input.code);
  // Kontrak sudah menegakkan pola; null di sini berarti kontrak dilompati.
  if (!normalized) return { kind: "duplicate" };
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const inserted = await tx
      .insert(discountCodes)
      .values({
        tenantId: ctx.tenantId,
        code: normalized,
        kind: input.kind,
        value: input.value,
        minOrderIdr: input.minOrderIdr ?? 0,
        maxRedemptions: input.maxRedemptions ?? null,
        maxPerContact: input.maxPerContact ?? null,
        startsAt: input.startsAt ? new Date(input.startsAt) : null,
        endsAt: input.endsAt ? new Date(input.endsAt) : null,
        isActive: input.isActive ?? true,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted.length === 0) return { kind: "duplicate" as const };
    const row = inserted[0];
    await tx.insert(auditLogs).values({
      tenantId: ctx.tenantId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "discount_code.created",
      meta: {
        discountCodeId: row.id,
        code: row.code,
        kind: row.kind,
        value: row.value,
      },
    });
    const [withStats] = await attachStatsTx(tx, ctx.tenantId, [row]);
    return { kind: "ok" as const, code: withStats };
  });
}

export async function listDiscountCodes(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
): Promise<DiscountCodeWithStats[]> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(discountCodes)
      .where(eq(discountCodes.tenantId, ctx.tenantId))
      .orderBy(asc(discountCodes.createdAt));
    return attachStatsTx(tx, ctx.tenantId, rows);
  });
}

export async function getDiscountCode(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  id: string,
): Promise<DiscountCodeWithStats | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(discountCodes)
      .where(
        and(
          eq(discountCodes.tenantId, ctx.tenantId),
          eq(discountCodes.id, id),
        ),
      )
      .limit(1);
    if (!row) return null;
    const [withStats] = await attachStatsTx(tx, ctx.tenantId, [row]);
    return withStats ?? null;
  });
}

export async function updateDiscountCode(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  id: string,
  input: UpdateDiscountCodeRequest,
  actor: { actorType: "user"; actorId: string },
): Promise<DiscountCodeWithStats | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const patch: Partial<DiscountCode> = { updatedAt: new Date() };
    if (input.kind !== undefined) patch.kind = input.kind;
    if (input.value !== undefined) patch.value = input.value;
    if (input.isActive !== undefined) patch.isActive = input.isActive;
    if (input.minOrderIdr !== undefined) patch.minOrderIdr = input.minOrderIdr;
    if (input.maxRedemptions !== undefined)
      patch.maxRedemptions = input.maxRedemptions;
    if (input.maxPerContact !== undefined)
      patch.maxPerContact = input.maxPerContact;
    if (input.startsAt !== undefined)
      patch.startsAt = input.startsAt ? new Date(input.startsAt) : null;
    if (input.endsAt !== undefined)
      patch.endsAt = input.endsAt ? new Date(input.endsAt) : null;
    const [row] = await tx
      .update(discountCodes)
      .set(patch)
      .where(
        and(
          eq(discountCodes.tenantId, ctx.tenantId),
          eq(discountCodes.id, id),
        ),
      )
      .returning();
    if (!row) return null;
    await tx.insert(auditLogs).values({
      tenantId: ctx.tenantId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "discount_code.updated",
      meta: { discountCodeId: row.id, code: row.code },
    });
    const [withStats] = await attachStatsTx(tx, ctx.tenantId, [row]);
    return withStats ?? null;
  });
}
