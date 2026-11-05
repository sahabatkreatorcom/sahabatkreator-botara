import { useCallback, useEffect, useState } from "react";

export type ThemeMode = "light" | "dark" | "system";
const STORAGE_KEY = "sk-theme";

function initialMode(): ThemeMode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "light" || saved === "dark" || saved === "system") return saved;
  } catch {
    /* abaikan */
  }
  return "system";
}

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/**
 * Tema light/dark/system (RANCANGAN §10.3). Default: system.
 * Class 'dark' diterapkan di <html>; warna berasal dari token CSS variables.
 */
export function useTheme() {
  const [mode, setModeState] = useState<ThemeMode>(initialMode);
  const [resolved, setResolved] = useState<"light" | "dark">(() =>
    typeof window === "undefined"
      ? "light"
      : initialMode() === "dark" || (initialMode() === "system" && systemPrefersDark())
        ? "dark"
        : "light",
  );

  const apply = useCallback((m: ThemeMode) => {
    const dark = m === "dark" || (m === "system" && systemPrefersDark());
    document.documentElement.classList.toggle("dark", dark);
    setResolved(dark ? "dark" : "light");
  }, []);

  useEffect(() => {
    apply(mode);
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* abaikan */
    }
    if (mode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => apply("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [mode, apply]);

  const setMode = useCallback((m: ThemeMode) => setModeState(m), []);
  const cycle = useCallback(() => {
    setModeState((m) => (m === "light" ? "dark" : m === "dark" ? "system" : "light"));
  }, []);

  return { mode, setMode, cycle, resolved };
}
