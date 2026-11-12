import type { TranslationKey } from "@sahabat-kreator/i18n";

/**
 * REGISTRY NAVIGASI TUNGGAL (RANCANGAN §10.1) — satu-satunya sumber kebenaran.
 * Sidebar desktop dan bottom bar mobile me-render array yang SAMA ini.
 * Mengubah menu = mengubah array ini saja. labelKey adalah kunci i18n,
 * BUKAN teks langsung. Field `route` adalah PATH URL asli item itu
 * (Fase 6E): klik menu menavigasi ke path ini, dan item aktif selalu
 * diturunkan DARI URL saat ini lewat `matchNavPath` — tidak ada state
 * "halaman aktif" terpisah di komponen mana pun.
 *
 * Setiap item juga tergabung dalam tepat satu KELOMPOK (`group`) —
 * sidebar desktop dan lembar "More" mobile merender item per kelompok
 * dengan tajuk `nav.group.*` lewat `groupNavItems`. Kelompok yang
 * tidak punya item terlihat (mis. semua itemnya tersaring permission)
 * tidak dirender sama sekali.
 */
export type IconName =
  | "home" | "inbox" | "bot" | "megaphone" | "users" | "workflow" | "book"
  | "bag" | "link" | "chart" | "card" | "settings" | "shield" | "more"
  | "list" | "audit" | "flow" | "growth" | "calendar" | "post" | "kanban";

/** Id kelompok navigasi — urutan di NAV_GROUPS adalah urutan render. */
export type NavGroupId =
  | "utama" | "konten" | "layanan" | "kelola" | "akun" | "sistem";

export interface NavGroup {
  id: NavGroupId;
  labelKey: TranslationKey;
}

/** Daftar kelompok kanonis, sesuai urutan tampil di sidebar & sheet More. */
export const NAV_GROUPS: NavGroup[] = [
  { id: "utama", labelKey: "nav.group.utama" },
  { id: "konten", labelKey: "nav.group.konten" },
  { id: "layanan", labelKey: "nav.group.layanan" },
  { id: "kelola", labelKey: "nav.group.kelola" },
  { id: "akun", labelKey: "nav.group.akun" },
  { id: "sistem", labelKey: "nav.group.sistem" },
];

export interface NavItem {
  id: string;
  labelKey: TranslationKey;
  icon: IconName;
  route: string;
  group: NavGroupId;
  permission?: string;
  entitlement?: string;
  badge?: "unreadInbox" | "pendingApprovals";
  mobile: { slot: 1 | 2 | 3 | 4 } | { slot: "more" } | { slot: "hidden" };
  order: { desktop: number; more: number };
}

