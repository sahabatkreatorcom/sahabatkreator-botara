import { randomBytes } from "node:crypto";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import {
  auditLogs,
  channelAccounts,
  contacts,
  growthLinkEvents,
  growthLinks,
  tenants,
  type ChannelAccount,
  type Database,
  type GrowthLink,
} from "@sahabat-kreator/db";
import { withTenantDb, type DbTx } from "./tx";

/**
 * Growth Tools (Fase 13B) — tautan publik per channel + halaman arahan
 * pemilih channel + analitik per tautan.
 *
 * Model:
 * - `growth_links`: satu baris per tautan. kind 'single' menunjuk SATU
 *   akun channel; kind 'picker' menunjuk himpunan akun (>= 2) dan
 *   /go/:slug me-render halaman arahan. slug unik GLOBAL (URL publik).
 * - `growth_link_events`: jejak mentah — click (ketukan /go atau tombol
 *   picker), picker_view (halaman arahan tampil), conversion (kontak
 *   teratribusi). Semua angka analitik DITURUNKAN dari event; tidak
 *   ada penghitung tersimpan yang bisa menyimpang.
 *
 * Atribusi (conversion) — `attributeContactToGrowthLink` adalah SATU
 * pintu yang dipakai semua jalur inbound (Telegram /start, referral
 * Meta, sesi webchat ?src=):
 * - hanya untuk kontak yang BELUM teratribusi (contacts.source NULL) —
 *   atribusi pertama menang dan tidak ditimpa tautan berikutnya;
 * - tautan harus aktif dan channel asal harus cocok (single: akunnya;
 *   picker: termasuk himpunannya);
 * - menerapkan auto_tag tautan (ditambahkan, tidak mengganti tag lain);
 * - mencatat event conversion — index unik parsial DB menjamin tepat
 *   sekali per kontak per tautan walau jalur balapan.
 *
 * Batas jujur per platform (lihat juga buildGrowthTargetUrl):
 * - WhatsApp TIDAK punya jalur payload atribusi — klik tercatat,
 *   konversi tidak dijanjikan.
 * - Teks awal (prefill) hanya bisa dibawa WhatsApp (?text=). Telegram
 *   payload start-nya adalah slug itu sendiri; Messenger/IG membawa
 *   ref=<slug> pada tautannya.
 */

export type { GrowthLink };

/** Ringkasan akun channel sebagaimana dirujuk tautan (tanpa kredensial). */
export interface GrowthLinkChannelInfo {
  id: string;
  provider: ChannelAccount["provider"];
  displayName: string | null;
  publicHandle: string | null;
  botUsername: string | null;
  status: ChannelAccount["status"];
}

export interface GrowthLinkStats {
  clicks: number;
  pickerViews: number;
  conversions: number;
}

/** Baris tautan + ringkasan channel terkait + statistik turunan event. */
export interface GrowthLinkDetailed extends GrowthLink {
  channel: GrowthLinkChannelInfo | null;
  pickerChannels: GrowthLinkChannelInfo[];
  stats: GrowthLinkStats;
}

function toChannelInfo(row: ChannelAccount): GrowthLinkChannelInfo {
  return {
    id: row.id,
    provider: row.provider,
    displayName: row.displayName,
    publicHandle: row.publicHandle,
    botUsername: row.botUsername,
    status: row.status,
  };
}

function isUniqueViolation(err: unknown): boolean {
  const text = `${(err as { message?: string })?.message ?? ""} ${(err as { cause?: { message?: string } })?.cause?.message ?? ""}`;
  return (
    /duplicate key|unique constraint|unique violation/i.test(text) ||
    (err as { code?: string })?.code === "23505" ||
    (err as { cause?: { code?: string } })?.cause?.code === "23505"
  );
}

/** Slug dasar dari label: huruf kecil, strip sebagai pemisah (pola tenants). */
export function growthSlugBase(label: string): string {
  const base = label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return base.length >= 3 ? base : "link";
}

