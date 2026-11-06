import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import {
  auditLogs,
  broadcastRecipients,
  broadcasts,
  channelAccounts,
  channelIdentities,
  contacts,
  conversations,
  messages,
  outboxEvents,
  whatsappTemplates,
  type Broadcast,
  type BroadcastRecipient,
  type Database,
  type WhatsAppTemplate,
} from "@sahabat-kreator/db";
import type { SegmentDefinition } from "@sahabat-kreator/contracts";
import { withTenantDb, type DbTx } from "./tx";
import { renderMessageText } from "./render-text";
import { deriveTemplateParamSpec } from "./whatsapp-template-params";
import {
  broadcastExperimentKey,
  broadcastVariantForBucket,
  experimentBucket,
} from "./experiments";
import { effectiveOptInStatus } from "./contacts";
import {
  evaluateSegmentDefinition,
  getSegmentRow,
  loadContactSegmentProfiles,
} from "./segments";

/**
 * Broadcasts v1 (Fase 7C) — kampanye siaran teks ke audiens kontak pada
 * SATU akun channel, dieksekusi worker.
 *
 * Keputusan desain yang mengikat modul ini:
 * - Provider yang didukung: telegram, messenger, instagram, dan
 *   whatsapp LEWAT TEMPLATE resmi (Fase 10A — pesan template adalah
 *   satu-satunya bentuk proaktif yang sah di luar jendela 24 jam).
 *   Webchat tetap dikecualikan (pengunjung anonim — tidak ada
 *   semantik push) dan ditolak berkode sejak buat/jadwalkan.
 * - Broadcast WhatsApp WAJIB menunjuk template cermin lokal
 *   berstatus APPROVED pada akun yang sama — diperiksa saat buat
 *   (422 BROADCAST_TEMPLATE_REQUIRED / _NOT_APPROVED), diperiksa
 *   ULANG saat jadwalkan dan saat dispatch (status di Meta bisa
 *   berubah di antara ketiganya; dispatch yang gagal pemeriksaan
 *   menutup broadcast `failed` berkode yang sama). Aturan jendela
 *   24 jam Meta TIDAK berlaku untuk WhatsApp template.
 * - Audiens dimaterialisasi SAAT DISPATCH (bukan saat dibuat/
 *   dijadwalkan): kontak yang opt-out di antara jadwal dan kirim tetap
 *   dihormati. Kandidat = kontak yang punya identitas pada akun channel
 *   (pernah berinteraksi) dan cocok filter tag/stage.
 * - Penerima opt-out tetap mendapat baris recipient `skipped`
 *   (skip_reason 'opted_out') agar statistik jujur; khusus Meta,
 *   penerima yang pesan masuk terakhirnya (di semua percakapan 1:1-nya
 *   pada akun itu) lebih tua dari 24 jam → `skipped`
 *   'outside_24h_window' SAAT dispatch — tidak dicoba kirim, tidak
 *   dihitung gagal (aturan jendela 24 jam Messenger/IG).
 * - Pesan keluar dibuat `queued` sender_type 'system' dengan {name}
 *   tersubstitusi; pengiriman sesungguhnya tetap milik poller
 *   telegram/meta yang ada (tidak ada pengirim paralel di sini), dan
 *   pesan keluar tidak pernah memicu automation/agent (hanya
 *   `message.received` yang memicu — dispatch tidak menulisnya).
 * - Statistik SELALU dihitung dari `broadcast_recipients` (sumber
 *   kebenaran tunggal). Status penerima disinkronkan dari status
 *   pesannya oleh penyapu worker `reconcileBroadcasts`; broadcast
 *   ditutup (completed/partially_failed/failed) oleh penyapu yang sama
 *   begitu tidak ada penerima `queued` tersisa.
 * - Akses ditegakkan di lapisan API: mutasi owner/admin; baca semua
 *   member (data kampanye bersama workspace, selaras daftar kontak).
 */

export type BroadcastProvider =
  | "telegram"
  | "messenger"
  | "instagram"
  | "whatsapp";
export type BroadcastStatus = Broadcast["status"];
export type BroadcastRecipientStatus = BroadcastRecipient["status"];

export const BROADCAST_SUPPORTED_PROVIDERS: ReadonlySet<string> = new Set([
  "telegram",
  "messenger",
  "instagram",
  // Fase 10A: WhatsApp didukung LEWAT template resmi (gerbang
  // template di bawah); webchat tetap satu-satunya yang ditolak.
  "whatsapp",
]);

export const META_24H_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Ukuran batch transaksi dispatch — audiens besar tidak menahan satu transaksi raksasa. */
export const BROADCAST_DISPATCH_CHUNK = 200;

export interface BroadcastAudienceFilter {
  /**
   * Mode audiens (Fase 13C). Kosong pada baris lama → diturunkan
   * normalizeFilter dari isi filter (regresi nol).
   */
  audience?: "all" | "tag" | "segment";
  tags?: string[];
  stages?: string[];
  /** Mode "segment": id segmen milik tenant yang sama. */
  segmentId?: string;
}

export interface BroadcastStats {
  total: number;
  queued: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  skipped: number;
  cancelled: number;
}

export interface BroadcastWithChannel extends Broadcast {
  provider: string;
  channelDisplayName: string | null;
}

export interface BroadcastRecipientWithContact extends BroadcastRecipient {
  contactName: string;
}

// ---------------------------------------------------------------------------
// Util: kursor (pola log integrasi 7B.1 — base64url {createdAt, id})
// ---------------------------------------------------------------------------

interface PageCursor {
  createdAt: string;
  id: string;
}

function encodeCursor(row: { createdAt: Date; id: string }): string {
  const raw: PageCursor = {
    createdAt: row.createdAt.toISOString(),
    id: row.id,
  };
  return Buffer.from(JSON.stringify(raw), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): PageCursor | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Partial<PageCursor>;
    if (
      typeof parsed.createdAt === "string" &&
      typeof parsed.id === "string" &&
      !Number.isNaN(Date.parse(parsed.createdAt))
    ) {
      return { createdAt: parsed.createdAt, id: parsed.id };
    }
  } catch {
    // Kursor rusak → halaman pertama (pola terdokumentasi 7B.1).
  }
  return null;
}

function clampLimit(limit: number | undefined): number {
  if (!limit || Number.isNaN(limit)) return 50;
  return Math.min(100, Math.max(1, Math.floor(limit)));
}

function normalizeFilter(
  filter: BroadcastAudienceFilter | undefined,
): BroadcastAudienceFilter {
  const tags = (filter?.tags ?? []).map((t) => t.trim()).filter(Boolean);
  const stages = (filter?.stages ?? []).map((s) => s.trim()).filter(Boolean);
  const segmentId = filter?.segmentId?.trim() || undefined;
  // Mode eksplisit menang; tanpa mode, TURUNKAN dari isi (baris lama
  // pra-13C tidak punya `audience`): segmentId → segment; tags/stages
  // non-kosong → tag; selain itu all. Perilaku filter lama identik.
  const audience =
    filter?.audience ??
    (segmentId ? "segment" : tags.length > 0 || stages.length > 0 ? "tag" : "all");
  const out: BroadcastAudienceFilter = { audience };
  if (audience === "tag") {
    if (tags.length > 0) out.tags = [...new Set(tags)];
    if (stages.length > 0) out.stages = [...new Set(stages)];
  }
  if (audience === "segment" && segmentId) out.segmentId = segmentId;
  return out;
}

/** Mode efektif filter (sesudah normalisasi selalu terisi). */
function filterAudienceMode(
  filter: BroadcastAudienceFilter,
): "all" | "tag" | "segment" {
  return filter.audience ?? "all";
}

// ---------------------------------------------------------------------------
// Resolusi audiens (dipakai estimasi + dispatch)
// ---------------------------------------------------------------------------

export interface AudienceCandidate {
  contactId: string;
  contactName: string;
  /** Fase 10A: dibaca untuk pemetaan variabel template WhatsApp. */
  customFields: Record<string, unknown>;
  optInStatus: "unknown" | "opted_in" | "opted_out";
  /** Fase 13C: jejak opt-in — penentu status efektif bersama optInStatus. */
  optInAt: Date | null;
  /** Identitas kontak pada akun ini (alamat kirim cadangan poller). */
  externalUserId: string;
  /** Percakapan 1:1 terbaru kontak pada akun ini; null bila belum ada. */
  conversationId: string | null;
  /** Pesan masuk terakhir kontak pada akun ini (semua percakapan 1:1). */
  lastInboundAt: Date | null;
}

function contactMatchesFilter(
  filter: BroadcastAudienceFilter,
  tags: string[],
  pipelineStage: string,
): boolean {
  if (filter.tags && filter.tags.length > 0) {
    if (!filter.tags.some((t) => tags.includes(t))) return false;
  }
  if (filter.stages && filter.stages.length > 0) {
    if (!filter.stages.includes(pipelineStage)) return false;
  }
  return true;
}

/**
 * Kandidat audiens mentah: kontak beridentitas pada akun (satu baris
 * per kontak — identitas pertama yang ditemukan menang bila kontak
 * punya lebih dari satu id eksternal di akun yang sama), lengkap
 * dengan percakapan 1:1 terbaru + waktu pesan masuk terakhir.
 * Filter tag/stage diterapkan di sini; opt-out TIDAK disaring keluar
 * (pemanggil memutuskan: estimasi menghitungnya terpisah, dispatch
 * menandainya skipped).
 */
