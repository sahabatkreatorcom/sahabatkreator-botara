/**
 * Chip status broadcast dan status template Meta, plus satu pemecah
 * daftar berkoma yang dipakai beberapa formulir.
 *
 * Dipisah dari `types.ts` karena berkas ini merender JSX; `types.ts`
 * sengaja tetap murni data sehingga bisa diimpor dari mana saja tanpa
 * menyeret React.
 */
import type { BroadcastStatus } from "@sahabat-kreator/contracts";
import type { TranslationKey } from "@sahabat-kreator/i18n";
import { STATUS_CHIP, type Translate } from "./types";

/** Chip status persetujuan template Meta (Fase 10A). */
export function TemplateStatusChip({
  t,
  status,
}: {
  t: Translate;
  status: string;
}) {
  const known: Record<string, { labelKey: TranslationKey; className: string }> = {
    APPROVED: {
      labelKey: "whatsappTemplates.statusApproved",
      className: "bg-success-soft text-success",
    },
    PENDING: {
      labelKey: "whatsappTemplates.statusPending",
      className: "bg-warning-soft text-warning",
    },
    REJECTED: {
      labelKey: "whatsappTemplates.statusRejected",
      className: "bg-danger-soft text-danger",
    },
    PAUSED: {
      labelKey: "whatsappTemplates.statusPaused",
      className: "bg-warning-soft text-warning",
    },
    DISABLED: {
      labelKey: "whatsappTemplates.statusDisabled",
      className: "bg-danger-soft text-danger",
    },
  };
  const chip = known[status];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${chip?.className ?? "bg-surface-2 text-muted"}`}
    >
      {chip ? t(chip.labelKey) : status}
    </span>
  );
}

export function StatusChip({ t, status }: { t: Translate; status: BroadcastStatus }) {
  const chip = STATUS_CHIP[status];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${chip.className}`}
    >
      {t(chip.labelKey)}
    </span>
  );
}

export function splitCommaList(raw: string): string[] | undefined {
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}
