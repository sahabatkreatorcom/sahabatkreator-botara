import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  createTranslator,
  type Locale,
} from "@sahabat-kreator/i18n";
import {
  desktopItems,
  filterNavItems,
  matchNavPath,
  moreItems,
  type NavItem,
} from "./navigation/registry";
import { saveReturnTo } from "./navigation/returnTo";
import { AuthProvider, useAuth } from "./auth/AuthProvider";
import { WorkspaceProvider } from "./workspace/WorkspaceProvider";
import { Sidebar } from "./components/Sidebar";
import { BrandLogo } from "./components/BrandLogo";
import { MobileBottomBar } from "./components/MobileBottomBar";
import { MoreSheet } from "./components/MoreSheet";
import { ProfileBlock } from "./components/ProfileBlock";
import { WorkspaceSwitcher } from "./components/WorkspaceSwitcher";
import { DashboardPage } from "./pages/DashboardPage";
import { InboxPage } from "./pages/InboxPage";
import {
  UnreadBadgeProvider,
  useUnreadBadge,
} from "./inbox/UnreadBadgeProvider";
import {
  PendingApprovalsProvider,
  usePendingApprovals,
} from "./agents/PendingApprovalsProvider";
import { PlaceholderPage } from "./pages/PlaceholderPage";
import { LoginPage } from "./pages/LoginPage";
import { RegisterPage } from "./pages/RegisterPage";
import { InvitePage } from "./pages/InvitePage";
import { ForgotPasswordPage } from "./pages/ForgotPasswordPage";
import { ResetPasswordPage } from "./pages/ResetPasswordPage";
import { PayPage } from "./pages/PayPage";
import { WebchatDemoPage } from "./pages/WebchatDemoPage";
import { LegalPage } from "./pages/LegalPage";
import { LEGAL_PATHS, type LegalPageKind } from "./components/LegalLinks";
import { useTheme, type ThemeMode } from "./theme";

// Code-splitting per rute (Fase 13A — menutup utang bundle sejak 8B):
// halaman berat dimuat malas agar chunk utama hanya memuat shell +
// halaman kritis (login/register/dashboard/inbox/halaman publik).
// Builder flow (@xyflow/react), Analytics, Channels, Broadcasts, dan
// halaman besar lain menjadi chunk terpisah yang diunduh saat rutenya
// pertama dibuka; fallback Suspense di ShellMain memakai teks loading
// dwibahasa yang sama seperti keadaan loading shell.
const AgentsHubPage = lazy(() =>
  import("./pages/AgentsHubPage").then((m) => ({ default: m.AgentsHubPage })),
);
const ContactsPage = lazy(() =>
  import("./pages/ContactsPage").then((m) => ({ default: m.ContactsPage })),
);
const ChannelsPage = lazy(() =>
  import("./pages/ChannelsPage").then((m) => ({ default: m.ChannelsPage })),
);
const AutomationsPage = lazy(() =>
  import("./pages/AutomationsPage").then((m) => ({
    default: m.AutomationsPage,
  })),
);
const BroadcastsPage = lazy(() =>
  import("./pages/BroadcastsPage").then((m) => ({ default: m.BroadcastsPage })),
);
const PostsPage = lazy(() =>
  import("./pages/PostsPage").then((m) => ({ default: m.PostsPage })),
);
const AnalyticsPage = lazy(() =>
  import("./pages/AnalyticsPage").then((m) => ({ default: m.AnalyticsPage })),
);
const FlowsPage = lazy(() =>
  import("./pages/FlowsPage").then((m) => ({ default: m.FlowsPage })),
);
const FlowBuilderPage = lazy(() =>
  import("./pages/FlowBuilderPage").then((m) => ({
    default: m.FlowBuilderPage,
  })),
);
const ProductsPage = lazy(() =>
  import("./pages/ProductsPage").then((m) => ({ default: m.ProductsPage })),
);
const SettingsPage = lazy(() =>
  import("./pages/SettingsPage").then((m) => ({ default: m.SettingsPage })),
);
const AdminConsolePage = lazy(() =>
  import("./pages/admin/AdminConsolePage").then((m) => ({
    default: m.AdminConsolePage,
  })),
);
const LogsPage = lazy(() =>
  import("./pages/LogsPage").then((m) => ({ default: m.LogsPage })),
);
const AuditPage = lazy(() =>
  import("./pages/AuditPage").then((m) => ({ default: m.AuditPage })),
);
const GrowthPage = lazy(() =>
  import("./pages/GrowthPage").then((m) => ({ default: m.GrowthPage })),
);
const AppointmentsPage = lazy(() =>
  import("./pages/AppointmentsPage").then((m) => ({
    default: m.AppointmentsPage,
  })),
);