async function resolveAudienceCandidates(
  tx: DbTx,
  tenantId: string,
  channelAccountId: string,
  filter: BroadcastAudienceFilter,
): Promise<AudienceCandidate[]> {
  const identityRows = await tx
    .select({
      contactId: contacts.id,
      contactName: contacts.name,
      customFields: contacts.customFields,
      optInStatus: contacts.optInStatus,
      optInAt: contacts.optInAt,
      tags: contacts.tags,
      pipelineStage: contacts.pipelineStage,
      externalUserId: channelIdentities.externalUserId,
      identityCreatedAt: channelIdentities.createdAt,
    })
    .from(channelIdentities)
    .innerJoin(contacts, eq(channelIdentities.contactId, contacts.id))
    .where(
      and(
        eq(channelIdentities.tenantId, tenantId),
        eq(channelIdentities.channelAccountId, channelAccountId),
      ),
    )
    .orderBy(asc(channelIdentities.createdAt), asc(channelIdentities.id));

  const byContact = new Map<string, AudienceCandidate & { tags: string[]; pipelineStage: string }>();
  for (const row of identityRows) {
    if (byContact.has(row.contactId)) continue;
    byContact.set(row.contactId, {
      contactId: row.contactId,
      contactName: row.contactName,
      customFields: (row.customFields ?? {}) as Record<string, unknown>,
      optInStatus: row.optInStatus,
      optInAt: row.optInAt,
      externalUserId: row.externalUserId,
      conversationId: null,
      lastInboundAt: null,
      tags: row.tags,
      pipelineStage: row.pipelineStage,
    });
  }
  let all = [...byContact.values()];
  if (filterAudienceMode(filter) === "tag") {
    all = all.filter((c) =>
      contactMatchesFilter(filter, c.tags, c.pipelineStage),
    );
  } else if (filterAudienceMode(filter) === "segment") {
    // Fase 13C: keanggotaan segmen dari evaluator TUNGGAL core atas
    // profil kontak kandidat (segmen tak ditemukan → audiens kosong;
    // pratinjau memvalidasi keberadaan segmen lebih dulu agar UI
    // bisa membedakannya dari segmen yang memang kosong).
    const segment = filter.segmentId
      ? await getSegmentRow(tx, tenantId, filter.segmentId)
      : null;
    if (!segment) return [];
    const definition = segment.definition as unknown as SegmentDefinition;
    const profiles = await loadContactSegmentProfiles(
      tx,
      tenantId,
      all.map((c) => c.contactId),
    );
    const memberIds = new Set(
      profiles
        .filter((p) => evaluateSegmentDefinition(p, definition))
        .map((p) => p.contactId),
    );
    all = all.filter((c) => memberIds.has(c.contactId));
  }
  if (all.length === 0) return [];

  // Percakapan 1:1 (kind 'private') kontak-kontak ini pada akun ini:
  // yang terbaru (last_message_at terbesar) menjadi alamat kirim;
  // pesan masuk terakhir dihitung dari SEMUA percakapan 1:1 mereka.
  const contactIds = all.map((c) => c.contactId);
  const convRows = await tx
    .select({
      id: conversations.id,
      contactId: conversations.contactId,
      lastMessageAt: conversations.lastMessageAt,
      createdAt: conversations.createdAt,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.tenantId, tenantId),
        eq(conversations.channelAccountId, channelAccountId),
        eq(conversations.kind, "private"),
        inArray(conversations.contactId, contactIds),
      ),
    )
    .orderBy(desc(conversations.createdAt));
  const convByContact = new Map<string, string[]>();
  for (const conv of convRows) {
    const list = convByContact.get(conv.contactId) ?? [];
    list.push(conv.id);
    convByContact.set(conv.contactId, list);
  }
  // Percakapan kirim = yang last_message_at-nya paling baru (baris
  // terurut created_at desc; stabilkan dengan membandingkan lastMessageAt).
  const convMeta = new Map(convRows.map((c) => [c.id, c]));
  for (const candidate of all) {
    const ids = convByContact.get(candidate.contactId);
    if (!ids || ids.length === 0) continue;
    let best = ids[0];
    for (const id of ids) {
      const a = convMeta.get(id)!;
      const b = convMeta.get(best)!;
      const aTime = (a.lastMessageAt ?? a.createdAt).getTime();
      const bTime = (b.lastMessageAt ?? b.createdAt).getTime();
      if (aTime > bTime) best = id;
    }
    candidate.conversationId = best;
  }
  const allConvIds = convRows.map((c) => c.id);
  if (allConvIds.length > 0) {
    const inboundRows = await tx
      .select({
        conversationId: messages.conversationId,
        lastInboundAt: sql<string>`max(${messages.createdAt})`,
      })
      .from(messages)
      .where(
        and(
          eq(messages.tenantId, tenantId),
          eq(messages.direction, "inbound"),
          inArray(messages.conversationId, allConvIds),
        ),
      )
      .groupBy(messages.conversationId);
    const inboundByConv = new Map(
      inboundRows.map((r) => [r.conversationId, new Date(r.lastInboundAt)]),
    );
    for (const candidate of all) {
      const ids = convByContact.get(candidate.contactId) ?? [];
      let latest: Date | null = null;
      for (const id of ids) {
        const at = inboundByConv.get(id);
        if (at && (!latest || at > latest)) latest = at;
      }
      candidate.lastInboundAt = latest;
    }
  }
  return all.map(({ tags: _tags, pipelineStage: _stage, ...rest }) => rest);
}

/** Alasan skip yang bisa dihasilkan klasifikasi kandidat (kontrak BroadcastSkipReasonSchema). */
export type BroadcastSkipClassificationReason =
  | "opted_out"
  | "not_opted_in"
  | "outside_24h_window"
  | "missing_phone_number"
  | "template_variable_missing"
  | "template_component_unsupported";

export type BroadcastCandidateClassification =
  | {
      kind: "send";
      /** Parameter BODY template WhatsApp; null untuk provider teks. */
      templateBodyParams: string[] | null;
      /** Pratinjau teks template berparameter; null untuk provider teks. */
      templatePreview: string | null;
    }
  | { kind: "skip"; reason: BroadcastSkipClassificationReason };

/**
 * KLASIFIKASI TUNGGAL kandidat audiens (Fase 13C) — dipakai dispatch
 * (materialisasi penerima) DAN pratinjau audiens, agar angka pratinjau
 * tidak pernah berbeda logika dari hasil kirim. Urutan gerbang:
 * 1. opt-out tersimpan → skip `opted_out` (selalu, sejak 7C).
 * 2. require_opt_in && status efektif bukan opted_in → `not_opted_in`.
 * 3. Meta (messenger/instagram) di luar jendela 24 jam →
 *    `outside_24h_window` (aturan platform; WhatsApp template dan
 *    Telegram tidak tunduk jendela ini).
 * 4. WhatsApp: alamat kosong → `missing_phone_number`; variabel
 *    template tak terpetakan → `template_variable_missing`.
 */
export function classifyBroadcastCandidate(input: {
  candidate: AudienceCandidate;
  provider: BroadcastProvider;
  requireOptIn: boolean;
  waTemplate: WhatsAppTemplate | null;
  templateVariableSources: string[];
  now: Date;
}): BroadcastCandidateClassification {
  const { candidate, provider } = input;
  if (candidate.optInStatus === "opted_out") {
    return { kind: "skip", reason: "opted_out" };
  }
  if (
    input.requireOptIn &&
    effectiveOptInStatus(candidate) !== "opted_in"
  ) {
    return { kind: "skip", reason: "not_opted_in" };
  }
  const isMeta = provider === "messenger" || provider === "instagram";
  if (isMeta) {
    const windowStart = new Date(input.now.getTime() - META_24H_WINDOW_MS);
    if (!candidate.lastInboundAt || candidate.lastInboundAt < windowStart) {
      return { kind: "skip", reason: "outside_24h_window" };
    }
  }
  if (provider === "whatsapp") {
    if (!input.waTemplate) {
      // Tak tercapai dari dispatch/pratinjau: gerbang template berjalan
      // lebih dulu. Diperlakukan sebagai variabel tak terpetakan agar
      // klasifikasi tetap total (tidak pernah melempar).
      return { kind: "skip", reason: "template_variable_missing" };
    }
    if (!candidate.externalUserId || candidate.externalUserId.trim() === "") {
      return { kind: "skip", reason: "missing_phone_number" };
    }
    // Fase 17: template ber-variabel HEADER / tombol URL belum bisa
    // dipetakan ke sumber data di broadcast. Ditolak DI SINI (sebelum
    // materialisasi) supaya tidak menjadi ribuan pesan `failed` di Meta
    // dengan kode yang tidak menjelaskan apa pun.
    const spec = deriveTemplateParamSpec(input.waTemplate.components);
    if (spec.header.variableCount > 0 || spec.urlButtons.length > 0) {
      return { kind: "skip", reason: "template_component_unsupported" };
    }
    const params = resolveTemplateBodyParams(
      input.waTemplate,
      input.templateVariableSources,
      candidate,
    );
    if (!params) return { kind: "skip", reason: "template_variable_missing" };
    return {
      kind: "send",
      templateBodyParams: params,
      templatePreview: renderWhatsAppTemplatePreview(
        input.waTemplate.bodyText ?? "",
        params,
      ),
    };
  }
  return { kind: "send", templateBodyParams: null, templatePreview: null };
}

export interface BroadcastAudiencePreview {
  totalCandidates: number;
  willSend: number;
  skippedOptedOut: number;
  skippedNotOptedIn: number;
  skippedOutside24hWindow: number;
  skippedMissingPhoneNumber: number;
  skippedTemplateVariableMissing: number;
  skippedTemplateComponentUnsupported: number;
}

export type PreviewBroadcastAudienceResult =
  | { kind: "ok"; preview: BroadcastAudiencePreview }
  | { kind: "channel_not_found" }
  | { kind: "segment_not_found" }
  | { kind: "template_required" }
  | { kind: "template_not_found" }
  | { kind: "template_not_approved"; status: string };