function randomSlugSuffix(): string {
  return randomBytes(6)
    .toString("base64url")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 6);
}

/**
 * URL tujuan platform untuk (tautan, akun) — null bila data akun tidak
 * cukup untuk menyusunnya (WhatsApp tanpa nomor tampil, Instagram
 * tanpa username, Telegram tanpa username bot). Dipakai validasi
 * buat/edit DAN jalur redirect publik (akun bisa berubah sesudah
 * tautan dibuat; redirect menjawab halaman 404 sopan bila null).
 */
export function buildGrowthTargetUrl(
  link: Pick<GrowthLink, "slug" | "prefillText">,
  account: Pick<
    ChannelAccount,
    "provider" | "externalId" | "publicHandle" | "botUsername"
  >,
): string | null {
  switch (account.provider) {
    case "whatsapp": {
      const digits = (account.publicHandle ?? "").replace(/\D/g, "");
      if (digits.length < 7) return null;
      const base = `https://wa.me/${digits}`;
      return link.prefillText
        ? `${base}?text=${encodeURIComponent(link.prefillText)}`
        : base;
    }
    case "telegram": {
      if (!account.botUsername) return null;
      return `https://t.me/${account.botUsername}?start=${encodeURIComponent(link.slug)}`;
    }
    case "messenger": {
      const handle = account.publicHandle || account.externalId;
      return `https://m.me/${encodeURIComponent(handle)}?ref=${encodeURIComponent(link.slug)}`;
    }
    case "instagram": {
      if (!account.publicHandle) return null;
      // Bentuk terdokumentasi tautan DM Instagram adalah ig.me/m/<user>.
      // Parameter ref disertakan seperti Messenger; bila Instagram
      // mengabaikannya, klik tetap tercatat dan atribusi memang tidak
      // dijanjikan untuk kedatangan yang ref-nya hilang di jalan.
      return `https://ig.me/m/${encodeURIComponent(account.publicHandle)}?ref=${encodeURIComponent(link.slug)}`;
    }
    case "webchat": {
      // Halaman chat ter-host milik kita (satu origin dengan /go):
      // widget membaca siteKey dari ?key= dan slug atribusi dari ?src=.
      return `/webchat-demo?key=${encodeURIComponent(account.externalId)}&src=${encodeURIComponent(link.slug)}`;
    }
    case "threads": {
      // Threads khusus content schedule, bukan channel percakapan:
      // tidak ada tautan DM/atribusi growth untuk akun linimasa ini.
      return null;
    }
    case "bluesky": {
      // Bluesky khusus content schedule, bukan channel percakapan:
      // tidak ada tautan DM/atribusi growth untuk akun linimasa ini.
      return null;
    }
    case "youtube": {
      // YouTube khusus content schedule, bukan channel percakapan:
      // tidak ada tautan DM/atribusi growth untuk akun linimasa ini.
      return null;
    }
    case "linkedin": {
      // LinkedIn khusus content schedule, bukan channel percakapan:
      // tidak ada tautan DM/atribusi growth untuk akun linimasa ini.
      return null;
    }
    case "pinterest": {
      // Pinterest khusus content schedule, bukan channel percakapan:
      // tidak ada tautan DM/atribusi growth untuk akun linimasa ini.
      return null;
    }
    case "google_business": {
      // Google Business khusus content schedule, bukan channel
      // percakapan: tidak ada tautan DM/atribusi growth untuk akun
      // linimasa ini.
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Validasi konfigurasi channel
// ---------------------------------------------------------------------------

type ChannelValidation =
  | { ok: true; accounts: ChannelAccount[] }
  | { ok: false; kind: "channel_invalid" | "target_unavailable" };

/**
 * Memuat + memvalidasi akun-akun yang dirujuk konfigurasi tautan:
 * semua harus milik tenant ini, tidak di Sampah, berstatus connected,
 * dan URL tujuannya bisa disusun. Urutan hasil mengikuti urutan input.
 */
async function validateGrowthAccounts(
  tx: DbTx,
  tenantId: string,
  link: Pick<GrowthLink, "slug" | "prefillText">,
  accountIds: string[],
): Promise<ChannelValidation> {
  if (accountIds.length === 0) return { ok: false, kind: "channel_invalid" };
  const rows = await tx
    .select()
    .from(channelAccounts)
    .where(
      and(
        eq(channelAccounts.tenantId, tenantId),
        inArray(channelAccounts.id, accountIds),
      ),
    );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const accounts: ChannelAccount[] = [];
  for (const id of accountIds) {
    const row = byId.get(id);
    if (!row || row.trashedAt !== null || row.status !== "connected") {
      return { ok: false, kind: "channel_invalid" };
    }
    accounts.push(row);
  }
  for (const account of accounts) {
    if (buildGrowthTargetUrl(link, account) === null) {
      return { ok: false, kind: "target_unavailable" };
    }
  }
  return { ok: true, accounts };
}

// ---------------------------------------------------------------------------
// CRUD (konteks tenant; peran ditegakkan route seperti flows/broadcasts)
// ---------------------------------------------------------------------------

export interface CreateGrowthLinkInput {
  tenantId: string;
  userId: string;
  kind: "single" | "picker";
  label: string;
  slug?: string;
  channelAccountId?: string;
  pickerChannelIds?: string[];
  autoTag?: string | null;
  prefillText?: string | null;
}

export type CreateGrowthLinkResult =
  | { kind: "created"; link: GrowthLinkDetailed }
  | { kind: "slug_taken" }
  | { kind: "channel_invalid" }
  | { kind: "target_unavailable" };

export async function createGrowthLink(
  db: Database,
  input: CreateGrowthLinkInput,
): Promise<CreateGrowthLinkResult> {
  const accountIds =
    input.kind === "single"
      ? input.channelAccountId
        ? [input.channelAccountId]
        : []
      : [...new Set(input.pickerChannelIds ?? [])];
  if (input.kind === "picker" && accountIds.length < 2) {
    return { kind: "channel_invalid" };
  }
  const providedSlug = input.slug;
  // Hingga 5 percobaan untuk slug tergenerate (tabrakan acak nyaris
  // mustahil, tetapi insert adalah satu-satunya hakim yang jujur).
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug =
      providedSlug ?? `${growthSlugBase(input.label)}-${randomSlugSuffix()}`;
    try {
      const created = await withTenantDb(db, input.tenantId, async (tx) => {
        const validation = await validateGrowthAccounts(
          tx,
          input.tenantId,
          { slug, prefillText: input.prefillText ?? null },
          accountIds,
        );
        if (!validation.ok) return validation;
        const [row] = await tx
          .insert(growthLinks)
          .values({
            tenantId: input.tenantId,
            kind: input.kind,
            label: input.label,
            slug,
            channelAccountId:
              input.kind === "single" ? accountIds[0]! : null,
            pickerChannelIds: input.kind === "picker" ? accountIds : [],
            autoTag: input.autoTag ?? null,
            prefillText: input.prefillText ?? null,
            createdByUserId: input.userId,
          })
          .returning();
        await tx.insert(auditLogs).values({
          tenantId: input.tenantId,
          actorType: "user",
          actorId: input.userId,
          action: "growth_link.created",
          meta: { growthLinkId: row.id, slug: row.slug, kind: row.kind },
        });
        return { ok: true as const, row };
      });
      if (!created.ok) return { kind: created.kind };
      const detailed = await getGrowthLink(db, { tenantId: input.tenantId }, created.row.id);
      return { kind: "created", link: detailed! };
    } catch (err) {
      if (isUniqueViolation(err)) {
        if (providedSlug) return { kind: "slug_taken" };
        continue; // slug tergenerate bertabrakan — coba suffix lain
      }
      throw err;
    }
  }
  return { kind: "slug_taken" };
}

/** Memperkaya baris tautan dengan ringkasan channel + statistik event. */
async function detailGrowthLinks(
  tx: DbTx,
  tenantId: string,
  rows: GrowthLink[],
): Promise<GrowthLinkDetailed[]> {
  if (rows.length === 0) return [];
  const accountIds = new Set<string>();
  for (const row of rows) {
    if (row.channelAccountId) accountIds.add(row.channelAccountId);
    for (const id of row.pickerChannelIds) accountIds.add(id);
  }
  const accounts =
    accountIds.size > 0
      ? await tx
          .select()
          .from(channelAccounts)
          .where(
            and(
              eq(channelAccounts.tenantId, tenantId),
              inArray(channelAccounts.id, [...accountIds]),
            ),
          )
      : [];
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const statRows = await tx
    .select({
      growthLinkId: growthLinkEvents.growthLinkId,
      kind: growthLinkEvents.kind,
      n: count(),
    })
    .from(growthLinkEvents)
    .where(
      and(
        eq(growthLinkEvents.tenantId, tenantId),
        inArray(
          growthLinkEvents.growthLinkId,
          rows.map((r) => r.id),
        ),
      ),
    )
    .groupBy(growthLinkEvents.growthLinkId, growthLinkEvents.kind);
  const statsByLink = new Map<string, GrowthLinkStats>();
  for (const row of rows) {
    statsByLink.set(row.id, { clicks: 0, pickerViews: 0, conversions: 0 });
  }
  for (const s of statRows) {
    const stats = statsByLink.get(s.growthLinkId);
    if (!stats) continue;
    if (s.kind === "click") stats.clicks = s.n;
    else if (s.kind === "picker_view") stats.pickerViews = s.n;
    else if (s.kind === "conversion") stats.conversions = s.n;
  }
  return rows.map((row) => ({
    ...row,
    channel: row.channelAccountId
      ? byId.has(row.channelAccountId)
        ? toChannelInfo(byId.get(row.channelAccountId)!)
        : null
      : null,
    pickerChannels: row.pickerChannelIds
      .map((id) => byId.get(id))
      .filter((a): a is ChannelAccount => a !== undefined)
      .map(toChannelInfo),
    stats: statsByLink.get(row.id) ?? { clicks: 0, pickerViews: 0, conversions: 0 },
  }));
}

export async function listGrowthLinks(
  db: Database,
  input: { tenantId: string },
): Promise<GrowthLinkDetailed[]> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(growthLinks)
      .where(eq(growthLinks.tenantId, input.tenantId))
      .orderBy(desc(growthLinks.createdAt));
    return detailGrowthLinks(tx, input.tenantId, rows);
  });
}