// Badge navigasi berasal dari API workspace aktif — query yang sama untuk
// desktop & mobile (§10.1), registry tidak diubah: unread Inbox dari API
// conversations (UnreadBadgeProvider, Fase 1E) dan pendingApprovals dari
// jumlah draf agent berstatus pending (PendingApprovalsProvider, Fase 3B —
// menggantikan angka demo Fase 0).

/**
 * Router URL asli (Fase 6E; memperluas router tangan Fase 1C tanpa
 * library baru): permukaan berdiri sendiri /login, /register,
 * /pay/:code, /webchat-demo tidak berubah; di DALAM shell, URL kini
 * menjadi sumber kebenaran navigasi — setiap item NAV_REGISTRY punya
 * path (field `route`), item aktif diturunkan dari URL lewat
 * `matchNavPath`, klik menu = history push, Back/Forward (popstate)
 * mengikuti URL, dan Inbox mendukung deep-link /inbox/:conversationId.
 * Konteks workspace SENGAJA tetap state, bukan bagian URL (non-goal 6E).
 */
function usePathRoute() {
  const [path, setPath] = useState(() =>
    typeof window === "undefined" ? "/" : window.location.pathname,
  );
  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const navigateTo = useCallback((next: string) => {
    if (window.location.pathname !== next) {
      window.history.pushState({}, "", next);
    }
    setPath(next);
  }, []);
  /** Ganti URL TANPA entri riwayat baru (pengalihan & pembersihan id basi). */
  const replaceTo = useCallback((next: string) => {
    if (window.location.pathname !== next) {
      window.history.replaceState({}, "", next);
    }
    setPath(next);
  }, []);
  return { path, navigateTo, replaceTo };
}

type Translator = ReturnType<typeof createTranslator>;

interface ShellProps {
  t: Translator;
  locale: Locale;
  controls: React.ReactNode;
  /** Path URL saat ini — sumber kebenaran halaman aktif di dalam shell. */
  path: string;
  onNavigateTo: (path: string) => void;
  onReplaceTo: (path: string) => void;
}

/** Shell dashboard TERPROTEKSI: wajib sesi; belum login → dialihkan ke /login. */
function Shell({ t, locale, controls, path, onNavigateTo, onReplaceTo }: ShellProps) {
  const { status } = useAuth();
  // Membedakan "tamu membuka deep-link" (simpan tujuan, kembalikan ke
  // sana setelah login) dari "pengguna baru saja keluar" (jangan simpan —
  // keluar adalah keputusan eksplisit, bukan tujuan kembali).
  const wasAuthenticatedRef = useRef(false);
  useEffect(() => {
    if (status === "authenticated") wasAuthenticatedRef.current = true;
  }, [status]);

  useEffect(() => {
    if (status === "anonymous") {
      if (!wasAuthenticatedRef.current && path !== "/") saveReturnTo(path);
      onReplaceTo("/login");
    }
  }, [status, path, onReplaceTo]);

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg text-ink">
        <p className="text-sm text-muted">{t("common.loading")}</p>
      </div>
    );
  }
  if (status !== "authenticated") return null;

  return (
    <WorkspaceProvider>
      <UnreadBadgeProvider>
        <PendingApprovalsProvider>
          <ShellMain
            t={t}
            locale={locale}
            controls={controls}
            path={path}
            onNavigateTo={onNavigateTo}
            onReplaceTo={onReplaceTo}
          />
        </PendingApprovalsProvider>
      </UnreadBadgeProvider>
    </WorkspaceProvider>
  );
}

