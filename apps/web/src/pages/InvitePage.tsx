import { useEffect, useState, type ReactNode } from "react";
import type { InvitationPreviewResponse } from "@sahabat-kreator/contracts";
import type { Locale, TranslationKey } from "@sahabat-kreator/i18n";
import { api } from "../api/client";
import { translateApiError } from "../api/errorText";
import { useAuth } from "../auth/AuthProvider";
import { saveReturnTo } from "../navigation/returnTo";
import {
  AuthLayout,
  FieldError,
  primaryButtonClassName,
} from "../components/AuthLayout";

type Translate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

interface InvitePageProps {
  t: Translate;
  locale: Locale;
  controls: ReactNode;
  token: string;
  onNavigate: (path: string) => void;
}

function roleKey(role: InvitationPreviewResponse["role"]): TranslationKey {
  switch (role) {
    case "admin":
      return "settings.team.roleAdmin";
    case "agent":
      return "settings.team.roleAgent";
    case "viewer":
      return "settings.team.roleViewer";
  }
}

/**
 * Halaman terima undangan /invite/:token (Fase 9C) — di luar shell,
 * di dalam AuthProvider:
 * - Belum login: jelaskan undangan bersifat personal per email dan
 *   arahkan ke Masuk / Buat akun; path undangan disimpan sebagai
 *   tujuan-kembali (pola 6E) agar sesudah login pengguna mendarat di
 *   sini lagi, bukan di Dashboard.
 * - Sudah login: pratinjau dari server (workspace, peran, status,
 *   kecocokan email). Email tidak cocok → penjelasan, tanpa tombol
 *   terima (server pun menolak). Status terminal (diterima/dicabut/
 *   kedaluwarsa) ditampilkan apa adanya.
 * - Terima: POST accept → muat ulang daftar workspace → tombol masuk
 *   ke workspace barunya.
 */
export function InvitePage({ t, controls, token, onNavigate }: InvitePageProps) {
  const { status, user } = useAuth();
  const [preview, setPreview] = useState<InvitationPreviewResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    if (status === "anonymous") {
      saveReturnTo(`/invite/${token}`);
    }
  }, [status, token]);

  useEffect(() => {
    if (status !== "authenticated") return;
    let cancelled = false;
    api.invitations
      .preview(token)
      .then((row) => {
        if (!cancelled) setPreview(row);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(translateApiError(t, err));
      });
    return () => {
      cancelled = true;
    };
  }, [status, token, t]);

  const handleAccept = async () => {
    setAccepting(true);
    setAcceptError(null);
    try {
      await api.invitations.accept(token);
      // Masuk shell sesudah ini memuat ulang daftar workspace dari
      // server (WorkspaceProvider me-mount segar), jadi workspace baru
      // langsung muncul tanpa sinkronisasi manual di sini.
      setAccepted(true);
    } catch (err) {
      setAcceptError(translateApiError(t, err));
    } finally {
      setAccepting(false);
    }
  };

  return (
    <AuthLayout
      t={t}
      title={t("invite.title")}
      subtitle={t("invite.subtitle")}
      controls={controls}
    >
      {status === "loading" ? (
        <p className="text-sm text-muted">{t("invite.loading")}</p>
      ) : status === "anonymous" ? (
        <div className="space-y-4">
          <p className="text-sm text-muted">{t("invite.signInPrompt")}</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onNavigate("/login")}
              className={primaryButtonClassName}
            >
              {t("invite.signInButton")}
            </button>
            <button
              type="button"
              onClick={() => onNavigate("/register")}
              className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium text-ink"
            >
              {t("invite.registerButton")}
            </button>
          </div>
        </div>
      ) : loadError ? (
        <p className="text-sm text-danger">{t("invite.loadError")}</p>
      ) : !preview ? (
        <p className="text-sm text-muted">{t("invite.loading")}</p>
      ) : accepted ? (
        <div className="space-y-4">
          <h2 className="text-base font-semibold text-ink">
            {t("invite.acceptedTitle")}
          </h2>
          <p className="text-sm text-muted">
            {t("invite.acceptedBody", { workspace: preview.tenantName })}
          </p>
          <button
            type="button"
            onClick={() => onNavigate("/")}
            className={primaryButtonClassName}
          >
            {t("invite.openWorkspaceButton")}
          </button>
        </div>
      ) : preview.status !== "pending" ? (
        <p className="text-sm text-muted">
          {t(
            preview.status === "accepted"
              ? "invite.statusAccepted"
              : preview.status === "revoked"
                ? "invite.statusRevoked"
                : "invite.statusExpired",
          )}
        </p>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-ink">
            {t("invite.invitedTo", {
              workspace: preview.tenantName,
              role: t(roleKey(preview.role)),
            })}
          </p>
          <p className="text-sm text-muted">
            {t("invite.invitedEmail", { email: preview.email })}
          </p>
          {preview.emailMatches ? (
            <>
              <FieldError message={acceptError} />
              <button
                type="button"
                onClick={handleAccept}
                disabled={accepting}
                className={primaryButtonClassName}
              >
                {accepting ? t("invite.accepting") : t("invite.acceptButton")}
              </button>
            </>
          ) : (
            <p className="rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">
              {t("invite.emailMismatch")}
              {user?.email ? ` (${user.email})` : ""}
            </p>
          )}
        </div>
      )}
    </AuthLayout>
  );
}
