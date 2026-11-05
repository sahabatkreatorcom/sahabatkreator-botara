import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "../api/client";
import {
  LIVE_REFRESH_INTERVAL_MS,
  usePolling,
} from "../hooks/usePolling";
import {
  useNudgeSubscription,
  useRealtimeConnection,
} from "../hooks/useRealtime";
import { useWorkspace } from "../workspace/WorkspaceProvider";

/**
 * Total unread Inbox untuk badge navigasi (Fase 1E).
 *
 * Registry navigasi (§10.1) hanya mendeklarasikan `badge: "unreadInbox"` pada
 * item Inbox — nilai angkanya datang dari sini: jumlah `unreadCount` semua
 * percakapan workspace aktif, dimuat dari API conversations yang sama dengan
 * halaman Inbox. Provider ini TIDAK mengubah isi registry; Sidebar &
 * MobileBottomBar menerima angka lewat prop `badges` seperti sebelumnya.
 *
 * Ditaruh DI DALAM WorkspaceProvider (butuh workspace aktif) dan dipakai
 * halaman Inbox untuk menyinkronkan total setelah daftar percakapan dimuat.
 */
interface UnreadBadgeContextValue {
  totalUnread: number;
  refresh: () => Promise<void>;
  /** Tetapkan total dari daftar percakapan yang baru dimuat (hindari fetch ganda). */
  setFromConversations: (
    conversations: Array<{ unreadCount: number }>,
  ) => void;
}

const UnreadBadgeContext = createContext<UnreadBadgeContextValue | null>(null);

export function UnreadBadgeProvider({ children }: { children: ReactNode }) {
  const { active } = useWorkspace();
  const tenantId = active?.id ?? null;
  const [totalUnread, setTotalUnread] = useState(0);
  const tenantRef = useRef<string | null>(tenantId);
  tenantRef.current = tenantId;

  const refresh = useCallback(async () => {
    const tid = tenantRef.current;
    if (!tid) {
      setTotalUnread(0);
      return;
    }
    try {
      const conversations = await api.conversations.list(tid);
      // Abaikan hasil basi bila workspace sudah berganti selama fetch.
      if (tenantRef.current !== tid) return;
      setTotalUnread(
        conversations.reduce((sum, c) => sum + (c.unreadCount || 0), 0),
      );
    } catch {
      /* badge bersifat informatif — kegagalan diam, halaman Inbox menampilkan error-nya */
    }
  }, []);

  useEffect(() => {
    setTotalUnread(0);
    void refresh();
  }, [tenantId, refresh]);

  // Segar tanpa refresh manual (Hotfix Dashboard Realtime): total unread
  // dicek ulang berkala selama ada workspace aktif — badge di Sidebar &
  // MobileBottomBar sila hidup di halaman mana pun, bukan hanya Inbox.
  usePolling(refresh, LIVE_REFRESH_INTERVAL_MS, tenantId !== null);

  // Fase 6G: transport utama kini PUSH — provider ini (selalu terpasang
  // di shell) menjaga koneksi bus realtime menunjuk workspace aktif, dan
  // setiap nudge memicu refresh yang sama seperti siklus polling.
  // Polling di atas tetap berjalan sebagai fallback saat socket putus.
  useRealtimeConnection(tenantId);
  useNudgeSubscription(() => {
    void refresh();
  });

  const setFromConversations = useCallback(
    (conversations: Array<{ unreadCount: number }>) => {
      setTotalUnread(
        conversations.reduce((sum, c) => sum + (c.unreadCount || 0), 0),
      );
    },
    [],
  );

  const value = useMemo<UnreadBadgeContextValue>(
    () => ({ totalUnread, refresh, setFromConversations }),
    [totalUnread, refresh, setFromConversations],
  );

  return (
    <UnreadBadgeContext.Provider value={value}>
      {children}
    </UnreadBadgeContext.Provider>
  );
}

export function useUnreadBadge(): UnreadBadgeContextValue {
  const ctx = useContext(UnreadBadgeContext);
  if (!ctx)
    throw new Error("useUnreadBadge harus dipakai di dalam UnreadBadgeProvider");
  return ctx;
}