/**
 * Pratinjau audiens untuk formulir (Fase 13C, menggantikan estimasi
 * 7C): menghitung rincian kirim/skip dengan classifyBroadcastCandidate
 * yang sama seperti dispatch. `requireOptIn` kosong → bawaan provider
 * (WhatsApp true, selain itu false), sama seperti bawaan pembuatan.
 */
export async function previewBroadcastAudience(
  db: Database,
  input: {
    tenantId: string;
    channelAccountId: string;
    filter?: BroadcastAudienceFilter;
    requireOptIn?: boolean;
    whatsappTemplateId?: string | null;
    templateVariableSources?: string[];
  },
): Promise<PreviewBroadcastAudienceResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [account] = await tx
      .select({
        id: channelAccounts.id,
        provider: channelAccounts.provider,
        trashedAt: channelAccounts.trashedAt,
      })
      .from(channelAccounts)
      .where(
        and(
          eq(channelAccounts.tenantId, input.tenantId),
          eq(channelAccounts.id, input.channelAccountId),
        ),
      )
      .limit(1);
    if (!account || account.trashedAt) {
      return { kind: "channel_not_found" as const };
    }
    const provider = account.provider as BroadcastProvider;
    const filter = normalizeFilter(input.filter);
    if (filterAudienceMode(filter) === "segment") {
      const segment = filter.segmentId
        ? await getSegmentRow(tx, input.tenantId, filter.segmentId)
        : null;
      if (!segment) return { kind: "segment_not_found" as const };
    }
    let waTemplate: WhatsAppTemplate | null = null;
    if (provider === "whatsapp") {
      const tGate = await gateWhatsAppTemplate(
        tx,
        input.tenantId,
        input.channelAccountId,
        input.whatsappTemplateId,
      );
      if (tGate.kind !== "ok") return tGate;
      waTemplate = tGate.template;
    }
    const requireOptIn = input.requireOptIn ?? provider === "whatsapp";
    const candidates = await resolveAudienceCandidates(
      tx,
      input.tenantId,
      input.channelAccountId,
      filter,
    );
    const preview: BroadcastAudiencePreview = {
      totalCandidates: candidates.length,
      willSend: 0,
      skippedOptedOut: 0,
      skippedNotOptedIn: 0,
      skippedOutside24hWindow: 0,
      skippedMissingPhoneNumber: 0,
      skippedTemplateVariableMissing: 0,
      skippedTemplateComponentUnsupported: 0,
    };
    const now = new Date();
    for (const candidate of candidates) {
      const classified = classifyBroadcastCandidate({
        candidate,
        provider,
        requireOptIn,
        waTemplate,
        templateVariableSources: normalizeTemplateVariableSources(
          input.templateVariableSources,
        ),
        now,
      });
      if (classified.kind === "send") preview.willSend += 1;
      else if (classified.reason === "opted_out") preview.skippedOptedOut += 1;
      else if (classified.reason === "not_opted_in") {
        preview.skippedNotOptedIn += 1;
      } else if (classified.reason === "outside_24h_window") {
        preview.skippedOutside24hWindow += 1;
      } else if (classified.reason === "missing_phone_number") {
        preview.skippedMissingPhoneNumber += 1;
      } else if (classified.reason === "template_component_unsupported") {
        preview.skippedTemplateComponentUnsupported += 1;
      } else {
        preview.skippedTemplateVariableMissing += 1;
      }
    }
    return { kind: "ok" as const, preview };
  });
}

// ---------------------------------------------------------------------------
// Statistik (sumber kebenaran: broadcast_recipients)
// ---------------------------------------------------------------------------

async function getBroadcastStats(
  tx: DbTx,
  tenantId: string,
  broadcastId: string,
): Promise<BroadcastStats> {
  const rows = await tx
    .select({
      status: broadcastRecipients.status,
      n: sql<string>`count(*)`,
    })
    .from(broadcastRecipients)
    .where(
      and(
        eq(broadcastRecipients.tenantId, tenantId),
        eq(broadcastRecipients.broadcastId, broadcastId),
      ),
    )
    .groupBy(broadcastRecipients.status);
  const stats: BroadcastStats = {
    total: 0,
    queued: 0,
    sent: 0,
    delivered: 0,
    read: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
  };
  for (const row of rows) {
    const n = Number(row.n);
    stats[row.status] += n;
    stats.total += n;
  }
  return stats;
}

async function getStatsForMany(
  tx: DbTx,
  tenantId: string,
  broadcastIds: string[],
): Promise<Map<string, BroadcastStats>> {
  const map = new Map<string, BroadcastStats>();
  if (broadcastIds.length === 0) return map;
  const rows = await tx
    .select({
      broadcastId: broadcastRecipients.broadcastId,
      status: broadcastRecipients.status,
      n: sql<string>`count(*)`,
    })
    .from(broadcastRecipients)
    .where(
      and(
        eq(broadcastRecipients.tenantId, tenantId),
        inArray(broadcastRecipients.broadcastId, broadcastIds),
      ),
    )
    .groupBy(broadcastRecipients.broadcastId, broadcastRecipients.status);
  for (const id of broadcastIds) {
    map.set(id, {
      total: 0, queued: 0, sent: 0, delivered: 0,
      read: 0, failed: 0, skipped: 0, cancelled: 0,
    });
  }
  for (const row of rows) {
    const stats = map.get(row.broadcastId)!;
    const n = Number(row.n);
    stats[row.status] += n;
    stats.total += n;
  }
  return map;
}

// ---------------------------------------------------------------------------
// Baca: daftar + detail + penerima
// ---------------------------------------------------------------------------

async function selectBroadcastWithChannel(
  tx: DbTx,
  tenantId: string,
  broadcastId: string,
): Promise<BroadcastWithChannel | null> {
  const [row] = await tx
    .select({
      broadcast: broadcasts,
      provider: channelAccounts.provider,
      channelDisplayName: channelAccounts.displayName,
    })
    .from(broadcasts)
    .innerJoin(
      channelAccounts,
      eq(broadcasts.channelAccountId, channelAccounts.id),
    )
    .where(
      and(eq(broadcasts.tenantId, tenantId), eq(broadcasts.id, broadcastId)),
    )
    .limit(1);
  if (!row) return null;
  return {
    ...row.broadcast,
    provider: row.provider,
    channelDisplayName: row.channelDisplayName,
  };
}

export async function getBroadcast(
  db: Database,
  input: { tenantId: string; broadcastId: string },
): Promise<{ broadcast: BroadcastWithChannel; stats: BroadcastStats } | null> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const broadcast = await selectBroadcastWithChannel(
      tx,
      input.tenantId,
      input.broadcastId,
    );
    if (!broadcast) return null;
    const stats = await getBroadcastStats(tx, input.tenantId, broadcast.id);
    return { broadcast, stats };
  });
}

export async function listBroadcasts(
  db: Database,
  input: {
    tenantId: string;
    status?: BroadcastStatus;
    cursor?: string;
    limit?: number;
  },
): Promise<{
  broadcasts: Array<BroadcastWithChannel & { stats: BroadcastStats }>;
  nextCursor: string | null;
}> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const limit = clampLimit(input.limit);
    const conditions = [eq(broadcasts.tenantId, input.tenantId)];
    if (input.status) conditions.push(eq(broadcasts.status, input.status));
    const cursor = decodeCursor(input.cursor);
    if (cursor) {
      const cursorDate = new Date(cursor.createdAt);
      conditions.push(
        or(
          lt(broadcasts.createdAt, cursorDate),
          and(
            eq(broadcasts.createdAt, cursorDate),
            lt(broadcasts.id, cursor.id),
          ),
        )!,
      );
    }
    const rows = await tx
      .select({
        broadcast: broadcasts,
        provider: channelAccounts.provider,
        channelDisplayName: channelAccounts.displayName,
      })
      .from(broadcasts)
      .innerJoin(
        channelAccounts,
        eq(broadcasts.channelAccountId, channelAccounts.id),
      )
      .where(and(...conditions))
      .orderBy(desc(broadcasts.createdAt), desc(broadcasts.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const statsMap = await getStatsForMany(
      tx,
      input.tenantId,
      pageRows.map((r) => r.broadcast.id),
    );
    return {
      broadcasts: pageRows.map((r) => ({
        ...r.broadcast,
        provider: r.provider,
        channelDisplayName: r.channelDisplayName,
        stats: statsMap.get(r.broadcast.id)!,
      })),
      nextCursor: hasMore
        ? encodeCursor(pageRows[pageRows.length - 1].broadcast)
        : null,
    };
  });
}

export async function listBroadcastRecipients(
  db: Database,
  input: {
    tenantId: string;
    broadcastId: string;
    status?: BroadcastRecipientStatus;
    cursor?: string;
    limit?: number;
  },
): Promise<
  | { kind: "ok"; recipients: BroadcastRecipientWithContact[]; nextCursor: string | null }
  | { kind: "not_found" }
> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const broadcast = await selectBroadcastWithChannel(
      tx,
      input.tenantId,
      input.broadcastId,
    );
    if (!broadcast) return { kind: "not_found" as const };
    const limit = clampLimit(input.limit);
    const conditions = [
      eq(broadcastRecipients.tenantId, input.tenantId),
      eq(broadcastRecipients.broadcastId, input.broadcastId),
    ];
    if (input.status) {
      conditions.push(eq(broadcastRecipients.status, input.status));
    }
    const cursor = decodeCursor(input.cursor);
    if (cursor) {
      const cursorDate = new Date(cursor.createdAt);
      conditions.push(
        or(
          lt(broadcastRecipients.createdAt, cursorDate),
          and(
            eq(broadcastRecipients.createdAt, cursorDate),
            lt(broadcastRecipients.id, cursor.id),
          ),
        )!,
      );
    }
    const rows = await tx
      .select({ recipient: broadcastRecipients, contactName: contacts.name })
      .from(broadcastRecipients)
      .innerJoin(contacts, eq(broadcastRecipients.contactId, contacts.id))
      .where(and(...conditions))
      .orderBy(
        desc(broadcastRecipients.createdAt),
        desc(broadcastRecipients.id),
      )
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    return {
      kind: "ok" as const,
      recipients: pageRows.map((r) => ({
        ...r.recipient,
        contactName: r.contactName,
      })),
      nextCursor: hasMore
        ? encodeCursor(pageRows[pageRows.length - 1].recipient)
        : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Tulis: buat / edit / hapus draft
// ---------------------------------------------------------------------------

type ChannelGate =
  | { kind: "ok"; provider: string }
  | { kind: "channel_not_found" }
  | { kind: "channel_unsupported"; provider: string };

async function gateChannelForBroadcast(
  tx: DbTx,
  tenantId: string,
  channelAccountId: string,
): Promise<ChannelGate> {
  const [account] = await tx
    .select({
      id: channelAccounts.id,
      provider: channelAccounts.provider,
      trashedAt: channelAccounts.trashedAt,
    })
    .from(channelAccounts)
    .where(
      and(
        eq(channelAccounts.tenantId, tenantId),
        eq(channelAccounts.id, channelAccountId),
      ),
    )
    .limit(1);
  if (!account || account.trashedAt) return { kind: "channel_not_found" };
  if (!BROADCAST_SUPPORTED_PROVIDERS.has(account.provider)) {
    return { kind: "channel_unsupported", provider: account.provider };
  }
  return { kind: "ok", provider: account.provider };
}

/** Hasil gerbang template WhatsApp (Fase 10A). */
export type WhatsAppTemplateGate =
  | { kind: "ok"; template: WhatsAppTemplate }
  | { kind: "template_required" }
  | { kind: "template_not_found" }
  | { kind: "template_not_approved"; status: string };

/**
 * Gerbang template broadcast WhatsApp: wajib menunjuk baris cermin
 * pada AKUN YANG SAMA berstatus APPROVED. Dipakai saat buat / edit /
 * jadwalkan (lapisan API menerjemahkan kind menjadi kode kontrak)
 * dan diperiksa ulang saat dispatch.
 */
async function gateWhatsAppTemplate(
  tx: DbTx,
  tenantId: string,
  channelAccountId: string,
  templateId: string | null | undefined,
): Promise<WhatsAppTemplateGate> {
  if (!templateId) return { kind: "template_required" };
  const [template] = await tx
    .select()
    .from(whatsappTemplates)
    .where(
      and(
        eq(whatsappTemplates.tenantId, tenantId),
        eq(whatsappTemplates.id, templateId),
        eq(whatsappTemplates.channelAccountId, channelAccountId),
      ),
    )
    .limit(1);
  if (!template) return { kind: "template_not_found" };
  if (template.status !== "APPROVED") {
    return { kind: "template_not_approved", status: template.status };
  }
  return { kind: "ok", template };
}

/**
 * Normalisasi sumber variabel template: trim per posisi, maks 25.
 * Entri kosong DIPERTAHANKAN (posisi adalah makna: menggeser entri
 * akan memetakan variabel ke sumber yang salah); dispatch
 * memperlakukan entri kosong sebagai tak terpetakan.
 */
function normalizeTemplateVariableSources(
  sources: string[] | undefined,
): string[] {
  if (!sources) return [];
  return sources.map((s) => s.trim()).slice(0, 25);
}

/**
 * Keadaan akhir konfigurasi uji A/B broadcast (Fase 13D) — diselesaikan
 * SATU KALI oleh helper ini untuk buat & edit agar kedua jalur tidak
 * pernah berbeda aturan:
 * - percentB kosong → A/B mati: semua kolom varian B dibersihkan.
 * - WhatsApp → template B wajib lolos gerbang yang sama seperti
 *   template A (cermin lokal, akun sama, APPROVED); teks varian B
 *   adalah snapshot BODY template B (selaras perlakuan varian A).
 * - Provider teks → isi teks B wajib non-kosong (`ab_incomplete`);
 *   penunjukan template B dibersihkan.
 */
export type BroadcastAbConfigResolution =
  | {
      kind: "ok";
      abSplitPercentB: number | null;
      variantBMessageText: string | null;
      variantBWhatsappTemplateId: string | null;
      variantBTemplateVariableSources: string[];
      /** Template B tergerbang (WhatsApp) untuk dipakai dispatch awal. */
      variantBTemplate: WhatsAppTemplate | null;
    }
  | { kind: "ab_incomplete" }
  | { kind: "template_required" }
  | { kind: "template_not_found" }
  | { kind: "template_not_approved"; status: string };

async function resolveBroadcastAbConfig(
  tx: DbTx,
  input: {
    tenantId: string;
    channelAccountId: string;
    provider: string;
    abSplitPercentB: number | null | undefined;
    variantBMessageText: string | null | undefined;
    variantBWhatsappTemplateId: string | null | undefined;
    variantBTemplateVariableSources: string[] | undefined;
  },
): Promise<BroadcastAbConfigResolution> {
  const cleared = {
    kind: "ok" as const,
    abSplitPercentB: null,
    variantBMessageText: null,
    variantBWhatsappTemplateId: null,
    variantBTemplateVariableSources: [] as string[],
    variantBTemplate: null,
  };
  if (
    input.abSplitPercentB === null ||
    input.abSplitPercentB === undefined
  ) {
    return cleared;
  }
  const percentB = input.abSplitPercentB;
  if (
    !Number.isInteger(percentB) ||
    percentB < 1 ||
    percentB > 99
  ) {
    return { kind: "ab_incomplete" };
  }
  if (input.provider === "whatsapp") {
    const bGate = await gateWhatsAppTemplate(
      tx,
      input.tenantId,
      input.channelAccountId,
      input.variantBWhatsappTemplateId,
    );
    if (bGate.kind !== "ok") return bGate;
    return {
      kind: "ok",
      abSplitPercentB: percentB,
      variantBMessageText:
        bGate.template.bodyText ?? bGate.template.name,
      variantBWhatsappTemplateId: bGate.template.id,
      variantBTemplateVariableSources: normalizeTemplateVariableSources(
        input.variantBTemplateVariableSources,
      ),
      variantBTemplate: bGate.template,
    };
  }
  if (
    !input.variantBMessageText ||
    input.variantBMessageText.trim() === ""
  ) {
    return { kind: "ab_incomplete" };
  }
  return {
    kind: "ok",
    abSplitPercentB: percentB,
    variantBMessageText: input.variantBMessageText,
    variantBWhatsappTemplateId: null,
    variantBTemplateVariableSources: [],
    variantBTemplate: null,
  };
}

/**
 * Varian deterministik satu penerima (Fase 13D): hash stabil atas
 * (broadcast, kontak) dibucket terhadap percentB. Fungsi murni —
 * materialisasi ulang menghasilkan varian yang sama; dan baris
 * penerima yang sudah ada tidak pernah ditulis ulang saat resume.
 */
export function broadcastVariantFor(
  broadcastId: string,
  contactId: string,
  abSplitPercentB: number | null | undefined,
): "a" | "b" {
  if (
    abSplitPercentB === null ||
    abSplitPercentB === undefined ||
    !Number.isInteger(abSplitPercentB) ||
    abSplitPercentB < 1 ||
    abSplitPercentB > 99
  ) {
    return "a";
  }
  return broadcastVariantForBucket(
    experimentBucket(broadcastExperimentKey(broadcastId, contactId)),
    abSplitPercentB,
  );
}

const TEMPLATE_PLACEHOLDER_RE = /\{\{(\d+)\}\}/g;

/**
 * Petakan nilai variabel BODY template untuk SATU penerima
 * (keputusan v1 Fase 10A): posisi {{n}} mengambil sumber ke-n dari
 * `sources` — "name" = nama kontak, nilai lain = kunci custom_fields
 * kontak; posisi 1 tanpa sumber jatuh ke "name". Nilai kosong /
 * kunci tidak ada / posisi tanpa sumber → null (penerima di-skip
 * `template_variable_missing`) — TIDAK PERNAH string kosong.
 */
function resolveTemplateBodyParams(
  template: WhatsAppTemplate,
  sources: string[],
  candidate: AudienceCandidate,
): string[] | null {
  const params: string[] = [];
  for (let pos = 1; pos <= template.variableCount; pos++) {
    const rawSource = sources[pos - 1];
    const source =
      rawSource && rawSource.trim() !== ""
        ? rawSource
        : pos === 1
          ? "name"
          : undefined;
    if (!source) return null;
    let value: string | null = null;
    if (source === "name") {
      value = candidate.contactName;
    } else {
      const raw = candidate.customFields?.[source];
      if (typeof raw === "string") value = raw;
      else if (typeof raw === "number" || typeof raw === "boolean") {
        value = String(raw);
      }
    }
    if (value === null || value.trim() === "") return null;
    params.push(value);
  }
  return params;
}

/**
 * Render pratinjau teks template dengan parameter terisi — disimpan
 * sebagai content_text pesan keluar agar inbox menampilkan isi yang
 * benar-benar terkirim. Cermin dari helper klien channel-whatsapp
 * (core berada DI BAWAH paket channel, jadi tidak mengimpornya).
 */
function renderWhatsAppTemplatePreview(
  bodyText: string,
  bodyParams: string[],
): string {
  return bodyText.replace(TEMPLATE_PLACEHOLDER_RE, (_whole, raw: string) => {
    const idx = Number(raw) - 1;
    return idx >= 0 && idx < bodyParams.length ? bodyParams[idx] : "";
  });
}

export type CreateBroadcastResult =
  | { kind: "created"; broadcast: BroadcastWithChannel }
  | { kind: "channel_not_found" }
  | { kind: "channel_unsupported"; provider: string }
  | { kind: "template_required" }
  | { kind: "template_not_found" }
  | { kind: "template_not_approved"; status: string }
  | { kind: "segment_not_found" }
  | { kind: "ab_incomplete" }
  | { kind: "message_required" };

export async function createBroadcast(
  db: Database,
  input: {
    tenantId: string;
    userId: string;
    name: string;
    channelAccountId: string;
    /** Wajib untuk provider teks; untuk whatsapp diabaikan (template). */
    messageText?: string;
    /** Fase 10A: wajib (dan harus APPROVED) untuk channel whatsapp. */
    whatsappTemplateId?: string | null;
    templateVariableSources?: string[];
    filter?: BroadcastAudienceFilter;
    /**
     * Fase 13C: gerbang opt-in; kosong = bawaan provider (WhatsApp
     * true — broadcast template adalah pesan pemasaran proaktif —
     * selain itu false).
     */
    requireOptIn?: boolean;
    /**
     * Fase 13D: uji A/B. abSplitPercentB terisi = A/B menyala dan isi
     * varian B wajib sah untuk provider (teks B / template B);
     * kosong/null = tanpa A/B (kolom varian dibersihkan server).
     */
    abSplitPercentB?: number | null;
    variantBMessageText?: string | null;
    variantBWhatsappTemplateId?: string | null;
    variantBTemplateVariableSources?: string[];
  },
): Promise<CreateBroadcastResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const gate = await gateChannelForBroadcast(
      tx,
      input.tenantId,
      input.channelAccountId,
    );
    if (gate.kind !== "ok") return gate;
    const normalizedFilter = normalizeFilter(input.filter);
    if (filterAudienceMode(normalizedFilter) === "segment") {
      const segment = normalizedFilter.segmentId
        ? await getSegmentRow(tx, input.tenantId, normalizedFilter.segmentId)
        : null;
      if (!segment) return { kind: "segment_not_found" as const };
    }
    let messageText = input.messageText;
    let whatsappTemplateId: string | null = null;
    let templateVariableSources: string[] = [];
    if (gate.provider === "whatsapp") {
      const tGate = await gateWhatsAppTemplate(
        tx,
        input.tenantId,
        input.channelAccountId,
        input.whatsappTemplateId,
      );
      if (tGate.kind !== "ok") return tGate;
      whatsappTemplateId = tGate.template.id;
      templateVariableSources = normalizeTemplateVariableSources(
        input.templateVariableSources,
      );
      // Teks broadcast WA = snapshot BODY template (pratinjau daftar);
      // isi sesungguhnya dirender per penerima saat dispatch.
      messageText = tGate.template.bodyText ?? tGate.template.name;
    } else if (!messageText || messageText.trim() === "") {
      return { kind: "message_required" as const };
    }
    // Fase 13D: selesaikan konfigurasi A/B terhadap provider final
    // (gerbang template B untuk WhatsApp; teks B wajib untuk teks).
    const ab = await resolveBroadcastAbConfig(tx, {
      tenantId: input.tenantId,
      channelAccountId: input.channelAccountId,
      provider: gate.provider,
      abSplitPercentB: input.abSplitPercentB,
      variantBMessageText: input.variantBMessageText,
      variantBWhatsappTemplateId: input.variantBWhatsappTemplateId,
      variantBTemplateVariableSources: input.variantBTemplateVariableSources,
    });
    if (ab.kind !== "ok") return ab;
    const [row] = await tx
      .insert(broadcasts)
      .values({
        tenantId: input.tenantId,
        channelAccountId: input.channelAccountId,
        name: input.name,
        messageText: messageText!,
        whatsappTemplateId,
        templateVariableSources,
        audienceFilter: normalizedFilter,
        requireOptIn: input.requireOptIn ?? gate.provider === "whatsapp",
        abSplitPercentB: ab.abSplitPercentB,
        variantBMessageText: ab.variantBMessageText,
        variantBWhatsappTemplateId: ab.variantBWhatsappTemplateId,
        variantBTemplateVariableSources: ab.variantBTemplateVariableSources,
        status: "draft",
        createdByUserId: input.userId,
      })
      .returning();
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "broadcast.created",
      meta: {
        broadcastId: row.id,
        channelAccountId: input.channelAccountId,
        provider: gate.provider,
        ...(whatsappTemplateId ? { whatsappTemplateId } : {}),
        ...(ab.abSplitPercentB !== null
          ? { abSplitPercentB: ab.abSplitPercentB }
          : {}),
      },
    });
    const broadcast = await selectBroadcastWithChannel(
      tx,
      input.tenantId,
      row.id,
    );
    return { kind: "created" as const, broadcast: broadcast! };
  });
}

