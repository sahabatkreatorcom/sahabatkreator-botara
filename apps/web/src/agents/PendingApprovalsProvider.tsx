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
import { useNudgeSubscription } from "../hooks/useRealtime";
import { useWorkspace } from "../workspace/WorkspaceProvider";

/**
 * Jumlah draf balasan agent yang menunggu persetujuan, untuk badge navigasi
 * (Fase 3B — menggantikan angka demo Fase 0).
 *
 * Registry navigasi (§10.1) hanya mendeklarasikan `badge: "pendingApprovals"`
 * pada item AI Agents — nilai aslinya datang dari sini: jumlah baris
 * GET /suggestions?status=pending workspace aktif (API yang sama dengan
 * antrean draf di halaman Agents). Provider ini TIDAK mengubah isi registry;
 * Sidebar & MobileBottomBar menerima angka lewat prop `badges` seperti
 * sebelumnya, dan angka 0 tidak dirender sebagai badge oleh keduanya.
 *
 * Pola sama dengan UnreadBadgeProvider (Fase 1E): ditaruh DI DALAM
 * WorkspaceProvider, dan halaman Agents memanggil refresh() setelah
 * approve/reject agar badge & antrean selalu sinkron.
 */
interface PendingApprovalsContextValue {
  pendingCount: number;
  refresh: () => Promise<void>;
}

const PendingApprovalsContext =
  createContext<PendingApprovalsContextValue | null>(null);

export function PendingApprovalsProvider({ children }: { children: ReactNode }) {
  const { active } = useWorkspace();
  const tenantId = active?.id ?? null;
  const [pendingCount, setPendingCount] = useState(0);
  const tenantRef = useRef<string | null>(tenantId);
  tenantRef.current = tenantId;

  const refresh = useCallback(async () => {
    const tid = tenantRef.current;
    if (!tid) {
      setPendingCount(0);
      return;
    }
    try {
      const suggestions = await api.suggestions.list(tid, {
        status: "pending",
      });
      // Abaikan hasil basi bila workspace sudah berganti selama fetch.
      if (tenantRef.current !== tid) return;
      setPendingCount(suggestions.length);
    } catch {
      /* badge bersifat informatif — kegagalan diam, halaman Agents menampilkan error-nya */
    }
  }, []);

  useEffect(() => {
    setPendingCount(0);
    void refresh();
  }, [tenantId, refresh]);

  // Segar tanpa refresh manual (Hotfix Dashboard Realtime): draf agent
  // yang tiba saat pemilik sedang di halaman lain tetap menaikkan badge
  // dalam hitungan detik. Pola sama dengan UnreadBadgeProvider.
  usePolling(refresh, LIVE_REFRESH_INTERVAL_MS, tenantId !== null);

  // Fase 6G: nudge `agent.suggestion` dari worker (dan nudge lain tenant
  // ini) memicu refresh yang sama — badge naik seketika, polling menjadi
  // fallback saat socket putus.
  useNudgeSubscription(() => {
    void refresh();
  });

  const value = useMemo<PendingApprovalsContextValue>(
    () => ({ pendingCount, refresh }),
    [pendingCount, refresh],
  );

  return (
    <PendingApprovalsContext.Provider value={value}>
      {children}
    </PendingApprovalsContext.Provider>
  );
}

export function usePendingApprovals(): PendingApprovalsContextValue {
  const ctx = useContext(PendingApprovalsContext);
  if (!ctx)
    throw new Error(
      "usePendingApprovals harus dipakai di dalam PendingApprovalsProvider",
    );
  return ctx;
}
