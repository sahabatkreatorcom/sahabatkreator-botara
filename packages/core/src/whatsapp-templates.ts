import { and, asc, eq } from "drizzle-orm";
import {
  auditLogs,
  whatsappTemplates,
  type Database,
  type WhatsAppTemplate,
} from "@sahabat-kreator/db";
import { withTenantDb } from "./tx";

/**
 * Template WhatsApp (Fase 10A) — cermin lokal template pesan resmi
 * Meta per akun WhatsApp.
 *
 * Pembagian kerja: pemanggilan Graph (sinkron/buat/hapus di Meta)
 * hidup di lapisan API (route membangun WhatsAppCloudClient dari
 * token akun); modul ini murni sisi DB — menyimpan hasil sinkron,
 * baris hasil pembuatan, dan penghapusan cermin — selalu dalam
 * konteks tenant + audit `whatsapp_template.*`.
 *
 * Semantik sinkron: daftar Meta adalah sumber kebenaran — baris
 * cermin yang (nama, bahasa)-nya tidak lagi dikembalikan Meta
 * DIHAPUS (template terhapus di Meta tidak boleh tetap bisa dipilih
 * di sini), baris lain di-upsert. Penghapusan lewat dashboard
 * meniru semantik Meta: DELETE berbasis NAMA menghapus semua bahasa,
 * jadi cermin menghapus semua baris bernama sama pada akun itu.
 */

export interface WhatsAppTemplateUpsert {
  metaTemplateId: string | null;
  name: string;
  language: string;
  category: string;
  status: string;
  /**
   * Alasan status dari Meta (penolakan) sebagaimana dilaporkan daftar
   * Graph; null/ta terisi = Meta tidak melaporkan alasan pada sinkron
   * ini. Semantik penggabungannya di `resolveSyncedStatusReason`.
   */
  statusReason?: string | null;
  components: unknown;
  bodyText: string | null;
  variableCount: number;
}

/**
 * Menggabungkan alasan status saat SINKRON (jalur webhook punya aturan
 * yang sama di `applyWhatsAppTemplateStatus`):
 * - status APPROVED/REINSTATED selalu MEMBERSIHKAN alasan lama —
 *   menampilkan alasan penolakan pada template yang sudah disetujui
 *   hanya menyesatkan;
 * - alasan yang baru dilaporkan Meta MENIMPA yang lama (kode
 *   `rejected_reason` Graph adalah sumber kebenaran sinkron);
 * - tanpa laporan baru, alasan yang sudah tercatat (mis. teks rinci
 *   dari webhook) DIPERTAHANKAN — sinkron tidak boleh menghapus
 *   informasi yang tidak bisa ia gantikan.
 * Nilai "NONE" dari Graph diperlakukan sebagai "tidak ada alasan".
 */
export function resolveSyncedStatusReason(
  status: string,
  incoming: string | null | undefined,
  existing: string | null,
): string | null {
  if (status === "APPROVED" || status === "REINSTATED") return null;
  const trimmed = incoming?.trim();
  if (trimmed && trimmed.toUpperCase() !== "NONE") {
    return trimmed.slice(0, 512);
  }
  return existing;
}

/** Daftar cermin template satu akun (urut nama lalu bahasa). */
export async function listWhatsAppTemplates(
  db: Database,
  input: { tenantId: string; channelAccountId: string },
): Promise<WhatsAppTemplate[]> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    return tx
      .select()
      .from(whatsappTemplates)
      .where(
        and(
          eq(whatsappTemplates.tenantId, input.tenantId),
          eq(whatsappTemplates.channelAccountId, input.channelAccountId),
        ),
      )
      .orderBy(asc(whatsappTemplates.name), asc(whatsappTemplates.language));
  });
}

