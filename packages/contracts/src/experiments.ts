import { z } from "zod";

// ---------------------------------------------------------------------------
// Fase 13D — Eksperimen A/B (hasil). PERMUKAAN DASHBOARD SAJA:
// skema-skema di bawah dipakai endpoint dashboard
// GET /tenants/:tenantId/flows/:id/experiments dan
// GET /tenants/:tenantId/broadcasts/:id/ab-results. SENGAJA tidak ada
// rute v1 / scope / SDK / MCP untuk hasil eksperimen (artefak
// kurasi builder & pelaporan operator — preseden yang sama seperti
// flow & broadcast itu sendiri di matriks cakupan 15A).
// ---------------------------------------------------------------------------

/** Statistik satu varian eksperimen flow (per node ab_split). */
export const FlowExperimentVariantStatsSchema = z.object({
  branch: z.enum(["a", "b"]),
  /** Kontak unik yang pernah ditugaskan ke varian ini. */
  assignedContacts: z.number().int().nonnegative(),
  /** Run yang melewati node split dan masuk varian ini. */
  runs: z.number().int().nonnegative(),
  /** Run di atas yang berakhir `completed`. */
  completedRuns: z.number().int().nonnegative(),
  /**
   * Run yang langkah suksesnya melewati node konversi SESUDAH
   * langkah split (hanya bermakna bila conversionNodeId diisi;
   * tanpa titik konversi selalu 0 dan conversionRate null).
   */
  conversions: z.number().int().nonnegative(),
  /** conversions / runs; null bila runs = 0 atau tanpa titik konversi. */
  conversionRate: z.number().min(0).max(1).nullable(),
});
export type FlowExperimentVariantStats = z.infer<
  typeof FlowExperimentVariantStatsSchema
>;

/**
 * Putusan statistik hasil eksperimen — KEJUJURAN STATISTIK (pola
 * kejujuran biaya 9B): petunjuk pemenang HANYA muncul bila uji
 * dua-proporsi (z-test pooled, dua sisi) atas tingkat konversi
 * menghasilkan p < 0.05 DAN kedua varian mencapai sampel minimum;
 * nilai z dan p selalu dikirim agar bisa ditampilkan apa adanya.
 */
export const FlowExperimentVerdictSchema = z.object({
  status: z.enum([
    "not_enough_data",
    "no_significant_difference",
    "winner",
  ]),
  /** Cabang pemenang; hanya terisi saat status = "winner". */
  winnerBranch: z.enum(["a", "b"]).nullable(),
  /** Statistik z uji dua-proporsi; null bila belum dihitung. */
  z: z.number().nullable(),
  /** Nilai p dua sisi; null bila belum dihitung. */
  pValue: z.number().min(0).max(1).nullable(),
  /** Sampel minimum (run per varian) sebelum putusan dihitung. */
  minSamplePerVariant: z.number().int().positive(),
});
export type FlowExperimentVerdict = z.infer<typeof FlowExperimentVerdictSchema>;

/** Hasil satu node ab_split mode eksperimen pada satu flow. */
export const FlowExperimentResultSchema = z.object({
  nodeId: z.string(),
  /** Label eksperimen dari config node; null bila tidak diisi. */
  label: z.string().nullable(),
  percentA: z.number().int().min(1).max(99),
  /** Node titik konversi dari config; null bila tidak diisi. */
  conversionNodeId: z.string().nullable(),
  variants: z.array(FlowExperimentVariantStatsSchema),
  verdict: FlowExperimentVerdictSchema,
});
export type FlowExperimentResult = z.infer<typeof FlowExperimentResultSchema>;

export const FlowExperimentsResponseSchema = z.object({
  flowId: z.string().uuid(),
  experiments: z.array(FlowExperimentResultSchema),
});
export type FlowExperimentsResponse = z.infer<
  typeof FlowExperimentsResponseSchema
>;
