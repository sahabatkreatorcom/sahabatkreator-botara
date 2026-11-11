/**
 * Halaman Channels.
 *
 * Berkas ini menyimpan yang memang hanya milik halaman: state, pemuatan
 * data, modal hubungkan, dan tata letak grid. Fungsi bantu murni, ikon,
 * dan blok tampilan yang sudah berdiri sendiri dipindah ke
 * `./channels/`.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type {
  ChannelAccountResponse,
  MetaOAuthAsset,
  MetaOAuthInfoResponse,
  MetaOAuthProvider,
  MetaOAuthSessionResponse,
  MetaWebhookInfoResponse,
  ThreadsOAuthInfoResponse,
} from "@sahabat-kreator/contracts";
import { api, ApiClientError } from "../api/client";
import { translateApiError } from "../api/errorText";
import { FieldError, inputClassName } from "../components/AuthLayout";
import { PasswordInput } from "../components/PasswordInput";
import {
  ChannelAvatar,
  ProviderGlyph,
  providerMeta,
} from "../components/ChannelAvatar";
import { useWorkspace } from "../workspace/WorkspaceProvider";
import { formatDate } from "../utils/format";
import {
  CONNECT_FORM_FOCUS_IDS,
  CONNECT_FORM_TITLES,
  CONNECT_PROVIDERS,
  META_PROVIDERS,
  ChannelHealthBlock,
  MetaOAuthStepBlock,
  MetaWebhookInfoBlock,
  StatusPill,
  ThreadsOAuthStepBlock,
  type ConnectProvider,
} from "./channels/blocks";
import {
  type ChannelsPageProps,
  embedSnippet,
  handleLine,
  providerLabel,
  publicLink,
} from "./channels/helpers";
import {
  BackIcon,
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  PlusIcon,
  PowerIcon,
  TrashIcon,
} from "./channels/icons";


/**
 * Halaman Channels (Fase 1F; kartu Fase 6H mengikuti referensi UI user):
 * daftar channel workspace aktif sebagai KARTU (avatar + badge provider,
 * nama/@handle, pill status + tanggal terhubung, chip tautan publik).
 * Penghubungan channel (Redesain Connect — permintaan user): tombol
 * "+ Hubungkan Channel" di kanan atas header membuka MODAL dua langkah
 * (pemilih provider → form provider itu); info Webhook Meta hidup di
 * dialog header owner/admin + kontekstual di langkah form Meta. Badan
 * halaman hanya grid kartu + seksi Sampah (Fase 6I: hapus BERPENJAGA —
 * ketik nama untuk konfirmasi + tombol ekspor riwayat di dialog yang
 * sama; masa tenggang 30 hari: Pulihkan / Ekspor, lalu worker purge).
 * Ikon power pada kartu memakai alur Disconnect yang sudah ada.
 */
