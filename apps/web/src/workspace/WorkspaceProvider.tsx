import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { TenantResponse } from "@sahabat-kreator/contracts";
import { api } from "../api/client";

const STORAGE_KEY = "sk-active-tenant-id";

/**
 * State workspace (tenant) untuk shell (Fase 1C).
 * - Di-mount hanya saat user terautentikasi.
 * - Pilihan workspace aktif terakhir disimpan di localStorage; bila id
 *   tersimpan tidak ada lagi di daftar (mis. akun berbeda), jatuh ke
 *   workspace pertama.
 */
interface WorkspaceContextValue {
  status: "loading" | "ready" | "error";
  tenants: TenantResponse[];
  active: TenantResponse | null;
  select: (id: string) => void;
  create: (name: string) => Promise<TenantResponse>;
  reload: () => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

function savedTenantId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [tenants, setTenants] = useState<TenantResponse[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  const applyList = useCallback((list: TenantResponse[]) => {
    setTenants(list);
    setActiveId((prev) => {
      const candidate = prev ?? savedTenantId();
      const chosen =
        candidate && list.some((t) => t.id === candidate)
          ? candidate
          : (list[0]?.id ?? null);
      try {
        if (chosen) localStorage.setItem(STORAGE_KEY, chosen);
        else localStorage.removeItem(STORAGE_KEY);
      } catch {
        /* abaikan */
      }
      return chosen;
    });
  }, []);

  const reload = useCallback(async () => {
    setStatus("loading");
    try {
      const list = await api.tenants.list();
      applyList(list);
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, [applyList]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const select = useCallback((id: string) => {
    setActiveId(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* abaikan */
    }
  }, []);

  const create = useCallback(
    async (name: string) => {
      const tenant = await api.tenants.create(name);
      setTenants((prev) => {
        const next = [...prev, tenant];
        return next;
      });
      select(tenant.id);
      setStatus("ready");
      return tenant;
    },
    [select],
  );

  const active = useMemo(
    () => tenants.find((t) => t.id === activeId) ?? null,
    [tenants, activeId],
  );

  const value = useMemo<WorkspaceContextValue>(
    () => ({ status, tenants, active, select, create, reload }),
    [status, tenants, active, select, create, reload],
  );

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace harus dipakai di dalam WorkspaceProvider");
  return ctx;
}
