import { useEffect } from "react";
import { api } from "../api/client";
import { useWorkspace } from "../workspace/WorkspaceProvider";

/**
 * Detak kehadiran tim (G13 butir 9): selama ada workspace aktif,
 * sesi ini mengirim heartbeat ±60 detik sekali ke server, yang
 * menjinakkan tulisnya (maks ±45 detik sekali per pengguna) ke
 * users.last_seen_at. Permukaan tim membaca stempel itu sebagai
 * penanda online (≤120 detik) / terakhir aktif. Kegagalan ditelan:
 * kehadiran adalah sinyal sosial, bukan fungsi kritis — tidak ada
 * UI error untuknya.
 */
export function PresenceHeartbeat() {
  const { active } = useWorkspace();
  const tenantId = active?.id ?? null;

  useEffect(() => {
    if (!tenantId) return;
    const ping = () => {
      void api.team.heartbeat(tenantId).catch(() => undefined);
    };
    ping();
    const id = window.setInterval(ping, 60_000);
    return () => window.clearInterval(id);
  }, [tenantId]);

  return null;
}