export type UpdateBroadcastResult =
  | { kind: "updated"; broadcast: BroadcastWithChannel }
  | { kind: "not_found" }
  | { kind: "invalid_state"; status: BroadcastStatus }
  | { kind: "channel_not_found" }
  | { kind: "channel_unsupported"; provider: string }
  | { kind: "template_required" }
  | { kind: "template_not_found" }
  | { kind: "template_not_approved"; status: string }
  | { kind: "ab_incomplete" }
  | { kind: "segment_not_found" };

export async function updateBroadcast(
  db: Database,
  input: {
    tenantId: string;
    broadcastId: string;
    /** Fase 13D: untuk audit perubahan konfigurasi A/B (opsional). */
    userId?: string;
    patch: {
      name?: string;
      channelAccountId?: string;
      messageText?: string;
      /** Fase 10A: ganti / lepas (null) template WhatsApp. */
      whatsappTemplateId?: string | null;
      templateVariableSources?: string[];
      filter?: BroadcastAudienceFilter;
      /** Fase 13C: ubah gerbang opt-in (hanya selama draft). */
      requireOptIn?: boolean;
      /**
       * Fase 13D: konfigurasi uji A/B. abSplitPercentB null eksplisit
       * = matikan A/B; undefined = pertahankan keadaan tersimpan
       * (divalidasi ulang terhadap provider/channel akhir).
       */
      abSplitPercentB?: number | null;
      variantBMessageText?: string | null;
      variantBWhatsappTemplateId?: string | null;
      variantBTemplateVariableSources?: string[];
    };
  },
): Promise<UpdateBroadcastResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const existing = await selectBroadcastWithChannel(
      tx,
      input.tenantId,
      input.broadcastId,
    );
    if (!existing) return { kind: "not_found" as const };
    if (existing.status !== "draft") {
      return { kind: "invalid_state" as const, status: existing.status };
    }
    const finalChannelId =
      input.patch.channelAccountId ?? existing.channelAccountId;
    let finalProvider = existing.provider;
    if (finalChannelId !== existing.channelAccountId) {
      const gate = await gateChannelForBroadcast(
        tx,
        input.tenantId,
        finalChannelId,
      );
      if (gate.kind !== "ok") return gate;
      finalProvider = gate.provider;
    }
    const patch: Partial<Broadcast> = { updatedAt: new Date() };
    if (input.patch.name !== undefined) patch.name = input.patch.name;
    if (input.patch.channelAccountId !== undefined) {
      patch.channelAccountId = input.patch.channelAccountId;
    }
    if (input.patch.messageText !== undefined) {
      patch.messageText = input.patch.messageText;
    }
    if (input.patch.filter !== undefined) {
      const normalized = normalizeFilter(input.patch.filter);
      if (filterAudienceMode(normalized) === "segment") {
        const segment = normalized.segmentId
          ? await getSegmentRow(tx, input.tenantId, normalized.segmentId)
          : null;
        if (!segment) return { kind: "segment_not_found" as const };
      }
      patch.audienceFilter = normalized;
    }
    if (input.patch.requireOptIn !== undefined) {
      patch.requireOptIn = input.patch.requireOptIn;
    }
    // Fase 10A: keadaan akhir broadcast WhatsApp selalu lolos gerbang
    // template (channel berganti ke WA tanpa template → ditolak);
    // broadcast non-WA selalu membersihkan penunjukan template.
    if (finalProvider === "whatsapp") {
      const finalTemplateId =
        input.patch.whatsappTemplateId !== undefined
          ? input.patch.whatsappTemplateId
          : existing.whatsappTemplateId;
      const tGate = await gateWhatsAppTemplate(
        tx,
        input.tenantId,
        finalChannelId,
        finalTemplateId,
      );
      if (tGate.kind !== "ok") return tGate;
      patch.whatsappTemplateId = tGate.template.id;
      if (input.patch.templateVariableSources !== undefined) {
        patch.templateVariableSources = normalizeTemplateVariableSources(
          input.patch.templateVariableSources,
        );
      }
      if (input.patch.messageText === undefined) {
        patch.messageText = tGate.template.bodyText ?? tGate.template.name;
      }
    } else {
      patch.whatsappTemplateId = null;
      patch.templateVariableSources = [];
    }
    // Fase 13D: keadaan akhir A/B diselesaikan terhadap provider +
    // channel AKHIR (template B milik channel lama tidak ikut pindah
    // — kandidatnya hanya dari patch; gerbang menolak bila tak sah).
    const channelChanged = finalChannelId !== existing.channelAccountId;
    const ab = await resolveBroadcastAbConfig(tx, {
      tenantId: input.tenantId,
      channelAccountId: finalChannelId,
      provider: finalProvider,
      abSplitPercentB:
        input.patch.abSplitPercentB !== undefined
          ? input.patch.abSplitPercentB
          : existing.abSplitPercentB,
      variantBMessageText:
        input.patch.variantBMessageText !== undefined
          ? input.patch.variantBMessageText
          : existing.variantBMessageText,
      variantBWhatsappTemplateId:
        input.patch.variantBWhatsappTemplateId !== undefined
          ? input.patch.variantBWhatsappTemplateId
          : channelChanged
            ? null
            : existing.variantBWhatsappTemplateId,
      variantBTemplateVariableSources:
        input.patch.variantBTemplateVariableSources !== undefined
          ? input.patch.variantBTemplateVariableSources
          : ((existing.variantBTemplateVariableSources as
              | string[]
              | null) ?? []),
    });
    if (ab.kind !== "ok") return ab;
    patch.abSplitPercentB = ab.abSplitPercentB;
    patch.variantBMessageText = ab.variantBMessageText;
    patch.variantBWhatsappTemplateId = ab.variantBWhatsappTemplateId;
    patch.variantBTemplateVariableSources =
      ab.variantBTemplateVariableSources;
    const abChanged =
      (existing.abSplitPercentB ?? null) !== ab.abSplitPercentB;
    await tx
      .update(broadcasts)
      .set(patch)
      .where(eq(broadcasts.id, input.broadcastId));
    // Fase 13D: perubahan konfigurasi A/B (nyala/mati/persen) diaudit
    // mengikuti pola audit broadcast.created/scheduled — edit biasa
    // tanpa perubahan A/B tidak menambah baris audit (perilaku lama).
    if (abChanged && input.userId) {
      await tx.insert(auditLogs).values({
        tenantId: input.tenantId,
        actorType: "user",
        actorId: input.userId,
        action: "broadcast.ab_config_changed",
        meta: {
          broadcastId: input.broadcastId,
          enabled: ab.abSplitPercentB !== null,
          splitPercentB: ab.abSplitPercentB,
        },
      });
    }
    const broadcast = await selectBroadcastWithChannel(
      tx,
      input.tenantId,
      input.broadcastId,
    );
    return { kind: "updated" as const, broadcast: broadcast! };
  });
}