export async function getGrowthLink(
  db: Database,
  input: { tenantId: string },
  id: string,
): Promise<GrowthLinkDetailed | null> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(growthLinks)
      .where(
        and(eq(growthLinks.tenantId, input.tenantId), eq(growthLinks.id, id)),
      )
      .limit(1);
    if (!row) return null;
    const [detailed] = await detailGrowthLinks(tx, input.tenantId, [row]);
    return detailed ?? null;
  });
}

export interface UpdateGrowthLinkInput {
  tenantId: string;
  userId: string;
  id: string;
  label?: string;
  slug?: string;
  channelAccountId?: string;
  pickerChannelIds?: string[];
  autoTag?: string | null;
  prefillText?: string | null;
  isActive?: boolean;
}

export type UpdateGrowthLinkResult =
  | { kind: "updated"; link: GrowthLinkDetailed }
  | { kind: "not_found" }
  | { kind: "slug_taken" }
  | { kind: "channel_invalid" }
  | { kind: "target_unavailable" };

export async function updateGrowthLink(
  db: Database,
  input: UpdateGrowthLinkInput,
): Promise<UpdateGrowthLinkResult> {
  try {
    const result = await withTenantDb(db, input.tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(growthLinks)
        .where(
          and(
            eq(growthLinks.tenantId, input.tenantId),
            eq(growthLinks.id, input.id),
          ),
        )
        .limit(1);
      if (!row) return { kind: "not_found" as const };

      // Konfigurasi channel hasil edit (kind TIDAK berubah — tautan
      // single tetap single, picker tetap picker; ganti jenis = buat
      // tautan baru, agar slug yang sudah tersebar tidak berubah arti).
      const nextChannelAccountId =
        row.kind === "single"
          ? (input.channelAccountId ?? row.channelAccountId)
          : null;
      const nextPickerIds =
        row.kind === "picker"
          ? [...new Set(input.pickerChannelIds ?? row.pickerChannelIds)]
          : [];
      const channelTouched =
        input.channelAccountId !== undefined ||
        input.pickerChannelIds !== undefined ||
        input.slug !== undefined ||
        input.prefillText !== undefined;
      if (channelTouched) {
        const accountIds =
          row.kind === "single"
            ? nextChannelAccountId
              ? [nextChannelAccountId]
              : []
            : nextPickerIds;
        if (row.kind === "picker" && accountIds.length < 2) {
          return { kind: "channel_invalid" as const };
        }
        const validation = await validateGrowthAccounts(
          tx,
          input.tenantId,
          {
            slug: input.slug ?? row.slug,
            prefillText:
              input.prefillText !== undefined
                ? input.prefillText
                : row.prefillText,
          },
          accountIds,
        );
        if (!validation.ok) return { kind: validation.kind };
      }

      const [updated] = await tx
        .update(growthLinks)
        .set({
          ...(input.label !== undefined ? { label: input.label } : {}),
          ...(input.slug !== undefined ? { slug: input.slug } : {}),
          ...(row.kind === "single" && input.channelAccountId !== undefined
            ? { channelAccountId: nextChannelAccountId }
            : {}),
          ...(row.kind === "picker" && input.pickerChannelIds !== undefined
            ? { pickerChannelIds: nextPickerIds }
            : {}),
          ...(input.autoTag !== undefined ? { autoTag: input.autoTag } : {}),
          ...(input.prefillText !== undefined
            ? { prefillText: input.prefillText }
            : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          updatedAt: new Date(),
        })
        .where(eq(growthLinks.id, row.id))
        .returning();
      await tx.insert(auditLogs).values({
        tenantId: input.tenantId,
        actorType: "user",
        actorId: input.userId,
        action: "growth_link.updated",
        meta: { growthLinkId: row.id, slug: updated.slug },
      });
      return { kind: "updated" as const, id: updated.id };
    });
    if (result.kind !== "updated") return result;
    const detailed = await getGrowthLink(db, { tenantId: input.tenantId }, result.id);
    return { kind: "updated", link: detailed! };
  } catch (err) {
    if (isUniqueViolation(err)) return { kind: "slug_taken" };
    throw err;
  }
}