export const NAV_REGISTRY: NavItem[] = [
  { id: "dashboard",   labelKey: "nav.dashboard", group: "utama",   icon: "home",      route: "/",            mobile: { slot: 1 },      order: { desktop: 1,  more: 0 } },
  { id: "inbox",       labelKey: "nav.inbox", group: "utama",       icon: "inbox",     route: "/inbox",       badge: "unreadInbox",      mobile: { slot: 2 },      order: { desktop: 2,  more: 0 } },
  { id: "agents",      labelKey: "nav.agents", group: "layanan",      icon: "bot",       route: "/agents",      badge: "pendingApprovals", mobile: { slot: 3 },      order: { desktop: 3,  more: 0 } },
  { id: "broadcasts",  labelKey: "nav.broadcasts", group: "konten",  icon: "megaphone", route: "/broadcasts", mobile: { slot: 4 },      order: { desktop: 4,  more: 0 } },
  // Jadwal Konten (Fase 23): postingan terjadwal ke channel Telegram.
  // Bersebelahan dengan Broadcasts karena keduanya "kirim sesuatu pada
  // waktu tertentu" — bedanya broadcast punya penerima, ini tidak.
  { id: "posts",       labelKey: "nav.posts", group: "konten",       icon: "post",      route: "/posts",       mobile: { slot: "more" }, order: { desktop: 4.5, more: 0.5 } },
  { id: "contacts",    labelKey: "nav.contacts", group: "layanan",    icon: "users",     route: "/contacts",    mobile: { slot: "more" }, order: { desktop: 5,  more: 1 } },
  { id: "automations", labelKey: "nav.automations", group: "layanan", icon: "workflow",  route: "/automations", mobile: { slot: "more" }, order: { desktop: 6,  more: 2 } },
  // Flow Builder (Fase 8B): daftar /flows + builder canvas /flows/:flowId
  // (matchNavPath memetakan sub-path ke item ini, pola deep-link Inbox).
  { id: "flows",       labelKey: "nav.flows", group: "layanan",       icon: "flow",      route: "/flows",       mobile: { slot: "more" }, order: { desktop: 7,  more: 3 } },
  // Knowledge Base TIDAK lagi entri tersendiri (Fase 12E): ia tab di
  // dalam hub /agents bersama Agen, Antrean Saran, dan Playground
  // (keputusan user — ketiganya saling berhubungan). URL lama /knowledge
  // dialihkan App ke /agents?tab=knowledge. Order desktop/more item di
  // bawah ini sengaja TIDAK direnumber — celah angka tidak berpengaruh
  // pada urutan render (semua daftar di-sort).
  // Growth Tools (Fase 13B): tautan publik per channel + landing
  // pemilih channel + analitik — mengisi celah order peninggalan
  // Knowledge (desktop 8 / more 4).
  { id: "growth",      labelKey: "nav.growth", group: "konten",      icon: "growth",    route: "/growth",      mobile: { slot: "more" }, order: { desktop: 8,  more: 4 } },
  { id: "products",    labelKey: "nav.products", group: "konten",    icon: "bag",       route: "/products",    mobile: { slot: "more" }, order: { desktop: 9,  more: 5 } },
  // Janji Temu (Fase 13G): layanan + ketersediaan + booking + Google Calendar.
  { id: "appointments", labelKey: "nav.appointments", group: "layanan", icon: "calendar", route: "/appointments", mobile: { slot: "more" }, order: { desktop: 10, more: 6 } },
  // Deals / Pipeline penjualan (G12): papan Kanban deal bernilai uang
  // per kontak — bersebelahan dengan Janji Temu di Layanan, sesudah
  // Kontak & Otomasi yang menjadi sumber dealnya.
  { id: "deals",       labelKey: "nav.deals", group: "layanan",       icon: "kanban",    route: "/deals",       mobile: { slot: "more" }, order: { desktop: 10.5, more: 6.5 } },
  { id: "channels",    labelKey: "nav.channels", group: "kelola",    icon: "link",      route: "/channels",    mobile: { slot: "more" }, order: { desktop: 11, more: 7 } },
  { id: "analytics",   labelKey: "nav.analytics", group: "kelola",   icon: "chart",     route: "/analytics",   mobile: { slot: "more" }, order: { desktop: 12, more: 8 } },
  { id: "billing",     labelKey: "nav.billing", group: "akun",     icon: "card",      route: "/billing",     mobile: { slot: "more" }, order: { desktop: 13, more: 9 } },
  { id: "settings",    labelKey: "nav.settings", group: "akun",    icon: "settings",  route: "/settings",    mobile: { slot: "more" }, order: { desktop: 14, more: 10 } },
  // Log integrasi (Fase 7B.1): jejak webhook & pengiriman per workspace —
  // grup utilitas bersama Settings/Admin di "More" (tab utama mobile
  // tetap 4 sesuai keputusan desain).
  { id: "logs",        labelKey: "nav.logs", group: "sistem",        icon: "list",      route: "/logs",        mobile: { slot: "more" }, order: { desktop: 15, more: 11 } },
  // Penelusur Audit (Fase 7B.4): jejak aksi user/agent/sistem/API key
  // per workspace dari audit_logs — bersebelahan dengan Logs.
  { id: "audit",       labelKey: "nav.audit", group: "sistem",       icon: "audit",     route: "/audit",       mobile: { slot: "more" }, order: { desktop: 16, more: 12 } },
  // Panel Admin Platform (Fase 6C): `permission: "platformAdmin"` — item
  // hanya dirender untuk user ber-flag isPlatformAdmin (lihat
  // filterNavItems); gerbang sesungguhnya ada di API (non-admin → 404).
  { id: "admin",       labelKey: "nav.admin", group: "sistem",       icon: "shield",    route: "/admin",       permission: "platformAdmin", mobile: { slot: "more" }, order: { desktop: 17, more: 13 } },
];

