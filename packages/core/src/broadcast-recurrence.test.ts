import { describe, expect, it } from "vitest";
import {
  firstRecurrenceSlotAtOrAfter,
  nextRecurrenceSlotAfter,
  previewRecurrenceSlots,
  validateRecurrencePattern,
  type BroadcastRecurrencePattern,
} from "./broadcast-recurrence";

/**
 * Matematika pola broadcast berulang (G9) sebagai fungsi murni:
 * harian/mingguan/bulanan, hari terakhir bulan, penjepitan tanggal,
 * dan jam dinding tetap melintasi DST. Semua instan dalam UTC;
 * zona aturan yang menentukan jam dindingnya.
 */

const JAKARTA = "Asia/Jakarta";
/** 09:00 di Jakarta = 02:00Z. */
const jkt = (isoDate: string) => `${isoDate}T02:00:00.000Z`;

function pattern(
  overrides: Partial<BroadcastRecurrencePattern>,
): BroadcastRecurrencePattern {
  return {
    frequency: "daily",
    interval: 1,
    daysOfWeek: [],
    dayOfMonth: null,
    lastDayOfMonth: false,
    timezone: JAKARTA,
    startsAt: new Date(jkt("2026-11-13")),
    endsAt: null,
    ...overrides,
  };
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

describe("pola harian", () => {
  it("interval 1: slot pada jangkar lalu tiap hari pada jam dinding yang sama", () => {
    const p = pattern({});
    expect(iso(firstRecurrenceSlotAtOrAfter(p, p.startsAt.getTime()))).toBe(
      jkt("2026-11-13"),
    );
    expect(iso(nextRecurrenceSlotAfter(p, p.startsAt.getTime()))).toBe(
      jkt("2026-11-14"),
    );
    const slots = previewRecurrenceSlots(p, {
      count: 3,
      from: new Date("2026-11-01T00:00:00.000Z"),
    });
    expect(slots.map((s) => s.toISOString())).toEqual([
      jkt("2026-11-13"),
      jkt("2026-11-14"),
      jkt("2026-11-15"),
    ]);
  });

  it("interval 3: melompat tiga hari", () => {
    const p = pattern({ interval: 3 });
    const slots = previewRecurrenceSlots(p, {
      count: 3,
      from: new Date("2026-11-01T00:00:00.000Z"),
    });
    expect(slots.map((s) => s.toISOString())).toEqual([
      jkt("2026-11-13"),
      jkt("2026-11-16"),
      jkt("2026-11-19"),
    ]);
  });

  it("bound di tengah aliran: slot pertama pada/sesudah bound", () => {
    const p = pattern({});
    // Bound sesudah slot 14 Nov (02:00Z) → berikutnya 15 Nov.
    expect(
      iso(
        firstRecurrenceSlotAtOrAfter(
          p,
          new Date("2026-11-14T03:00:00.000Z").getTime(),
        ),
      ),
    ).toBe(jkt("2026-11-15"));
    // Bound tepat pada slot → slot itu sendiri.
    expect(
      iso(
        firstRecurrenceSlotAtOrAfter(
          p,
          new Date(jkt("2026-11-14")).getTime(),
        ),
      ),
    ).toBe(jkt("2026-11-14"));
  });
});

describe("pola mingguan", () => {
  // Senin, 9 November 2026, 09:00 Jakarta.
  const monday = new Date(jkt("2026-11-09"));

  it("hari aktif Senin+Rabu, interval 1", () => {
    const p = pattern({
      frequency: "weekly",
      startsAt: monday,
      daysOfWeek: [1, 3],
    });
    const slots = previewRecurrenceSlots(p, {
      count: 4,
      from: new Date("2026-11-01T00:00:00.000Z"),
    });
    expect(slots.map((s) => s.toISOString())).toEqual([
      jkt("2026-11-09"), // Senin
      jkt("2026-11-11"), // Rabu
      jkt("2026-11-16"), // Senin
      jkt("2026-11-18"), // Rabu
    ]);
  });

  it("interval 2: minggu bergantian", () => {
    const p = pattern({
      frequency: "weekly",
      interval: 2,
      startsAt: monday,
      daysOfWeek: [1, 3],
    });
    const slots = previewRecurrenceSlots(p, {
      count: 4,
      from: new Date("2026-11-01T00:00:00.000Z"),
    });
    expect(slots.map((s) => s.toISOString())).toEqual([
      jkt("2026-11-09"),
      jkt("2026-11-11"),
      jkt("2026-11-23"),
      jkt("2026-11-25"),
    ]);
  });

  it("daysOfWeek kosong = hari yang sama dengan jangkar (Jumat)", () => {
    const p = pattern({ frequency: "weekly" }); // jangkar Jumat 13 Nov
    const slots = previewRecurrenceSlots(p, {
      count: 3,
      from: new Date("2026-11-01T00:00:00.000Z"),
    });
    expect(slots.map((s) => s.toISOString())).toEqual([
      jkt("2026-11-13"),
      jkt("2026-11-20"),
      jkt("2026-11-27"),
    ]);
  });
});

describe("pola bulanan", () => {
  it("tanggal 31 dijepit ke hari terakhir bulan pendek", () => {
    const p = pattern({
      frequency: "monthly",
      startsAt: new Date(jkt("2027-01-31")),
      dayOfMonth: 31,
    });
    const slots = previewRecurrenceSlots(p, {
      count: 4,
      from: new Date("2027-01-01T00:00:00.000Z"),
    });
    expect(slots.map((s) => s.toISOString())).toEqual([
      jkt("2027-01-31"),
      jkt("2027-02-28"), // dijepit, bukan dilewati
      jkt("2027-03-31"),
      jkt("2027-04-30"), // dijepit
    ]);
  });

  it("hari terakhir bulan eksplisit", () => {
    const p = pattern({
      frequency: "monthly",
      startsAt: new Date(jkt("2027-01-15")),
      lastDayOfMonth: true,
    });
    const slots = previewRecurrenceSlots(p, {
      count: 3,
      from: new Date("2027-01-01T00:00:00.000Z"),
    });
    expect(slots.map((s) => s.toISOString())).toEqual([
      jkt("2027-01-31"),
      jkt("2027-02-28"),
      jkt("2027-03-31"),
    ]);
  });

  it("interval 2 pada tanggal 15", () => {
    const p = pattern({
      frequency: "monthly",
      interval: 2,
      startsAt: new Date(jkt("2026-11-15")),
      dayOfMonth: 15,
    });
    const slots = previewRecurrenceSlots(p, {
      count: 3,
      from: new Date("2026-11-01T00:00:00.000Z"),
    });
    expect(slots.map((s) => s.toISOString())).toEqual([
      jkt("2026-11-15"),
      jkt("2027-01-15"),
      jkt("2027-03-15"),
    ]);
  });

  it("dayOfMonth lebih awal dari tanggal jangkar: bulan pertama dilewati", () => {
    const p = pattern({
      frequency: "monthly",
      startsAt: new Date(jkt("2026-11-20")),
      dayOfMonth: 5,
    });
    const slots = previewRecurrenceSlots(p, {
      count: 2,
      from: new Date("2026-11-01T00:00:00.000Z"),
    });
    expect(slots.map((s) => s.toISOString())).toEqual([
      jkt("2026-12-05"),
      jkt("2027-01-05"),
    ]);
  });
});

describe("zona waktu & DST", () => {
  it("jam dinding tetap 09:00 melintasi spring-forward America/New_York", () => {
    const p = pattern({
      timezone: "America/New_York",
      // Jumat 6 Maret 2026 09:00 EST = 14:00Z; DST mulai Minggu 8 Maret.
      startsAt: new Date("2026-03-06T14:00:00.000Z"),
    });
    const slots = previewRecurrenceSlots(p, {
      count: 4,
      from: new Date("2026-03-01T00:00:00.000Z"),
    });
    expect(slots.map((s) => s.toISOString())).toEqual([
      "2026-03-06T14:00:00.000Z", // EST (UTC-5)
      "2026-03-07T14:00:00.000Z", // EST
      "2026-03-08T13:00:00.000Z", // EDT (UTC-4) — jam dinding tetap 09:00
      "2026-03-09T13:00:00.000Z", // EDT
    ]);
  });
});

describe("batas rentang & validasi", () => {
  it("pratinjau berhenti pada endsAt (inklusif)", () => {
    const p = pattern({ endsAt: new Date(jkt("2026-11-15")) });
    const slots = previewRecurrenceSlots(p, {
      count: 10,
      from: new Date("2026-11-01T00:00:00.000Z"),
    });
    expect(slots.map((s) => s.toISOString())).toEqual([
      jkt("2026-11-13"),
      jkt("2026-11-14"),
      jkt("2026-11-15"),
    ]);
  });

  it("validasi menolak zona tak dikenal, interval 0, hari ganda, rentang terbalik", () => {
    expect(validateRecurrencePattern(pattern({}))).toBeNull();
    expect(
      validateRecurrencePattern(pattern({ timezone: "Asia/Jakartaa" })),
    ).toBe("invalid_timezone");
    expect(validateRecurrencePattern(pattern({ interval: 0 }))).toBe(
      "invalid_interval",
    );
    expect(
      validateRecurrencePattern(
        pattern({ frequency: "weekly", daysOfWeek: [1, 1] }),
      ),
    ).toBe("invalid_days_of_week");
    expect(
      validateRecurrencePattern(pattern({ dayOfMonth: 32 })),
    ).toBe("invalid_day_of_month");
    expect(
      validateRecurrencePattern(
        pattern({ endsAt: new Date("2026-11-01T00:00:00.000Z") }),
      ),
    ).toBe("invalid_range");
  });
});
