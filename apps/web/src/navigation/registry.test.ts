import { describe, expect, it } from "vitest";

import {
  NAV_GROUPS,
  NAV_REGISTRY,
  desktopItems,
  filterNavItems,
  groupNavItems,
  moreItems,
  type NavItem,
} from "./registry";

/**
 * Pengelompokan navigasi (permintaan pemilik: "grouping navigasi").
 *
 * Yang dijaga test ini: daftar rata 18 item kini terbagi ke enam
 * kelompok yang stabil — sidebar desktop dan lembar More mobile
 * merender kelompok yang sama dari fungsi yang sama. Dua kegagalan
 * yang tidak boleh terjadi: item kehilangan kelompoknya (hilang dari
 * tampilan) dan kelompok kosong-permission tetap dirender sebagai
 * tajuk yatim tanpa isi.
 */
const ids = (items: NavItem[]): string[] => items.map((i) => i.id);
const groupedIds = (items: NavItem[]): [string, string[]][] =>
  groupNavItems(items).map((g) => [g.group.id, ids(g.items)]);

describe("kelompok registry navigasi", () => {
  it("setiap item tergabung dalam tepat satu kelompok yang dikenal", () => {
    const known = new Set(NAV_GROUPS.map((g) => g.id));
    for (const item of NAV_REGISTRY) {
      expect(known.has(item.group)).toBe(true);
    }
    // Tidak ada duplikasi id item (satu item = satu tempat).
    expect(new Set(ids(NAV_REGISTRY)).size).toBe(NAV_REGISTRY.length);
  });

  it("setiap kelompok terpakai dan labelnya kunci nav.group.*", () => {
    const used = new Set(NAV_REGISTRY.map((i) => i.group));
    for (const group of NAV_GROUPS) {
      expect(used.has(group.id)).toBe(true);
      expect(group.labelKey.startsWith("nav.group.")).toBe(true);
    }
  });

  it("sidebar desktop: isi tiap kelompok mengikuti order.desktop", () => {
    expect(groupedIds(desktopItems)).toEqual([
      ["utama", ["dashboard", "inbox"]],
      ["konten", ["broadcasts", "posts", "growth", "products"]],
      ["layanan", ["agents", "contacts", "automations", "flows", "appointments", "deals"]],
      ["kelola", ["channels", "analytics"]],
      ["akun", ["billing", "settings"]],
      ["sistem", ["logs", "audit", "admin"]],
    ]);
  });

  it("lembar More: isi tiap kelompok mengikuti order.more, kelompok utama absen", () => {
    // dashboard/inbox/agents/broadcasts adalah slot bottom bar, bukan
    // isi More — kelompok "utama" tidak punya satu pun item di sini,
    // jadi ia harus hilang dari hasil, bukan tampil sebagai tajuk kosong.
    expect(groupedIds(moreItems)).toEqual([
      ["konten", ["posts", "growth", "products"]],
      ["layanan", ["contacts", "automations", "flows", "appointments", "deals"]],
      ["kelola", ["channels", "analytics"]],
      ["akun", ["billing", "settings"]],
      ["sistem", ["logs", "audit", "admin"]],
    ]);
  });

  it("non-admin: admin hilang dari kelompok sistem, kelompoknya tetap ada", () => {
    const visible = filterNavItems(desktopItems, { isPlatformAdmin: false });
    const groups = groupedIds(visible);
    expect(groups.find(([id]) => id === "sistem")?.[1]).toEqual(["logs", "audit"]);
  });

  it("kelompok yang seluruh itemnya tersaring permission hilang sepenuhnya", () => {
    const adminOnly = NAV_REGISTRY.filter((i) => i.id === "admin");
    expect(adminOnly).toHaveLength(1);
    // Satu-satunya item "sistem" di daftar ini ber-permission
    // platformAdmin; untuk non-admin hasilnya harus kosong total.
    expect(groupNavItems(filterNavItems(adminOnly, { isPlatformAdmin: false }))).toEqual([]);
    expect(groupNavItems([])).toEqual([]);
  });

  it("pengelompokan tidak menghilangkan atau menggandakan item", () => {
    const flattened = groupNavItems(desktopItems).flatMap((g) => ids(g.items));
    expect([...flattened].sort()).toEqual(ids(desktopItems).sort());
  });

  it("urutan kelompok selalu kanonis walau daftar masukan diacak", () => {
    const shuffled = [...desktopItems].reverse();
    expect(groupNavItems(shuffled).map((g) => g.group.id)).toEqual(
      NAV_GROUPS.map((g) => g.id),
    );
  });
});
