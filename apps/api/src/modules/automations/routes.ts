import { Hono } from "hono";
import { z } from "zod";
import {
  AUTOMATION_TEMPLATES,
  AutomationListResponseSchema,
  AutomationResponseSchema,
  AutomationRunListResponseSchema,
  AutomationRunResponseSchema,
  AutomationTemplateListResponseSchema,
  AutomationTemplateLocaleSchema,
  CreateAutomationRequestSchema,
  CreateSequenceTemplateRequestSchema,
  EnrollConversationListResponseSchema,
  EnrollSequenceByTagRequestSchema,
  EnrollSequenceByTagResponseSchema,
  EnrollSequenceContactRequestSchema,
  EnrollSequenceContactResponseSchema,
  InstantiateAutomationTemplateRequestSchema,
  InstantiateSequenceTemplateRequestSchema,
  SequenceEnrollmentListResponseSchema,
  SequenceEnrollmentResponseSchema,
  SequenceTemplateListResponseSchema,
  SequenceTemplateResponseSchema,
  UpdateAutomationRequestSchema,
  summarizeAutomationTemplate,
  type AutomationResponse,
  type AutomationRunResponse,
  type AutomationTemplateLocale,
  type SequenceEnrollmentResponse,
  type SequenceTemplateResponse,
} from "@sahabat-kreator/contracts";
import {
  createAutomation,
  createSequenceTemplate,
  deleteSequenceTemplate,
  enrollContactsInSequenceByTag,
  enrollContactInSequenceManually,
  getAutomation,
  getChannelAccount,
  instantiateAutomationTemplate,
  instantiateSequenceTemplate,
  listAutomationRuns,
  listAutomations,
  listContactMessagingConversations,
  listSequenceEnrollments,
  listSequenceTemplates,
  updateAutomation,
  type AutomationWithRunCount,
  type CreateAutomationInput,
  type SequenceEnrollmentWithTotal,
} from "@sahabat-kreator/core";
import type { AutomationRun, SequenceTemplate } from "@sahabat-kreator/db";
import type { AuthBundle } from "../../auth";
import { apiError, type AppContext, type AppVariables } from "../../http";
import { resolveTenantForUser } from "../tenants/guard";