/** Satu baris cermin berdasarkan id (null bila bukan milik tenant ini). */
export async function getWhatsAppTemplateById(
  db: Database,
  input: { tenantId: string; templateId: string },
): Promise<WhatsAppTemplate | null> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(whatsappTemplates)
      .where(
        and(
          eq(whatsappTemplates.tenantId, input.tenantId),
          eq(whatsappTemplates.id, input.templateId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

/**
 * Terapkan hasil sinkronisasi Meta ke cermin: upsert per
 * (akun, nama, bahasa) + hapus baris yang tidak lagi ada di Meta.
 * Mengembalikan daftar cermin sesudah sinkron.
 */
export async function replaceSyncedWhatsAppTemplates(
  db: Database,
  input: {
    tenantId: string;
    userId: string;
    channelAccountId: string;
    templates: WhatsAppTemplateUpsert[];
  },
): Promise<WhatsAppTemplate[]> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const now = new Date();
    const keepKeys = new Set(
      input.templates.map((t) => `${t.name}${t.language}`),
    );
    const existing = await tx
      .select({
        id: whatsappTemplates.id,
        name: whatsappTemplates.name,
        language: whatsappTemplates.language,
        statusReason: whatsappTemplates.statusReason,
      })
      .from(whatsappTemplates)
      .where(
        and(
          eq(whatsappTemplates.tenantId, input.tenantId),
          eq(whatsappTemplates.channelAccountId, input.channelAccountId),
        ),
      );
    const existingReasonByKey = new Map(
      existing.map((r) => [`${r.name}${r.language}`, r.statusReason]),
    );
    for (const row of existing) {
      if (!keepKeys.has(`${row.name}${row.language}`)) {
        await tx
          .delete(whatsappTemplates)
          .where(eq(whatsappTemplates.id, row.id));
      }
    }
    for (const t of input.templates) {
      const statusReason = resolveSyncedStatusReason(
        t.status,
        t.statusReason,
        existingReasonByKey.get(`${t.name}${t.language}`) ?? null,
      );
      await tx
        .insert(whatsappTemplates)
        .values({
          tenantId: input.tenantId,
          channelAccountId: input.channelAccountId,
          metaTemplateId: t.metaTemplateId,
          name: t.name,
          language: t.language,
          category: t.category,
          status: t.status,
          statusReason,
          components: t.components as WhatsAppTemplate["components"],
          bodyText: t.bodyText,
          variableCount: t.variableCount,
          syncedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            whatsappTemplates.channelAccountId,
            whatsappTemplates.name,
            whatsappTemplates.language,
          ],
          set: {
            metaTemplateId: t.metaTemplateId,
            category: t.category,
            status: t.status,
            statusReason,
            components: t.components as WhatsAppTemplate["components"],
            bodyText: t.bodyText,
            variableCount: t.variableCount,
            syncedAt: now,
            updatedAt: now,
          },
        });
    }
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "whatsapp_template.synced",
      meta: {
        channelAccountId: input.channelAccountId,
        count: input.templates.length,
      },
    });
    return tx
      .select()
      .from(whatsappTemplates)
      .where(
        and(
          eq(whatsappTemplates.tenantId, input.tenantId),
          eq(whatsappTemplates.channelAccountId, input.channelAccountId),
        ),
      )
      .orderBy(asc(whatsappTemplates.name), asc(whatsappTemplates.language));
  });
}

/**
 * Simpan baris cermin untuk template yang baru dibuat di Meta
 * (pembuatan terjadi di lapisan API; di sini hanya pencatatan +
 * audit). Upsert pada kunci alami agar balapan sinkron tidak
 * menggandakan baris.
 */