export type DeleteGrowthLinkResult = { kind: "deleted" } | { kind: "not_found" };

export async function deleteGrowthLink(
  db: Database,
  input: { tenantId: string; userId: string; id: string },
): Promise<DeleteGrowthLinkResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(growthLinks)
      .where(
        and(
          eq(growthLinks.tenantId, input.tenantId),
          eq(growthLinks.id, input.id),
        ),
      )
      .limit(1);
    if (!row) return { kind: "not_found" as const };
    // Event analitik ikut terhapus (FK cascade) — menghapus tautan
    // memang menghapus riwayatnya; nonaktif adalah pilihan yang
    // mempertahankan angka.
    await tx.delete(growthLinks).where(eq(growthLinks.id, row.id));
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "growth_link.deleted",
      meta: { growthLinkId: row.id, slug: row.slug },
    });
    return { kind: "deleted" as const };
  });
}

export interface GrowthAttributedContact {
  contactId: string;
  name: string;
  source: string | null;
  convertedAt: Date;
}

/** Kontak teratribusi terbaru untuk satu tautan (dari event conversion). */
export async function listGrowthLinkAttributedContacts(
  db: Database,
  input: { tenantId: string },
  linkId: string,
  limit = 20,
): Promise<GrowthAttributedContact[]> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const rows = await tx
      .select({
        contactId: growthLinkEvents.contactId,
        name: contacts.name,
        source: contacts.source,
        convertedAt: growthLinkEvents.createdAt,
      })
      .from(growthLinkEvents)
      .innerJoin(contacts, eq(contacts.id, growthLinkEvents.contactId))
      .where(
        and(
          eq(growthLinkEvents.tenantId, input.tenantId),
          eq(growthLinkEvents.growthLinkId, linkId),
          eq(growthLinkEvents.kind, "conversion"),
        ),
      )
      .orderBy(desc(growthLinkEvents.createdAt))
      .limit(limit);
    return rows
      .filter((r): r is GrowthAttributedContact => r.contactId !== null)
      .map((r) => ({ ...r }));
  });
}

