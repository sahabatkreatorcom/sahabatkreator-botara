import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type {
  AppointmentAvailabilityWindow,
  AppointmentServiceResponse,
  AppointmentSettingsResponse,
  AppointmentSlot,
  BookingResponse,
  ContactResponse,
  GoogleCalendarConnectionResponse,
  GoogleCalendarOption,
} from "@sahabat-kreator/contracts";
import type { Locale, TranslationKey } from "@sahabat-kreator/i18n";
import { api } from "../api/client";
import { translateApiError } from "../api/errorText";
import { FieldError, inputClassName } from "../components/AuthLayout";
import { useWorkspace } from "../workspace/WorkspaceProvider";

type Translate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

interface AppointmentsPageProps {
  t: Translate;
  locale: Locale;
}

const WEEKDAY_KEYS: TranslationKey[] = [
  "appointments.weekday0",
  "appointments.weekday1",
  "appointments.weekday2",
  "appointments.weekday3",
  "appointments.weekday4",
  "appointments.weekday5",
  "appointments.weekday6",
];

interface DayDraft {
  open: boolean;
  startTime: string;
  endTime: string;
}

/** Format satu instan di zona waktu janji tenant (Intl, dwibahasa). */
function formatInTz(
  iso: string,
  locale: Locale,
  timeZone: string,
  withDate: boolean,
): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(locale === "id" ? "id-ID" : "en-GB", {
    timeZone,
    ...(withDate
      ? { weekday: "short", day: "numeric", month: "short" }
      : {}),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

/**
 * Halaman Janji Temu (Fase 13G): layanan yang bisa dibooking, editor
 * ketersediaan mingguan + zona waktu, koneksi Google Calendar tenant
 * (status / hubungkan / putuskan / pilih kalender), daftar booking
 * dengan aksi batal, dan booking manual dari pratinjau slot. Kalender
 * internal bekerja PENUH tanpa Google; Google hanya sinkronisasi.
 * Callback OAuth mendarat di sini dengan ?google=connected|error.
 */
export function AppointmentsPage({ t, locale }: AppointmentsPageProps) {
  const { status, active } = useWorkspace();
  const tenantId = active?.id ?? null;
  const canManage = active?.role === "owner" || active?.role === "admin";

  const [settings, setSettings] =
    useState<AppointmentSettingsResponse | null>(null);
  const [services, setServices] = useState<AppointmentServiceResponse[]>([]);
  const [bookings, setBookings] = useState<BookingResponse[]>([]);
  const [contacts, setContacts] = useState<ContactResponse[]>([]);
  const [google, setGoogle] =
    useState<GoogleCalendarConnectionResponse | null>(null);
  const [googleNotConfigured, setGoogleNotConfigured] = useState(false);
  const [calendars, setCalendars] = useState<GoogleCalendarOption[] | null>(
    null,
  );
  const [days, setDays] = useState<DayDraft[]>(
    Array.from({ length: 7 }, () => ({
      open: false,
      startTime: "09:00",
      endTime: "17:00",
    })),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requestSeq = useRef(0);

  // Form pengaturan
  const [tzDraft, setTzDraft] = useState("");
  const [leadDraft, setLeadDraft] = useState(120);
  // Form layanan
  const [serviceFormOpen, setServiceFormOpen] = useState(false);
  const [editService, setEditService] =
    useState<AppointmentServiceResponse | null>(null);
  const [svcName, setSvcName] = useState("");
  const [svcDuration, setSvcDuration] = useState(60);
  const [svcDescription, setSvcDescription] = useState("");
  const [svcActive, setSvcActive] = useState(true);
  const [serviceError, setServiceError] = useState<string | null>(null);
  // Booking manual
  const [manualContactId, setManualContactId] = useState("");
  const [manualServiceId, setManualServiceId] = useState("");
  const [manualSlots, setManualSlots] = useState<AppointmentSlot[] | null>(
    null,
  );
  const [manualSlot, setManualSlot] = useState<AppointmentSlot | null>(null);
  const [manualError, setManualError] = useState<string | null>(null);
  const [manualBusy, setManualBusy] = useState(false);

  const load = useCallback(async () => {
    if (!tenantId) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const from = new Date();
      const to = new Date(Date.now() + 30 * 24 * 3600 * 1000);
      const [s, svc, av, bk, gg, ct] = await Promise.all([
        api.appointments.getSettings(tenantId),
        api.appointments.listServices(tenantId),
        api.appointments.getAvailability(tenantId),
        api.appointments.listBookings(tenantId, {
          from: from.toISOString(),
          to: to.toISOString(),
        }),
        api.appointments.googleStatus(tenantId).catch(() => null),
        api.contacts
          .list(tenantId, { limit: 200 })
          .catch(() => null),
      ]);
      if (requestSeq.current !== seq) return;
      setSettings(s);
      setTzDraft(s.timezone);
      setLeadDraft(s.minLeadMinutes);
      setServices(svc);
      setBookings(bk);
      setGoogle(gg);
      setContacts(ct?.contacts ?? []);
      const nextDays: DayDraft[] = Array.from({ length: 7 }, () => ({
        open: false,
        startTime: "09:00",
        endTime: "17:00",
      }));
      for (const w of av.windows) {
        nextDays[w.weekday] = {
          open: true,
          startTime: w.startTime,
          endTime: w.endTime,
        };
      }
      setDays(nextDays);
    } catch (err) {
      if (requestSeq.current !== seq) return;
      setError(translateApiError(t, err));
    } finally {
      if (requestSeq.current === seq) setLoading(false);
    }
  }, [tenantId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Hasil callback OAuth Google (?google=connected|error&reason=...).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const g = params.get("google");
    if (!g) return;
    if (g === "connected") {
      setNotice(t("appointments.googleConnectedToast"));
    } else {
      setNotice(
        t("appointments.googleErrorToast", {
          reason: params.get("reason") ?? "unknown",
        }),
      );
    }
    params.delete("google");
    params.delete("reason");
    const qs = params.toString();
    window.history.replaceState(
      null,
      "",
      window.location.pathname + (qs ? `?${qs}` : ""),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tz = settings?.timezone ?? "Asia/Jakarta";

  const handleSaveSettings = async (e: FormEvent) => {
    e.preventDefault();
    if (!tenantId) return;
    setError(null);
    try {
      const next = await api.appointments.updateSettings(tenantId, {
        timezone: tzDraft.trim(),
        minLeadMinutes: Math.max(0, Math.floor(leadDraft || 0)),
      });
      setSettings(next);
      setNotice(t("appointments.savedToast"));
      void load();
    } catch (err) {
      setError(translateApiError(t, err));
    }
  };

  const handleSaveAvailability = async () => {
    if (!tenantId) return;
    setError(null);
    const windows: AppointmentAvailabilityWindow[] = [];
    days.forEach((d, weekday) => {
      if (d.open) {
        windows.push({
          weekday,
          startTime: d.startTime,
          endTime: d.endTime,
        });
      }
    });
    try {
      await api.appointments.replaceAvailability(tenantId, { windows });
      setNotice(t("appointments.savedToast"));
      void load();
    } catch (err) {
      setError(translateApiError(t, err));
    }
  };

  const openServiceForm = (svc: AppointmentServiceResponse | null) => {
    setEditService(svc);
    setSvcName(svc?.name ?? "");
    setSvcDuration(svc?.durationMinutes ?? 60);
    setSvcDescription(svc?.description ?? "");
    setSvcActive(svc?.isActive ?? true);
    setServiceError(null);
    setServiceFormOpen(true);
  };

  const handleSaveService = async (e: FormEvent) => {
    e.preventDefault();
    if (!tenantId) return;
    setServiceError(null);
    const body = {
      name: svcName.trim(),
      durationMinutes: Math.max(5, Math.floor(svcDuration || 5)),
      description: svcDescription.trim() ? svcDescription.trim() : null,
      isActive: svcActive,
    };
    try {
      if (editService) {
        await api.appointments.updateService(tenantId, editService.id, body);
      } else {
        await api.appointments.createService(tenantId, body);
      }
      setServiceFormOpen(false);
      void load();
    } catch (err) {
      setServiceError(translateApiError(t, err));
    }
  };

  const handleDeleteService = async (svc: AppointmentServiceResponse) => {
    if (!tenantId) return;
    try {
      await api.appointments.deleteService(tenantId, svc.id);
      void load();
    } catch (err) {
      setError(translateApiError(t, err));
    }
  };

  const handleGoogleConnect = async () => {
    if (!tenantId) return;
    setError(null);
    try {
      const { url } = await api.appointments.googleConnect(tenantId);
      window.location.href = url;
    } catch (err) {
      const apiErr = err as { code?: string };
      if (apiErr?.code === "GOOGLE_NOT_CONFIGURED") {
        setGoogleNotConfigured(true);
      }
      setError(translateApiError(t, err));
    }
  };

  const handleGoogleDisconnect = async () => {
    if (!tenantId) return;
    try {
      await api.appointments.googleDisconnect(tenantId);
      setCalendars(null);
      void load();
    } catch (err) {
      setError(translateApiError(t, err));
    }
  };

  const handleLoadCalendars = async () => {
    if (!tenantId) return;
    try {
      const body = await api.appointments.googleCalendars(tenantId);
      setCalendars(body.calendars);
    } catch (err) {
      setError(translateApiError(t, err));
    }
  };

  const handlePickCalendar = async (calendarId: string) => {
    if (!tenantId) return;
    try {
      const next = await api.appointments.googleSetCalendar(tenantId, {
        calendarId,
      });
      setGoogle(next);
    } catch (err) {
      setError(translateApiError(t, err));
    }
  };

  const handleCancelBooking = async (b: BookingResponse) => {
    if (!tenantId) return;
    if (!window.confirm(t("appointments.bookingCancelConfirm"))) return;
    try {
      await api.appointments.cancelBooking(tenantId, b.id);
      void load();
    } catch (err) {
      setError(translateApiError(t, err));
    }
  };

  const handleLoadManualSlots = async () => {
    if (!tenantId) return;
    setManualError(null);
    setManualSlot(null);
    if (!manualContactId || !manualServiceId) {
      setManualError(t("appointments.manualPickFirst"));
      return;
    }
    setManualBusy(true);
    try {
      const from = new Date();
      const to = new Date(Date.now() + 14 * 24 * 3600 * 1000);
      const body = await api.appointments.listSlots(
        tenantId,
        manualServiceId,
        from.toISOString(),
        to.toISOString(),
      );
      setManualSlots(body.slots);
    } catch (err) {
      setManualError(translateApiError(t, err));
    } finally {
      setManualBusy(false);
    }
  };

  const handleManualBook = async () => {
    if (!tenantId || !manualSlot) return;
    setManualError(null);
    setManualBusy(true);
    try {
      await api.appointments.createBooking(tenantId, {
        serviceId: manualServiceId,
        contactId: manualContactId,
        startsAt: manualSlot.startsAt,
      });
      setManualSlots(null);
      setManualSlot(null);
      void load();
    } catch (err) {
      const apiErr = err as { code?: string };
      setManualError(
        apiErr?.code === "SLOT_TAKEN"
          ? t("appointments.slotTakenError")
          : translateApiError(t, err),
      );
    } finally {
      setManualBusy(false);
    }
  };

  if (status === "loading" || (loading && !settings)) {
    return (
      <section>
        <h1 className="text-2xl font-bold text-ink">
          {t("appointments.title")}
        </h1>
        <p className="mt-6 text-sm text-muted">{t("common.loading")}</p>
      </section>
    );
  }

  if (!active) {
    return (
      <section>
        <h1 className="text-2xl font-bold text-ink">
          {t("appointments.title")}
        </h1>
        <p className="mt-2 text-sm text-muted">
          {t("appointments.subtitle")}
        </p>
      </section>
    );
  }

  const googleChip = (b: BookingResponse) =>
    b.googleSyncStatus === "synced"
      ? t("appointments.bookingGoogleSynced")
      : b.googleSyncStatus === "pending"
        ? t("appointments.bookingGooglePending")
        : b.googleSyncStatus === "failed"
          ? t("appointments.bookingGoogleFailed")
          : t("appointments.bookingGoogleNone");

  return (
    <section>
      <h1 className="text-2xl font-bold text-ink">{t("appointments.title")}</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        {t("appointments.subtitle")}
      </p>

      {notice ? (
        <p className="mt-3 rounded-lg bg-elevated px-3 py-2 text-sm text-ink">
          {notice}
        </p>
      ) : null}
      <FieldError message={error} />

      {/* Google Calendar */}
      <h2 className="mt-8 text-lg font-bold text-ink">
        {t("appointments.googleTitle")}
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        {t("appointments.googleBody")}
      </p>
      <div className="mt-3 max-w-2xl rounded-2xl border border-line bg-surface p-4">
        {googleNotConfigured ? (
          <p className="text-sm text-muted">
            {t("appointments.googleNotConfigured")}
          </p>
        ) : google?.connected ? (
          <div className="space-y-3">
            <p className="text-sm text-ink">
              {t("appointments.googleConnectedAs", {
                email: google.accountEmail ?? "",
              })}
            </p>
            <div>
              <label
                className="text-xs font-medium text-muted"
                htmlFor="appt-google-calendar"
              >
                {t("appointments.googleCalendarLabel")}
              </label>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <select
                  id="appt-google-calendar"
                  className={inputClassName}
                  value={google.calendarId ?? "primary"}
                  disabled={!canManage || calendars === null}
                  onChange={(e) => void handlePickCalendar(e.target.value)}
                >
                  {calendars === null ? (
                    <option value={google.calendarId ?? "primary"}>
                      {google.calendarId ?? "primary"}
                    </option>
                  ) : (
                    calendars.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.summary}
                        {c.primary ? " ★" : ""}
                      </option>
                    ))
                  )}
                </select>
                {calendars === null ? (
                  <button
                    type="button"
                    className="rounded-lg border border-line px-3 py-2 text-sm text-ink"
                    onClick={() => void handleLoadCalendars()}
                  >
                    {t("common.reload")}
                  </button>
                ) : null}
              </div>
            </div>
            {canManage ? (
              <button
                type="button"
                className="rounded-lg border border-line px-3 py-2 text-sm text-danger"
                onClick={() => void handleGoogleDisconnect()}
              >
                {t("appointments.googleDisconnectButton")}
              </button>
            ) : null}
          </div>
        ) : (
          <button
            type="button"
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            disabled={!canManage}
            onClick={() => void handleGoogleConnect()}
          >
            {t("appointments.googleConnectButton")}
          </button>
        )}
      </div>

      {/* Pengaturan booking */}
      <h2 className="mt-8 text-lg font-bold text-ink">
        {t("appointments.settingsTitle")}
      </h2>
      <form
        className="mt-3 grid max-w-2xl grid-cols-1 gap-3 sm:grid-cols-2"
        onSubmit={(e) => void handleSaveSettings(e)}
      >
        <div>
          <label
            className="text-xs font-medium text-muted"
            htmlFor="appt-timezone"
          >
            {t("appointments.timezoneLabel")}
          </label>
          <input
            id="appt-timezone"
            className={inputClassName}
            value={tzDraft}
            disabled={!canManage}
            onChange={(e) => setTzDraft(e.target.value)}
            placeholder="Asia/Jakarta"
          />
          <p className="mt-1 text-xs text-muted">
            {t("appointments.timezoneHint")}
          </p>
        </div>
        <div>
          <label className="text-xs font-medium text-muted" htmlFor="appt-lead">
            {t("appointments.minLeadLabel")}
          </label>
          <input
            id="appt-lead"
            type="number"
            min={0}
            step={1}
            className={inputClassName}
            value={leadDraft}
            disabled={!canManage}
            onChange={(e) => setLeadDraft(Number(e.target.value) || 0)}
          />
          <p className="mt-1 text-xs text-muted">
            {t("appointments.minLeadHint")}
          </p>
        </div>
        {canManage ? (
          <div>
            <button
              type="submit"
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white"
            >
              {t("common.save")}
            </button>
          </div>
        ) : null}
      </form>

      {/* Layanan */}
      <div className="mt-8 flex items-center gap-3">
        <h2 className="text-lg font-bold text-ink">
          {t("appointments.servicesTitle")}
        </h2>
        {canManage ? (
          <button
            type="button"
            className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink"
            onClick={() => openServiceForm(null)}
          >
            {t("appointments.serviceAddButton")}
          </button>
        ) : null}
      </div>
      {serviceFormOpen ? (
        <form
          className="mt-3 max-w-2xl space-y-3 rounded-2xl border border-line bg-surface p-4"
          onSubmit={(e) => void handleSaveService(e)}
        >
          <div>
            <label className="text-xs font-medium text-muted" htmlFor="svc-name">
              {t("appointments.serviceNameLabel")}
            </label>
            <input
              id="svc-name"
              className={inputClassName}
              value={svcName}
              maxLength={255}
              placeholder={t("appointments.serviceNamePlaceholder")}
              onChange={(e) => setSvcName(e.target.value)}
              required
            />
          </div>
          <div>
            <label
              className="text-xs font-medium text-muted"
              htmlFor="svc-duration"
            >
              {t("appointments.serviceDurationLabel")}
            </label>
            <input
              id="svc-duration"
              type="number"
              min={5}
              max={1440}
              step={5}
              className={inputClassName}
              value={svcDuration}
              onChange={(e) => setSvcDuration(Number(e.target.value) || 5)}
            />
          </div>
          <div>
            <label
              className="text-xs font-medium text-muted"
              htmlFor="svc-description"
            >
              {t("appointments.serviceDescriptionLabel")}
            </label>
            <textarea
              id="svc-description"
              className={inputClassName}
              rows={2}
              maxLength={1000}
              value={svcDescription}
              onChange={(e) => setSvcDescription(e.target.value)}
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={svcActive}
              onChange={(e) => setSvcActive(e.target.checked)}
            />
            {t("appointments.serviceActiveLabel")}
          </label>
          <FieldError message={serviceError} />
          <div className="flex gap-2">
            <button
              type="submit"
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white"
            >
              {t("common.save")}
            </button>
            <button
              type="button"
              className="rounded-lg border border-line px-4 py-2 text-sm text-ink"
              onClick={() => setServiceFormOpen(false)}
            >
              {t("common.cancel")}
            </button>
          </div>
        </form>
      ) : null}
      <ul className="mt-3 max-w-2xl space-y-2">
        {services.length === 0 ? (
          <li className="text-sm text-muted">
            {t("appointments.serviceEmpty")}
          </li>
        ) : (
          services.map((s) => (
            <li
              key={s.id}
              className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2"
            >
              <span className="font-medium text-ink">{s.name}</span>
              <span className="text-xs text-muted">
                {t("appointments.serviceMinutes", {
                  minutes: s.durationMinutes,
                })}
              </span>
              {!s.isActive ? (
                <span className="rounded-full bg-elevated px-2 py-0.5 text-xs text-muted">
                  {t("appointments.serviceInactiveChip")}
                </span>
              ) : null}
              {canManage ? (
                <span className="ml-auto flex gap-2">
                  <button
                    type="button"
                    className="text-sm text-accent"
                    onClick={() => openServiceForm(s)}
                  >
                    {t("common.edit")}
                  </button>
                  <button
                    type="button"
                    className="text-sm text-danger"
                    onClick={() => void handleDeleteService(s)}
                  >
                    {t("common.delete")}
                  </button>
                </span>
              ) : null}
            </li>
          ))
        )}
      </ul>

      {/* Ketersediaan mingguan */}
      <h2 className="mt-8 text-lg font-bold text-ink">
        {t("appointments.availabilityTitle")}
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        {t("appointments.availabilityHint")}
      </p>
      <div className="mt-3 max-w-2xl space-y-2">
        {days.map((d, weekday) => (
          <div
            key={weekday}
            className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2"
          >
            <span className="w-24 text-sm font-medium text-ink">
              {t(WEEKDAY_KEYS[weekday] as TranslationKey)}
            </span>
            <label className="flex items-center gap-1.5 text-sm text-ink">
              <input
                type="checkbox"
                checked={d.open}
                disabled={!canManage}
                onChange={(e) =>
                  setDays((prev) =>
                    prev.map((x, i) =>
                      i === weekday ? { ...x, open: e.target.checked } : x,
                    ),
                  )
                }
              />
              {t("appointments.availabilityOpenLabel")}
            </label>
            <label className="flex items-center gap-1 text-xs text-muted">
              {t("appointments.availabilityFromLabel")}
              <input
                type="time"
                className="rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink disabled:opacity-50"
                value={d.startTime}
                disabled={!canManage || !d.open}
                onChange={(e) =>
                  setDays((prev) =>
                    prev.map((x, i) =>
                      i === weekday ? { ...x, startTime: e.target.value } : x,
                    ),
                  )
                }
              />
            </label>
            <label className="flex items-center gap-1 text-xs text-muted">
              {t("appointments.availabilityToLabel")}
              <input
                type="time"
                className="rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink disabled:opacity-50"
                value={d.endTime}
                disabled={!canManage || !d.open}
                onChange={(e) =>
                  setDays((prev) =>
                    prev.map((x, i) =>
                      i === weekday ? { ...x, endTime: e.target.value } : x,
                    ),
                  )
                }
              />
            </label>
          </div>
        ))}
        {canManage ? (
          <button
            type="button"
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white"
            onClick={() => void handleSaveAvailability()}
          >
            {t("common.save")}
          </button>
        ) : null}
      </div>

      {/* Booking manual */}
      <h2 className="mt-8 text-lg font-bold text-ink">
        {t("appointments.manualTitle")}
      </h2>
      <div className="mt-3 max-w-2xl space-y-3 rounded-2xl border border-line bg-surface p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label
              className="text-xs font-medium text-muted"
              htmlFor="manual-contact"
            >
              {t("appointments.manualContactLabel")}
            </label>
            <select
              id="manual-contact"
              className={inputClassName}
              value={manualContactId}
              onChange={(e) => setManualContactId(e.target.value)}
            >
              <option value="">—</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label
              className="text-xs font-medium text-muted"
              htmlFor="manual-service"
            >
              {t("appointments.manualServiceLabel")}
            </label>
            <select
              id="manual-service"
              className={inputClassName}
              value={manualServiceId}
              onChange={(e) => setManualServiceId(e.target.value)}
            >
              <option value="">—</option>
              {services
                .filter((s) => s.isActive)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
          </div>
        </div>
        <button
          type="button"
          className="rounded-lg border border-line px-3 py-2 text-sm text-ink disabled:opacity-60"
          disabled={manualBusy}
          onClick={() => void handleLoadManualSlots()}
        >
          {t("appointments.manualLoadSlotsButton")}
        </button>
        <FieldError message={manualError} />
        {manualSlots !== null ? (
          manualSlots.length === 0 ? (
            <p className="text-sm text-muted">
              {t("appointments.manualNoSlots")}
            </p>
          ) : (
            <div>
              <p className="text-xs font-medium text-muted">
                {t("appointments.manualPickSlotLabel")}
              </p>
              <div className="mt-2 flex max-h-64 flex-wrap gap-2 overflow-y-auto">
                {manualSlots.map((s) => (
                  <button
                    key={s.startsAt}
                    type="button"
                    className={
                      manualSlot?.startsAt === s.startsAt
                        ? "rounded-full bg-accent px-3 py-1.5 text-xs font-semibold text-white"
                        : "rounded-full border border-line px-3 py-1.5 text-xs text-ink"
                    }
                    onClick={() => setManualSlot(s)}
                  >
                    {formatInTz(s.startsAt, locale, tz, true)}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="mt-3 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                disabled={!manualSlot || manualBusy || !canManage}
                onClick={() => void handleManualBook()}
              >
                {t("appointments.manualBookButton")}
              </button>
            </div>
          )
        ) : null}
      </div>

      {/* Daftar booking */}
      <h2 className="mt-8 text-lg font-bold text-ink">
        {t("appointments.bookingsTitle")}
      </h2>
      <ul className="mt-3 max-w-3xl space-y-2">
        {bookings.length === 0 ? (
          <li className="text-sm text-muted">
            {t("appointments.bookingsEmpty")}
          </li>
        ) : (
          bookings.map((b) => (
            <li
              key={b.id}
              className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2"
            >
              <span className="font-medium text-ink">
                {formatInTz(b.startsAt, locale, tz, true)} –{" "}
                {formatInTz(b.endsAt, locale, tz, false)}
              </span>
              <span className="text-sm text-ink">{b.serviceName ?? "—"}</span>
              <span className="text-sm text-muted">{b.contactName ?? "—"}</span>
              <span
                className={
                  b.status === "confirmed"
                    ? "rounded-full bg-success/15 px-2 py-0.5 text-xs text-success"
                    : "rounded-full bg-elevated px-2 py-0.5 text-xs text-muted"
                }
              >
                {b.status === "confirmed"
                  ? t("appointments.bookingStatusConfirmed")
                  : t("appointments.bookingStatusCancelled")}
              </span>
              <span className="rounded-full bg-elevated px-2 py-0.5 text-xs text-muted">
                {b.source === "flow"
                  ? t("appointments.bookingSourceFlow")
                  : t("appointments.bookingSourceDashboard")}
              </span>
              <span className="rounded-full bg-elevated px-2 py-0.5 text-xs text-muted">
                {googleChip(b)}
              </span>
              {b.status === "confirmed" && canManage ? (
                <button
                  type="button"
                  className="ml-auto text-sm text-danger"
                  onClick={() => void handleCancelBooking(b)}
                >
                  {t("appointments.bookingCancelButton")}
                </button>
              ) : null}
            </li>
          ))
        )}
      </ul>
    </section>
  );
}