export function serializeAutomation(row: AutomationWithRunCount): AutomationResponse {
  return AutomationResponseSchema.parse({
    id: row.id,
    name: row.name,
    triggerType: row.triggerType,
    kind: row.kind,
    keywords: row.triggerConfig.keywords,
    // G5: payload tombol aturan postback/quick_reply; kosong selain itu.
    payloads: row.triggerConfig.payloads ?? [],
    match: row.triggerConfig.match,
    actionType: row.actionType,
    text: row.actionConfig.text,
    // Fase 10B: field aturan komentar; aturan pesan mendapat default
    // aman (akun null, semua aksi mati).
    channelAccountId: row.triggerConfig.channelAccountId ?? null,
    sendDm: row.actionConfig.sendDm ?? false,
    publicReplyText: row.actionConfig.publicReplyText ?? null,
    hideComment: row.actionConfig.hideComment ?? false,
    steps: row.steps.map((s) => ({
      position: s.position,
      delayMinutes: s.delayMinutes,
      text: s.text,
    })),
    stepCount: row.stepCount,
    isActive: row.isActive,
    runCount: row.runCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export function serializeSequenceTemplate(
  row: SequenceTemplate,
): SequenceTemplateResponse {
  return SequenceTemplateResponseSchema.parse({
    id: row.id,
    name: row.name,
    keywords: row.keywords,
    match: row.match === "contains" ? "contains" : "exact",
    steps: row.steps.map((s, i) => ({
      position: i + 1,
      delayMinutes: s.delayMinutes,
      text: s.text,
    })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

function serializeEnrollment(
  row: SequenceEnrollmentWithTotal,
): SequenceEnrollmentResponse {
  return SequenceEnrollmentResponseSchema.parse({
    id: row.id,
    automationId: row.automationId,
    contactId: row.contactId,
    conversationId: row.conversationId,
    triggerMessageId: row.triggerMessageId,
    status: row.status,
    currentStep: row.currentStep,
    totalSteps: row.totalSteps,
    nextRunAt: row.nextRunAt ? row.nextRunAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

function serializeRun(row: AutomationRun): AutomationRunResponse {
  return AutomationRunResponseSchema.parse({
    id: row.id,
    automationId: row.automationId,
    contactId: row.contactId,
    conversationId: row.conversationId,
    triggerMessageId: row.triggerMessageId,
    status: row.status,
    detail: row.detail,
    createdAt: row.createdAt.toISOString(),
  });
}

/**
 * Modul automations (Fase 2A; sequence Fase 2C) — manajemen automation
 * workspace:
 *   POST  /tenants/:tenantId/automations            buat → 201
 *         kind 'keyword' (atau tanpa kind): {name, keywords, match, text}
 *         kind 'sequence': {name, keywords, match, steps[{delayMinutes, text}]}
 *   GET   /tenants/:tenantId/automations            daftar + jumlah run +
 *                                                   kind & langkah sequence
 *   GET   /tenants/:tenantId/automations/templates  katalog template (14A);
 *                                                   ?locale=id|en memilih isi
 *                                                   sequence (G2)
 *   POST  /tenants/:tenantId/automations/templates/:slug
 *                                                   buat automation NONAKTIF
 *                                                   dari template → 201
 *   POST  /tenants/:tenantId/sequence-templates     simpan templat sequence
 *                                                   pribadi → 201 (G2)
 *   GET   /tenants/:tenantId/sequence-templates     daftar templat pribadi
 *   DELETE /tenants/:tenantId/sequence-templates/:id
 *                                                   hapus templat pribadi
 *   POST  /tenants/:tenantId/sequence-templates/:id/instantiate
 *                                                   pakai templat pribadi →
 *                                                   automation NONAKTIF 201
 *   PATCH /tenants/:tenantId/automations/:id        ubah isActive/name/keywords/match/text
 *                                                   (langkah sequence TIDAK bisa
 *                                                   diubah — buat automation baru)
 *   GET   /tenants/:tenantId/automations/:id/runs   riwayat eksekusi terbaru
 *   GET   /tenants/:tenantId/automations/:id/enrollments
 *                                                   pendaftaran sequence terbaru
 *   POST  /tenants/:tenantId/automations/:id/enroll daftarkan SATU kontak
 *                                                   secara manual (G2b);
 *                                                   jangkar = conversationId
 *                                                   pilihan atau percakapan
 *                                                   pesan terbaru kontak
 *   POST  /tenants/:tenantId/automations/:id/enroll-by-tag
 *                                                   daftarkan semua kontak
 *                                                   bertag; balasan = laporan
 *                                                   agregat (G2b)
 *   GET   /tenants/:tenantId/automations/:id/enroll-conversations?contactId=
 *                                                   percakapan pesan kontak
 *                                                   untuk pemilih jangkar (G2b)
 * Wajib sesi + membership workspace (non-member → 404 TENANT_NOT_FOUND,
 * pola Fase 1B/1D). Eksekusi automation sendiri berjalan di worker
 * (job `automation.evaluate` & `sequence.step`), bukan di proses API ini.
 */
export function createAutomationsRoutes(bundle: AuthBundle | null) {
  const app = new Hono<{ Variables: AppVariables }>();
  const base = "/tenants/:tenantId/automations";
  const seqTemplatesBase = "/tenants/:tenantId/sequence-templates";

  if (!bundle) {
    const notConfigured = (c: Parameters<typeof apiError>[0]) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured");
    app.post(base, notConfigured);
    app.get(base, notConfigured);
    app.get(`${base}/templates`, notConfigured);
    app.post(`${base}/templates/:slug`, notConfigured);
    app.patch(`${base}/:id`, notConfigured);
    app.get(`${base}/:id/runs`, notConfigured);
    app.get(`${base}/:id/enrollments`, notConfigured);
    app.post(`${base}/:id/enroll`, notConfigured);
    app.post(`${base}/:id/enroll-by-tag`, notConfigured);
    app.get(`${base}/:id/enroll-conversations`, notConfigured);
    app.post(seqTemplatesBase, notConfigured);
    app.get(seqTemplatesBase, notConfigured);
    app.delete(`${seqTemplatesBase}/:id`, notConfigured);
    app.post(`${seqTemplatesBase}/:id/instantiate`, notConfigured);
    return app;
  }


  const resolveTenant = async (c: AppContext) =>
    resolveTenantForUser(
      bundle,
      c.req.param("tenantId") ?? "",
      c.get("appUser").id,
    );

  app.post(base, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = CreateAutomationRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid automation payload");
    }
    // Fase 10B: aturan komentar terikat ke satu akun IG/Messenger milik
    // tenant ini. Akun tak ditemukan di tenant, provider di luar
    // instagram/messenger, atau akun sedang terputus → 422
    // COMMENT_CHANNEL_UNSUPPORTED (aturan tak pernah lahir mengambang).
    if ("channelAccountId" in parsed.data) {
      const account = await getChannelAccount(
        bundle.db,
        { tenantId: tenant.id },
        parsed.data.channelAccountId,
      );
      if (
        !account ||
        (account.provider !== "instagram" &&
          account.provider !== "messenger") ||
        account.status !== "connected"
      ) {
        return apiError(
          c,
          422,
          "COMMENT_CHANNEL_UNSUPPORTED",
          "Comment rules require a connected Instagram or Messenger account",
        );
      }
    }
    // G5: varian pemicu baru (postback/quick_reply/welcome) dikenali
    // dari field triggerType — diperiksa PERTAMA karena variannya
    // juga bisa membawa steps (kind 'sequence'). Aksi mengikuti kind;
    // keywords selalu kosong (payload yang dicocokkan, bukan teks).
    let createInput: CreateAutomationInput;
    if ("triggerType" in parsed.data) {
      const data = parsed.data;
      createInput = {
        name: data.name,
        keywords: [],
        match: "exact",
        kind: data.kind,
        triggerType: data.triggerType,
        ...(data.triggerType !== "welcome"
          ? { payloads: data.payloads }
          : {}),
        ...(data.kind === "sequence"
          ? { steps: data.steps }
          : { text: data.text }),
      };
    } else if ("steps" in parsed.data) {
      createInput = {
        name: parsed.data.name,
        keywords: parsed.data.keywords,
        match: parsed.data.match,
        kind: "sequence",
        steps: parsed.data.steps,
      };
    } else if ("channelAccountId" in parsed.data) {
      createInput = {
        name: parsed.data.name,
        keywords: parsed.data.keywords,
        match: parsed.data.match,
        kind: "comment",
        channelAccountId: parsed.data.channelAccountId,
        sendDm: parsed.data.sendDm,
        text: parsed.data.dmText,
        publicReplyText: parsed.data.publicReplyText ?? null,
        hideComment: parsed.data.hideComment,
      };
    } else {
      createInput = {
        name: parsed.data.name,
        keywords: parsed.data.keywords,
        match: parsed.data.match,
        kind: "keyword",
        text: parsed.data.text,
      };
    }
    const created = await createAutomation(
      bundle.db,
      { tenantId: tenant.id },
      createInput,
    );
    return c.json(
      serializeAutomation({
        ...created,
        runCount: 0,
        stepCount: created.steps.length,
      }),
      201,
    );
  });

  app.get(base, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const rows = await listAutomations(bundle.db, { tenantId: tenant.id });
    const body = AutomationListResponseSchema.parse({
      automations: rows.map(serializeAutomation),
    });
    return c.json(body);
  });

  // ---- Galeri template (Fase 16B) ------------------------------------------
  // Katalog statis dari kontrak (AUTOMATION_TEMPLATES): respons hanya
  // ringkasan — teks lengkap tidak keluar di daftar; ia disalin server
  // saat instantiate. Otorisasi mengikuti POST biasa modul ini (setiap
  // anggota workspace), karena membuat automation memang bukan aksi
  // owner/admin di sini; rute yang lebih ketat hanya akan jadi pagar
  // palsu selama POST biasa tetap terbuka.
  app.get(`${base}/templates`, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    // G2: isi sequence dwibahasa — ?locale=id|en memilih teks langkah
    // pratinjau (dan jumlah kata kunci) yang dikembalikan; nilai tak
    // dikenal jatuh ke "id", bukan kesalahan.
    const localeParsed = AutomationTemplateLocaleSchema.safeParse(
      c.req.query("locale"),
    );
    const locale: AutomationTemplateLocale = localeParsed.success
      ? localeParsed.data
      : "id";
    const body = AutomationTemplateListResponseSchema.parse({
      templates: AUTOMATION_TEMPLATES.map((tpl) =>
        summarizeAutomationTemplate(tpl, locale),
      ),
    });
    return c.json(body);
  });

  // Membuat automation NYATA dari template — selalu NONAKTIF (lihat
  // catatan keselamatan di kontrak automation-templates): pemilik
  // meninjau kata kunci & teks, menyunting placeholder, baru
  // mengaktifkannya. Body boleh kosong; {name} opsional menimpa nama
  // bawaan, {locale} memilih isi sequence dwibahasa. Slug tak dikenal
  // → 404 AUTOMATION_TEMPLATE_NOT_FOUND.
  app.post(`${base}/templates/:slug`, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    let name: string | undefined;
    let locale: AutomationTemplateLocale | undefined;
    try {
      const json = (await c.req.json()) as
        | { name?: unknown; locale?: unknown }
        | null;
      if (
        json &&
        typeof json === "object" &&
        (json.name !== undefined || json.locale !== undefined)
      ) {
        const parsed = InstantiateAutomationTemplateRequestSchema.safeParse(json);
        if (!parsed.success) {
          return apiError(c, 400, "VALIDATION_ERROR", "Invalid template payload");
        }
        name = parsed.data.name;
        locale = parsed.data.locale;
      }
    } catch {
      // Body kosong sah = pakai nama bawaan template.
    }
    const result = await instantiateAutomationTemplate(
      bundle.db,
      { tenantId: tenant.id },
      { slug: c.req.param("slug") ?? "", name, locale },
    );
    if (result.kind === "template_not_found") {
      return apiError(
        c,
        404,
        "AUTOMATION_TEMPLATE_NOT_FOUND",
        "Automation template not found",
      );
    }
    return c.json(
      serializeAutomation({
        ...result.automation,
        runCount: 0,
        stepCount: result.automation.steps.length,
      }),
      201,
    );
  });

  // ---- Templat sequence pribadi (G2) --------------------------------------
  // Pola bersama "simpan templat pribadi" (lihat kontrak agents.ts):
  // buat/daftar/hapus salinan keadaan formulir sequence. Penanda
  // "[...]" yang belum diganti BUKAN kesalahan di sini — skema kontrak
  // sengaja hanya membatasi bentuk & panjang, sama seperti pembuatan
  // automation sequence itu sendiri.
  app.post(seqTemplatesBase, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = CreateSequenceTemplateRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid sequence template payload");
    }
    const created = await createSequenceTemplate(
      bundle.db,
      { tenantId: tenant.id, userId: c.get("appUser").id },
      parsed.data,
    );
    return c.json(serializeSequenceTemplate(created), 201);
  });

  app.get(seqTemplatesBase, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const rows = await listSequenceTemplates(bundle.db, {
      tenantId: tenant.id,
    });
    const body = SequenceTemplateListResponseSchema.parse({
      templates: rows.map(serializeSequenceTemplate),
    });
    return c.json(body);
  });

  app.delete(`${seqTemplatesBase}/:id`, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) {
      return apiError(c, 404, "NOT_FOUND", "Sequence template not found");
    }
    const deleted = await deleteSequenceTemplate(
      bundle.db,
      { tenantId: tenant.id },
      id,
    );
    if (!deleted) {
      return apiError(c, 404, "NOT_FOUND", "Sequence template not found");
    }
    return c.json(serializeSequenceTemplate(deleted));
  });

  // Pakai templat pribadi → automation sequence BARU yang selalu
  // NONAKTIF (keselamatan instantiate katalog). Id bukan uuid / milik
  // tenant lain → 404 yang sama (isolasi tidak bocor lewat beda kode).
  app.post(`${seqTemplatesBase}/:id/instantiate`, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) {
      return apiError(c, 404, "NOT_FOUND", "Sequence template not found");
    }
    let name: string | undefined;
    try {
      const json = (await c.req.json()) as { name?: unknown } | null;
      if (json && typeof json === "object" && json.name !== undefined) {
        const parsed = InstantiateSequenceTemplateRequestSchema.safeParse(json);
        if (!parsed.success) {
          return apiError(c, 400, "VALIDATION_ERROR", "Invalid template payload");
        }
        name = parsed.data.name;
      }
    } catch {
      // Body kosong sah = pakai nama templat.
    }
    const result = await instantiateSequenceTemplate(
      bundle.db,
      { tenantId: tenant.id },
      { templateId: id, name },
    );
    if (result.kind === "template_not_found") {
      return apiError(c, 404, "NOT_FOUND", "Sequence template not found");
    }
    return c.json(
      serializeAutomation({
        ...result.automation,
        runCount: 0,
        stepCount: result.automation.steps.length,
      }),
      201,
    );
  });

  app.patch(`${base}/:id`, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) {
      return apiError(c, 404, "NOT_FOUND", "Automation not found");
    }
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = UpdateAutomationRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid automation payload");
    }
    const updated = await updateAutomation(
      bundle.db,
      { tenantId: tenant.id },
      id,
      parsed.data,
    );
    if (!updated) return apiError(c, 404, "NOT_FOUND", "Automation not found");
    const rows = await listAutomations(bundle.db, { tenantId: tenant.id });
    const withCount =
      rows.find((r) => r.id === updated.id) ??
      { ...updated, runCount: 0, steps: [], stepCount: 0 };
    return c.json(serializeAutomation(withCount));
  });

  app.get(`${base}/:id/enrollments`, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) {
      return apiError(c, 404, "NOT_FOUND", "Automation not found");
    }
    const enrollments = await listSequenceEnrollments(
      bundle.db,
      { tenantId: tenant.id },
      id,
      { limit: 50 },
    );
    if (!enrollments)
      return apiError(c, 404, "NOT_FOUND", "Automation not found");
    const body = SequenceEnrollmentListResponseSchema.parse({
      enrollments: enrollments.map(serializeEnrollment),
    });
    return c.json(body);
  });

  // ---- Pendaftaran sequence manual (G2b) ----------------------------------
  // Entry point manual di atas service bersama sequence-enroll (jalur
  // yang sama dengan kata kunci & node flow). Penolakan selalu berkode
  // khusus supaya UI menerjemahkan SEBABNYA ke pengguna (kontak tanpa
  // percakapan pesan, kontak opt-out, sequence nonaktif/tanpa langkah)
  // — bukan error generik.
  app.post(`${base}/:id/enroll`, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) {
      return apiError(c, 404, "NOT_FOUND", "Automation not found");
    }
    const automation = await getAutomation(
      bundle.db,
      { tenantId: tenant.id },
      id,
    );
    if (!automation) return apiError(c, 404, "NOT_FOUND", "Automation not found");
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = EnrollSequenceContactRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid enroll payload");
    }
    const result = await enrollContactInSequenceManually(
      bundle.db,
      { tenantId: tenant.id, userId: c.get("appUser").id },
      {
        automationId: id,
        contactId: parsed.data.contactId,
        conversationId: parsed.data.conversationId,
      },
    );
    switch (result.kind) {
      case "enrolled":
      case "already_enrolled": {
        const body = EnrollSequenceContactResponseSchema.parse({
          outcome: result.kind,
          enrollment: serializeEnrollment({
            ...result.enrollment,
            totalSteps: result.totalSteps,
          }),
        });
        return c.json(body, result.kind === "enrolled" ? 201 : 200);
      }
      case "contact_not_found":
        return apiError(c, 404, "NOT_FOUND", "Contact not found");
      case "sequence_unavailable":
        return apiError(
          c,
          422,
          "SEQUENCE_UNAVAILABLE",
          "Sequence is not an active sequence",
        );
      case "no_steps":
        return apiError(
          c,
          422,
          "SEQUENCE_NO_STEPS",
          "Sequence has no steps to send",
        );
      case "no_conversation":
        return apiError(
          c,
          422,
          "ENROLL_NO_CONVERSATION",
          "Contact has no messaging conversation to anchor the enrollment",
        );
      case "conversation_not_messaging":
        return apiError(
          c,
          422,
          "ENROLL_CONVERSATION_INVALID",
          "Selected conversation is not a messaging conversation of this contact",
        );
      case "contact_opted_out":
        return apiError(
          c,
          422,
          "ENROLL_CONTACT_OPTED_OUT",
          "Contact has opted out of marketing messages",
        );
    }
  });

  app.post(`${base}/:id/enroll-by-tag`, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) {
      return apiError(c, 404, "NOT_FOUND", "Automation not found");
    }
    const automation = await getAutomation(
      bundle.db,
      { tenantId: tenant.id },
      id,
    );
    if (!automation) return apiError(c, 404, "NOT_FOUND", "Automation not found");
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = EnrollSequenceByTagRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid enroll-by-tag payload");
    }
    const result = await enrollContactsInSequenceByTag(
      bundle.db,
      { tenantId: tenant.id, userId: c.get("appUser").id },
      { automationId: id, tag: parsed.data.tag },
    );
    if (result.kind === "sequence_unavailable") {
      return apiError(
        c,
        422,
        "SEQUENCE_UNAVAILABLE",
        "Sequence is not an active sequence",
      );
    }
    if (result.kind === "no_steps") {
      return apiError(
        c,
        422,
        "SEQUENCE_NO_STEPS",
        "Sequence has no steps to send",
      );
    }
    return c.json(EnrollSequenceByTagResponseSchema.parse(result.report));
  });

  app.get(`${base}/:id/enroll-conversations`, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) {
      return apiError(c, 404, "NOT_FOUND", "Automation not found");
    }
    const automation = await getAutomation(
      bundle.db,
      { tenantId: tenant.id },
      id,
    );
    if (!automation) return apiError(c, 404, "NOT_FOUND", "Automation not found");
    const contactId = c.req.query("contactId") ?? "";
    if (!z.string().uuid().safeParse(contactId).success) {
      return apiError(
        c,
        400,
        "VALIDATION_ERROR",
        "contactId query parameter must be a uuid",
      );
    }
    const rows = await listContactMessagingConversations(
      bundle.db,
      { tenantId: tenant.id },
      contactId,
    );
    if (!rows) return apiError(c, 404, "NOT_FOUND", "Contact not found");
    const body = EnrollConversationListResponseSchema.parse({
      conversations: rows.map((row) => ({
        id: row.id,
        kind: row.kind === "group" ? ("group" as const) : ("private" as const),
        provider: row.provider,
        title: row.title,
        lastMessageAt: row.lastMessageAt
          ? row.lastMessageAt.toISOString()
          : null,
        createdAt: row.createdAt.toISOString(),
      })),
    });
    return c.json(body);
  });

  app.get(`${base}/:id/runs`, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) {
      return apiError(c, 404, "NOT_FOUND", "Automation not found");
    }
    const runs = await listAutomationRuns(
      bundle.db,
      { tenantId: tenant.id },
      id,
      { limit: 50 },
    );
    if (!runs) return apiError(c, 404, "NOT_FOUND", "Automation not found");
    const body = AutomationRunListResponseSchema.parse({
      runs: runs.map(serializeRun),
    });
    return c.json(body);
  });

  return app;
}