export type DeleteBroadcastResult =
  | { kind: "deleted" }
  | { kind: "not_found" }
  | { kind: "invalid_state"; status: BroadcastStatus };

export async function deleteBroadcast(
  db: Database,
  input: { tenantId: string; broadcastId: string; userId: string },
): Promise<DeleteBroadcastResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const existing = await selectBroadcastWithChannel(
      tx,
      input.tenantId,
      input.broadcastId,
    );
    if (!existing) return { kind: "not_found" as const };
    if (existing.status !== "draft") {
      return { kind: "invalid_state" as const, status: existing.status };
    }
    await tx.delete(broadcasts).where(eq(broadcasts.id, input.broadcastId));
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "broadcast.deleted",
      meta: { broadcastId: input.broadcastId },
    });
    return { kind: "deleted" as const };
  });
}

// ---------------------------------------------------------------------------
// Jadwalkan (draft → scheduled + event outbox untuk relay worker)
// ---------------------------------------------------------------------------

export type ScheduleBroadcastResult =
  | { kind: "scheduled"; broadcast: BroadcastWithChannel; dispatchAt: Date }
  | { kind: "not_found" }
  | { kind: "invalid_state"; status: BroadcastStatus }
  | { kind: "channel_disconnected" }
  | { kind: "channel_unsupported"; provider: string }
  | { kind: "template_required" }
  | { kind: "template_not_approved"; status: string };

export async function scheduleBroadcast(
  db: Database,
  input: {
    tenantId: string;
    broadcastId: string;
    userId: string;
    /** Null/tidak diisi = kirim sekarang. Waktu lampau diperlakukan sekarang. */
    scheduledAt?: Date | null;
  },
): Promise<ScheduleBroadcastResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const existing = await selectBroadcastWithChannel(
      tx,
      input.tenantId,
      input.broadcastId,
    );
    if (!existing) return { kind: "not_found" as const };
    if (existing.status !== "draft") {
      return { kind: "invalid_state" as const, status: existing.status };
    }
    const [account] = await tx
      .select({
        status: channelAccounts.status,
        trashedAt: channelAccounts.trashedAt,
        provider: channelAccounts.provider,
      })
      .from(channelAccounts)
      .where(
        and(
          eq(channelAccounts.tenantId, input.tenantId),
          eq(channelAccounts.id, existing.channelAccountId),
        ),
      )
      .limit(1);
    if (!account || account.trashedAt || account.status !== "connected") {
      return { kind: "channel_disconnected" as const };
    }
    if (!BROADCAST_SUPPORTED_PROVIDERS.has(account.provider)) {
      return {
        kind: "channel_unsupported" as const,
        provider: account.provider,
      };
    }
    // Fase 10A: periksa ulang template SEBELUM menjadwalkan — status
    // persetujuan di Meta bisa berubah sejak broadcast dibuat.
    if (account.provider === "whatsapp") {
      const tGate = await gateWhatsAppTemplate(
        tx,
        input.tenantId,
        existing.channelAccountId,
        existing.whatsappTemplateId,
      );
      if (tGate.kind === "template_not_approved") {
        return { kind: "template_not_approved" as const, status: tGate.status };
      }
      if (tGate.kind !== "ok") {
        return { kind: "template_required" as const };
      }
      // Fase 13D: template B ber-A/B digerbang dengan aturan yang sama.
      if (existing.abSplitPercentB !== null) {
        const bGate = await gateWhatsAppTemplate(
          tx,
          input.tenantId,
          existing.channelAccountId,
          existing.variantBWhatsappTemplateId,
        );
        if (bGate.kind === "template_not_approved") {
          return {
            kind: "template_not_approved" as const,
            status: bGate.status,
          };
        }
        if (bGate.kind !== "ok") {
          return { kind: "template_required" as const };
        }
      }
    }
    const now = new Date();
    const dispatchAt =
      input.scheduledAt && input.scheduledAt.getTime() > now.getTime()
        ? input.scheduledAt
        : now;
    const [updated] = await tx
      .update(broadcasts)
      .set({ status: "scheduled", scheduledAt: dispatchAt, updatedAt: now })
      .where(
        and(
          eq(broadcasts.id, input.broadcastId),
          eq(broadcasts.status, "draft"),
        ),
      )
      .returning();
    if (!updated) {
      // Balapan dengan mutasi lain — laporkan keadaan terbaru.
      const fresh = await selectBroadcastWithChannel(
        tx,
        input.tenantId,
        input.broadcastId,
      );
      return {
        kind: "invalid_state" as const,
        status: fresh?.status ?? existing.status,
      };
    }
    // Relay worker menerjemahkan event ini menjadi job BullMQ tertunda
    // `broadcast.dispatch` (jobId deterministik dari id broadcast) —
    // pola yang sama dengan sequence.step_due (Fase 2C).
    await tx.insert(outboxEvents).values({
      tenantId: input.tenantId,
      type: "broadcast.dispatch_due",
      payload: {
        broadcastId: input.broadcastId,
        dispatchAt: dispatchAt.toISOString(),
      },
    });
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "broadcast.scheduled",
      meta: {
        broadcastId: input.broadcastId,
        channelAccountId: existing.channelAccountId,
        scheduledAt: dispatchAt.toISOString(),
      },
    });
    const broadcast = await selectBroadcastWithChannel(
      tx,
      input.tenantId,
      input.broadcastId,
    );
    return {
      kind: "scheduled" as const,
      broadcast: broadcast!,
      dispatchAt,
    };
  });
}

// ---------------------------------------------------------------------------
// Batalkan (draft/scheduled → cancelled; sending → sisa queued dihapus)
// ---------------------------------------------------------------------------

export type CancelBroadcastResult =
  | { kind: "cancelled"; broadcast: BroadcastWithChannel; cancelledRecipients: number }
  | { kind: "not_found" }
  | { kind: "invalid_state"; status: BroadcastStatus };

