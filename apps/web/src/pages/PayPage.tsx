import { useEffect, useState } from "react";
import type { PublicPaymentResponse } from "@sahabat-kreator/contracts";
import type { Locale, TranslationKey } from "@sahabat-kreator/i18n";
import { api, ApiClientError } from "../api/client";
import { formatDateTime, formatIdrId } from "../utils/format";
import { BrandLogo } from "../components/BrandLogo";

type Translate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

interface PayPageProps {
  t: Translate;
  locale: Locale;
  /** Code tautan dari path /pay/:code. */
  code: string;
}

/**
 * Halaman bayar publik — DI LUAR shell & tanpa login, seperti halaman
 * checkout sungguhan yang dibagikan penjual ke pembeli.
 *
 * Kejujuran label mengikuti provider TAUTAN (Fase 14A):
 * - 'simulation': lencana SIMULASI besar & permanen + tombol "Bayar
 *   (simulasi)" — tidak ada uang sungguhan yang bergerak.
 * - 'midtrans'/'xendit': TANPA lencana simulasi; pembeli diarahkan ke
 *   halaman checkout provider (checkoutUrl dari provider) dan status
 *   akhir datang dari webhook provider — halaman ini tidak pernah
 *   menandai lunas sendiri.
 *
 * Harga selalu diformat Intl id-ID (penetapan desain Fase 4A); teks UI
 * mengikuti locale aplikasi.
 */
