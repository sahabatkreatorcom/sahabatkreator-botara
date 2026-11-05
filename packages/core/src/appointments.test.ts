import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  computeBookableSlots,
  createBooking,
  formatAppointmentSlot,
  isValidTimeZone,
  localDateOf,
  parseSlotSelection,
  SlotTakenError,
  tzOffsetMs,
  weekdayOfDate,
  zonedWallToUtcMs,
} from "./appointments";
import { createTestDb, seedContact, TEST_TENANT_ID, type TestDb } from "./testing/pglite";

/**
 * Janji temu adalah tempat dua jenis kesalahan paling mahal bertemu:
 * salah hitung waktu (pelanggan datang ke slot yang tidak ada) dan
 * double booking (dua pelanggan di jam yang sama).
 *
 * Bagian pertama menguji matematika zona waktu dan mesin slot sebagai
 * fungsi murni — cepat, tanpa database, dan menangkap kesalahan offset
 * yang paling sering lolos. Bagian kedua menjalankan booking sungguhan
 * di Postgres (PGlite) untuk membuktikan exclusion constraint memang
 * menolak bentrok, dan bahwa SlotTakenError benar-benar muncul.
 */

// Rabu, 4 November 2026.
const WEDNESDAY = 3;
const JAKARTA = "Asia/Jakarta";
const AT_09_JAKARTA = new Date("2026-11-04T02:00:00Z");