export async function cancelBroadcast(
  db: Database,
  input: { tenantId: string; broadcastId: string; userId: string },
): Promise<CancelBroadcastResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const existing = await selectBroadcastWithChannel(
      tx,
      input.tenantId,
      input.broadcastId,
    );
    if (!existing) return { kind: "not_found" as const };
    if (
      existing.status !== "draft" &&
      existing.status !== "scheduled" &&
      existing.status !== "sending"
    ) {
      return { kind: "invalid_state" as const, status: existing.status };
    }
    const now = new Date();
    let cancelledRecipients = 0;
    if (existing.status === "sending") {
      // Penerima yang masih queued: pesan keluarnya DIHAPUS (belum
      // pernah terkirim — poller tidak boleh mengirim pesan hantu) dan
      // penerimanya menjadi cancelled. Balapan dengan poller ditangani
      // jujur: pesan yang ternyata sudah berubah status (sedang/baru
      // terkirim) TIDAK dihapus; status penerimanya diselaraskan ke
      // status pesan itu.
      const queuedRecipients = await tx
        .select({
          id: broadcastRecipients.id,
          messageId: broadcastRecipients.messageId,
        })
        .from(broadcastRecipients)
        .where(
          and(
            eq(broadcastRecipients.tenantId, input.tenantId),
            eq(broadcastRecipients.broadcastId, input.broadcastId),
            eq(broadcastRecipients.status, "queued"),
          ),
        );
      for (const recipient of queuedRecipients) {
        if (recipient.messageId) {
          const [msg] = await tx
            .select({ status: messages.status })
            .from(messages)
            .where(eq(messages.id, recipient.messageId))
            .limit(1);
          if (msg && msg.status === "queued") {
            await tx.delete(messages).where(eq(messages.id, recipient.messageId));
            await tx
              .update(broadcastRecipients)
              .set({ status: "cancelled", updatedAt: now })
              .where(eq(broadcastRecipients.id, recipient.id));
            cancelledRecipients += 1;
          } else if (msg) {
            await tx
              .update(broadcastRecipients)
              .set({
                status: msg.status as BroadcastRecipientStatus,
                errorCode: null,
                updatedAt: now,
              })
              .where(eq(broadcastRecipients.id, recipient.id));
          } else {
            // Pesan sudah hilang (mis. purge) — penerima dibatalkan.
            await tx
              .update(broadcastRecipients)
              .set({ status: "cancelled", updatedAt: now })
              .where(eq(broadcastRecipients.id, recipient.id));
            cancelledRecipients += 1;
          }
        } else {
          await tx
            .update(broadcastRecipients)
            .set({ status: "cancelled", updatedAt: now })
            .where(eq(broadcastRecipients.id, recipient.id));
          cancelledRecipients += 1;
        }
      }
    }
    const [updated] = await tx
      .update(broadcasts)
      .set({ status: "cancelled", completedAt: now, updatedAt: now })
      .where(
        and(
          eq(broadcasts.id, input.broadcastId),
          inArray(broadcasts.status, ["draft", "scheduled", "sending"]),
        ),
      )
      .returning();
    if (!updated) {
      const fresh = await selectBroadcastWithChannel(
        tx,
        input.tenantId,
        input.broadcastId,
      );
      return {
        kind: "invalid_state" as const,
        status: fresh?.status ?? existing.status,
      };
    }
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "broadcast.cancelled",
      meta: {
        broadcastId: input.broadcastId,
        fromStatus: existing.status,
        cancelledRecipients,
      },
    });
    const broadcast = await selectBroadcastWithChannel(
      tx,
      input.tenantId,
      input.broadcastId,
    );
    return {
      kind: "cancelled" as const,
      broadcast: broadcast!,
      cancelledRecipients,
    };
  });
}

// ---------------------------------------------------------------------------
// Dispatch (sisi worker — job `broadcast.dispatch`)
// ---------------------------------------------------------------------------

export interface DispatchBroadcastResult {
  dispatched: boolean;
  reason?:
    | "not_found"
    | "not_scheduled"
    | "channel_disconnected"
    | "channel_unsupported"
    | "template_required"
    | "template_not_approved"
    | "audience_empty"
    | "cancelled_mid_dispatch";
  /** Jumlah penerima yang dimaterialisasi pada pemanggilan ini. */
  materialized?: number;
  queued?: number;
  skipped?: number;
}

/**
 * Mengeksekusi dispatch satu broadcast. Aman dipanggil berulang
 * (retry BullMQ): klaim atomik scheduled→sending; pemanggilan ulang
 * pada broadcast `sending` MELANJUTKAN materialisasi (penerima yang
 * sudah punya baris dilewati — unik (broadcast, kontak) menegakkan).
 * Bila broadcast dibatalkan di tengah dispatch, potongan berikutnya
 * berhenti (status diperiksa di awal setiap potongan).
 */
