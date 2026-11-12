import { and, desc, eq } from "drizzle-orm";
import {
  sequenceTemplates,
  type Automation,
  type AutomationStep,
  type Database,
  type SequenceTemplate,
} from "@sahabat-kreator/db";
import type { TenantContext } from "./tenant";
import { withTenantDb } from "./tx";
import { createAutomation } from "./automations";

/**
 * Service domain Templat Sequence pribadi tenant (gelombang G2) —
 * sisi manajemen. Transport-agnostic; semua query dalam konteks RLS
 * tenant.
 *
 * Mengikuti POLA BERSAMA "SIMPAN TEMPLAT PRIBADI" (kontrak agents.ts,
 * diimplementasikan pertama kali oleh `agent-templates.ts` untuk
 * instruction agent) — pola yang sama, TABEL SENDIRI
 * (`sequence_templates`): satu templat adalah SALINAN keadaan formulir
 * sequence saat disimpan (nama + kata kunci + mode cocok + langkah
 * terurut), disimpan pemilik untuk dipakai ulang dari galeri.
 *
 * Templat bukan rujukan: memakainya membuat automation sequence BARU
 * (selalu NONAKTIF — keselamatan yang sama dengan instantiate katalog
 * Fase 16B), dan mengubah/menghapus templat tidak menyentuh automation
 * mana pun. Ubah templat tersimpan di v1 = hapus + simpan ulang
 * (karena itu CRUD di sini sengaja hanya buat/daftar/hapus + pakai).
 *
 * Isolasi tenant ditegakkan di sini (where tenant_id pada setiap
 * query) DAN oleh RLS migrasi 0028.
 */

export interface CreateSequenceTemplateInput {
  name: string;
  keywords: string[];
  match: "exact" | "contains";
  steps: { delayMinutes: number; text: string }[];
}

export async function createSequenceTemplate(
  db: Database,
  ctx: Pick<TenantContext, "tenantId"> & { userId: string },
  input: CreateSequenceTemplateInput,
): Promise<SequenceTemplate> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .insert(sequenceTemplates)
      .values({
        tenantId: ctx.tenantId,
        name: input.name,
        keywords: input.keywords,
        match: input.match,
        steps: input.steps,
        createdBy: ctx.userId,
      })
      .returning();
    return row;
  });
}

export async function listSequenceTemplates(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
): Promise<SequenceTemplate[]> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    return tx
      .select()
      .from(sequenceTemplates)
      .where(eq(sequenceTemplates.tenantId, ctx.tenantId))
      .orderBy(desc(sequenceTemplates.createdAt));
  });
}

/** Null bila templat tidak ada DI tenant ini. */
export async function getSequenceTemplate(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  id: string,
): Promise<SequenceTemplate | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(sequenceTemplates)
      .where(
        and(
          eq(sequenceTemplates.tenantId, ctx.tenantId),
          eq(sequenceTemplates.id, id),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

/** Null bila templat tidak ada DI tenant ini. */
export async function deleteSequenceTemplate(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  id: string,
): Promise<SequenceTemplate | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .delete(sequenceTemplates)
      .where(
        and(
          eq(sequenceTemplates.tenantId, ctx.tenantId),
          eq(sequenceTemplates.id, id),
        ),
      )
      .returning();
    return row ?? null;
  });
}

export type InstantiateSequenceTemplateResult =
  | {
      kind: "created";
      automation: Automation & { steps: AutomationStep[] };
    }
  | { kind: "template_not_found" };

/**
 * Memakai templat pribadi: membuat automation sequence BARU dari
 * salinannya — selalu NONAKTIF (pemilik meninjau kata kunci & teks,
 * mengganti penanda, baru mengaktifkan; keselamatan yang sama dengan
 * `instantiateAutomationTemplate`). Nama boleh ditimpa klien; tanpa
 * timpaan, nama templat yang dipakai. Null-safe per tenant: templat
 * tenant lain tidak terlihat (template_not_found, API menjawab 404).
 */
export async function instantiateSequenceTemplate(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  input: { templateId: string; name?: string },
): Promise<InstantiateSequenceTemplateResult> {
  const template = await getSequenceTemplate(db, ctx, input.templateId);
  if (!template) return { kind: "template_not_found" };

  const automation = await createAutomation(db, ctx, {
    name: input.name?.trim() ? input.name.trim() : template.name,
    keywords: template.keywords,
    match: template.match === "contains" ? "contains" : "exact",
    isActive: false,
    kind: "sequence",
    steps: template.steps.map((s) => ({
      delayMinutes: s.delayMinutes,
      text: s.text,
    })),
  });
  return { kind: "created", automation };
}
