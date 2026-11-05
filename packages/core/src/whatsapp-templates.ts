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
  components: unknown;
  bodyText: string | null;
  variableCount: number;
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
      })
      .from(whatsappTemplates)
      .where(
        and(
          eq(whatsappTemplates.tenantId, input.tenantId),
          eq(whatsappTemplates.channelAccountId, input.channelAccountId),
        ),
      );
    for (const row of existing) {
      if (!keepKeys.has(`${row.name}${row.language}`)) {
        await tx
          .delete(whatsappTemplates)
          .where(eq(whatsappTemplates.id, row.id));
      }
    }
    for (const t of input.templates) {
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