describe("matematika zona waktu", () => {
  it("mengenali zona IANA dan menolak teks sembarang", () => {
    expect(isValidTimeZone("Asia/Jakarta")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Asia/Jakartaa")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone("bukan/zona")).toBe(false);
  });

  it("menerima pengenal offset karena ECMA-402 mengakuinya", () => {
    // Ini bukan kelalaian: zona offset berperilaku benar di semua fungsi
    // modul ini (tanpa DST). Yang penting adalah perilakunya DIKUNCI,
    // supaya perubahan tak sengaja di masa depan terlihat.
    expect(isValidTimeZone("+07:00")).toBe(true);
    expect(tzOffsetMs("+07:00", AT_09_JAKARTA.getTime())).toBe(7 * 3_600_000);
    expect(zonedWallToUtcMs("+07:00", 2026, 11, 4, 9, 0)).toBe(
      Date.parse("2026-11-04T02:00:00Z"),
    );
  });

  it("offset Jakarta tetap +7 jam sepanjang tahun", () => {
    expect(tzOffsetMs(JAKARTA, AT_09_JAKARTA.getTime())).toBe(7 * 3_600_000);
    expect(
      tzOffsetMs(JAKARTA, new Date("2026-07-04T02:00:00Z").getTime()),
    ).toBe(7 * 3_600_000);
  });

  it("offset zona ber-DST berubah sesuai musim", () => {
    // New York: EST (UTC−5) di Januari, EDT (UTC−4) di Juli.
    const winter = tzOffsetMs("America/New_York", Date.parse("2026-01-15T12:00:00Z"));
    const summer = tzOffsetMs("America/New_York", Date.parse("2026-07-15T12:00:00Z"));
    expect(winter).toBe(-5 * 3_600_000);
    expect(summer).toBe(-4 * 3_600_000);
  });

  it("jam dinding → UTC memakai offset yang benar", () => {
    // 09:00 di Jakarta = 02:00 UTC.
    expect(zonedWallToUtcMs(JAKARTA, 2026, 11, 4, 9, 0)).toBe(
      Date.parse("2026-11-04T02:00:00Z"),
    );
    // UTC adalah identitas.
    expect(zonedWallToUtcMs("UTC", 2026, 11, 4, 9, 0)).toBe(
      Date.parse("2026-11-04T09:00:00Z"),
    );
  });

  it("jam dinding New York jatuh tepat pada transisi DST", () => {
    // 8 Maret 2026: jam 02:00 EST melompat ke 03:00 EDT. Jam dinding
    // 01:30 masih EST (UTC−5) → 06:30Z; 03:30 sudah EDT (UTC−4) → 07:30Z.
    expect(zonedWallToUtcMs("America/New_York", 2026, 3, 8, 1, 30)).toBe(
      Date.parse("2026-03-08T06:30:00Z"),
    );
    expect(zonedWallToUtcMs("America/New_York", 2026, 3, 8, 3, 30)).toBe(
      Date.parse("2026-03-08T07:30:00Z"),
    );
  });

  it("tanggal lokal dan weekday diambil dari kalender zona, bukan UTC", () => {
    // 23:30 UTC tanggal 3 November = 06:30 tanggal 4 November di Jakarta.
    const instant = Date.parse("2026-11-03T23:30:00Z");
    expect(localDateOf(JAKARTA, instant)).toEqual({
      year: 2026,
      month: 11,
      day: 4,
    });
    expect(localDateOf("UTC", instant)).toEqual({ year: 2026, month: 11, day: 3 });
    expect(weekdayOfDate(2026, 11, 4)).toBe(WEDNESDAY);
  });
});

describe("label slot", () => {
  it("menampilkan tanggal dan jam dalam zona tenant, dwibahasa", () => {
    const endsAt = new Date(AT_09_JAKARTA.getTime() + 30 * 60_000);
    expect(formatAppointmentSlot(JAKARTA, AT_09_JAKARTA, endsAt)).toBe(
      "Wednesday/Rabu, 4 Nov 2026 — 09:00–09:30",
    );
  });

  it("instan yang sama ditampilkan berbeda di zona berbeda", () => {
    const endsAt = new Date(AT_09_JAKARTA.getTime() + 30 * 60_000);
    expect(formatAppointmentSlot("UTC", AT_09_JAKARTA, endsAt)).toBe(
      "Wednesday/Rabu, 4 Nov 2026 — 02:00–02:30",
    );
  });
});

describe("parsing pilihan slot", () => {
  it("menerima nomor di dalam rentang", () => {
    expect(parseSlotSelection("1", 3)).toEqual({ index: 0 });
    expect(parseSlotSelection("3", 3)).toEqual({ index: 2 });
    expect(parseSlotSelection("  2  ", 3)).toEqual({ index: 1 });
  });

  it("menolak nomor di luar rentang", () => {
    expect(parseSlotSelection("0", 3)).toBeNull();
    expect(parseSlotSelection("4", 3)).toBeNull();
    expect(parseSlotSelection("-1", 3)).toBeNull();
  });

  it("menolak bentuk yang bukan nomor polos", () => {
    // Janji tidak punya kuantitas, jadi "2x3" TIDAK sah (beda dari katalog).
    expect(parseSlotSelection("2x3", 3)).toBeNull();
    expect(parseSlotSelection("dua", 3)).toBeNull();
    expect(parseSlotSelection("", 3)).toBeNull();
    expect(parseSlotSelection("1.5", 3)).toBeNull();
  });
});

describe("mesin slot", () => {
  const base = {
    timezone: JAKARTA,
    minLeadMinutes: 0,
    durationMinutes: 30,
    windows: [{ weekday: WEDNESDAY, startTime: "09:00", endTime: "10:00" }],
    confirmed: [],
    extraBusy: [],
    from: new Date("2026-11-04T00:00:00Z"),
    to: new Date("2026-11-05T00:00:00Z"),
    now: new Date("2026-11-03T00:00:00Z"),
  };

  it("memotong jendela menjadi slot sepanjang durasi layanan", () => {
    const slots = computeBookableSlots(base);
    expect(slots.map((s) => s.startsAt.toISOString())).toEqual([
      "2026-11-04T02:00:00.000Z",
      "2026-11-04T02:30:00.000Z",
    ]);
    expect(slots[0]?.endsAt.toISOString()).toBe("2026-11-04T02:30:00.000Z");
  });

  it("tidak membuat slot yang melewati akhir jendela", () => {
    // Jendela 45 menit dengan durasi 30 menit hanya menyisakan satu slot.
    const slots = computeBookableSlots({
      ...base,
      windows: [{ weekday: WEDNESDAY, startTime: "09:00", endTime: "09:45" }],
    });
    expect(slots).toHaveLength(1);
  });

  it("menghormati waktu tunggu minimum", () => {
    // Pukul 09:10 lokal, tunggu minimum 0 → slot 09:00 sudah lewat.
    const slots = computeBookableSlots({
      ...base,
      now: new Date("2026-11-04T02:10:00Z"),
    });
    expect(slots.map((s) => s.startsAt.toISOString())).toEqual([
      "2026-11-04T02:30:00.000Z",
    ]);
  });

  it("waktu tunggu 120 menit membuang slot yang terlalu dekat", () => {
    const slots = computeBookableSlots({
      ...base,
      minLeadMinutes: 120,
      now: new Date("2026-11-04T00:10:00Z"), // +120 menit = 02:10Z
    });
    expect(slots.map((s) => s.startsAt.toISOString())).toEqual([
      "2026-11-04T02:30:00.000Z",
    ]);
  });

  it("membuang slot yang bertumpang tindih dengan booking terkonfirmasi", () => {
    const slots = computeBookableSlots({
      ...base,
      confirmed: [
        {
          start: new Date("2026-11-04T02:00:00Z"),
          end: new Date("2026-11-04T02:30:00Z"),
        },
      ],
    });
    expect(slots.map((s) => s.startsAt.toISOString())).toEqual([
      "2026-11-04T02:30:00.000Z",
    ]);
  });

  it("booking yang bersambung TIDAK dianggap bentrok", () => {
    // 09:00–09:30 lalu 09:30–10:00 harus dua slot yang sah: rentang
    // setengah-terbuka [start, end). Kalau batas ini salah, mesin slot
    // kehilangan separuh kapasitasnya tanpa error apa pun.
    const slots = computeBookableSlots({
      ...base,
      confirmed: [
        {
          start: new Date("2026-11-04T02:30:00Z"),
          end: new Date("2026-11-04T03:00:00Z"),
        },
      ],
    });
    expect(slots.map((s) => s.startsAt.toISOString())).toEqual([
      "2026-11-04T02:00:00.000Z",
    ]);
  });

  it("kesibukan tambahan (Google) memotong slot dengan cara yang sama", () => {
    const slots = computeBookableSlots({
      ...base,
      extraBusy: [
        {
          start: new Date("2026-11-04T02:15:00Z"),
          end: new Date("2026-11-04T02:20:00Z"),
        },
      ],
    });
    // Kesibukan 5 menit di tengah slot pertama membatalkan slot itu utuh.
    expect(slots.map((s) => s.startsAt.toISOString())).toEqual([
      "2026-11-04T02:30:00.000Z",
    ]);
  });

  it("jendela yang jatuh di hari UTC sebelumnya tetap muncul", () => {
    // 06:00–08:00 Jakarta = 23:00Z hari sebelumnya. Iterasi per tanggal
    // LOKAL yang membuat ini benar; iterasi per tanggal UTC akan
    // menghilangkan seluruh pagi hari tenant.
    const slots = computeBookableSlots({
      ...base,
      windows: [{ weekday: WEDNESDAY, startTime: "06:00", endTime: "08:00" }],
      from: new Date("2026-11-03T12:00:00Z"),
      to: new Date("2026-11-04T02:00:00Z"),
    });
    expect(slots.map((s) => s.startsAt.toISOString())).toEqual([
      "2026-11-03T23:00:00.000Z",
      "2026-11-03T23:30:00.000Z",
      "2026-11-04T00:00:00.000Z",
      "2026-11-04T00:30:00.000Z",
    ]);
  });

  it("mengembalikan daftar kosong bila tidak ada jendela pada hari itu", () => {
    const slots = computeBookableSlots({
      ...base,
      windows: [{ weekday: 0, startTime: "09:00", endTime: "10:00" }],
    });
    expect(slots).toEqual([]);
  });
});

describe("booking di database sungguhan", () => {
  let ctx: TestDb;
  let serviceId: string;
  let contactId: string;
  let actorId: string;

  beforeAll(async () => {
    ctx = await createTestDb();
    contactId = await seedContact(ctx.pglite, TEST_TENANT_ID);
    actorId = crypto.randomUUID();
    serviceId = crypto.randomUUID();
    await ctx.pglite.query(
      `INSERT INTO appointment_services (id, tenant_id, name, duration_minutes)
       VALUES ($1, $2, 'Konsultasi 30 Menit', 30)`,
      [serviceId, TEST_TENANT_ID],
    );
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const book = (startsAt: string) =>
    createBooking(ctx.db, TEST_TENANT_ID, {
      serviceId,
      contactId,
      startsAt: new Date(startsAt),
      source: "dashboard",
      actorType: "user",
      actorId,
    });

  it("menurunkan endsAt dari durasi layanan", async () => {
    const booking = await book("2026-12-01T02:00:00Z");
    expect(booking.startsAt.toISOString()).toBe("2026-12-01T02:00:00.000Z");
    expect(booking.endsAt.toISOString()).toBe("2026-12-01T02:30:00.000Z");
    expect(booking.status).toBe("confirmed");
  });

  it("menolak booking kedua yang beririsan dengan SlotTakenError", async () => {
    // Mulai 10 menit setelah booking pertama — masih beririsan.
    await expect(book("2026-12-01T02:10:00Z")).rejects.toBeInstanceOf(
      SlotTakenError,
    );
  });

  it("menerima booking yang bersambung tepat di ujung", async () => {
    // 02:30 tepat setelah 02:00–02:30: batas [) berarti tidak bentrok.
    const adjacent = await book("2026-12-01T02:30:00Z");
    expect(adjacent.id).toBeTruthy();
  });

  it("booking yang dibatalkan membebaskan slotnya", async () => {
    await book("2026-12-02T02:00:00Z");
    // Batalkan lewat SQL langsung: yang diuji adalah efek status pada
    // constraint, bukan jalur pembatalan (itu punya test tersendiri).
    await ctx.pglite.query(
      `UPDATE bookings SET status = 'cancelled', cancelled_at = now()
       WHERE starts_at = $1`,
      [new Date("2026-12-02T02:00:00Z")],
    );
    const replacement = await book("2026-12-02T02:00:00Z");
    expect(replacement.id).toBeTruthy();
  });

  it("booking untuk layanan berbeda di jam yang sama tetap boleh", async () => {
    // Constraint hanya mengunci per layanan: dua terapis berbeda boleh
    // melayani dua pelanggan pada jam yang sama.
    const otherServiceId = crypto.randomUUID();
    await ctx.pglite.query(
      `INSERT INTO appointment_services (id, tenant_id, name, duration_minutes)
       VALUES ($1, $2, 'Konsultasi 60 Menit', 60)`,
      [otherServiceId, TEST_TENANT_ID],
    );
    const booking = await createBooking(ctx.db, TEST_TENANT_ID, {
      serviceId: otherServiceId,
      contactId,
      startsAt: new Date("2026-12-01T02:00:00Z"),
      source: "dashboard",
      actorType: "user",
      actorId,
    });
    expect(booking.id).toBeTruthy();
  });
});