/** Isi shell (sidebar + konten + bottom bar) — berjalan di dalam provider workspace & badge. */
function ShellMain({ t, locale, controls, path, onNavigateTo, onReplaceTo }: ShellProps) {
  const { user, signOut } = useAuth();
  const { totalUnread } = useUnreadBadge();
  const { pendingCount } = usePendingApprovals();
  const [moreOpen, setMoreOpen] = useState(false);

  // Pengalihan /knowledge (Fase 12E): Knowledge Base kini tab di hub
  // /agents dan entri registry-nya sudah dihapus — URL lama (bookmark,
  // tautan dari sesi sebelumnya, returnTo pasca-login) dialihkan ke
  // tab-nya dengan replace agar tidak menumpuk riwayat.
  useEffect(() => {
    if (path === "/knowledge") onReplaceTo("/agents?tab=knowledge");
  }, [path, onReplaceTo]);

  // Halaman aktif SELALU diturunkan dari URL (Fase 6E) — tidak ada state
  // halaman terpisah. `match.segment` untuk Inbox adalah id percakapan
  // deep-link; untuk item lain tidak dipakai. Query string (tab hub
  // /agents, Fase 12E) bukan bagian identitas halaman — dibuang sebelum
  // pencocokan registry.
  const match = matchNavPath(path.split("?")[0] ?? path);
  const activeItem = match.item;
  const activeId = activeItem.id;

  if (!user) return null;

  // Satu frame kosong selama pengalihan /knowledge berjalan (effect di
  // atas menukar URL pada commit yang sama).
  if (path === "/knowledge") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg text-ink">
        <p className="text-sm text-muted">{t("common.loading")}</p>
      </div>
    );
  }

  const badges = { pendingApprovals: pendingCount, unreadInbox: totalUnread };
  const moreActive = activeItem.mobile.slot === "more";
  // Item ber-permission khusus (Panel Admin, Fase 6C) hanya dirender
  // untuk user yang berhak; registry lengkap tetap dipakai matchNavPath.
  const isPlatformAdmin = user.isPlatformAdmin ?? false;
  const visibleDesktopItems = filterNavItems(desktopItems, { isPlatformAdmin });
  const visibleMoreItems = filterNavItems(moreItems, { isPlatformAdmin });

  const navigate = (item: NavItem) => {
    setMoreOpen(false);
    onNavigateTo(item.route);
  };

  /** Pilihan percakapan inbox hidup di URL: /inbox/:conversationId. */
  const handleConversationChange = (
    id: string | null,
    opts?: { replace?: boolean },
  ) => {
    const next = id ? `/inbox/${encodeURIComponent(id)}` : "/inbox";
    if (opts?.replace) onReplaceTo(next);
    else onNavigateTo(next);
  };

  /** Builder flow hidup di URL: /flows/:flowId (pola deep-link yang sama). */
  const handleFlowOpen = (flowId: string | null) => {
    onNavigateTo(flowId ? `/flows/${encodeURIComponent(flowId)}` : "/flows");
  };

  // Builder canvas (Fase 8B) butuh panggung lebih lebar dari kolom
  // baca 5xl halaman lain — hanya saat builder yang terbuka. Halaman
  // Jadwal Konten juga memakai panggung lebar yang sama: formulir dan
  // kalender berdampingan tidak muat di kolom baca 5xl. Panel Admin
  // ikut lebar: grid kartu platform 2–3 kolom tidak muat di 5xl.
  const wideMain =
    activeId === "posts" ||
    activeId === "admin" ||
    (activeId === "flows" && match.segment !== null);

  const handleSignOut = async () => {
    await signOut();
    onNavigateTo("/login");
  };

  const profile = (
    <ProfileBlock t={t} user={user} onSignOut={handleSignOut} />
  );
  const workspace = <WorkspaceSwitcher t={t} />;

  return (
    <div className="flex min-h-screen bg-bg text-ink">
      <Sidebar
        t={t}
        activeId={activeId}
        onNavigate={navigate}
        badges={badges}
        controls={controls}
        workspace={workspace}
        profile={profile}
        items={visibleDesktopItems}
      />
      <main
        className={`mx-auto w-full flex-1 px-4 pb-24 pt-6 md:px-8 md:pb-10 ${
          wideMain ? "max-w-[1440px]" : "max-w-5xl"
        }`}
      >
        <div className="mb-6 flex items-center gap-2.5 md:hidden">
          <BrandLogo size={36} />
          <div className="min-w-0">
            <div className="truncate text-base font-bold leading-tight">
              {t("app.name")}
            </div>
            <div className="truncate text-xs text-muted">{t("app.tagline")}</div>
          </div>
        </div>
        <Suspense
          fallback={<p className="text-sm text-muted">{t("common.loading")}</p>}
        >
        {activeId === "dashboard" ? (
          <DashboardPage t={t} locale={locale} />
        ) : activeId === "contacts" ? (
          <ContactsPage t={t} locale={locale} />
        ) : activeId === "inbox" ? (
          <InboxPage
            t={t}
            locale={locale}
            conversationId={match.segment}
            onConversationChange={handleConversationChange}
          />
        ) : activeId === "agents" ? (
          <AgentsHubPage t={t} locale={locale} />
        ) : activeId === "channels" ? (
          <ChannelsPage t={t} locale={locale} />
        ) : activeId === "automations" ? (
          <AutomationsPage
            t={t}
            locale={locale}
            onOpenWaTemplates={() => onNavigateTo("/broadcasts")}
          />
        ) : activeId === "broadcasts" ? (
          <BroadcastsPage t={t} locale={locale} />
        ) : activeId === "posts" ? (
          <PostsPage t={t} locale={locale} />
        ) : activeId === "flows" ? (
          match.segment ? (
            <FlowBuilderPage
              t={t}
              locale={locale}
              flowId={match.segment}
              onBack={() => handleFlowOpen(null)}
            />
          ) : (
            <FlowsPage
              t={t}
              locale={locale}
              onOpenBuilder={(flowId) => handleFlowOpen(flowId)}
            />
          )
        ) : activeId === "products" ? (
          <ProductsPage t={t} locale={locale} />
        ) : activeId === "appointments" ? (
          <AppointmentsPage t={t} locale={locale} />
        ) : activeId === "growth" ? (
          <GrowthPage t={t} locale={locale} />
        ) : activeId === "settings" ? (
          <SettingsPage t={t} locale={locale} />
        ) : activeId === "logs" ? (
          <LogsPage t={t} locale={locale} isPlatformAdmin={isPlatformAdmin} />
        ) : activeId === "audit" ? (
          <AuditPage t={t} locale={locale} isPlatformAdmin={isPlatformAdmin} />
        ) : activeId === "analytics" ? (
          <AnalyticsPage t={t} locale={locale} />
        ) : activeId === "admin" && isPlatformAdmin ? (
          <AdminConsolePage t={t} locale={locale} />
        ) : (
          <PlaceholderPage t={t} titleKey={activeItem.labelKey} />
        )}
        </Suspense>
      </main>
      <MobileBottomBar
        t={t}
        activeId={activeId}
        moreActive={moreActive}
        onNavigate={navigate}
        onMore={() => setMoreOpen(true)}
        badges={badges}
      />
      <MoreSheet
        t={t}
        open={moreOpen}
        activeId={activeId}
        onClose={() => setMoreOpen(false)}
        onNavigate={navigate}
        controls={controls}
        workspace={workspace}
        profile={profile}
        items={visibleMoreItems}
      />
    </div>
  );
}

