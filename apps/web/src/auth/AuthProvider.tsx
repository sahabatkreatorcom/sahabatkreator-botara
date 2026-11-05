import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api, UNAUTHORIZED_EVENT, type SessionUser } from "../api/client";

/**
 * State sesi untuk seluruh aplikasi (Fase 1C).
 * - "loading": get-session pertama belum selesai → tampilkan layar muat,
 *   JANGAN render shell (menghindari kedip halaman login/dashboard).
 * - "anonymous": tidak ada sesi valid → shell mengalihkan ke /login.
 * - "authenticated": `user` tersedia untuk area profil.
 */
export type AuthStatus = "loading" | "anonymous" | "authenticated";

interface AuthContextValue {
  status: AuthStatus;
  user: SessionUser | null;
  /** Ambil ulang sesi dari server (dipakai setelah sign-in/sign-up berhasil). */
  refresh: () => Promise<SessionUser | null>;
  /** Panggil sign-out di server lalu bersihkan state lokal. */
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<SessionUser | null>(null);

  const refresh = useCallback(async (): Promise<SessionUser | null> => {
    try {
      const sessionUser = await api.auth.getSessionUser();
      setUser(sessionUser);
      setStatus(sessionUser ? "authenticated" : "anonymous");
      return sessionUser;
    } catch {
      // Server tidak terjangkau / sesi tidak terbaca → perlakukan sebagai
      // belum login; halaman login akan menampilkan error jaringan saat submit.
      setUser(null);
      setStatus("anonymous");
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Sesi kedaluwarsa/dicabut di tengah pemakaian: klien memancarkan event
  // pada balasan 401 pertama (lihat api/client.ts). Segarkan sesi sekali —
  // bila benar sudah tidak valid, status menjadi anonymous dan shell
  // mengalihkan ke /login, alih-alih setiap halaman menampilkan error.
  useEffect(() => {
    const onUnauthorized = () => {
      void refresh();
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [refresh]);

  const signOut = useCallback(async () => {
    try {
      await api.auth.signOut();
    } catch {
      /* sesi di server mungkin sudah berakhir; state lokal tetap dibersihkan */
    }
    try {
      localStorage.removeItem("sk-active-tenant-id");
    } catch {
      /* abaikan */
    }
    setUser(null);
    setStatus("anonymous");
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, refresh, signOut }),
    [status, user, refresh, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth harus dipakai di dalam AuthProvider");
  return ctx;
}
