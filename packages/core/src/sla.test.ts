import { describe, expect, it } from "vitest";
import type { WorkSchedule } from "@sahabat-kreator/db";
import {
  addWorkingMinutes,
  deriveWindows,
  responsibilityIntervals,
  weeklyWorkingMinutes,
  workingMinutesBetween,
  type SlaMessageLike,
} from "./sla";

/**
 * Matematika jam kerja & derivasi SLA (G15) sebagai fungsi murni.
 * Kesalahan paling mahal di fitur ini adalah salah hitung menit
 * (akhir pekan/DST) dan jendela yang tertutup oleh balasan AI —
 * keduanya ditangkap di sini tanpa database.
 */

const JAKARTA = "Asia/Jakarta";
const NEW_YORK = "America/New_York";

/** Senin–Jumat 09:00–17:00. */
const MON_FRI_9_5: WorkSchedule = {
  days: {
    "1": [{ start: "09:00", end: "17:00" }],
    "2": [{ start: "09:00", end: "17:00" }],
    "3": [{ start: "09:00", end: "17:00" }],
    "4": [{ start: "09:00", end: "17:00" }],
    "5": [{ start: "09:00", end: "17:00" }],
  },
};

/** Instan dari waktu dinding Jakarta (UTC+7, tanpa DST). */
function jakarta(y: number, mo: number, d: number, h: number, mi = 0): Date {
  return new Date(Date.UTC(y, mo - 1, d, h - 7, mi));
}

// 2026-01-05 adalah Senin; 2026-01-09 Jumat; 2026-01-10/11 Sabtu/Minggu.
describe("workingMinutesBetween", () => {
  it("menghitung satu hari kerja penuh dan mengabaikan di luar jam", () => {
    const mins = workingMinutesBetween(
      MON_FRI_9_5,
      JAKARTA,
      jakarta(2026, 1, 5, 8),
      jakarta(2026, 1, 5, 18),
    );
    expect(mins).toBe(480);
  });

  it("melintasi akhir pekan: Jumat sore → Senin pagi hanya jam kerja", () => {
    const mins = workingMinutesBetween(
      MON_FRI_9_5,
      JAKARTA,
      jakarta(2026, 1, 9, 16),
      jakarta(2026, 1, 12, 10),
    );
    expect(mins).toBe(120); // 60 Jumat + 60 Senin
  });

  it("akhir pekan murni = 0", () => {
    const mins = workingMinutesBetween(
      MON_FRI_9_5,
      JAKARTA,
      jakarta(2026, 1, 10, 0),
      jakarta(2026, 1, 11, 23, 59),
    );
    expect(mins).toBe(0);
  });

  it("menghormati jeda di antara dua rentang pada hari yang sama", () => {
    const split: WorkSchedule = {
      days: {
        "1": [
          { start: "09:00", end: "12:00" },
          { start: "13:00", end: "17:00" },
        ],
      },
    };
    const mins = workingMinutesBetween(
      split,
      JAKARTA,
      jakarta(2026, 1, 5, 11),
      jakarta(2026, 1, 5, 14),
    );
    expect(mins).toBe(120); // 60 sebelum makan siang + 60 sesudahnya
  });

  it("rentang [start, end): tepat di batas tidak menambah", () => {
    const mins = workingMinutesBetween(
      MON_FRI_9_5,
      JAKARTA,
      jakarta(2026, 1, 5, 17),
      jakarta(2026, 1, 6, 9),
    );
    expect(mins).toBe(0);
  });

  it("DST spring-forward New York: jam dinding 01:00–04:00 = 2 jam nyata", () => {
    // 8 Maret 2026: pukul 02:00 EST dilompati ke 03:00 EDT.
    const sunday: WorkSchedule = {
      days: { "0": [{ start: "01:00", end: "04:00" }] },
    };
    const mins = workingMinutesBetween(
      sunday,
      NEW_YORK,
      new Date("2026-03-08T05:00:00Z"), // 00:00 EST
      new Date("2026-03-08T12:00:00Z"), // 08:00 EDT
    );
    expect(mins).toBe(120);
  });

  it("DST fall-back New York: jam dinding 01:00–04:00 = 4 jam nyata", () => {
    // 1 November 2026: pukul 01:00 terjadi dua kali.
    const sunday: WorkSchedule = {
      days: { "0": [{ start: "01:00", end: "04:00" }] },
    };
    const mins = workingMinutesBetween(
      sunday,
      NEW_YORK,
      new Date("2026-11-01T04:00:00Z"), // 00:00 EDT
      new Date("2026-11-01T12:00:00Z"), // 07:00 EST
    );
    expect(mins).toBe(240);
  });

  it("zona menentukan hari: Sabtu di Jakarta bisa masih Jumat di UTC", () => {
    // Sabtu 2026-01-10 08:00 Jakarta = Jumat 2026-01-09 20:00 EST —
    // jadwal Sabtu di zona New York tidak berlaku untuk instan ini
    // sebagai Jumat; yang berlaku hari JUMAT New York (tidak ada di
    // jadwal khusus Sabtu) → 0. Sebaliknya jadwal Jumat NY berlaku.
    const saturdayOnly: WorkSchedule = {
      days: { "6": [{ start: "09:00", end: "17:00" }] },
    };
    const mins = workingMinutesBetween(
      saturdayOnly,
      NEW_YORK,
      new Date("2026-01-10T01:00:00Z"),
      new Date("2026-01-10T03:00:00Z"),
    );
    expect(mins).toBe(0);
  });

  it("jadwal kosong dan rentang terbalik waktu = 0", () => {
    expect(weeklyWorkingMinutes({ days: {} })).toBe(0);
    expect(
      workingMinutesBetween(
        MON_FRI_9_5,
        JAKARTA,
        jakarta(2026, 1, 5, 10),
        jakarta(2026, 1, 5, 9),
      ),
    ).toBe(0);
  });
});