export function PayPage({ t, locale, code }: PayPageProps) {
  const [payment, setPayment] = useState<PublicPaymentResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [paying, setPaying] = useState(false);
  const [payFailed, setPayFailed] = useState(false);

  const isSimulation = payment?.provider === "simulation";
  const providerName =
    payment?.provider === "midtrans"
      ? "Midtrans"
      : payment?.provider === "xendit"
        ? "Xendit"
        : "";

  // Provider sungguhan + masih pending → arahkan pembeli ke halaman
  // checkout provider. Tombol manual di bawah adalah cadangan bila
  // pengalihan otomatis terhalang.
  useEffect(() => {
    if (
      payment &&
      payment.provider !== "simulation" &&
      payment.status === "pending" &&
      payment.checkoutUrl
    ) {
      const url = payment.checkoutUrl;
      const timer = setTimeout(() => {
        window.location.replace(url);
      }, 800);
      return () => clearTimeout(timer);
    }
  }, [payment]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const view = await api.pay.getPublic(code);
        if (!cancelled) setPayment(view);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiClientError && err.status === 404) {
          setNotFound(true);
        } else {
          setLoadFailed(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  const handlePay = async () => {
    setPaying(true);
    setPayFailed(false);
    try {
      const view = await api.pay.simulatePay(code);
      setPayment(view);
    } catch {
      setPayFailed(true);
    } finally {
      setPaying(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col bg-bg px-4 py-10 text-ink">
      <div className="flex items-center gap-2">
        <BrandLogo size={28} />
        <span className="text-lg font-bold">{t("app.name")}</span>
      </div>

      {/* Lencana SIMULASI — hanya untuk provider 'simulation', besar &
          permanen, tidak bisa dilewatkan pembeli. */}
      {payment && isSimulation ? (
        <div className="mt-6 rounded-xl border-2 border-danger bg-surface p-4 text-center">
          <p className="text-base font-extrabold uppercase tracking-wide text-danger">
            {t("pay.simulationBadge")}
          </p>
          <p className="mt-1 text-xs text-muted">{t("pay.simulationNote")}</p>
        </div>
      ) : null}

      {loading ? (
        <p className="mt-8 text-sm text-muted">{t("common.loading")}</p>
      ) : notFound ? (
        <div className="mt-8 rounded-xl border border-line bg-surface p-6">
          <h1 className="text-xl font-bold">{t("pay.notFoundTitle")}</h1>
          <p className="mt-2 text-sm text-muted">{t("pay.notFoundBody")}</p>
        </div>
      ) : loadFailed || !payment ? (
        <div className="mt-8 rounded-xl border border-line bg-surface p-6">
          <h1 className="text-xl font-bold">{t("pay.loadError")}</h1>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-3 rounded-lg bg-elevated px-4 py-2 text-sm font-medium text-ink"
          >
            {t("common.retry")}
          </button>
        </div>
      ) : (
        <div className="mt-8 rounded-xl border border-line bg-surface p-6">
          <p className="text-xs uppercase tracking-wide text-muted">
            {t("pay.title")}
          </p>
          <h1 className="mt-1 text-2xl font-bold">{payment.productName}</h1>
          <p className="mt-1 text-sm text-muted">
            {t("pay.soldByLabel", { name: payment.tenantName })}
          </p>
          {payment.description ? (
            <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-ink">
              {payment.description}
            </p>
          ) : null}

          <div className="mt-5 border-t border-line pt-4">
            <p className="text-xs text-muted">{t("pay.amountLabel")}</p>
            <p className="mt-0.5 text-3xl font-extrabold">
              {formatIdrId(payment.amountIdr)}
            </p>
          </div>

          {payment.status === "paid" ? (
            <div className="mt-5 rounded-lg bg-elevated p-4">
              <p className="text-base font-bold text-accent">
                ✓ {t("pay.paidTitle")} — {t("pay.statusPaid")}
              </p>
              <p className="mt-1 text-sm text-muted">
                {isSimulation ? t("pay.paidBody") : t("pay.realPaidBody")}
              </p>
              {payment.paidAt ? (
                <p className="mt-1 text-sm text-muted">
                  {t("pay.paidAtLabel", {
                    date: formatDateTime(payment.paidAt, locale),
                  })}
                </p>
              ) : null}
            </div>
          ) : payment.status === "expired" ? (
            <div className="mt-5 rounded-lg bg-elevated p-4">
              <p className="text-base font-bold">{t("pay.expiredTitle")}</p>
              <p className="mt-1 text-sm text-muted">{t("pay.expiredBody")}</p>
            </div>
          ) : payment.status === "cancelled" ? (
            <div className="mt-5 rounded-lg bg-elevated p-4">
              <p className="text-base font-bold">{t("pay.cancelledTitle")}</p>
              <p className="mt-1 text-sm text-muted">
                {t("pay.cancelledBody")}
              </p>
            </div>
          ) : !isSimulation ? (
            <div className="mt-5">
              <p className="text-sm font-medium">
                {t("pay.statusPending")} ·{" "}
                <span className="text-muted">
                  {t("pay.expiresLabel", {
                    date: formatDateTime(payment.expiresAt, locale),
                  })}
                </span>
              </p>
              <p className="mt-2 text-sm font-semibold">
                {t("pay.redirectTitle", { provider: providerName })}
              </p>
              <p className="mt-1 text-sm text-muted">
                {t("pay.redirectBody", { provider: providerName })}
              </p>
              {payment.checkoutUrl ? (
                <a
                  href={payment.checkoutUrl}
                  className="mt-3 block w-full rounded-lg bg-accent px-4 py-3 text-center text-base font-bold text-white"
                >
                  {t("pay.continueButton", { provider: providerName })}
                </a>
              ) : null}
              <p className="mt-2 text-center text-xs text-muted">
                {t("pay.providerLabel", { provider: providerName })}
              </p>
            </div>
          ) : (
            <div className="mt-5">
              <p className="text-sm font-medium">
                {t("pay.statusPending")} ·{" "}
                <span className="text-muted">
                  {t("pay.expiresLabel", {
                    date: formatDateTime(payment.expiresAt, locale),
                  })}
                </span>
              </p>
              <button
                type="button"
                disabled={paying}
                onClick={() => void handlePay()}
                className="mt-3 w-full rounded-lg bg-accent px-4 py-3 text-base font-bold text-white disabled:opacity-60"
              >
                {paying ? t("pay.payingLabel") : t("pay.payButton")}
              </button>
              <p className="mt-2 text-center text-xs text-muted">
                {t("pay.pendingNote")}
              </p>
              {payFailed ? (
                <p className="mt-2 text-center text-sm text-danger">
                  {t("pay.loadError")}
                </p>
              ) : null}
            </div>
          )}
        </div>
      )}
    </main>
  );
}