export async function recordCreatedWhatsAppTemplate(
  db: Database,
  input: {
    tenantId: string;
    userId: string;
    channelAccountId: string;
    template: WhatsAppTemplateUpsert;
  },
): Promise<WhatsAppTemplate> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const now = new Date();
    const t = input.template;
    const [prior] = await tx
      .select({ statusReason: whatsappTemplates.statusReason })
      .from(whatsappTemplates)
      .where(
        and(
          eq(whatsappTemplates.tenantId, input.tenantId),
          eq(whatsappTemplates.channelAccountId, input.channelAccountId),
          eq(whatsappTemplates.name, t.name),
          eq(whatsappTemplates.language, t.language),
        ),
      )
      .limit(1);
    const statusReason = resolveSyncedStatusReason(
      t.status,
      t.statusReason,
      prior?.statusReason ?? null,
    );
    const [row] = await tx
      .insert(whatsappTemplates)
      .values({
        tenantId: input.tenantId,
        channelAccountId: input.channelAccountId,
        metaTemplateId: t.metaTemplateId,
        name: t.name,
        language: t.language,
        category: t.category,
        status: t.status,
        statusReason,
        components: t.components as WhatsAppTemplate["components"],
        bodyText: t.bodyText,
        variableCount: t.variableCount,
        syncedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          whatsappTemplates.channelAccountId,
          whatsappTemplates.name,
          whatsappTemplates.language,
        ],
        set: {
          metaTemplateId: t.metaTemplateId,
          category: t.category,
          status: t.status,
          statusReason,
          components: t.components as WhatsAppTemplate["components"],
          bodyText: t.bodyText,
          variableCount: t.variableCount,
          syncedAt: now,
          updatedAt: now,
        },
      })
      .returning();
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "whatsapp_template.created",
      meta: {
        whatsappTemplateId: row.id,
        channelAccountId: input.channelAccountId,
        name: row.name,
        language: row.language,
        status: row.status,
      },
    });
    return row;
  });
}

/**
 * Catat hasil perbaikan template di Meta (pengubahan terjadi di
 * lapisan API lewat Graph `POST /{message_template_id}`; di sini
 * hanya pencatatan + audit). Template yang diperbaiki masuk tinjauan
 * ulang, jadi cermin kembali ke PENDING dan alasan penolakan lama
 * dibersihkan — alasan itu milik versi yang baru saja diganti.
 * Mengembalikan baris terbaru, atau null bila barisnya sudah tidak ada.
 */
export async function recordEditedWhatsAppTemplate(
  db: Database,
  input: {
    tenantId: string;
    userId: string;
    templateId: string;
    category: string;
    components: unknown;
    bodyText: string | null;
    variableCount: number;
  },
): Promise<WhatsAppTemplate | null> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const now = new Date();
    const [row] = await tx
      .update(whatsappTemplates)
      .set({
        category: input.category,
        status: "PENDING",
        statusReason: null,
        components: input.components as WhatsAppTemplate["components"],
        bodyText: input.bodyText,
        variableCount: input.variableCount,
        syncedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(whatsappTemplates.tenantId, input.tenantId),
          eq(whatsappTemplates.id, input.templateId),
        ),
      )
      .returning();
    if (!row) return null;
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "whatsapp_template.edited",
      meta: {
        whatsappTemplateId: row.id,
        channelAccountId: row.channelAccountId,
        name: row.name,
        language: row.language,
        status: row.status,
      },
    });
    return row;
  });
}

/**
 * Kode bahasa template dari webhook Meta memakai bentuk `en-US`,
 * sedangkan Graph (`message_templates`) memakai `en_US`, dan formulir
 * kita menyimpan apa yang diketik pengguna. Ketiganya harus dianggap
 * sama saat mencocokkan; kalau tidak, status template berbahasa dengan
 * locale tidak akan pernah menemukan barisnya.
 */
function normalizeTemplateLanguage(language: string): string {
  return language.trim().toLowerCase().replace(/-/g, "_");
}

export interface ApplyWhatsAppTemplateStatusInput {
  tenantId: string;
  channelAccountId: string;
  /** `message_template_id` Meta — kunci pencocokan utama bila ada. */
  metaTemplateId: string | null;
  name: string;
  language: string;
  /** Nilai `event` apa adanya (APPROVED, REJECTED, PAUSED, …). */
  status: string;
  category: string | null;
  /** Alasan dari Meta (penolakan / pause / disable); null bila tak ada. */
  reason: string | null;
}

export interface ApplyWhatsAppTemplateStatusResult {
  updated: boolean;
  templateId: string | null;
  previousStatus: string | null;
}

