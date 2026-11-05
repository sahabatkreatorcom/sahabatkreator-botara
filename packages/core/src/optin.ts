import { eq } from "drizzle-orm";
import {
  auditLogs,
  tenantOptInSettings,
  type Database,
} from "@sahabat-kreator/db";
import { withTenantDb } from "./tx";

/**
 * Mesin opt-in broadcast (Fase 13C) — pengaturan per tenant.
 *
 * Penangkapan persetujuan berjalan di pipeline inbound
 * (evaluateInboundMessageForAutomations di automations.ts) sebagai
 * matcher TINGKAT SISTEM: dievaluasi sesudah konteks pesan dimuat dan
 * SEBELUM automation keyword/flow/agent. Pesan yang cocok kata kunci
 * consent dianggap TERTANGANI SISTEM (seperti pesan yang menembak
 * automation): tidak diteruskan ke agent AI sebagai pertanyaan biasa.
 *
 * Pencocokan = kata PERSIS (mode "exact" matcher keyword yang ada:
 * trim + lowercase atas seluruh teks) — persetujuan tidak boleh
 * terpicu dari kalimat yang sekadar menyebut kata itu. Bila teks
 * cocok kata opt-out DAN opt-in sekaligus, OPT-OUT MENANG.
 *
 * Catatan kejujuran cakupan: sebelum fase ini TIDAK ada penangkapan
 * kata opt-out inbound sama sekali di produk ini — opt-out hanya
 * status yang diatur dashboard/API dan dihormati jalur pengiriman.
 * Kata bawaan di bawah + tambahan tenant adalah penangkapan
 * inbound-nya, baru sejak 13C.
 *
 * Konversi growth link (Fase 13B) SENGAJA tidak dianggap opt-in
 * pemasaran: mengklik tautan / memulai chat adalah atribusi sumber,
 * bukan persetujuan menerima broadcast marketing — persetujuan harus
 * datang dari kata kunci opt-in, toggle manual, atau jalur eksplisit
 * lain. Lihat juga komentar di attributeContactToGrowthLink.
 */

/** Kata kunci opt-in bawaan bila tenant belum menyimpan pengaturan. */
export const DEFAULT_OPT_IN_KEYWORDS: readonly string[] = [
  "ikut",
  "mau ikut",
  "join",
  "optin",
];

/** Kata kunci opt-out bawaan sistem (selalu berlaku, tak bisa dihapus). */
export const DEFAULT_OPT_OUT_KEYWORDS: readonly string[] = [
  "stop",
  "berhenti",
  "unsubscribe",
  "unsub",
  "keluar",
];

export interface OptInSettings {
  optInKeywords: string[];
  /** Teks konfirmasi opt-in; null = opt-in diam (tanpa balasan). */
  optInConfirmationText: string | null;
  optOutExtraKeywords: string[];
}

export const DEFAULT_OPT_IN_SETTINGS: OptInSettings = {
  optInKeywords: [...DEFAULT_OPT_IN_KEYWORDS],
  optInConfirmationText: null,
  optOutExtraKeywords: [],
};

function normalizeKeywordList(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const kw = raw.trim().toLowerCase();
    if (!kw || seen.has(kw)) continue;
    seen.add(kw);
    out.push(kw);
  }
  return out;
}

/**
 * Pengaturan opt-in tenant; baris belum ada → bawaan (baris dibuat
 * malas pada update pertama, bukan saat baca).
 */
export async function getOptInSettings(
  db: Database,
  tenantId: string,
): Promise<OptInSettings> {
  return withTenantDb(db, tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(tenantOptInSettings)
      .where(eq(tenantOptInSettings.tenantId, tenantId))
      .limit(1);
    if (!row) return { ...DEFAULT_OPT_IN_SETTINGS };
    return {
      optInKeywords: normalizeKeywordList(row.optInKeywords ?? []),
      optInConfirmationText: row.optInConfirmationText,
      optOutExtraKeywords: normalizeKeywordList(row.optOutExtraKeywords ?? []),
    };
  });
}

export async function updateOptInSettings(
  db: Database,
  input: {
    tenantId: string;
    userId: string;
    patch: Partial<OptInSettings>;
  },
): Promise<OptInSettings> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(tenantOptInSettings)
      .where(eq(tenantOptInSettings.tenantId, input.tenantId))
      .limit(1);
    const current: OptInSettings = existing
      ? {
          optInKeywords: existing.optInKeywords ?? [],
          optInConfirmationText: existing.optInConfirmationText,
          optOutExtraKeywords: existing.optOutExtraKeywords ?? [],
        }
      : { ...DEFAULT_OPT_IN_SETTINGS };
    const next: OptInSettings = {
      optInKeywords:
        input.patch.optInKeywords !== undefined
          ? normalizeKeywordList(input.patch.optInKeywords)
          : current.optInKeywords,
      optInConfirmationText:
        input.patch.optInConfirmationText !== undefined
          ? input.patch.optInConfirmationText?.trim()
            ? input.patch.optInConfirmationText.trim()
            : null
          : current.optInConfirmationText,
      optOutExtraKeywords:
        input.patch.optOutExtraKeywords !== undefined
          ? normalizeKeywordList(input.patch.optOutExtraKeywords)
          : current.optOutExtraKeywords,
    };
    if (existing) {
      await tx
        .update(tenantOptInSettings)
        .set({ ...next, updatedAt: new Date() })
        .where(eq(tenantOptInSettings.tenantId, input.tenantId));
    } else {
      await tx.insert(tenantOptInSettings).values({
        tenantId: input.tenantId,
        ...next,
      });
    }
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "optin.settings_updated",
      meta: {
        optInKeywordCount: next.optInKeywords.length,
        hasConfirmationText: next.optInConfirmationText !== null,
        optOutExtraKeywordCount: next.optOutExtraKeywords.length,
      },
    });
    return next;
  });
}

/**
 * Normalisasi teks untuk pencocokan consent — SENGAJA sama dengan
 * normalizeText matcher keyword automation (trim + lowercase) agar
 * perilaku kedua matcher konsisten.
 */
function normalizeConsentText(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Matcher consent tingkat sistem: kembalikan "opt_out" / "opt_in" /
 * null untuk teks pesan masuk. Kata PERSIS (seluruh teks ternormalisasi
 * sama dengan kata kunci). Opt-out diperiksa lebih dulu dan menang
 * atas opt-in.
 */
export function matchConsentKeyword(
  text: string,
  settings: OptInSettings,
): "opt_in" | "opt_out" | null {
  const normalized = normalizeConsentText(text);
  if (!normalized) return null;
  const optOutWords = new Set([
    ...DEFAULT_OPT_OUT_KEYWORDS,
    ...settings.optOutExtraKeywords.map(normalizeConsentText),
  ]);
  if (optOutWords.has(normalized)) return "opt_out";
  const optInWords = new Set(
    settings.optInKeywords.map(normalizeConsentText),
  );
  if (optInWords.has(normalized)) return "opt_in";
  return null;
}