/**
 * Saring daftar item menurut hak sesi (Fase 6C): item ber-permission
 * "platformAdmin" hanya tampil bila `isPlatformAdmin`. Dipakai Shell
 * untuk daftar yang diserahkan ke Sidebar & MoreSheet — registry sendiri
 * tetap memuat semua item (matchNavPath harus tetap bisa memetakan
 * /admin; halaman yang dirender untuk non-admin adalah placeholder).
 */
export function filterNavItems(
  items: NavItem[],
  opts: { isPlatformAdmin: boolean },
): NavItem[] {
  return items.filter(
    (i) => i.permission !== "platformAdmin" || opts.isPlatformAdmin,
  );
}

/** Satu kelompok beserta item terlihatnya, siap dirender bertajuk. */
export interface NavItemGroup {
  group: NavGroup;
  items: NavItem[];
}

/**
 * Kelompokkan daftar item yang SUDAH terurut & tersaring (desktopItems /
 * moreItems setelah filterNavItems) menurut kelompoknya. Urutan kelompok
 * selalu urutan kanonis NAV_GROUPS; urutan item di dalam kelompok
 * mengikuti urutan daftar masukan (order.desktop / order.more). Kelompok
 * tanpa item tidak muncul di hasil — jadi kelompok yang seluruh isinya
 * tersaring permission hilang dari tampilan, bukan tampil kosong.
 */
export function groupNavItems(items: NavItem[]): NavItemGroup[] {
  return NAV_GROUPS.map((group) => ({
    group,
    items: items.filter((i) => i.group === group.id),
  })).filter((g) => g.items.length > 0);
}

/** Item untuk sidebar desktop: semua item terurut order.desktop. */
export const desktopItems: NavItem[] = [...NAV_REGISTRY].sort(
  (a, b) => a.order.desktop - b.order.desktop,
);

/** Tepat 4 tab mobile (slot 1–4), terurut slot. */
export const mobileTabItems: NavItem[] = NAV_REGISTRY.filter(
  (i): i is NavItem & { mobile: { slot: number } } => typeof i.mobile.slot === "number",
).sort((a, b) => (a.mobile.slot as number) - (b.mobile.slot as number));

/** Sisa item yang tampil di sheet "More" pada mobile, terurut order.more. */
export const moreItems: NavItem[] = NAV_REGISTRY.filter(
  (i) => i.mobile.slot === "more",
).sort((a, b) => a.order.more - b.order.more);

/** Hasil pencocokan path URL terhadap registry (Fase 6E). */
export interface NavPathMatch {
  item: NavItem;
  /**
   * Segmen pertama setelah route item — untuk Inbox ini adalah id
   * percakapan pada deep-link `/inbox/:conversationId`. Null bila URL
   * persis sama dengan route item.
   */
  segment: string | null;
}

/**
 * Turunkan item navigasi aktif dari pathname URL. Kecocokan persis
 * didahulukan; selain itu awalan `route + "/"` (route terpanjang menang)
 * menangkap sub-path seperti /inbox/:id. Path tak dikenal jatuh ke item
 * pertama (Dashboard) — perilaku shell yang sama seperti sebelum 6E,
 * agar URL sampah tidak pernah menghasilkan layar kosong.
 */
export function matchNavPath(pathname: string): NavPathMatch {
  for (const item of NAV_REGISTRY) {
    if (pathname === item.route) return { item, segment: null };
  }
  const prefixed = NAV_REGISTRY.filter((i) => i.route !== "/").sort(
    (a, b) => b.route.length - a.route.length,
  );
  for (const item of prefixed) {
    if (pathname.startsWith(`${item.route}/`)) {
      const raw = pathname.slice(item.route.length + 1).split("/")[0] ?? "";
      let segment = raw;
      try {
        segment = decodeURIComponent(raw);
      } catch {
        /* segmen tidak valid — pakai apa adanya */
      }
      return { item, segment: segment === "" ? null : segment };
    }
  }
  return { item: NAV_REGISTRY[0]!, segment: null };
}