/**
 * Menerapkan satu `message_template_status_update` ke cermin lokal.
 *
 * Sebelum ini, status template hanya berubah bila operator menekan
 * Sinkron — sehingga template yang sudah disetujui Meta masih tampil
 * PENDING (dan yang ditolak masih tampil PENDING) sampai ada yang
 * ingat menyinkronkan. Chip status di halaman Broadcasts sekarang
 * bergerak sendiri.
 *
 * Pencocokan: `meta_template_id` lebih dulu (otoritatif, tidak
 * terpengaruh perbedaan penulisan bahasa), lalu nama + bahasa
 * ternormalisasi sebagai cadangan untuk baris lama yang belum punya id.
 *
 * Status yang datang tidak divalidasi terhadap daftar Meta — nilai baru
 * disimpan apa adanya supaya tidak hilang diam-diam; UI punya cadangan
 * tampilan untuk status yang belum dikenal.
 */
export async function applyWhatsAppTemplateStatus(
  db: Database,
  input: ApplyWhatsAppTemplateStatusInput,
): Promise<ApplyWhatsAppTemplateStatusResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(whatsappTemplates)
      .where(
        and(
          eq(whatsappTemplates.tenantId, input.tenantId),
          eq(whatsappTemplates.channelAccountId, input.channelAccountId),
        ),
      );

    const wantedLanguage = normalizeTemplateLanguage(input.language);
    const target =
      (input.metaTemplateId
        ? rows.find((r) => r.metaTemplateId === input.metaTemplateId)
        : undefined) ??
      rows.find(
        (r) =>
          r.name === input.name &&
          normalizeTemplateLanguage(r.language) === wantedLanguage,
      );

    if (!target) {
      return { updated: false, templateId: null, previousStatus: null };
    }

    const nextReason = input.reason?.slice(0, 512) ?? null;
    // APPROVED/REINSTATED menghapus alasan lama: menyimpan alasan
    // penolakan pada template yang sudah disetujui hanya menyesatkan.
    const clearsReason =
      input.status === "APPROVED" || input.status === "REINSTATED";
    const reasonToStore = clearsReason ? null : nextReason;

    const unchanged =
      target.status === input.status && target.statusReason === reasonToStore;
    if (unchanged) {
      return {
        updated: false,
        templateId: target.id,
        previousStatus: target.status,
      };
    }

    const now = new Date();
    await tx
      .update(whatsappTemplates)
      .set({
        status: input.status.slice(0, 32),
        statusReason: reasonToStore,
        // Kategori hanya ditimpa bila Meta mengirimkannya — webhook
        // sebagian event tidak menyertakan kategori.
        ...(input.category ? { category: input.category.slice(0, 32) } : {}),
        updatedAt: now,
      })
      .where(eq(whatsappTemplates.id, target.id));

    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "system",
      actorId: "whatsapp-webhook",
      action: "whatsapp_template.status_updated",
      meta: {
        whatsappTemplateId: target.id,
        channelAccountId: input.channelAccountId,
        name: target.name,
        language: target.language,
        from: target.status,
        to: input.status,
        reason: reasonToStore,
      },
    });

    return {
      updated: true,
      templateId: target.id,
      previousStatus: target.status,
    };
  });
}

/**
 * Hapus baris cermin berdasarkan NAMA pada satu akun (semantik DELETE
 * Meta). Mengembalikan jumlah baris terhapus; audit hanya ditulis
 * bila memang ada yang terhapus.
 */
export async function deleteWhatsAppTemplateMirrorByName(
  db: Database,
  input: {
    tenantId: string;
    userId: string;
    channelAccountId: string;
    name: string;
    templateId: string;
  },
): Promise<{ deleted: number }> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const removed = await tx
      .delete(whatsappTemplates)
      .where(
        and(
          eq(whatsappTemplates.tenantId, input.tenantId),
          eq(whatsappTemplates.channelAccountId, input.channelAccountId),
          eq(whatsappTemplates.name, input.name),
        ),
      )
      .returning({ id: whatsappTemplates.id });
    if (removed.length > 0) {
      await tx.insert(auditLogs).values({
        tenantId: input.tenantId,
        actorType: "user",
        actorId: input.userId,
        action: "whatsapp_template.deleted",
        meta: {
          whatsappTemplateId: input.templateId,
          channelAccountId: input.channelAccountId,
          name: input.name,
          removed: removed.length,
        },
      });
    }
    return { deleted: removed.length };
  });
}