/** Ikon mode tema aktif (gaya stroke sama seperti NavIcon): matahari = light, bulan = dark, monitor = system. */
function ThemeModeIcon({ mode }: { mode: ThemeMode }) {
  return (
    <svg
      className="h-5 w-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={true}
    >
      {mode === "light" ? (
        <>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </>
      ) : mode === "dark" ? (
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      ) : (
        <>
          <rect x="2" y="3" width="20" height="14" rx="2" />
          <path d="M8 21h8M12 17v4" />
        </>
      )}
    </svg>
  );
}

export default function App() {
  const [locale, setLocale] = useState<Locale>(() => {
    try {
      return localStorage.getItem("sk-locale") === "id" ? "id" : "en";
    } catch {
      return "en";
    }
  });
  const { mode: themeMode, cycle: cycleThemeMode } = useTheme();
  const { path, navigateTo, replaceTo } = usePathRoute();

  const t = useMemo(() => createTranslator(locale), [locale]);

  useEffect(() => {
    try {
      localStorage.setItem("sk-locale", locale);
    } catch {
      /* abaikan */
    }
    document.documentElement.lang = locale;
  }, [locale]);

  const themeLabel = (m: ThemeMode) =>
    t(m === "light" ? "common.themeLight" : m === "dark" ? "common.themeDark" : "common.themeSystem");

  // Kontrol bahasa + tema SATU baris (Fase 6H): tema cukup satu tombol
  // ikon kompak yang memutar light → dark → system → light (cycle() dari
  // useTheme — logika tema tidak berubah, hanya presentasinya). Ikon
  // mencerminkan mode aktif; nama mode aktif ada di title + aria-label.
  // Ukuran tombol disamakan dengan tombol bahasa (28px) agar sejajar.
  // Fase 7A (permintaan user): label teks terlihat "Language"/"Theme"
  // DIHAPUS — pengguna sudah paham kedua kontrol ini; yang tersisa hanya
  // tombol EN/ID + tombol ikon tema (aria-label/title tak terlihat tetap
  // dipertahankan demi aksesibilitas).
  const controls = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="flex items-center gap-2">
        <div className="flex gap-1">
          {(["en", "id"] as Locale[]).map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setLocale(l)}
              className={`rounded-md px-3 py-1 text-sm ${
                locale === l
                  ? "bg-accent font-semibold text-white"
                  : "bg-elevated text-ink"
              }`}
            >
              {l.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={cycleThemeMode}
          title={themeLabel(themeMode)}
          aria-label={themeLabel(themeMode)}
          className="rounded-md bg-elevated p-1 text-ink"
        >
          <ThemeModeIcon mode={themeMode} />
        </button>
      </div>
    </div>
  );

  // Halaman legal publik (Fase 7D.1): /privacy, /terms, /data-deletion —
  // di luar shell & tanpa sesi; URL-nya didaftarkan ke pengaturan
  // aplikasi Meta (privasi + instruksi penghapusan data).
  const legalKind = (Object.keys(LEGAL_PATHS) as LegalPageKind[]).find(
    (kind) => LEGAL_PATHS[kind] === path,
  );
  if (legalKind) {
    return (
      <LegalPage
        t={t}
        kind={legalKind}
        controls={controls}
        onNavigate={navigateTo}
      />
    );
  }

  // Halaman demo webchat publik (Fase 1F): di luar shell & tanpa sesi —
  // harus bisa dibuka siapa pun seperti situs tenant yang memasang widget.
  if (path === "/webchat-demo") {
    return <WebchatDemoPage t={t} locale={locale} />;
  }

  // Halaman bayar publik (Fase 4A): di luar shell & tanpa sesi — tautan
  // /pay/:code dibagikan penjual ke pembeli. SIMULASI berlabel besar.
  if (path.startsWith("/pay/")) {
    const code = decodeURIComponent(path.slice("/pay/".length)).split("/")[0];
    if (code) {
      return <PayPage t={t} locale={locale} code={code} />;
    }
  }

  return (
    <AuthProvider>
      {path === "/login" ? (
        <LoginPage t={t} locale={locale} controls={controls} onNavigate={navigateTo} />
      ) : path === "/register" ? (
        <RegisterPage t={t} locale={locale} controls={controls} onNavigate={navigateTo} />
      ) : path === "/forgot-password" ? (
        <ForgotPasswordPage t={t} locale={locale} controls={controls} onNavigate={navigateTo} />
      ) : path === "/reset-password" ? (
        <ResetPasswordPage t={t} locale={locale} controls={controls} onNavigate={navigateTo} />
      ) : path.startsWith("/invite/") ? (
        <InvitePage
          t={t}
          locale={locale}
          controls={controls}
          token={decodeURIComponent(path.slice("/invite/".length)).split("/")[0]}
          onNavigate={navigateTo}
        />
      ) : (
        <Shell
          t={t}
          locale={locale}
          controls={controls}
          path={path}
          onNavigateTo={navigateTo}
          onReplaceTo={replaceTo}
        />
      )}
    </AuthProvider>
  );
}