export async function dispatchBroadcast(
  db: Database,
  input: { tenantId: string; broadcastId: string },
): Promise<DispatchBroadcastResult> {
  const { tenantId, broadcastId } = input;

  // --- Klaim + pemeriksaan channel (satu transaksi tenant) ---
  const claim = await withTenantDb(db, tenantId, async (tx) => {
    const [broadcast] = await tx
      .select()
      .from(broadcasts)
      .where(
        and(eq(broadcasts.tenantId, tenantId), eq(broadcasts.id, broadcastId)),
      )
      .limit(1);
    if (!broadcast) return { kind: "not_found" as const };
    if (broadcast.status !== "scheduled" && broadcast.status !== "sending") {
      return { kind: "not_scheduled" as const };
    }
    const [account] = await tx
      .select()
      .from(channelAccounts)
      .where(
        and(
          eq(channelAccounts.tenantId, tenantId),
          eq(channelAccounts.id, broadcast.channelAccountId),
        ),
      )
      .limit(1);
    const failBroadcast = async (errorCode: string) => {
      const now = new Date();
      await tx
        .update(broadcasts)
        .set({
          status: "failed",
          errorCode,
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(broadcasts.id, broadcastId));
      await tx.insert(auditLogs).values({
        tenantId,
        actorType: "system",
        actorId: `broadcast:${broadcastId}`,
        action: "broadcast.failed",
        meta: { broadcastId, errorCode },
      });
    };
    if (!account || account.trashedAt || account.status !== "connected") {
      await failBroadcast("CHANNEL_DISCONNECTED");
      return { kind: "channel_disconnected" as const };
    }
    if (!BROADCAST_SUPPORTED_PROVIDERS.has(account.provider)) {
      await failBroadcast("CHANNEL_UNSUPPORTED");
      return { kind: "channel_unsupported" as const };
    }
    // Fase 10A: pemeriksaan template TERAKHIR di gerbang dispatch —
    // template yang dicabut persetujuannya di Meta sesudah jadwal
    // menutup broadcast `failed` berkode kontrak yang sama, bukan
    // mengirim diam-diam.
    let waTemplate: WhatsAppTemplate | null = null;
    let waTemplateB: WhatsAppTemplate | null = null;
    if (account.provider === "whatsapp") {
      const tGate = await gateWhatsAppTemplate(
        tx,
        tenantId,
        broadcast.channelAccountId,
        broadcast.whatsappTemplateId,
      );
      if (tGate.kind === "template_not_approved") {
        await failBroadcast("BROADCAST_TEMPLATE_NOT_APPROVED");
        return { kind: "template_not_approved" as const };
      }
      if (tGate.kind !== "ok") {
        await failBroadcast("BROADCAST_TEMPLATE_REQUIRED");
        return { kind: "template_required" as const };
      }
      waTemplate = tGate.template;
      // Fase 13D: gerbang dispatch yang sama untuk template B —
      // template B yang dicabut persetujuannya menutup broadcast
      // dengan kode yang sama, bukan mengirim varian A ke semua.
      if (broadcast.abSplitPercentB !== null) {
        const bGate = await gateWhatsAppTemplate(
          tx,
          tenantId,
          broadcast.channelAccountId,
          broadcast.variantBWhatsappTemplateId,
        );
        if (bGate.kind === "template_not_approved") {
          await failBroadcast("BROADCAST_TEMPLATE_NOT_APPROVED");
          return { kind: "template_not_approved" as const };
        }
        if (bGate.kind !== "ok") {
          await failBroadcast("BROADCAST_TEMPLATE_REQUIRED");
          return { kind: "template_required" as const };
        }
        waTemplateB = bGate.template;
      }
    }
    if (broadcast.status === "scheduled") {
      const now = new Date();
      const [claimed] = await tx
        .update(broadcasts)
        .set({ status: "sending", startedAt: now, updatedAt: now })
        .where(
          and(
            eq(broadcasts.id, broadcastId),
            eq(broadcasts.status, "scheduled"),
          ),
        )
        .returning();
      if (!claimed) return { kind: "not_scheduled" as const };
    }
    return {
      kind: "claimed" as const,
      broadcast,
      provider: account.provider as BroadcastProvider,
      waTemplate,
      waTemplateB,
    };
  });
  if (claim.kind !== "claimed") {
    return { dispatched: false, reason: claim.kind };
  }
  const { broadcast, provider, waTemplate, waTemplateB } = claim;
  const filter = normalizeFilter(
    broadcast.audienceFilter as BroadcastAudienceFilter,
  );

  const candidates = await withTenantDb(db, tenantId, (tx) =>
    resolveAudienceCandidates(tx, tenantId, broadcast.channelAccountId, filter),
  );
  if (candidates.length === 0) {
    await withTenantDb(db, tenantId, async (tx) => {
      const now = new Date();
      const [updated] = await tx
        .update(broadcasts)
        .set({
          status: "failed",
          errorCode: "AUDIENCE_EMPTY",
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(broadcasts.id, broadcastId),
            eq(broadcasts.status, "sending"),
          ),
        )
        .returning();
      if (updated) {
        await tx.insert(auditLogs).values({
          tenantId,
          actorType: "system",
          actorId: `broadcast:${broadcastId}`,
          action: "broadcast.failed",
          meta: { broadcastId, errorCode: "AUDIENCE_EMPTY" },
        });
      }
    });
    return { dispatched: false, reason: "audience_empty" };
  }

  // --- Materialisasi per potongan (transaksi wajar per ±200 penerima) ---
  let materialized = 0;
  let queuedCount = 0;
  let skippedCount = 0;
  let variantBCount = 0;
  for (let offset = 0; offset < candidates.length; offset += BROADCAST_DISPATCH_CHUNK) {
    const chunk = candidates.slice(offset, offset + BROADCAST_DISPATCH_CHUNK);
    const outcome = await withTenantDb(db, tenantId, async (tx) => {
      const [current] = await tx
        .select({ status: broadcasts.status })
        .from(broadcasts)
        .where(eq(broadcasts.id, broadcastId))
        .limit(1);
      if (!current || current.status !== "sending") {
        return {
          stopped: true as const,
          materialized: 0,
          queued: 0,
          skipped: 0,
          variantB: 0,
        };
      }
      // Lewati kontak yang sudah punya baris (resume sesudah retry).
      const existing = await tx
        .select({ contactId: broadcastRecipients.contactId })
        .from(broadcastRecipients)
        .where(
          and(
            eq(broadcastRecipients.broadcastId, broadcastId),
            inArray(
              broadcastRecipients.contactId,
              chunk.map((c) => c.contactId),
            ),
          ),
        );
      const existingIds = new Set(existing.map((r) => r.contactId));
      const now = new Date();
      let m = 0;
      let q = 0;
      let s = 0;
      let vb = 0;
      for (const candidate of chunk) {
        if (existingIds.has(candidate.contactId)) continue;
        // Fase 13D: varian penerima ditentukan DETERMINISTIK dari
        // (broadcast, kontak) SEBELUM klasifikasi — penerima yang
        // di-skip pun membawa variannya, agar rincian per varian
        // utuh; penerima lama tidak pernah dihitung ulang (barisnya
        // sudah ada → dilewati di atas), jadi varian tak berbalik.
        const variant = broadcastVariantFor(
          broadcastId,
          candidate.contactId,
          broadcast.abSplitPercentB,
        );
        const candidateTemplate =
          provider === "whatsapp"
            ? variant === "b"
              ? waTemplateB
              : waTemplate
            : null;
        const candidateSources =
          variant === "b"
            ? ((broadcast.variantBTemplateVariableSources as
                | string[]
                | null) ?? [])
            : ((broadcast.templateVariableSources as string[] | null) ?? []);
        // Fase 13C: klasifikasi TUNGGAL (fungsi yang sama dengan
        // pratinjau audiens) — opt-out → gerbang opt-in → jendela
        // 24 jam Meta → pemeriksaan alamat/variabel WhatsApp.
        // Fase 13D: klasifikasi berjalan atas template VARIAN
        // penerima (aturan identik untuk kedua varian).
        const classified = classifyBroadcastCandidate({
          candidate,
          provider,
          requireOptIn: broadcast.requireOptIn,
          waTemplate: candidateTemplate,
          templateVariableSources: candidateSources,
          now,
        });
        if (classified.kind === "skip") {
          await tx.insert(broadcastRecipients).values({
            tenantId,
            broadcastId,
            contactId: candidate.contactId,
            conversationId: candidate.conversationId,
            status: "skipped",
            skipReason: classified.reason,
            variant,
          });
          m += 1;
          s += 1;
          if (variant === "b") vb += 1;
          continue;
        }
        const templateBodyParams = classified.templateBodyParams;
        const templatePreview = classified.templatePreview;
        // Percakapan 1:1 tujuan: pakai yang sudah ada, atau buat baru
        // (kontak beridentitas tetapi belum pernah membuka percakapan
        // yang tercatat — alamat balasan = id eksternal identitasnya,
        // pola yang sama seperti pencatatan pesan masuk).
        let conversationId = candidate.conversationId;
        if (!conversationId) {
          const [created] = await tx
            .insert(conversations)
            .values({
              tenantId,
              channelAccountId: broadcast.channelAccountId,
              contactId: candidate.contactId,
              provider,
              providerChatId: candidate.externalUserId,
              kind: "private",
              status: "open",
            })
            .returning();
          conversationId = created.id;
        }
        // Render PER PENERIMA (Fase 9A): selain {name}, spintax diacak
        // ulang untuk setiap penerima agar variasinya menyebar ke
        // seluruh audiens, bukan satu varian untuk semua. Untuk
        // WhatsApp isi pesan adalah pratinjau template berparameter
        // (templatePayload membawa muatan kirim sesungguhnya).
        // Fase 13D: teks/template yang dirender adalah milik VARIAN
        // penerima (B memakai teks B / template B + sumber variabel B).
        const rendered =
          provider === "whatsapp"
            ? templatePreview!
            : renderMessageText(
                variant === "b" && broadcast.variantBMessageText
                  ? broadcast.variantBMessageText
                  : broadcast.messageText,
                {
                  name: candidate.contactName,
                },
              );
        const [message] = await tx
          .insert(messages)
          .values({
            tenantId,
            conversationId,
            direction: "outbound",
            senderType: "system",
            type: provider === "whatsapp" ? "template" : "text",
            contentText: rendered,
            templatePayload:
              provider === "whatsapp"
                ? {
                    name: candidateTemplate!.name,
                    languageCode: candidateTemplate!.language,
                    bodyParams: templateBodyParams!,
                  }
                : undefined,
            status: "queued",
          })
          .returning();
        await tx.insert(broadcastRecipients).values({
          tenantId,
          broadcastId,
          contactId: candidate.contactId,
          conversationId,
          messageId: message.id,
          status: "queued",
          variant,
        });
        await tx
          .update(conversations)
          .set({ lastMessageAt: now, updatedAt: now })
          .where(eq(conversations.id, conversationId));
        // Event antrean keluar (pola yang sama seperti sequence):
        // relay menandainya published tanpa konsumen; poller telegram/
        // meta membaca tabel messages langsung.
        await tx.insert(outboxEvents).values({
          tenantId,
          type: "message.queued",
          payload: { conversationId, messageId: message.id },
        });
        m += 1;
        q += 1;
        if (variant === "b") vb += 1;
      }
      return {
        stopped: false as const,
        materialized: m,
        queued: q,
        skipped: s,
        variantB: vb,
      };
    });
    materialized += outcome.materialized;
    queuedCount += outcome.queued;
    skippedCount += outcome.skipped;
    variantBCount += outcome.variantB;
    if (outcome.stopped) {
      return {
        dispatched: true,
        reason: "cancelled_mid_dispatch",
        materialized,
        queued: queuedCount,
        skipped: skippedCount,
      };
    }
  }

  await withTenantDb(db, tenantId, async (tx) => {
    await tx.insert(auditLogs).values({
      tenantId,
      actorType: "system",
      actorId: `broadcast:${broadcastId}`,
      action: "broadcast.dispatched",
      meta: {
        broadcastId,
        channelAccountId: broadcast.channelAccountId,
        provider,
        recipients: materialized,
        queued: queuedCount,
        skipped: skippedCount,
        ...(broadcast.abSplitPercentB !== null
          ? {
              abSplitPercentB: broadcast.abSplitPercentB,
              variantBRecipients: variantBCount,
            }
          : {}),
      },
    });
  });
  return {
    dispatched: true,
    materialized,
    queued: queuedCount,
    skipped: skippedCount,
  };
}

// ---------------------------------------------------------------------------
// Penyapu finalisasi (sisi worker, berkala)
// ---------------------------------------------------------------------------

/**
 * Satu sapuan finalisasi lintas tenant:
 * 1. Temukan broadcast `sending` lewat lengan baca `system_broadcast_scan`
 *    (flag app.system_broadcast='reconcile' — migrasi 0030).
 * 2. Per broadcast, dalam konteks tenant pemiliknya: sinkronkan status
 *    penerima dari status pesannya (queued→sent/delivered/read/failed),
 *    tandai penerima yatim (pesannya hilang, mis. purge) sebagai
 *    skipped/message_deleted, lalu tutup broadcast yang sudah tidak
 *    punya penerima queued: completed / partially_failed / failed +
 *    audit broadcast.completed / broadcast.failed.
 * Mengembalikan ringkasan untuk log worker.
 */
export async function reconcileBroadcasts(
  db: Database,
  limit = 25,
): Promise<{ scanned: number; finalized: number }> {
  const targets = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.system_broadcast', 'reconcile', true)`,
    );
    return tx
      .select({ id: broadcasts.id, tenantId: broadcasts.tenantId })
      .from(broadcasts)
      .where(eq(broadcasts.status, "sending"))
      .orderBy(asc(broadcasts.startedAt))
      .limit(limit);
  });

  let finalized = 0;
  for (const target of targets) {
    const done = await withTenantDb(db, target.tenantId, async (tx) => {
      // Sinkron status penerima ← status pesan (hanya yang berubah).
      await tx.execute(sql`
        UPDATE broadcast_recipients r
        SET status = m.status::text::broadcast_recipient_status,
            error_code = m.error_code,
            updated_at = now()
        FROM messages m
        WHERE r.tenant_id = ${target.tenantId}
          AND r.broadcast_id = ${target.id}
          AND r.message_id = m.id
          AND r.status IN ('queued', 'sent', 'delivered')
          AND m.status::text <> r.status::text
      `);
      // Penerima yatim: masih queued tetapi pesannya sudah tidak ada.
      await tx
        .update(broadcastRecipients)
        .set({
          status: "skipped",
          skipReason: "message_deleted",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(broadcastRecipients.tenantId, target.tenantId),
            eq(broadcastRecipients.broadcastId, target.id),
            eq(broadcastRecipients.status, "queued"),
            isNull(broadcastRecipients.messageId),
          ),
        );
      const [remaining] = await tx
        .select({ n: sql<string>`count(*)` })
        .from(broadcastRecipients)
        .where(
          and(
            eq(broadcastRecipients.tenantId, target.tenantId),
            eq(broadcastRecipients.broadcastId, target.id),
            eq(broadcastRecipients.status, "queued"),
          ),
        );
      if (Number(remaining.n) > 0) return false;

      const stats = await getBroadcastStats(tx, target.tenantId, target.id);
      const succeeded = stats.sent + stats.delivered + stats.read;
      const finalStatus: BroadcastStatus =
        stats.failed > 0 && succeeded === 0
          ? "failed"
          : stats.failed > 0
            ? "partially_failed"
            : "completed";
      const now = new Date();
      const [updated] = await tx
        .update(broadcasts)
        .set({ status: finalStatus, completedAt: now, updatedAt: now })
        .where(
          and(
            eq(broadcasts.id, target.id),
            eq(broadcasts.status, "sending"),
          ),
        )
        .returning();
      if (!updated) return false;
      await tx.insert(auditLogs).values({
        tenantId: target.tenantId,
        actorType: "system",
        actorId: `broadcast:${target.id}`,
        action:
          finalStatus === "failed"
            ? "broadcast.failed"
            : "broadcast.completed",
        meta: {
          broadcastId: target.id,
          finalStatus,
          stats,
        },
      });
      return true;
    });
    if (done) finalized += 1;
  }
  return { scanned: targets.length, finalized };
}