describe("addWorkingMinutes", () => {
  it("melompati akhir pekan untuk mencapai tenggat", () => {
    const deadline = addWorkingMinutes(
      MON_FRI_9_5,
      JAKARTA,
      jakarta(2026, 1, 9, 16, 30), // Jumat 16:30
      60,
    );
    expect(deadline).toEqual(jakarta(2026, 1, 12, 9, 30)); // Senin 09:30
  });

  it("mulai di luar jam kerja → akumulasi mulai rentang berikutnya", () => {
    const deadline = addWorkingMinutes(
      MON_FRI_9_5,
      JAKARTA,
      jakarta(2026, 1, 10, 12), // Sabtu siang
      30,
    );
    expect(deadline).toEqual(jakarta(2026, 1, 12, 9, 30));
  });

  it("jadwal tanpa menit kerja → null (tenggat tidak pernah tiba)", () => {
    expect(
      addWorkingMinutes({ days: {} }, JAKARTA, jakarta(2026, 1, 5, 10), 30),
    ).toBeNull();
  });
});

describe("deriveWindows", () => {
  const at = (h: number) => new Date(Date.UTC(2026, 0, 5, h));
  const msg = (
    direction: "inbound" | "outbound",
    senderType: string,
    h: number,
  ): SlaMessageLike => ({ direction, senderType, createdAt: at(h) });

  it("hanya balasan manusia yang menutup; AI & sistem dilewati", () => {
    const windows = deriveWindows([
      msg("inbound", "contact", 1),
      msg("outbound", "agent", 2), // AI membalas — jendela tetap terbuka
      msg("outbound", "system", 3), // notifikasi sistem — sama
      msg("inbound", "contact", 4), // rangkaian masuk: bukan jendela baru
      msg("outbound", "user", 5), // manusia menutup
      msg("inbound", "contact", 6), // jendela kedua
    ]);
    expect(windows).toHaveLength(2);
    expect(windows[0]).toEqual({ openedAt: at(1), closedAt: at(5) });
    expect(windows[1]).toEqual({ openedAt: at(6), closedAt: null });
  });

  it("pesan keluar manusia tanpa jendela terbuka tidak menciptakan apa pun", () => {
    expect(deriveWindows([msg("outbound", "user", 1)])).toHaveLength(0);
  });
});

describe("responsibilityIntervals", () => {
  const at = (h: number) => new Date(Date.UTC(2026, 0, 5, h));
  const base = {
    createdAt: at(0),
    updatedAt: at(10),
    current: { aiOff: false, assigned: false },
  };

  it("handoff membuka, agent_enabled menutup", () => {
    const intervals = responsibilityIntervals(
      [
        { action: "agent.handoff", at: at(2) },
        { action: "conversation.agent_enabled", at: at(6) },
      ],
      base,
    );
    expect(intervals).toEqual([{ start: at(2), end: at(6) }]);
  });

  it("ditugaskan lalu dilepas saat AI menyala → interval tertutup", () => {
    const intervals = responsibilityIntervals(
      [
        { action: "conversation.assigned", at: at(1) },
        { action: "conversation.unassigned", at: at(3) },
      ],
      base,
    );
    expect(intervals).toEqual([{ start: at(1), end: at(3) }]);
  });

  it("dilepas tugas saat AI mati → tetap bertanggung jawab", () => {
    const intervals = responsibilityIntervals(
      [
        { action: "conversation.agent_disabled", at: at(1) },
        { action: "conversation.assigned", at: at(2) },
        { action: "conversation.unassigned", at: at(3) },
      ],
      { ...base, current: { aiOff: true, assigned: false } },
    );
    expect(intervals).toEqual([{ start: at(1), end: null }]);
  });

  it("tanpa peristiwa + keadaan kini bertanggung jawab → sejak dibuat (warisan)", () => {
    const intervals = responsibilityIntervals([], {
      ...base,
      current: { aiOff: true, assigned: false },
    });
    expect(intervals).toEqual([{ start: at(0), end: null }]);
  });

  it("replay berbeda dari keadaan kini → interval korektif dari updatedAt", () => {
    const intervals = responsibilityIntervals(
      [
        { action: "agent.handoff", at: at(2) },
        { action: "conversation.agent_enabled", at: at(4) },
      ],
      { ...base, current: { aiOff: true, assigned: false } },
    );
    expect(intervals).toEqual([
      { start: at(2), end: at(4) },
      { start: at(10), end: null },
    ]);
  });
});