// ---------------------------------------------------------------------------
// Jalur publik (/go/:slug) — resolusi tanpa konteks tenant
// ---------------------------------------------------------------------------

export interface ResolvedGrowthLink {
  link: GrowthLink;
  tenantName: string;
  /** Akun single (kind 'single') atau himpunan picker, urut konfigurasi. */
  accounts: ChannelAccount[];
}

/**
 * Resolusi slug publik TANPA konteks tenant: transaksi men-set
 * `app.growth_slug` dan policy `growth_link_public_lookup` hanya
 * membuka baris slug itu. Akun channel + nama tenant dibaca sesudahnya
 * dalam konteks tenant hasil resolusi (policy standar). Null bila
 * slug tidak dikenal. Status aktif DIPERIKSA pemanggil (tautan
 * nonaktif harus bisa dibedakan dari tidak dikenal di log, walau
 * respons publiknya sama-sama 404).
 */
export async function resolveGrowthLinkBySlug(
  db: Database,
  slug: string,
): Promise<ResolvedGrowthLink | null> {
  const stub = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.growth_slug', ${slug}, true)`);
    const [row] = await tx
      .select()
      .from(growthLinks)
      .where(eq(growthLinks.slug, slug))
      .limit(1);
    return row ?? null;
  });
  if (!stub) return null;
  return withTenantDb(db, stub.tenantId, async (tx) => {
    const [tenant] = await tx
      .select({ name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, stub.tenantId))
      .limit(1);
    const accountIds =
      stub.kind === "single"
        ? stub.channelAccountId
          ? [stub.channelAccountId]
          : []
        : stub.pickerChannelIds;
    const accounts =
      accountIds.length > 0
        ? await tx
            .select()
            .from(channelAccounts)
            .where(
              and(
                eq(channelAccounts.tenantId, stub.tenantId),
                inArray(channelAccounts.id, accountIds),
              ),
            )
        : [];
    const byId = new Map(accounts.map((a) => [a.id, a]));
    return {
      link: stub,
      tenantName: tenant?.name ?? "",
      accounts: accountIds
        .map((id) => byId.get(id))
        .filter((a): a is ChannelAccount => a !== undefined),
    };
  });
}

