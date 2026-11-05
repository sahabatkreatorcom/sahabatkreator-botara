import { useEffect, useRef } from "react";
import { setRealtimeTenantId, subscribeNudge } from "../realtime/bus";

/**
 * Hook realtime dashboard (Fase 6G) — pasangan hooks/usePolling.
 *
 * `useRealtimeConnection(tenantId)` menjaga koneksi bus menunjuk tenant
 * aktif (dipanggil SATU kali oleh provider yang selalu terpasang di
 * shell). `useNudgeSubscription(callback)` menjalankan callback senyap
 * setiap nudge tenant aktif tiba — callback selalu versi terbaru lewat
 * ref, langganan dibersihkan saat unmount.
 *
 * Polling (usePolling) TETAP aktif di semua konsumen: ia kini fallback
 * otomatis untuk saat socket terputus / apps/realtime mati.
 */
export function useRealtimeConnection(tenantId: string | null): void {
  useEffect(() => {
    setRealtimeTenantId(tenantId);
  }, [tenantId]);
}

export function useNudgeSubscription(callback: () => void): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  useEffect(() => {
    return subscribeNudge(() => {
      callbackRef.current();
    });
  }, []);
}