export function ChannelsPage({ t, locale }: ChannelsPageProps) {
  const { active } = useWorkspace();
  const tenantId = active?.id ?? null;

  const [items, setItems] = useState<ChannelAccountResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // Modal Hubungkan Channel: null = tertutup, "pick" = langkah pemilih
  // provider, selain itu nama provider = langkah form provider itu.
  const [connectStep, setConnectStep] = useState<string | null>(null);
  const [webhookDialogOpen, setWebhookDialogOpen] = useState(false);
  // Kartu yang baru berhasil dihubungkan — disorot sesaat sesudah modal
  // tertutup agar pengguna melihat hasil kerjanya di grid.
  const [justConnectedId, setJustConnectedId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null);
  const [tgName, setTgName] = useState("");
  const [tgToken, setTgToken] = useState("");
  const [tgCreating, setTgCreating] = useState(false);
  const [tgError, setTgError] = useState<string | null>(null);
  // Form Meta (Fase 7A): Messenger (Page) & Instagram — token-based
  // seperti Telegram; token hanya hidup di state selama form terisi.
  const [msName, setMsName] = useState("");
  const [msPageId, setMsPageId] = useState("");
  const [msToken, setMsToken] = useState("");
  const [msCreating, setMsCreating] = useState(false);
  const [msError, setMsError] = useState<string | null>(null);
  const [igName, setIgName] = useState("");
  const [igPageId, setIgPageId] = useState("");
  const [igId, setIgId] = useState("");
  const [igToken, setIgToken] = useState("");
  // Jenis token connect manual IG (Fase 7D.3): Page Access Token (7A)
  // atau System User Token — varian SUAT tidak memakai Page ID.
  const [igTokenType, setIgTokenType] = useState<
    "page_access_token" | "system_user_token"
  >("page_access_token");
  const [igCreating, setIgCreating] = useState(false);
  const [igError, setIgError] = useState<string | null>(null);
  // Form WhatsApp (Fase 7B): WABA ID + Phone Number ID + token System
  // User — token-based seperti Meta; token hanya hidup di state form.
  const [waName, setWaName] = useState("");
  const [waWabaId, setWaWabaId] = useState("");
  const [waPhoneId, setWaPhoneId] = useState("");
  const [waToken, setWaToken] = useState("");
  const [waCreating, setWaCreating] = useState(false);
  const [waError, setWaError] = useState<string | null>(null);
  const [metaWebhook, setMetaWebhook] =
    useState<MetaWebhookInfoResponse | null>(null);
  // OAuth Meta (Fase 7D): ketersediaan per provider, status start,
  // lipatan form manual, dan alur pulang dari dialog Meta (sesi pemilih
  // aset / banner error / peringatan subscribe).
  const [oauthInfo, setOauthInfo] = useState<MetaOAuthInfoResponse | null>(
    null,
  );
  const [oauthStarting, setOauthStarting] = useState(false);
  const [oauthStartError, setOauthStartError] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [oauthSessionId, setOauthSessionId] = useState<string | null>(null);
  const [oauthSession, setOauthSession] =
    useState<MetaOAuthSessionResponse | null>(null);
  const [oauthSessionError, setOauthSessionError] = useState<string | null>(
    null,
  );
  const [oauthCompletingId, setOauthCompletingId] = useState<string | null>(
    null,
  );
  const [oauthCompleteError, setOauthCompleteError] = useState<string | null>(
    null,
  );
  const [oauthBannerError, setOauthBannerError] = useState<string | null>(
    null,
  );
  const [connectWarning, setConnectWarning] = useState<string | null>(null);
  const oauthParamsHandled = useRef(false);
  // OAuth Threads (integrasi Threads): ketersediaan connect, status
  // start, dan banner sukses kepulangan callback (callback langsung
  // menghubungkan — tidak ada sesi pemilih seperti Meta).
  const [threadsOAuthInfo, setThreadsOAuthInfo] =
    useState<ThreadsOAuthInfoResponse | null>(null);
  const [threadsOAuthStarting, setThreadsOAuthStarting] = useState(false);
  const [threadsOAuthStartError, setThreadsOAuthStartError] = useState<
    string | null
  >(null);
  const [threadsConnected, setThreadsConnected] = useState(false);
  const [copiedWebhookField, setCopiedWebhookField] = useState<string | null>(
    null,
  );
  const [disconnectTarget, setDisconnectTarget] =
    useState<ChannelAccountResponse | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  const [trashItems, setTrashItems] = useState<ChannelAccountResponse[]>([]);
  const [deleteTarget, setDeleteTarget] =
    useState<ChannelAccountResponse | null>(null);
  const [deleteName, setDeleteName] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    setError(null);
    try {
      const [channels, trashed] = await Promise.all([
        api.channels.list(tenantId),
        api.channels.listTrash(tenantId),
      ]);
      setItems(channels);
      setTrashItems(trashed);
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setLoading(false);
    }
  }, [tenantId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Buka modal Hubungkan Channel — tanpa argumen di langkah pemilih. */
  const openConnect = useCallback((provider?: ConnectProvider) => {
    setConnectStep(provider ?? "pick");
  }, []);

  /** Sesudah connect sukses: tutup modal + sorot kartu barunya di grid. */
  const finishConnect = useCallback((channelId: string) => {
    setConnectStep(null);
    setJustConnectedId(channelId);
  }, []);

  // Sorotan kartu baru hanya sesaat (±3 detik), lalu kembali normal.
  useEffect(() => {
    if (!justConnectedId) return;
    const timer = window.setTimeout(() => setJustConnectedId(null), 3000);
    return () => window.clearTimeout(timer);
  }, [justConnectedId]);

  // Langkah form modal dibuka → fokuskan field pertamanya (perilaku yang
  // sama seperti "Hubungkan lagi" lama yang memfokuskan field form).
  useEffect(() => {
    if (!connectStep || connectStep === "pick") return;
    const id =
      CONNECT_FORM_FOCUS_IDS[connectStep as ConnectProvider] ?? undefined;
    if (!id) return;
    const timer = window.setTimeout(() => {
      document.getElementById(id)?.focus({ preventScroll: true });
    }, 60);
    return () => window.clearTimeout(timer);
  }, [connectStep]);

  // Info webhook Meta (Fase 7A): hanya owner/admin yang bisa membaca
  // endpoint-nya — peran lain menerima 403 dan panel disembunyikan
  // diam-diam (bukan error halaman).
  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
    api.channels
      .metaWebhookInfo(tenantId)
      .then((info) => {
        if (!cancelled) setMetaWebhook(info);
      })
      .catch(() => {
        if (!cancelled) setMetaWebhook(null);
      });
    // Ketersediaan OAuth Meta (Fase 7D) — gerbang yang sama (owner/admin);
    // kegagalan berarti tombol OAuth tampil nonaktif, bukan error halaman.
    api.channels
      .metaOAuthInfo(tenantId)
      .then((info) => {
        if (!cancelled) setOauthInfo(info);
      })
      .catch(() => {
        if (!cancelled) setOauthInfo(null);
      });
    // Ketersediaan connect Threads — gerbang & perlakuan yang sama.
    api.channels
      .threadsOAuthInfo(tenantId)
      .then((info) => {
        if (!cancelled) setThreadsOAuthInfo(info);
      })
      .catch(() => {
        if (!cancelled) setThreadsOAuthInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  // Ganti langkah modal → lipatan manual tertutup lagi + error start bersih.
  useEffect(() => {
    setManualOpen(false);
    setOauthStartError(null);
    setThreadsOAuthStartError(null);
  }, [connectStep]);

  // Kepulangan dari dialog Meta (Fase 7D): callback API me-redirect ke
  // /channels?meta_oauth=<sesi> atau ?meta_oauth_error=<kode>. Baca
  // SEKALI, bersihkan query dari URL, lalu tampilkan pemilih/banner.
  // Kepulangan Threads (integrasi Threads) memakai penanda sendiri:
  // ?threads_oauth=connected (callback langsung menghubungkan) atau
  // ?threads_oauth_error=<kode> — ditangani di efek yang sama.
  useEffect(() => {
    if (oauthParamsHandled.current) return;
    oauthParamsHandled.current = true;
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("meta_oauth");
    const errorCode = params.get("meta_oauth_error");
    const threadsResult = params.get("threads_oauth");
    const threadsError = params.get("threads_oauth_error");
    if (!sessionId && !errorCode && !threadsResult && !threadsError) return;
    params.delete("meta_oauth");
    params.delete("meta_oauth_error");
    params.delete("threads_oauth");
    params.delete("threads_oauth_error");
    const rest = params.toString();
    window.history.replaceState(
      null,
      "",
      window.location.pathname + (rest ? `?${rest}` : ""),
    );
    if (errorCode) {
      setOauthBannerError(
        translateApiError(t, new ApiClientError(0, errorCode, "")),
      );
    }
    if (sessionId) {
      setOauthSessionError(null);
      setOauthSession(null);
      setOauthSessionId(sessionId);
    }
    if (threadsError) {
      setOauthBannerError(
        translateApiError(t, new ApiClientError(0, threadsError, "")),
      );
    }
    if (threadsResult === "connected") {
      setThreadsConnected(true);
      void load();
    }
    // Sengaja hanya sekali saat mount; `t` dari render pertama cukup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Muat aset sesi OAuth begitu id sesi + tenant siap (dialog pemilih).
  useEffect(() => {
    if (!tenantId || !oauthSessionId) return;
    let cancelled = false;
    api.channels
      .metaOAuthSession(tenantId, oauthSessionId)
      .then((session) => {
        if (!cancelled) setOauthSession(session);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setOauthSessionError(
            err instanceof ApiClientError
              ? translateApiError(t, err)
              : t("errors.generic"),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, oauthSessionId, t]);

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (!tenantId) return;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await api.channels.create(tenantId, {
        provider: "webchat",
        displayName: name.trim() || undefined,
      });
      setName("");
      await load();
      finishConnect(created.id);
    } catch (err) {
      setCreateError(
        err instanceof ApiClientError
          ? translateApiError(t, err)
          : t("errors.generic"),
      );
    } finally {
      setCreating(false);
    }
  };

  const handleConnectTelegram = async (event: FormEvent) => {
    event.preventDefault();
    if (!tenantId) return;
    setTgCreating(true);
    setTgError(null);
    try {
      const created = await api.channels.create(tenantId, {
        provider: "telegram",
        displayName: tgName.trim() || undefined,
        botToken: tgToken.trim(),
      });
      // Token tidak disimpan di state lebih lama dari yang perlu.
      setTgToken("");
      setTgName("");
      await load();
      finishConnect(created.id);
    } catch (err) {
      setTgError(
        err instanceof ApiClientError
          ? translateApiError(t, err)
          : t("errors.generic"),
      );
    } finally {
      setTgCreating(false);
    }
  };

  const handleConnectMessenger = async (event: FormEvent) => {
    event.preventDefault();
    if (!tenantId) return;
    setMsCreating(true);
    setMsError(null);
    try {
      const created = await api.channels.create(tenantId, {
        provider: "messenger",
        displayName: msName.trim() || undefined,
        pageId: msPageId.trim(),
        pageAccessToken: msToken.trim(),
      });
      // Token tidak disimpan di state lebih lama dari yang perlu.
      setMsToken("");
      setMsName("");
      setMsPageId("");
      await load();
      finishConnect(created.id);
    } catch (err) {
      setMsError(
        err instanceof ApiClientError
          ? translateApiError(t, err)
          : t("errors.generic"),
      );
    } finally {
      setMsCreating(false);
    }
  };

  const handleConnectInstagram = async (event: FormEvent) => {
    event.preventDefault();
    if (!tenantId) return;
    setIgCreating(true);
    setIgError(null);
    const suat = igTokenType === "system_user_token";
    try {
      const created = await api.channels.create(tenantId, {
        provider: "instagram",
        displayName: igName.trim() || undefined,
        // Varian SUAT (Fase 7D.3): tanpa Page ID — server memvalidasi
        // token langsung ke akun IG.
        ...(suat ? {} : { pageId: igPageId.trim() }),
        igUserId: igId.trim(),
        pageAccessToken: igToken.trim(),
        tokenType: igTokenType,
      });
      setIgToken("");
      setIgName("");
      setIgPageId("");
      setIgId("");
      // Peringatan subscribe varian SUAT memakai banner yang sama
      // seperti alur OAuth (koneksi berhasil, webhook belum tentu).
      if (created.warnings?.includes("META_SUBSCRIBE_FAILED")) {
        setConnectWarning(t("channels.oauthSubscribeWarning"));
      }
      await load();
      finishConnect(created.id);
    } catch (err) {
      setIgError(
        err instanceof ApiClientError
          ? translateApiError(t, err)
          : t("errors.generic"),
      );
    } finally {
      setIgCreating(false);
    }
  };

  const handleConnectWhatsApp = async (event: FormEvent) => {
    event.preventDefault();
    if (!tenantId) return;
    setWaCreating(true);
    setWaError(null);
    try {
      const created = await api.channels.create(tenantId, {
        provider: "whatsapp",
        displayName: waName.trim() || undefined,
        wabaId: waWabaId.trim(),
        phoneNumberId: waPhoneId.trim(),
        accessToken: waToken.trim(),
      });
      // Token tidak disimpan di state lebih lama dari yang perlu.
      setWaToken("");
      setWaName("");
      setWaWabaId("");
      setWaPhoneId("");
      // Jalur tempel token WAJIB subscribe WABA sendiri (OAuth
      // melakukannya otomatis). Bila langganan itu gagal, nomor tetap
      // terhubung tetapi pesan masuk tidak akan tiba — beri tahu di
      // banner yang sama dengan alur OAuth, bukan diam-diam. Status
      // nomor yang belum CONNECTED adalah penyebab lain dengan gejala
      // yang sama, jadi keduanya dilaporkan bila muncul bersamaan.
      const notices: string[] = [];
      if (created.warnings?.includes("WHATSAPP_NUMBER_NOT_CONNECTED")) {
        notices.push(t("channels.whatsappStatusWarning"));
      }
      if (created.warnings?.includes("META_SUBSCRIBE_FAILED")) {
        notices.push(t("channels.oauthSubscribeWarning"));
      }
      if (notices.length > 0) setConnectWarning(notices.join(" "));
      await load();
      finishConnect(created.id);
    } catch (err) {
      setWaError(
        err instanceof ApiClientError
          ? translateApiError(t, err)
          : t("errors.generic"),
      );
    } finally {
      setWaCreating(false);
    }
  };

  const copyWebhookValue = async (field: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedWebhookField(field);
      window.setTimeout(
        () => setCopiedWebhookField((cur) => (cur === field ? null : cur)),
        2000,
      );
    } catch {
      /* clipboard tidak tersedia — nilai tetap terlihat untuk disalin manual */
    }
  };

  /**
   * Mulai OAuth Meta (Fase 7D): minta URL dialog ke API lalu arahkan
   * browser ke sana (redirect penuh). Callback API yang membawa pulang.
   */
  const handleOAuthStart = async (provider: MetaOAuthProvider) => {
    if (!tenantId || oauthStarting) return;
    setOauthStarting(true);
    setOauthStartError(null);
    try {
      const started = await api.channels.metaOAuthStart(tenantId, provider);
      window.location.href = started.dialogUrl;
    } catch (err) {
      setOauthStartError(
        err instanceof ApiClientError
          ? translateApiError(t, err)
          : t("errors.generic"),
      );
      setOauthStarting(false);
    }
  };

  /** Mulai connect Threads: minta URL dialog lalu arahkan browser. */
  const handleThreadsOAuthStart = async () => {
    if (!tenantId || threadsOAuthStarting) return;
    setThreadsOAuthStarting(true);
    setThreadsOAuthStartError(null);
    try {
      const started = await api.channels.threadsOAuthStart(tenantId);
      window.location.href = started.dialogUrl;
    } catch (err) {
      setThreadsOAuthStartError(
        err instanceof ApiClientError
          ? translateApiError(t, err)
          : t("errors.generic"),
      );
      setThreadsOAuthStarting(false);
    }
  };

  /** Selesaikan OAuth: hubungkan aset terpilih dari sesi (Fase 7D). */
  const handleOAuthComplete = async (asset: MetaOAuthAsset) => {
    // Hotfix R1: aset nonaktif (Page tanpa token yang dapat dipakai)
    // tidak pernah dikirim ke complete — tombolnya nonaktif, ini
    // penjaga kedua di sisi klien (API juga menolaknya).
    if (asset.connectable === false) return;
    if (!tenantId || !oauthSessionId || oauthCompletingId) return;
    setOauthCompletingId(asset.assetId);
    setOauthCompleteError(null);
    try {
      const result = await api.channels.metaOAuthComplete(
        tenantId,
        oauthSessionId,
        asset.assetId,
      );
      setOauthSessionId(null);
      setOauthSession(null);
      if (result.warnings.includes("META_SUBSCRIBE_FAILED")) {
        setConnectWarning(t("channels.oauthSubscribeWarning"));
      }
      await load();
      finishConnect(result.channel.id);
    } catch (err) {
      setOauthCompleteError(
        err instanceof ApiClientError
          ? translateApiError(t, err)
          : t("errors.generic"),
      );
    } finally {
      setOauthCompletingId(null);
    }
  };

  const closeOAuthPicker = () => {
    setOauthSessionId(null);
    setOauthSession(null);
    setOauthSessionError(null);
    setOauthCompleteError(null);
  };

  const handleDisconnect = async () => {
    if (!tenantId || !disconnectTarget) return;
    setDisconnecting(true);
    setDisconnectError(null);
    try {
      await api.channels.disconnect(tenantId, disconnectTarget.id);
      setDisconnectTarget(null);
      await load();
    } catch (err) {
      setDisconnectError(
        err instanceof ApiClientError
          ? translateApiError(t, err)
          : t("channels.disconnectError"),
      );
    } finally {
      setDisconnecting(false);
    }
  };

  const handleTrash = async () => {
    if (!tenantId || !deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.channels.trash(tenantId, deleteTarget.id, deleteName);
      setDeleteTarget(null);
      setDeleteName("");
      await load();
    } catch (err) {
      setDeleteError(
        err instanceof ApiClientError
          ? translateApiError(t, err)
          : t("channels.deleteError"),
      );
    } finally {
      setDeleting(false);
    }
  };

  const handleRestore = async (channel: ChannelAccountResponse) => {
    if (!tenantId) return;
    setRestoringId(channel.id);
    setRestoreError(null);
    try {
      await api.channels.restore(tenantId, channel.id);
      await load();
    } catch (err) {
      setRestoreError(
        err instanceof ApiClientError
          ? translateApiError(t, err)
          : t("channels.restoreError"),
      );
    } finally {
      setRestoringId(null);
    }
  };

  const handleExport = async (channel: ChannelAccountResponse) => {
    if (!tenantId) return;
    try {
      await api.channels.downloadExport(tenantId, channel.id);
    } catch {
      /* unduhan gagal — riwayat tetap aman; pengguna bisa mencoba lagi */
    }
  };

  const copySnippet = async (channel: ChannelAccountResponse) => {
    try {
      await navigator.clipboard.writeText(embedSnippet(channel.externalId));
      setCopiedId(channel.id);
      window.setTimeout(() => setCopiedId((cur) => (cur === channel.id ? null : cur)), 2000);
    } catch {
      /* clipboard tidak tersedia — snippet tetap bisa disalin manual */
    }
  };

  const copyLink = async (channel: ChannelAccountResponse, url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedLinkId(channel.id);
      window.setTimeout(
        () => setCopiedLinkId((cur) => (cur === channel.id ? null : cur)),
        2000,
      );
    } catch {
      /* clipboard tidak tersedia — tautan tetap terlihat untuk disalin manual */
    }
  };

  // Aset sesi OAuth dikelompokkan per induk (WhatsApp: per WABA);
  // provider lain satu grup tanpa judul (parentId null).
  const oauthGroups: Array<{
    key: string;
    parentName: string | null;
    assets: MetaOAuthAsset[];
  }> = [];
  if (oauthSession) {
    for (const asset of oauthSession.assets) {
      const key = asset.parentId ?? "__single__";
      let group = oauthGroups.find((g) => g.key === key);
      if (!group) {
        group = { key, parentName: asset.parentName, assets: [] };
        oauthGroups.push(group);
      }
      group.assets.push(asset);
    }
  }

  if (!tenantId) {
    return (
      <section>
        <h1 className="text-2xl font-bold">{t("channels.title")}</h1>
        <p className="mt-2 text-sm text-muted">{t("workspace.none")}</p>
      </section>
    );
  }

  return (
    <section>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t("channels.title")}</h1>
          <p className="mt-1 text-sm text-muted">{t("channels.subtitle")}</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {metaWebhook ? (
            <button
              type="button"
              onClick={() => setWebhookDialogOpen(true)}
              className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium"
            >
              {t("channels.metaWebhookButton")}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => openConnect()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white"
          >
            <PlusIcon />
            {t("channels.connectButton")}
          </button>
        </div>
      </div>

      {oauthBannerError ? (
        <div className="mt-4 flex items-start justify-between gap-3 rounded-lg bg-elevated px-3 py-2">
          <FieldError message={oauthBannerError} />
          <button
            type="button"
            onClick={() => setOauthBannerError(null)}
            className="shrink-0 rounded-md px-2 py-1 text-sm font-medium text-muted hover:text-ink"
          >
            {t("common.close")}
          </button>
        </div>
      ) : null}

      {threadsConnected ? (
        <div className="mt-4 flex items-start justify-between gap-3 rounded-lg border border-line bg-elevated px-3 py-2">
          <p className="text-sm text-ink">
            {t("channels.threadsConnectedNotice")}
          </p>
          <button
            type="button"
            onClick={() => setThreadsConnected(false)}
            className="shrink-0 rounded-md px-2 py-1 text-sm font-medium text-muted hover:text-ink"
          >
            {t("common.close")}
          </button>
        </div>
      ) : null}

      {connectWarning ? (
        <div className="mt-4 flex items-start justify-between gap-3 rounded-lg border border-line bg-elevated px-3 py-2">
          <p className="text-sm text-ink">{connectWarning}</p>
          <button
            type="button"
            onClick={() => setConnectWarning(null)}
            className="shrink-0 rounded-md px-2 py-1 text-sm font-medium text-muted hover:text-ink"
          >
            {t("common.close")}
          </button>
        </div>
      ) : null}

      {error ? (
        <div className="mt-4">
          <FieldError message={error} />
          <button
            type="button"
            onClick={() => void load()}
            className="mt-2 rounded-md bg-elevated px-3 py-1 text-sm"
          >
            {t("common.retry")}
          </button>
        </div>
      ) : null}

      <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {loading && items.length === 0 ? (
          <p className="text-sm text-muted sm:col-span-2 xl:col-span-3">
            {t("common.loading")}
          </p>
        ) : items.length === 0 ? (
          <div className="rounded-xl border border-line bg-surface p-4 sm:col-span-2 xl:col-span-3">
            <div className="font-semibold">{t("channels.emptyTitle")}</div>
            <p className="mt-1 text-sm text-muted">{t("channels.emptyBody")}</p>
            <button
              type="button"
              onClick={() => openConnect()}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white"
            >
              <PlusIcon />
              {t("channels.connectButton")}
            </button>
          </div>
        ) : (
          items.map((channel) => {
            const handle = handleLine(channel);
            const link = publicLink(channel);
            return (
              <article
                key={channel.id}
                className={`flex flex-col rounded-xl border bg-surface p-4 transition-shadow ${
                  channel.id === justConnectedId
                    ? "border-accent ring-2 ring-accent"
                    : "border-line"
                } ${channel.status === "disconnected" ? "opacity-60" : ""}`}
              >
                <div className="flex items-start gap-3">
                  <ChannelAvatar
                    provider={channel.provider}
                    name={
                      channel.displayName ||
                      channel.botUsername ||
                      channel.publicHandle ||
                      providerLabel(t, channel.provider)
                    }
                    imageUrl={channel.avatarUrl ?? undefined}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold">
                      {channel.displayName || providerLabel(t, channel.provider)}
                    </div>
                    {handle ? (
                      <div className="truncate font-mono text-sm text-muted">
                        {handle}
                      </div>
                    ) : null}
                    <div className="text-xs text-muted">
                      {providerLabel(t, channel.provider)}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-start gap-1">
                    {channel.status !== "disconnected" ? (
                      <button
                        type="button"
                        onClick={() => {
                          setDisconnectError(null);
                          setDisconnectTarget(channel);
                        }}
                        aria-label={t("channels.disconnectButton")}
                        title={t("channels.disconnectButton")}
                        className={`rounded-md p-1.5 hover:bg-elevated ${
                          channel.status === "connected"
                            ? "text-success"
                            : "text-muted"
                        }`}
                      >
                        <PowerIcon />
                      </button>
                    ) : channel.provider === "telegram" ||
                      channel.provider === "messenger" ||
                      channel.provider === "instagram" ||
                      channel.provider === "whatsapp" ? (
                      <button
                        type="button"
                        onClick={() =>
                          openConnect(channel.provider as ConnectProvider)
                        }
                        className="rounded-md px-2 py-1.5 text-sm font-medium text-accent hover:bg-elevated"
                      >
                        {t("channels.reconnectButton")}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => {
                        setDeleteError(null);
                        setDeleteName("");
                        setDeleteTarget(channel);
                      }}
                      aria-label={t("channels.deleteButton")}
                      title={t("channels.deleteButton")}
                      className="rounded-md p-1.5 text-muted hover:bg-elevated hover:text-danger"
                    >
                      <TrashIcon />
                    </button>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <StatusPill t={t} status={channel.status} />
                  <span className="text-xs text-muted">
                    {t("channels.connectedSince", {
                      date: formatDate(channel.createdAt, locale),
                    })}
                  </span>
                </div>

                <ChannelHealthBlock t={t} locale={locale} channel={channel} />

                {link ? (
                  <div className="mt-3 flex items-center gap-2">
                    <div className="flex min-w-0 flex-1 items-center rounded-lg bg-elevated px-3 py-2">
                      <span className="truncate font-mono text-xs text-accent">
                        {link.display}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => void copyLink(channel, link.url)}
                      aria-label={t("channels.copyLink")}
                      title={
                        copiedLinkId === channel.id
                          ? t("channels.copied")
                          : t("channels.copyLink")
                      }
                      className="shrink-0 rounded-lg border border-line bg-surface p-2 text-muted hover:text-ink"
                    >
                      {copiedLinkId === channel.id ? (
                        <span className="text-success">
                          <CheckIcon />
                        </span>
                      ) : (
                        <CopyIcon />
                      )}
                    </button>
                  </div>
                ) : null}

                {channel.provider === "webchat" && channel.status === "connected" ? (
                  <div className="mt-3 space-y-2 border-t border-line pt-3">
                    <div className="text-xs text-muted">
                      {t("channels.siteKeyLabel")}:{" "}
                      <code className="font-mono">{channel.externalId}</code>
                    </div>
                    <div className="text-sm font-medium">{t("channels.embedTitle")}</div>
                    <p className="text-xs text-muted">{t("channels.embedHint")}</p>
                    <textarea
                      readOnly
                      rows={2}
                      value={embedSnippet(channel.externalId)}
                      className="w-full rounded-md border border-line bg-elevated p-2 font-mono text-xs"
                      onFocus={(e) => e.target.select()}
                    />
                    <button
                      type="button"
                      onClick={() => void copySnippet(channel)}
                      className="rounded-md bg-accent px-3 py-1 text-sm font-semibold text-white"
                    >
                      {copiedId === channel.id ? t("channels.copied") : t("channels.copyButton")}
                    </button>
                  </div>
                ) : null}
              </article>
            );
          })
        )}
      </div>


      <div className="mt-8">
        <h2 className="font-semibold">{t("channels.trashTitle")}</h2>
        {restoreError ? (
          <div className="mt-2">
            <FieldError message={restoreError} />
          </div>
        ) : null}
        {trashItems.length === 0 ? (
          <p className="mt-2 text-sm text-muted">{t("channels.trashEmpty")}</p>
        ) : (
          <div className="mt-3 space-y-2">
            {trashItems.map((channel) => (
              <div
                key={channel.id}
                className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface p-3 opacity-80"
              >
                <ChannelAvatar
                  provider={channel.provider}
                  name={
                    channel.displayName ||
                    channel.botUsername ||
                    channel.publicHandle ||
                    providerLabel(t, channel.provider)
                  }
                  imageUrl={channel.avatarUrl ?? undefined}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold">
                    {channel.displayName || providerLabel(t, channel.provider)}
                  </div>
                  <div className="text-xs text-muted">
                    {providerLabel(t, channel.provider)}
                    {channel.trashedAt
                      ? ` · ${t("channels.trashedOn", {
                          date: formatDate(channel.trashedAt, locale),
                        })}`
                      : ""}
                    {channel.purgeAt
                      ? ` · ${t("channels.purgeOn", {
                          date: formatDate(channel.purgeAt, locale),
                        })}`
                      : ""}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleExport(channel)}
                  className="rounded-md bg-elevated px-3 py-1.5 text-sm font-medium"
                >
                  {t("channels.exportButton")}
                </button>
                <button
                  type="button"
                  disabled={restoringId === channel.id}
                  onClick={() => void handleRestore(channel)}
                  className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60"
                >
                  {restoringId === channel.id
                    ? t("channels.restoring")
                    : t("channels.restoreButton")}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {webhookDialogOpen && metaWebhook ? (
        <div
          className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-xl sm:rounded-2xl">
            <MetaWebhookInfoBlock
              t={t}
              info={metaWebhook}
              copiedField={copiedWebhookField}
              onCopy={(field, value) => void copyWebhookValue(field, value)}
            />
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => setWebhookDialogOpen(false)}
                className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium"
              >
                {t("common.close")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {connectStep ? (
        <div
          className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-label={t("channels.connectTitle")}
        >
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-xl sm:rounded-2xl">
            {connectStep === "pick" ? (
              <>
                <h2 className="text-lg font-bold">{t("channels.connectTitle")}</h2>
                <p className="mt-1 text-sm text-muted">
                  {t("channels.connectSubtitle")}
                </p>
                <div className="mt-4 space-y-2">
                  {CONNECT_PROVIDERS.map(({ provider, descKey }) => {
                    const meta = providerMeta(provider);
                    return (
                      <button
                        key={provider}
                        type="button"
                        onClick={() => setConnectStep(provider)}
                        className="flex w-full items-center gap-3 rounded-xl border border-line p-3 text-left hover:bg-elevated"
                      >
                        <span
                          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
                          style={{
                            backgroundColor: `${meta.color}1A`,
                            color: meta.color,
                          }}
                        >
                          <ProviderGlyph provider={provider} className="h-6 w-6" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block font-semibold">
                            {providerLabel(t, provider)}
                          </span>
                          <span className="block text-sm text-muted">
                            {t(descKey)}
                          </span>
                        </span>
                        <ChevronRightIcon />
                      </button>
                    );
                  })}
                </div>
                <div className="mt-4 flex justify-end">
                  <button
                    type="button"
                    onClick={() => setConnectStep(null)}
                    className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium"
                  >
                    {t("common.close")}
                  </button>
                </div>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setConnectStep("pick")}
                  className="inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-ink"
                >
                  <BackIcon />
                  {t("common.back")}
                </button>
                <h2 className="mt-2 text-lg font-bold">
                  {t(CONNECT_FORM_TITLES[connectStep as ConnectProvider])}
                </h2>
                {META_PROVIDERS.includes(connectStep) && metaWebhook ? (
                  <div className="mt-3 rounded-lg border border-line bg-elevated/40 p-3">
                    <MetaWebhookInfoBlock
                      t={t}
                      info={metaWebhook}
                      copiedField={copiedWebhookField}
                      onCopy={(field, value) =>
                        void copyWebhookValue(field, value)
                      }
                    />
                  </div>
                ) : null}

                {connectStep === "webchat" ? (
                  <form onSubmit={handleCreate}>
                    <label
                      className="mt-3 block text-sm font-medium"
                      htmlFor="channel-name"
                    >
                      {t("channels.nameLabel")}
                    </label>
                    <input
                      id="channel-name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder={t("channels.namePlaceholder")}
                      maxLength={255}
                      className={`${inputClassName} mt-1`}
                    />
                    {createError ? (
                      <div className="mt-2">
                        <FieldError message={createError} />
                      </div>
                    ) : null}
                    <button
                      type="submit"
                      disabled={creating}
                      className="mt-3 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                    >
                      {creating
                        ? t("channels.creating")
                        : t("channels.createButton")}
                    </button>
                  </form>
                ) : null}

                {connectStep === "telegram" ? (
                  <form onSubmit={handleConnectTelegram}>
                    <label
                      className="mt-3 block text-sm font-medium"
                      htmlFor="telegram-name"
                    >
                      {t("channels.telegramNameLabel")}
                    </label>
                    <input
                      id="telegram-name"
                      value={tgName}
                      onChange={(e) => setTgName(e.target.value)}
                      placeholder={t("channels.telegramNamePlaceholder")}
                      maxLength={255}
                      className={`${inputClassName} mt-1`}
                    />
                    <label
                      className="mt-3 block text-sm font-medium"
                      htmlFor="telegram-token"
                    >
                      {t("channels.tokenLabel")}
                    </label>
                    <PasswordInput
                      t={t}
                      id="telegram-token"
                      autoComplete="off"
                      value={tgToken}
                      onChange={(e) => setTgToken(e.target.value)}
                      placeholder={t("channels.tokenPlaceholder")}
                      maxLength={255}
                      className={`${inputClassName} mt-1`}
                    />
                    <p className="mt-1 text-xs text-muted">
                      {t("channels.tokenHint")}
                    </p>
                    {tgError ? (
                      <div className="mt-2">
                        <FieldError message={tgError} />
                      </div>
                    ) : null}
                    <button
                      type="submit"
                      disabled={tgCreating || !tgToken.trim()}
                      className="mt-3 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                    >
                      {tgCreating
                        ? t("channels.telegramConnecting")
                        : t("channels.telegramConnectButton")}
                    </button>
                  </form>
                ) : null}

                {connectStep === "messenger" ? (
                  <>
                    <MetaOAuthStepBlock
                      t={t}
                      provider="messenger"
                      available={
                        oauthInfo?.providers.messenger.available ?? false
                      }
                      starting={oauthStarting}
                      startError={oauthStartError}
                      onStart={(p) => void handleOAuthStart(p)}
                    />
                    <button
                      type="button"
                      onClick={() => setManualOpen((open) => !open)}
                      className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-accent"
                      aria-expanded={manualOpen}
                    >
                      {t("channels.oauthManualTitle")}
                      <ChevronRightIcon />
                    </button>
                    {manualOpen ? (
                  <form onSubmit={handleConnectMessenger}>
                    <label
                      className="mt-3 block text-sm font-medium"
                      htmlFor="messenger-name"
                    >
                      {t("channels.metaNameLabel")}
                    </label>
                    <input
                      id="messenger-name"
                      value={msName}
                      onChange={(e) => setMsName(e.target.value)}
                      placeholder={t("channels.metaNamePlaceholder")}
                      maxLength={255}
                      className={`${inputClassName} mt-1`}
                    />
                    <label
                      className="mt-3 block text-sm font-medium"
                      htmlFor="messenger-page-id"
                    >
                      {t("channels.pageIdLabel")}
                    </label>
                    <input
                      id="messenger-page-id"
                      value={msPageId}
                      onChange={(e) => setMsPageId(e.target.value)}
                      placeholder={t("channels.pageIdPlaceholder")}
                      maxLength={64}
                      className={`${inputClassName} mt-1`}
                    />
                    <label
                      className="mt-3 block text-sm font-medium"
                      htmlFor="messenger-token"
                    >
                      {t("channels.pageTokenLabel")}
                    </label>
                    <PasswordInput
                      t={t}
                      id="messenger-token"
                      autoComplete="off"
                      value={msToken}
                      onChange={(e) => setMsToken(e.target.value)}
                      placeholder={t("channels.pageTokenPlaceholder")}
                      maxLength={1024}
                      className={`${inputClassName} mt-1`}
                    />
                    <p className="mt-1 text-xs text-muted">
                      {t("channels.metaTokenHint")}
                    </p>
                    {msError ? (
                      <div className="mt-2">
                        <FieldError message={msError} />
                      </div>
                    ) : null}
                    <button
                      type="submit"
                      disabled={msCreating || !msPageId.trim() || !msToken.trim()}
                      className="mt-3 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                    >
                      {msCreating
                        ? t("channels.metaConnecting")
                        : t("channels.messengerConnectButton")}
                    </button>
                  </form>
                    ) : null}
                  </>
                ) : null}

                {connectStep === "instagram" ? (
                  <>
                    <MetaOAuthStepBlock
                      t={t}
                      provider="instagram"
                      available={
                        oauthInfo?.providers.instagram.available ?? false
                      }
                      starting={oauthStarting}
                      startError={oauthStartError}
                      onStart={(p) => void handleOAuthStart(p)}
                    />
                    <button
                      type="button"
                      onClick={() => setManualOpen((open) => !open)}
                      className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-accent"
                      aria-expanded={manualOpen}
                    >
                      {t("channels.oauthManualTitle")}
                      <ChevronRightIcon />
                    </button>
                    {manualOpen ? (
                  <form onSubmit={handleConnectInstagram}>
                    <label
                      className="mt-3 block text-sm font-medium"
                      htmlFor="instagram-name"
                    >
                      {t("channels.metaNameLabel")}
                    </label>
                    <input
                      id="instagram-name"
                      value={igName}
                      onChange={(e) => setIgName(e.target.value)}
                      placeholder={t("channels.metaNamePlaceholder")}
                      maxLength={255}
                      className={`${inputClassName} mt-1`}
                    />
                    <label
                      className="mt-3 block text-sm font-medium"
                      htmlFor="instagram-ig-id"
                    >
                      {t("channels.igIdLabel")}
                    </label>
                    <input
                      id="instagram-ig-id"
                      value={igId}
                      onChange={(e) => setIgId(e.target.value)}
                      placeholder={t("channels.igIdPlaceholder")}
                      maxLength={64}
                      className={`${inputClassName} mt-1`}
                    />
                    <fieldset className="mt-3">
                      <legend className="text-sm font-medium">
                        {t("channels.igTokenTypeLabel")}
                      </legend>
                      <div className="mt-1 flex flex-wrap gap-4">
                        <label className="inline-flex items-center gap-2 text-sm">
                          <input
                            type="radio"
                            name="instagram-token-type"
                            value="page_access_token"
                            checked={igTokenType === "page_access_token"}
                            onChange={() =>
                              setIgTokenType("page_access_token")
                            }
                          />
                          {t("channels.igTokenTypePage")}
                        </label>
                        <label className="inline-flex items-center gap-2 text-sm">
                          <input
                            type="radio"
                            name="instagram-token-type"
                            value="system_user_token"
                            checked={igTokenType === "system_user_token"}
                            onChange={() =>
                              setIgTokenType("system_user_token")
                            }
                          />
                          {t("channels.igTokenTypeSystemUser")}
                        </label>
                      </div>
                    </fieldset>
                    {igTokenType === "page_access_token" ? (
                      <>
                        <label
                          className="mt-3 block text-sm font-medium"
                          htmlFor="instagram-page-id"
                        >
                          {t("channels.pageIdLabel")}
                        </label>
                        <input
                          id="instagram-page-id"
                          value={igPageId}
                          onChange={(e) => setIgPageId(e.target.value)}
                          placeholder={t("channels.pageIdPlaceholder")}
                          maxLength={64}
                          className={`${inputClassName} mt-1`}
                        />
                      </>
                    ) : null}
                    <label
                      className="mt-3 block text-sm font-medium"
                      htmlFor="instagram-token"
                    >
                      {igTokenType === "system_user_token"
                        ? t("channels.suatTokenLabel")
                        : t("channels.pageTokenLabel")}
                    </label>
                    <PasswordInput
                      t={t}
                      id="instagram-token"
                      autoComplete="off"
                      value={igToken}
                      onChange={(e) => setIgToken(e.target.value)}
                      placeholder={
                        igTokenType === "system_user_token"
                          ? t("channels.suatTokenPlaceholder")
                          : t("channels.pageTokenPlaceholder")
                      }
                      maxLength={1024}
                      className={`${inputClassName} mt-1`}
                    />
                    <p className="mt-1 text-xs text-muted">
                      {igTokenType === "system_user_token"
                        ? t("channels.suatTokenHint")
                        : t("channels.metaTokenHint")}
                    </p>
                    {igError ? (
                      <div className="mt-2">
                        <FieldError message={igError} />
                      </div>
                    ) : null}
                    <button
                      type="submit"
                      disabled={
                        igCreating ||
                        !igId.trim() ||
                        (igTokenType === "page_access_token" &&
                          !igPageId.trim()) ||
                        !igToken.trim()
                      }
                      className="mt-3 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                    >
                      {igCreating
                        ? t("channels.metaConnecting")
                        : t("channels.instagramConnectButton")}
                    </button>
                  </form>
                    ) : null}
                  </>
                ) : null}

                {connectStep === "threads" ? (
                  <ThreadsOAuthStepBlock
                    t={t}
                    info={threadsOAuthInfo}
                    starting={threadsOAuthStarting}
                    startError={threadsOAuthStartError}
                    onStart={() => void handleThreadsOAuthStart()}
                  />
                ) : null}

                {connectStep === "whatsapp" ? (
                  <>
                    <MetaOAuthStepBlock
                      t={t}
                      provider="whatsapp"
                      available={
                        oauthInfo?.providers.whatsapp.available ?? false
                      }
                      starting={oauthStarting}
                      startError={oauthStartError}
                      onStart={(p) => void handleOAuthStart(p)}
                    />
                    <button
                      type="button"
                      onClick={() => setManualOpen((open) => !open)}
                      className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-accent"
                      aria-expanded={manualOpen}
                    >
                      {t("channels.oauthManualTitle")}
                      <ChevronRightIcon />
                    </button>
                    {manualOpen ? (
                  <form onSubmit={handleConnectWhatsApp}>
                    <label
                      className="mt-3 block text-sm font-medium"
                      htmlFor="whatsapp-name"
                    >
                      {t("channels.metaNameLabel")}
                    </label>
                    <input
                      id="whatsapp-name"
                      value={waName}
                      onChange={(e) => setWaName(e.target.value)}
                      placeholder={t("channels.metaNamePlaceholder")}
                      maxLength={255}
                      className={`${inputClassName} mt-1`}
                    />
                    <label
                      className="mt-3 block text-sm font-medium"
                      htmlFor="whatsapp-waba-id"
                    >
                      {t("channels.wabaIdLabel")}
                    </label>
                    <input
                      id="whatsapp-waba-id"
                      value={waWabaId}
                      onChange={(e) => setWaWabaId(e.target.value)}
                      placeholder={t("channels.wabaIdPlaceholder")}
                      maxLength={64}
                      className={`${inputClassName} mt-1`}
                    />
                    <label
                      className="mt-3 block text-sm font-medium"
                      htmlFor="whatsapp-phone-id"
                    >
                      {t("channels.phoneNumberIdLabel")}
                    </label>
                    <input
                      id="whatsapp-phone-id"
                      value={waPhoneId}
                      onChange={(e) => setWaPhoneId(e.target.value)}
                      placeholder={t("channels.phoneNumberIdPlaceholder")}
                      maxLength={64}
                      className={`${inputClassName} mt-1`}
                    />
                    <label
                      className="mt-3 block text-sm font-medium"
                      htmlFor="whatsapp-token"
                    >
                      {t("channels.waTokenLabel")}
                    </label>
                    <PasswordInput
                      t={t}
                      id="whatsapp-token"
                      autoComplete="off"
                      value={waToken}
                      onChange={(e) => setWaToken(e.target.value)}
                      placeholder={t("channels.waTokenPlaceholder")}
                      maxLength={1024}
                      className={`${inputClassName} mt-1`}
                    />
                    <p className="mt-1 text-xs text-muted">
                      {t("channels.waTokenHint")}
                    </p>
                    {waError ? (
                      <div className="mt-2">
                        <FieldError message={waError} />
                      </div>
                    ) : null}
                    <button
                      type="submit"
                      disabled={
                        waCreating ||
                        !waWabaId.trim() ||
                        !waPhoneId.trim() ||
                        !waToken.trim()
                      }
                      className="mt-3 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                    >
                      {waCreating
                        ? t("channels.metaConnecting")
                        : t("channels.whatsappConnectButton")}
                    </button>
                  </form>
                    ) : null}
                  </>
                ) : null}

                <div className="mt-4 flex justify-end">
                  <button
                    type="button"
                    onClick={() => setConnectStep(null)}
                    className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium"
                  >
                    {t("common.close")}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}

      {oauthSessionId ? (
        <div
          className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-label={t("channels.oauthPickerTitle")}
        >
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-xl sm:rounded-2xl">
            <h2 className="text-lg font-bold">
              {t("channels.oauthPickerTitle")}
            </h2>
            <p className="mt-1 text-sm text-muted">
              {t("channels.oauthPickerBody")}
            </p>
            {!oauthSession && !oauthSessionError ? (
              <p className="mt-4 text-sm text-muted">
                {t("channels.oauthPickerLoading")}
              </p>
            ) : null}
            {oauthSessionError ? (
              <div className="mt-3">
                <FieldError message={oauthSessionError} />
              </div>
            ) : null}
            {oauthSession && oauthSession.assets.length === 0 ? (
              <p className="mt-4 text-sm text-muted">
                {/* Fase 7D.3: petunjuk spesifik per penyebab kosong
                    (jenis token / izin bisnis / belum dibagikan) —
                    generik hanya bila server tak memberi petunjuk. */}
                {oauthSession.emptyHint === "not_system_user"
                  ? t("channels.oauthPickerEmptyNotSystemUser")
                  : oauthSession.emptyHint === "no_accounts_shared"
                    ? t("channels.oauthPickerEmptyNoAccounts")
                    : oauthSession.emptyHint ===
                        "business_permission_missing"
                      ? t("channels.oauthPickerEmptyBusinessPermission")
                      : t("channels.oauthPickerEmpty")}
              </p>
            ) : null}
            {oauthSession
              ? oauthGroups.map((group) => (
                  <div key={group.key} className="mt-4">
                    {oauthSession.provider === "whatsapp" ? (
                      <div className="text-xs font-semibold uppercase tracking-wide text-muted">
                        {group.parentName ?? group.key}
                      </div>
                    ) : null}
                    <div className="mt-2 space-y-2">
                      {group.assets.map((asset) => {
                        const title =
                          asset.name ??
                          (asset.handle
                            ? `@${asset.handle}`
                            : asset.assetId);
                        const subtitle =
                          oauthSession.provider === "whatsapp"
                            ? asset.handle
                            : asset.name && asset.handle
                              ? `@${asset.handle}`
                              : null;
                        // Hotfix R1: aset yang ditemukan tetapi tidak
                        // punya kredensial yang dapat dipakai (Page
                        // tanpa Page token) tetap ditampilkan —
                        // diredupkan, beralasan, tombol nonaktif.
                        const unavailable = asset.connectable === false;
                        return (
                          <div
                            key={asset.assetId}
                            className={`flex items-center gap-3 rounded-xl border border-line p-3${unavailable ? " opacity-70" : ""}`}
                          >
                            <ChannelAvatar
                              provider={oauthSession.provider}
                              name={title}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="truncate font-semibold">
                                {title}
                              </div>
                              {subtitle ? (
                                <div className="truncate font-mono text-sm text-muted">
                                  {subtitle}
                                </div>
                              ) : null}
                              {asset.linkedIgUsername ? (
                                <div className="truncate text-xs text-muted">
                                  {t("channels.oauthLinkedIgLabel", {
                                    username: asset.linkedIgUsername,
                                  })}
                                </div>
                              ) : null}
                              {unavailable ? (
                                <div className="mt-1 text-xs text-muted">
                                  {t(
                                    "channels.oauthPickerUnavailableMissingToken",
                                  )}
                                </div>
                              ) : null}
                            </div>
                            <button
                              type="button"
                              disabled={
                                oauthCompletingId !== null || unavailable
                              }
                              onClick={() => void handleOAuthComplete(asset)}
                              className="shrink-0 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
                            >
                              {oauthCompletingId === asset.assetId
                                ? t("channels.oauthPickerConnecting")
                                : t("channels.oauthPickerConnect")}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))
              : null}
            {oauthCompleteError ? (
              <div className="mt-3">
                <FieldError message={oauthCompleteError} />
              </div>
            ) : null}
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={closeOAuthPicker}
                disabled={oauthCompletingId !== null}
                className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium disabled:opacity-60"
              >
                {t("channels.oauthPickerCancel")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {deleteTarget ? (
        <div
          className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-xl sm:rounded-2xl">
            <h2 className="text-lg font-bold">{t("channels.deleteTitle")}</h2>
            <p className="mt-2 text-sm text-muted">
              {t("channels.deleteBody", {
                name:
                  deleteTarget.displayName ||
                  providerLabel(t, deleteTarget.provider),
              })}
            </p>
            <button
              type="button"
              onClick={() => void handleExport(deleteTarget)}
              className="mt-3 rounded-lg bg-elevated px-4 py-2 text-sm font-medium"
            >
              {t("channels.deleteExportButton")}
            </button>
            <label
              className="mt-4 block text-sm font-medium"
              htmlFor="delete-confirm-name"
            >
              {t("channels.deleteConfirmLabel")}:{" "}
              <span className="font-mono font-semibold">
                {deleteTarget.confirmationName}
              </span>
            </label>
            <input
              id="delete-confirm-name"
              value={deleteName}
              onChange={(e) => setDeleteName(e.target.value)}
              className={`${inputClassName} mt-1`}
              autoComplete="off"
            />
            {deleteError ? (
              <div className="mt-2">
                <FieldError message={deleteError} />
              </div>
            ) : null}
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                disabled={deleting || deleteName !== deleteTarget.confirmationName}
                onClick={() => void handleTrash()}
                className="rounded-lg bg-danger px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {deleting
                  ? t("channels.deleting")
                  : t("channels.deleteConfirmButton")}
              </button>
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium"
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {disconnectTarget ? (
        <div
          className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-xl sm:rounded-2xl">
            <h2 className="text-lg font-bold">{t("channels.disconnectTitle")}</h2>
            <p className="mt-2 text-sm text-muted">
              {t("channels.disconnectBody", {
                name:
                  disconnectTarget.displayName ||
                  providerLabel(t, disconnectTarget.provider),
              })}
            </p>
            {disconnectError ? (
              <div className="mt-2">
                <FieldError message={disconnectError} />
              </div>
            ) : null}
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                disabled={disconnecting}
                onClick={() => void handleDisconnect()}
                className="rounded-lg bg-danger px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {disconnecting
                  ? t("channels.disconnecting")
                  : t("channels.disconnectButton")}
              </button>
              <button
                type="button"
                onClick={() => setDisconnectTarget(null)}
                className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium"
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