/** Mencatat satu event analitik dalam konteks tenant pemilik tautan. */
export async function recordGrowthLinkEvent(
  db: Database,
  input: {
    tenantId: string;
    growthLinkId: string;
    kind: "click" | "picker_view" | "conversion";
    contactId?: string | null;
  },
): Promise<void> {
  await withTenantDb(db, input.tenantId, async (tx) => {
    await tx
      .insert(growthLinkEvents)
      .values({
        tenantId: input.tenantId,
        growthLinkId: input.growthLinkId,
        kind: input.kind,
        contactId: input.contactId ?? null,
      })
      .onConflictDoNothing();
  });
}

// ---------------------------------------------------------------------------
// Atribusi kontak (satu pintu untuk Telegram / Meta / webchat)
// ---------------------------------------------------------------------------

export type AttributeGrowthResult =
  | { attributed: true; linkId: string }
  | {
      attributed: false;
      reason:
        | "link_not_found"
        | "link_inactive"
        | "channel_mismatch"
        | "already_attributed"
        | "already_converted";
    };

/**
 * Mengatribusikan kontak ke growth link ber-slug `slug` pada tenant
 * pemiliknya, dari kedatangan lewat akun `channelAccountId`.
 * Idempoten & aman dipanggil ulang (replay webhook, sesi webchat
 * berulang): hasil kedua dan seterusnya adalah no-op beralasan.
 * TIDAK PERNAH melempar untuk keadaan bisnis — pemanggil (webhook)
 * tidak boleh gagal karena atribusi; kesalahan DB tetap dilempar.
 *
 * Fase 13C — atribusi growth SENGAJA BUKAN opt-in pemasaran: fungsi
 * ini hanya menulis `contacts.source` (+ auto-tag & event conversion).
 * Mengklik tautan atau memulai chat adalah sinyal SUMBER, bukan
 * persetujuan menerima broadcast marketing; persetujuan hanya lahir
 * dari kata kunci opt-in (pipeline inbound), toggle manual, atau
 * jalur eksplisit lain (lihat core/optin.ts). Menyetarakan klik
 * dengan consent akan membuat gerbang require_opt_in tidak berarti.
 */
export async function attributeContactToGrowthLink(
  db: Database,
  input: {
    tenantId: string;
    contactId: string;
    slug: string;
    channelAccountId: string;
  },
): Promise<AttributeGrowthResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [link] = await tx
      .select()
      .from(growthLinks)
      .where(
        and(
          eq(growthLinks.tenantId, input.tenantId),
          eq(growthLinks.slug, input.slug),
        ),
      )
      .limit(1);
    if (!link) return { attributed: false, reason: "link_not_found" } as const;
    if (!link.isActive) {
      return { attributed: false, reason: "link_inactive" } as const;
    }
    const channelMatches =
      link.kind === "single"
        ? link.channelAccountId === input.channelAccountId
        : link.pickerChannelIds.includes(input.channelAccountId);
    if (!channelMatches) {
      return { attributed: false, reason: "channel_mismatch" } as const;
    }
    const [contact] = await tx
      .select()
      .from(contacts)
      .where(
        and(eq(contacts.tenantId, input.tenantId), eq(contacts.id, input.contactId)),
      )
      .limit(1);
    if (!contact) return { attributed: false, reason: "link_not_found" } as const;
    if (contact.source !== null) {
      return { attributed: false, reason: "already_attributed" } as const;
    }
    const [existing] = await tx
      .select({ id: growthLinkEvents.id })
      .from(growthLinkEvents)
      .where(
        and(
          eq(growthLinkEvents.growthLinkId, link.id),
          eq(growthLinkEvents.contactId, input.contactId),
          eq(growthLinkEvents.kind, "conversion"),
        ),
      )
      .limit(1);
    if (existing) {
      return { attributed: false, reason: "already_converted" } as const;
    }

    const tags =
      link.autoTag && !contact.tags.includes(link.autoTag)
        ? [...contact.tags, link.autoTag]
        : contact.tags;
    await tx
      .update(contacts)
      .set({ source: `growth:${link.slug}`, tags, updatedAt: new Date() })
      .where(eq(contacts.id, contact.id));
    await tx
      .insert(growthLinkEvents)
      .values({
        tenantId: input.tenantId,
        growthLinkId: link.id,
        kind: "conversion",
        contactId: input.contactId,
      })
      .onConflictDoNothing();
    return { attributed: true, linkId: link.id } as const;
  });
}
