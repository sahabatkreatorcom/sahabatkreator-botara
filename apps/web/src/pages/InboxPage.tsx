import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type {
  ConversationNoteResponse,
  ConversationResponse,
  ConversationStatus,
  MessageReplyTo,
  MessageResponse,
  SavedReplyResponse,
  TeamMemberResponse,
  WhatsAppTemplateResponse,
} from "@sahabat-kreator/contracts";
import type { Locale, TranslationKey } from "@sahabat-kreator/i18n";
import { api, ApiClientError } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { translateApiError } from "../api/errorText";
import { FieldError, inputClassName } from "../components/AuthLayout";
import { Avatar } from "../components/Avatar";
import {
  LIVE_REFRESH_INTERVAL_MS,
  usePolling,
} from "../hooks/usePolling";
import { useNudgeSubscription } from "../hooks/useRealtime";
import { useUnreadBadge } from "../inbox/UnreadBadgeProvider";
import { formatListTime, formatTime } from "../utils/format";
import { useWorkspace } from "../workspace/WorkspaceProvider";

type Translate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

const MESSAGE_LIMIT = 100;

interface InboxPageProps {
  t: Translate;
  locale: Locale;
  /**
   * Percakapan terpilih MENURUT URL (Fase 6E): segmen id pada
   * /inbox/:conversationId, atau null pada /inbox polos. Pilihan TIDAK
   * lagi state lokal — URL adalah sumber kebenarannya, agar deep-link,
   * refresh, dan Back/Forward berperilaku seperti halaman web biasa.
   */
  conversationId: string | null;
  /**
   * Minta perubahan pilihan lewat URL. `replace: true` membersihkan id
   * basi (pindah workspace / id tidak valid) tanpa entri riwayat baru,
   * supaya Back tidak mengembalikan pengguna ke id yang sudah gugur.
   */
  onConversationChange: (
    id: string | null,
    opts?: { replace?: boolean },
  ) => void;
}

/**
 * Halaman Inbox (Fase 1E): dua kolom responsif di atas API 1D.
 * - Kiri: daftar percakapan workspace aktif (nama kontak, cuplikan pesan
 *   terakhir, waktu, badge unread, label provider & status).
 * - Kanan: utas pesan kronologis + kotak balas. POST balasan membuat pesan
 *   outbound berstatus `queued` (pengiriman ke channel adalah stub Fase 1D —
 *   diberi label jujur lewat `inbox.deliveryNote`).
 * - Layar kecil: daftar dan utas bergantian; tombol kembali muncul di utas.
 * - Setelah kirim: utas dimuat ulang dari server + daftar percakapan
 *   disegarkan (cuplikan & urutan ikut berubah), badge nav disinkronkan.
 * - Penyegaran langsung: sejak Hotfix Dashboard Realtime daftar, utas
 *   yang terbuka, dan badge disegarkan otomatis; sejak Fase 6G transport
 *   utamanya PUSH (nudge WebSocket apps/realtime memicu penyegaran
 *   senyap yang sama) dan polling ±5 dtk turun menjadi fallback —
 *   keduanya tanpa mengganggu draf ketikan maupun posisi scroll agen.
 * - Pilihan percakapan hidup di URL (Fase 6E): /inbox/:conversationId —
 *   klik daftar menavigasi (push), membuka URL langsung memilih
 *   percakapan itu, id tak valid jatuh lembut kembali ke /inbox.
 */
export function InboxPage({ t, locale, conversationId, onConversationChange }: InboxPageProps) {
  const { user } = useAuth();
  const { status, tenants, active, reload } = useWorkspace();
  const { setFromConversations } = useUnreadBadge();
  const tenantId = active?.id ?? null;

  const [conversations, setConversations] = useState<ConversationResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Pilihan = prop dari URL; TIDAK ada state pilihan lokal lagi.
  const selectedId = conversationId;

  const [messages, setMessages] = useState<MessageResponse[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState<string | null>(null);

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // Fase 9A — saved replies (macro `/`): pustaka workspace untuk
  // composer; pemilih muncul saat draf diawali "/", panel kelola
  // dibuka dari tombol di atas composer.
  const [savedReplies, setSavedReplies] = useState<SavedReplyResponse[]>([]);
  const [savedRepliesError, setSavedRepliesError] = useState<string | null>(null);
  const [srPanelOpen, setSrPanelOpen] = useState(false);
  const [pickerIndex, setPickerIndex] = useState(0);
  const [pickerDismissed, setPickerDismissed] = useState(false);
  const [srForm, setSrForm] = useState<{ id: string | null; title: string; body: string }>({
    id: null,
    title: "",
    body: "",
  });
  const [srSaving, setSrSaving] = useState(false);
  const [srDeleteConfirmId, setSrDeleteConfirmId] = useState<string | null>(null);

  // Fase 7B.5 — balas dengan kutipan: target yang sedang dikutip
  // (chip di atas composer) + id pesan yang sedang disorot sesaat
  // setelah lompat dari klik blok kutipan.
  const [quoteTarget, setQuoteTarget] = useState<MessageResponse | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const highlightTimerRef = useRef<number | null>(null);

  const threadRef = useRef<HTMLDivElement | null>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;
  const onConversationChangeRef = useRef(onConversationChange);
  onConversationChangeRef.current = onConversationChange;
  const tenantIdRef = useRef<string | null>(null);
  const conversationsRef = useRef<ConversationResponse[]>([]);
  conversationsRef.current = conversations;
  // Agen dianggap "menempel di bawah" utas (pantas ikut turun saat pesan
  // baru tiba) hanya bila posisi scroll-nya dekat dasar; begitu ia scroll
  // ke atas membaca riwayat, penyegaran latar TIDAK boleh menyeretnya.
  const stickToBottomRef = useRef(true);

  // Fase 9C — penugasan & catatan internal: filter daftar (semua / milik
  // saya / belum ditugaskan), daftar member untuk pemilih penerima tugas,
  // dan tab panel (Pesan | Catatan). Filter disimpan juga di ref agar
  // penyegaran latar menghormatinya (daftar tidak boleh "melompat"
  // kembali ke Semua setiap siklus polling).
  const [assignmentFilter, setAssignmentFilter] = useState<
    "all" | "mine" | "unassigned"
  >("all");
  const assignmentFilterRef = useRef<"all" | "mine" | "unassigned">("all");
  const [members, setMembers] = useState<TeamMemberResponse[]>([]);
  const [assignError, setAssignError] = useState<string | null>(null);
  const [panelTab, setPanelTab] = useState<"messages" | "notes">("messages");
  const [notes, setNotes] = useState<ConversationNoteResponse[]>([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [notesError, setNotesError] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteSaving, setNoteSaving] = useState(false);
  // Fase 16C — halaman pesan lebih lama: `hasMore` dari server, dan status
  // muat supaya tombolnya tidak bisa ditekan dua kali.
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Fase 16C — ubah status kerja & nyalakan/matikan AI per percakapan.
  const [statusSaving, setStatusSaving] = useState(false);
  const [agentSaving, setAgentSaving] = useState(false);
  const [metaError, setMetaError] = useState<string | null>(null);
  // Fase 16C: pengiriman template WhatsApp. Ini pasangan dari banner
  // "jendela tertutup" — tanpanya banner itu hanya memberi tahu masalah
  // tanpa memberi jalan keluar, karena tidak ada tempat lain di inbox
  // untuk mengirim template ke SATU kontak.
  const [templateOpen, setTemplateOpen] = useState(false);
  const [templates, setTemplates] = useState<WhatsAppTemplateResponse[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [templateParams, setTemplateParams] = useState<string[]>([]);
  const [templateSending, setTemplateSending] = useState(false);
  // Fase 16C: pencarian percakapan (nama kontak / nomor / judul).
  const [searchInput, setSearchInput] = useState("");
  const searchRef = useRef("");
  const searchTimerRef = useRef<number | null>(null);
  const myMember = members.find((m) => m.isSelf) ?? null;
  const canModerateNotes =
    myMember?.role === "owner" || myMember?.role === "admin";

  const loadConversations = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    setError(null);
    try {
      const filter = assignmentFilterRef.current;
      const search = searchRef.current.trim();
      const list = await api.conversations.list(tenantId, {
        ...(filter === "all" ? {} : { assignment: filter }),
        ...(search ? { q: search } : {}),
      });
      setConversations(list);
      // Badge navigasi menghitung unread SELURUH workspace — hanya daftar
      // TANPA filter dan TANPA pencarian yang boleh menyinkronkannya.
      // Daftar hasil pencarian adalah potongan, bukan keseluruhan.
      if (filter === "all" && !search) setFromConversations(list);
    } catch (err) {
      setError(translateApiError(t, err));
      setConversations([]);
    } finally {
      setLoading(false);
    }
  }, [tenantId, t, setFromConversations]);

  /**
   * Fase 16C: pencarian dengan jeda 300 ms.
   *
   * Nilainya ditulis ke ref SEBELUM jeda supaya penyegaran latar (polling
   * & nudge realtime) memakai kata kunci yang sama — tanpa itu, siklus
   * polling berikutnya akan mengembalikan daftar tanpa filter dan kotak
   * pencarian tampak "tidak berfungsi" sesaat kemudian.
   */
  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchInput(value);
      searchRef.current = value;
      if (searchTimerRef.current !== null) {
        window.clearTimeout(searchTimerRef.current);
      }
      searchTimerRef.current = window.setTimeout(() => {
        searchTimerRef.current = null;
        void loadConversations();
      }, 300);
    },
    [loadConversations],
  );

  useEffect(() => {
    return () => {
      if (searchTimerRef.current !== null) {
        window.clearTimeout(searchTimerRef.current);
      }
    };
  }, []);

  // Ganti workspace → daftar direset, data workspace baru dimuat. Pilihan
  // di URL dibersihkan (replace) HANYA pada perpindahan workspace
  // sungguhan — muat awal (tenant null → tenant pertama) TIDAK
  // membersihkan, karena deep-link /inbox/:id memang harus membuka
  // percakapan pada workspace awal itu.
  useEffect(() => {
    const prevTenantId = tenantIdRef.current;
    tenantIdRef.current = tenantId;
    if (
      prevTenantId !== null &&
      tenantId !== null &&
      prevTenantId !== tenantId &&
      selectedRef.current
    ) {
      onConversationChangeRef.current(null, { replace: true });
    }
    setMessages([]);
    setHasOlderMessages(false);
    setDraft("");
    // Panel template menempel pada SATU percakapan; membiarkannya
    // terbuka saat pindah utas akan menampilkan template milik nomor
    // lain (dan parameter yang sudah terisi untuk orang lain).
    setTemplateOpen(false);
    setTemplateId("");
    setTemplateParams([]);
    setTemplatesError(null);
    void loadConversations();
  }, [loadConversations, tenantId]);

  const loadMessages = useCallback(
    async (conversationId: string) => {
      if (!tenantId) return;
      setMessagesLoading(true);
      setMessagesError(null);
      try {
        const page = await api.conversations.listMessages(
          tenantId,
          conversationId,
          { limit: MESSAGE_LIMIT },
        );
        if (selectedRef.current !== conversationId) return;
        setMessages(page.messages);
        setHasOlderMessages(page.hasMore);
        // Server menandai percakapan terbaca saat utas dibuka (API GET
        // messages) — sinkronkan daftar lokal & badge navigasi sekarang
        // juga, tanpa menunggu muat ulang daftar (bug QA-1: chip unread
        // & badge tidak pernah bersih setelah percakapan dibuka).
        const current = conversationsRef.current;
        if (
          current.some(
            (c) => c.id === conversationId && c.unreadCount > 0,
          )
        ) {
          const next = current.map((c) =>
            c.id === conversationId ? { ...c, unreadCount: 0 } : c,
          );
          setConversations(next);
          if (assignmentFilterRef.current === "all") {
            setFromConversations(next);
          }
        }
      } catch (err) {
        if (selectedRef.current !== conversationId) return;
        if (err instanceof ApiClientError && err.status === 404) {
          // Deep-link ke percakapan yang tidak ada / bukan milik
          // workspace aktif (API menjawab 404 untuk keduanya): jatuh
          // lembut ke daftar — URL dibersihkan dengan replace, TANPA
          // pesan error (Fase 6E).
          setMessages([]);
          setMessagesError(null);
          onConversationChangeRef.current(null, { replace: true });
          return;
        }
        setMessagesError(translateApiError(t, err));
        setMessages([]);
      } finally {
        if (selectedRef.current === conversationId) setMessagesLoading(false);
      }
    },
    [tenantId, t, setFromConversations],
  );

  useEffect(() => {
    if (selectedId) void loadMessages(selectedId);
  }, [selectedId, loadMessages]);

  // Fase 9C: daftar member workspace untuk pemilih penerima tugas.
  // Kegagalan ditelan — inbox tetap berfungsi, pemilih hanya kosong.
  useEffect(() => {
    if (!tenantId) {
      setMembers([]);
      return;
    }
    let cancelled = false;
    api.team
      .listMembers(tenantId)
      .then((rows) => {
        if (!cancelled) setMembers(rows);
      })
      .catch(() => {
        if (!cancelled) setMembers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  const changeAssignmentFilter = useCallback(
    (filter: "all" | "mine" | "unassigned") => {
      assignmentFilterRef.current = filter;
      setAssignmentFilter(filter);
      void loadConversations();
    },
    [loadConversations],
  );

  const handleAssign = useCallback(
    async (conversationId: string, assigneeUserId: string | null) => {
      if (!tenantId) return;
      setAssignError(null);
      try {
        const updated = await api.conversations.assign(
          tenantId,
          conversationId,
          assigneeUserId,
        );
        setConversations((prev) => {
          const next = prev.map((c) => (c.id === updated.id ? updated : c));
          // Filter aktif bisa membuat baris ini tidak lagi cocok (mis.
          // melepas tugas saat filter "Milik saya") — keluarkan dari
          // daftar agar tampilan konsisten dengan filter.
          const filter = assignmentFilterRef.current;
          if (filter === "mine") {
            const mineId = members.find((m) => m.isSelf)?.userId;
            return next.filter((c) => c.assigneeUserId === mineId);
          }
          if (filter === "unassigned") {
            return next.filter((c) => c.assigneeUserId === null);
          }
          return next;
        });
      } catch (err) {
        setAssignError(translateApiError(t, err));
      }
    },
    [tenantId, t, members],
  );

  // Fase 16C: muat halaman pesan yang lebih tua. Kursor = id pesan TERTUA
  // yang sedang tampil; hasilnya DITEMPAHKAN di depan (bukan digabung di
  // akhir) karena server mengembalikan urutan kronologis menaik.
  const handleLoadOlder = useCallback(async () => {
    const conversationId = selectedRef.current;
    if (!tenantId || !conversationId || loadingOlder) return;
    const oldest = messages[0];
    if (!oldest) return;
    setLoadingOlder(true);
    setMessagesError(null);
    try {
      const page = await api.conversations.listMessages(
        tenantId,
        conversationId,
        { limit: MESSAGE_LIMIT, before: oldest.id },
      );
      if (selectedRef.current !== conversationId) return;
      setMessages((prev) => {
        // Jaga-jaga terhadap tumpang tindih (pesan yang tiba di antara
        // dua permintaan): saring id yang sudah ada.
        const seen = new Set(prev.map((m) => m.id));
        return [...page.messages.filter((m) => !seen.has(m.id)), ...prev];
      });
      setHasOlderMessages(page.hasMore);
    } catch (err) {
      setMessagesError(translateApiError(t, err));
    } finally {
      setLoadingOlder(false);
    }
  }, [tenantId, t, loadingOlder, messages]);

  // Fase 16C: ubah status kerja percakapan (open/pending/closed).
  const handleStatusChange = useCallback(
    async (conversationId: string, status: ConversationStatus) => {
      if (!tenantId) return;
      setMetaError(null);
      setStatusSaving(true);
      try {
        const updated = await api.conversations.setStatus(
          tenantId,
          conversationId,
          status,
        );
        setConversations((prev) =>
          prev.map((c) => (c.id === updated.id ? updated : c)),
        );
      } catch (err) {
        setMetaError(translateApiError(t, err));
      } finally {
        setStatusSaving(false);
      }
    },
    [tenantId, t],
  );

  // Fase 16C: nyalakan/matikan AI untuk percakapan ini. Tanpa tombol ini
  // satu handoff mematikan AI selamanya (tidak ada jalur balik di server
  // sebelum endpoint POST .../agent ada).
  const handleAgentToggle = useCallback(
    async (conversationId: string, agentEnabled: boolean) => {
      if (!tenantId) return;
      setMetaError(null);
      setAgentSaving(true);
      try {
        const updated = await api.conversations.setAgentEnabled(
          tenantId,
          conversationId,
          agentEnabled,
        );
        setConversations((prev) =>
          prev.map((c) => (c.id === updated.id ? updated : c)),
        );
      } catch (err) {
        setMetaError(translateApiError(t, err));
      } finally {
        setAgentSaving(false);
      }
    },
    [tenantId, t],
  );

  // Fase 9C: catatan internal — dimuat saat percakapan berganti (tab
  // Catatan langsung siap) dan direset bersama pilihan.
  const loadNotes = useCallback(
    async (conversationId: string) => {
      if (!tenantId) return;
      setNotesLoading(true);
      setNotesError(null);
      try {
        const list = await api.conversations.listNotes(tenantId, conversationId);
        if (selectedRef.current !== conversationId) return;
        setNotes(list);
      } catch (err) {
        if (selectedRef.current !== conversationId) return;
        setNotesError(translateApiError(t, err));
        setNotes([]);
      } finally {
        if (selectedRef.current === conversationId) setNotesLoading(false);
      }
    },
    [tenantId, t],
  );

  useEffect(() => {
    setPanelTab("messages");
    setNotes([]);
    setNoteDraft("");
    setNotesError(null);
    if (selectedId) void loadNotes(selectedId);
  }, [selectedId, loadNotes]);

  const handleNoteCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!tenantId || !selectedId || !noteDraft.trim()) return;
    setNoteSaving(true);
    setNotesError(null);
    try {
      const created = await api.conversations.createNote(
        tenantId,
        selectedId,
        noteDraft.trim(),
      );
      setNotes((prev) => [...prev, created]);
      setNoteDraft("");
    } catch (err) {
      setNotesError(translateApiError(t, err));
    } finally {
      setNoteSaving(false);
    }
  };

  const handleNoteDelete = async (note: ConversationNoteResponse) => {
    if (!tenantId || !selectedId) return;
    setNotesError(null);
    try {
      await api.conversations.deleteNote(tenantId, selectedId, note.id);
      setNotes((prev) => prev.filter((n) => n.id !== note.id));
    } catch (err) {
      setNotesError(translateApiError(t, err));
    }
  };

  // --- Penyegaran latar (Hotfix Dashboard Realtime → Fase 6G) ----------
  // Versi SENYAP dari pemuatan awal: tidak menyalakan status memuat,
  // tidak memasang error, tidak menyentuh draf balasan maupun pilihan
  // percakapan. Kegagalan sesaat ditelan — siklus berikutnya mencoba
  // lagi. Dipicu DUA transport: nudge push apps/realtime (utama sejak
  // 6G) dan polling hooks/usePolling (fallback saat socket terputus).

  const refreshConversationsInBackground = useCallback(async () => {
    if (!tenantId) return;
    try {
      const filter = assignmentFilterRef.current;
      const search = searchRef.current.trim();
      const list = await api.conversations.list(tenantId, {
        ...(filter === "all" ? {} : { assignment: filter }),
        ...(search ? { q: search } : {}),
      });
      const openId = selectedRef.current;
      // Percakapan yang sedang dibuka sudah ditandai terbaca di server
      // oleh GET messages — paksa unread lokalnya 0 agar chip daftar &
      // badge tidak berkedip naik sesaat pada percakapan yang sedang
      // dibaca agen sendiri.
      const next =
        openId === null
          ? list
          : list.map((c) => (c.id === openId ? { ...c, unreadCount: 0 } : c));
      setConversations(next);
      // Sama seperti muat awal: daftar hasil pencarian bukan keseluruhan,
      // jadi tidak boleh menyetel badge unread workspace.
      if (filter === "all" && !search) setFromConversations(next);
    } catch {
      /* senyap — kegagalan latar bukan urusan agen */
    }
  }, [tenantId, setFromConversations]);

  const refreshMessagesInBackground = useCallback(async () => {
    const conversationId = selectedRef.current;
    if (!tenantId || !conversationId) return;
    try {
      const page = await api.conversations.listMessages(
        tenantId,
        conversationId,
        { limit: MESSAGE_LIMIT },
      );
      if (selectedRef.current !== conversationId) return;
      // Gabung per id pesan: salinan server menimpa versi lama (status
      // queued→sent ikut segar), pesan baru menempel di akhir mengikuti
      // urutan kronologis server — tanpa duplikat, tanpa mengganti
      // seluruh daftar (tidak ada kedip), draf ketikan tidak disentuh.
      // `hasMore` sengaja TIDAK ditimpa di sini: penyegaran latar selalu
      // memuat halaman terbaru, sedangkan halaman lama yang sudah dimuat
      // pengguna tidak boleh "hilang" dari penanda.
      setMessages((prev) => {
        const byId = new Map(page.messages.map((m) => [m.id, m]));
        const merged = prev.map((m) => byId.get(m.id) ?? m);
        const seen = new Set(prev.map((m) => m.id));
        for (const m of page.messages) {
          if (!seen.has(m.id)) merged.push(m);
        }
        return merged;
      });
      setMessagesError(null);
    } catch {
      /* senyap — siklus berikutnya mencoba lagi */
    }
  }, [tenantId]);

  const liveRefresh = useCallback(async () => {
    await refreshConversationsInBackground();
    await refreshMessagesInBackground();
  }, [refreshConversationsInBackground, refreshMessagesInBackground]);
  usePolling(liveRefresh, LIVE_REFRESH_INTERVAL_MS, tenantId !== null);
  // Fase 6G: nudge realtime memicu penyegaran senyap yang sama, seketika
  // — polling di atas kini hanya fallback saat socket terputus.
  useNudgeSubscription(() => {
    void liveRefresh();
  });

  // Pindah percakapan → utas dibuka dari pesan terbaru (menempel di bawah).
  // Target kutipan juga dibersihkan: mengutip lintas percakapan tidak sah.
  useEffect(() => {
    stickToBottomRef.current = true;
    setQuoteTarget(null);
    setHighlightedId(null);
  }, [selectedId]);

  // Timer sorotan kutipan dibersihkan saat halaman dilepas — tanpa ini,
  // berpindah halaman dalam 1,6 dtk memicu setState pada komponen mati.
  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) {
        window.clearTimeout(highlightTimerRef.current);
        highlightTimerRef.current = null;
      }
    };
  }, []);

  // Fase 9A — pustaka saved replies dimuat per workspace aktif.
  // Nomor urut permintaan: balasan yang datang terlambat (workspace sudah
  // berganti / permintaan lebih baru sudah jalan) TIDAK boleh menimpa
  // state dengan data workspace lama.
  const savedRepliesReqRef = useRef(0);
  const loadSavedReplies = useCallback(async () => {
    if (!tenantId) return;
    const seq = ++savedRepliesReqRef.current;
    try {
      const res = await api.savedReplies.list(tenantId);
      if (seq !== savedRepliesReqRef.current) return;
      setSavedReplies(res.replies);
      setSavedRepliesError(null);
    } catch {
      if (seq !== savedRepliesReqRef.current) return;
      setSavedRepliesError(t("inbox.savedReplies.loadError"));
    }
  }, [tenantId, t]);
  useEffect(() => {
    setSavedReplies([]);
    setSrPanelOpen(false);
    setSrForm({ id: null, title: "", body: "" });
    setSrDeleteConfirmId(null);
    void loadSavedReplies();
  }, [loadSavedReplies]);

  // Pemilih `/`: aktif hanya saat draf DIAWALI "/" — teks sesudahnya
  // adalah kata kunci filter (judul/isi, tak peka huruf).
  const pickerQuery = draft.startsWith("/") ? draft.slice(1) : null;
  const pickerMatches =
    pickerQuery === null
      ? []
      : savedReplies.filter((r) => {
          const q = pickerQuery.trim().toLowerCase();
          return (
            q === "" ||
            r.title.toLowerCase().includes(q) ||
            r.body.toLowerCase().includes(q)
          );
        });
  const pickerOpen =
    pickerQuery !== null && !pickerDismissed && !srPanelOpen && !!selectedId;

  const canManageReply = (r: SavedReplyResponse): boolean =>
    r.createdByUserId === user?.id ||
    active?.role === "owner" ||
    active?.role === "admin";

  /** Sisipkan macro: SELURUH draf diganti isi macro dengan {name}
   *  terganti nama kontak percakapan ini — WYSIWYG, agen melihat &
   *  bisa mengedit teks final sebelum mengirim. */
  const insertSavedReply = (reply: SavedReplyResponse) => {
    const conv = conversations.find((c) => c.id === selectedId);
    const name = conv?.contactName ?? conv?.title ?? "";
    setDraft(reply.body.replaceAll("{name}", name));
    setPickerDismissed(true);
  };

  const handleSrSave = async () => {
    if (!tenantId || srSaving) return;
    const title = srForm.title.trim();
    const body = srForm.body.trim();
    if (!title || !body) return;
    setSrSaving(true);
    setSavedRepliesError(null);
    try {
      if (srForm.id) {
        await api.savedReplies.update(tenantId, srForm.id, { title, body });
      } else {
        await api.savedReplies.create(tenantId, { title, body });
      }
      setSrForm({ id: null, title: "", body: "" });
      await loadSavedReplies();
    } catch {
      setSavedRepliesError(t("inbox.savedReplies.saveError"));
    } finally {
      setSrSaving(false);
    }
  };

  const handleSrDelete = async (reply: SavedReplyResponse) => {
    if (!tenantId) return;
    try {
      await api.savedReplies.remove(tenantId, reply.id);
      setSrDeleteConfirmId(null);
      if (srForm.id === reply.id) setSrForm({ id: null, title: "", body: "" });
      await loadSavedReplies();
    } catch {
      setSavedRepliesError(t("inbox.savedReplies.saveError"));
    }
  };

  // Ikut turun ke pesan terbaru HANYA bila agen sedang menempel di bawah;
  // agen yang sedang scroll ke atas membaca riwayat tidak diseret turun.
  useEffect(() => {
    const el = threadRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, messagesLoading]);

  const handleThreadScroll = () => {
    const el = threadRef.current;
    if (!el) return;
    stickToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  /**
   * Fase 7B.5: klik blok kutipan → gulir ke pesan asal + sorot sebentar.
   * Pesan asal yang TIDAK ada di utas termuat → tidak melakukan apa-apa
   * (bukan error — utas hanya memuat N pesan terakhir).
   */
  const jumpToQuotedMessage = (targetId: string) => {
    const el = document.getElementById(`inbox-msg-${targetId}`);
    if (!el) return;
    stickToBottomRef.current = false;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightedId(targetId);
    if (highlightTimerRef.current) {
      window.clearTimeout(highlightTimerRef.current);
    }
    highlightTimerRef.current = window.setTimeout(
      () => setHighlightedId(null),
      1600,
    );
  };

  const handleSend = async (e: FormEvent) => {
    e.preventDefault();
    const content = draft.trim();
    if (!tenantId || !selectedId || !content || sending) return;
    setSendError(null);
    setSending(true);
    try {
      const created = await api.conversations.sendMessage(
        tenantId,
        selectedId,
        content,
        quoteTarget?.id,
      );
      // Agen yang baru mengirim balasan selalu dibawa ke pesan terbaru.
      stickToBottomRef.current = true;
      setDraft("");
      // Kutipan terkirim → chip dibersihkan (hanya pada sukses; kirim
      // yang gagal mempertahankan chip agar agen bisa mencoba lagi).
      setQuoteTarget(null);
      // Tampilkan langsung pesan returned (status queued), lalu segarkan
      // utas & daftar dari server agar konsisten dengan sumber kebenaran.
      setMessages((prev) => [...prev, created]);
      // Spinner kirim berhenti DI SINI, bukan sesudah refresh. Pesan sudah
      // tampil dari respons POST, jadi menunggu dua GET di bawah tidak lagi
      // termasuk "sedang mengirim" — dulu `setSending(false)` baru berjalan
      // di `finally` sesudah keduanya, sehingga tombol terlihat berputar
      // selama tiga request berturut-turut.
      setSending(false);
      // Kedua refresh dijalankan PARALEL: sebelumnya berurutan
      // (`await` … lalu `await` …), jadi waktunya dijumlahkan.
      await Promise.all([loadMessages(selectedId), loadConversations()]);
    } catch (err) {
      setSendError(translateApiError(t, err));
    } finally {
      setSending(false);
    }
  };

  if (status === "loading") {
    return (
      <section>
        <h1 className="text-2xl font-bold text-ink">{t("inbox.title")}</h1>
        <p className="mt-6 text-sm text-muted">{t("workspace.loading")}</p>
      </section>
    );
  }
  if (status === "error") {
    return (
      <section>
        <h1 className="text-2xl font-bold text-ink">{t("inbox.title")}</h1>
        <div className="mt-6 rounded-xl border border-line bg-surface p-6">
          <p className="text-sm text-danger">{t("workspace.loadError")}</p>
          <button
            type="button"
            onClick={() => void reload()}
            className="mt-3 rounded-lg bg-elevated px-4 py-2 text-sm font-medium text-ink"
          >
            {t("common.retry")}
          </button>
        </div>
      </section>
    );
  }
  if (tenants.length === 0 || !active) {
    return (
      <section>
        <h1 className="text-2xl font-bold text-ink">{t("inbox.title")}</h1>
        <div className="mt-6 rounded-xl border border-dashed border-line bg-surface p-6">
          <h2 className="text-lg font-semibold text-ink">{t("workspace.emptyTitle")}</h2>
          <p className="mt-1 max-w-md text-sm text-muted">{t("workspace.emptyBody")}</p>
        </div>
      </section>
    );
  }

  const selected =
    conversations.find((c) => c.id === selectedId) ?? null;

  /**
   * Fase 16C: jendela pesan bebas tertutup (WhatsApp > 24 jam sejak pesan
   * masuk terakhir). Server MENOLAK balasan seperti ini (422
   * MESSAGING_WINDOW_CLOSED) — jadi kotak balasan dimatikan lebih dulu
   * beserta alasannya, bukan dibiarkan diketik lalu gagal.
   */
  const windowClosed =
    selected !== null &&
    selected.messagingWindow.enforced &&
    !selected.messagingWindow.open;

  /**
   * Fase 16C: hanya template APPROVED yang boleh dipakai — PENDING dan
   * REJECTED akan ditolak Meta, dan menampilkannya hanya membuat
   * pengguna memilih sesuatu yang pasti gagal.
   */
  const approvedTemplates = templates.filter((tpl) => tpl.status === "APPROVED");
  const selectedTemplate =
    approvedTemplates.find((tpl) => tpl.id === templateId) ?? null;

  const selectTemplate = (tpl: WhatsAppTemplateResponse) => {
    setTemplateId(tpl.id);
    // Variabel pertama diisi nama kontak — konvensi yang sama dengan
    // broadcast (sumber default posisi 1 = "name"). Sisanya dibiarkan
    // kosong: inbox adalah kiriman satu penerima, jadi manusia yang
    // memutuskan isi variabelnya, bukan pemetaan otomatis.
    setTemplateParams(
      Array.from({ length: tpl.variableCount }, (_, i) =>
        i === 0 ? (selected?.contactName ?? "") : "",
      ),
    );
  };

  const openTemplatePanel = async () => {
    if (!tenantId || !selected) return;
    setTemplateOpen(true);
    setTemplatesError(null);
    setTemplatesLoading(true);
    try {
      const res = await api.whatsappTemplates.list(
        tenantId,
        selected.channelAccountId,
      );
      setTemplates(res.templates);
      const approved = res.templates.filter((tpl) => tpl.status === "APPROVED");
      // Satu template = tidak ada yang perlu dipilih; langsung siapkan
      // parameter agar pengguna hanya mengisi nilainya.
      if (approved.length === 1) selectTemplate(approved[0]!);
    } catch (err) {
      setTemplatesError(translateApiError(t, err));
      setTemplates([]);
    } finally {
      setTemplatesLoading(false);
    }
  };

  const closeTemplatePanel = () => {
    setTemplateOpen(false);
    setTemplateId("");
    setTemplateParams([]);
    setTemplatesError(null);
  };

  const handleSendTemplate = async () => {
    if (!tenantId || !selected || !selectedTemplate || templateSending) return;
    setTemplateSending(true);
    setTemplatesError(null);
    try {
      const created = await api.conversations.sendTemplate(
        tenantId,
        selected.id,
        selectedTemplate.id,
        templateParams.map((value) => value.trim()),
      );
      stickToBottomRef.current = true;
      setMessages((prev) => [...prev, created]);
      closeTemplatePanel();
      await Promise.all([loadMessages(selected.id), loadConversations()]);
    } catch (err) {
      // Pesan server spesifik (belum APPROVED / variabel tidak cocok)
      // ditampilkan apa adanya — pengguna hanya bisa memperbaiki yang
      // disebutkan.
      setTemplatesError(translateApiError(t, err));
    } finally {
      setTemplateSending(false);
    }
  };

  // Fase 7B.5: label penulis & cuplikan blok kutipan (dari ringkasan
  // server `replyTo`) dan chip composer (dari pesan lokal yang dipilih).
  // Penulis masuk tanpa nama eksplisit = kontak/judul percakapan ini;
  // penulis keluar tanpa nama user teresolusi = label tim.
  const contactDisplayName = selected?.title ?? selected?.contactName ?? "";
  const quoteAuthorOfReplyTo = (replyTo: MessageReplyTo): string =>
    replyTo.authorLabel ??
    (replyTo.direction === "outbound"
      ? t("inbox.quoteTeamLabel")
      : contactDisplayName);
  const quotePreviewOfReplyTo = (replyTo: MessageReplyTo): string =>
    replyTo.contentPreview ??
    (replyTo.type === "text"
      ? t("inbox.mediaMessage")
      : t(`inbox.messageType.${replyTo.type}` as TranslationKey));
  // Hotfix 7B.6: label & cuplikan blok snapshot kutipan cadangan —
  // label penulis dari payload provider; kosong → cadangan per arah
  // yang sama seperti blok tertaut. Cuplikan kosong (media tanpa
  // caption) → label media umum.
  const quoteAuthorOfSnapshot = (msg: MessageResponse): string =>
    msg.replyToSnapshot?.authorLabel ??
    (msg.direction === "outbound"
      ? t("inbox.quoteTeamLabel")
      : contactDisplayName);
  const quotePreviewOfSnapshot = (msg: MessageResponse): string =>
    msg.replyToSnapshot?.contentPreview ?? t("inbox.mediaMessage");
  const quoteAuthorOfMessage = (msg: MessageResponse): string =>
    msg.senderName ??
    (msg.direction === "outbound"
      ? t("inbox.quoteTeamLabel")
      : contactDisplayName);
  const quotePreviewOfMessage = (msg: MessageResponse): string =>
    msg.contentText ?? t("inbox.mediaMessage");

  return (
    <section>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">{t("inbox.title")}</h1>
          <p className="mt-1 text-sm text-muted">{t("inbox.subtitle")}</p>
        </div>
        <button
          type="button"
          onClick={() => void loadConversations()}
          className="rounded-lg bg-elevated px-3 py-2 text-sm font-medium text-ink"
        >
          {t("common.reload")}
        </button>
      </div>

      <FieldError message={error} />

      {loading && conversations.length === 0 ? (
        <p className="mt-6 text-sm text-muted">{t("common.loading")}</p>
      ) : conversations.length === 0 && !error && assignmentFilter === "all" ? (
        <div className="mt-6 rounded-xl border border-dashed border-line bg-surface p-8 text-center">
          <h2 className="text-base font-semibold text-ink">{t("inbox.emptyTitle")}</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted">{t("inbox.emptyBody")}</p>
        </div>
      ) : (
        <div className="mt-5 flex h-[calc(100dvh-16rem)] min-h-[26rem] overflow-hidden rounded-xl border border-line bg-surface md:h-[calc(100dvh-12rem)]">
          {/* Kolom daftar — di mobile disembunyikan saat utas terbuka */}
          <div
            className={`w-full shrink-0 flex-col border-line md:flex md:w-80 md:border-r ${
              selected ? "hidden md:flex" : "flex"
            }`}
          >
            {/* Fase 16C: pencarian percakapan — nama kontak, nomor, atau
                judul grup/channel. Tanpa ini inbox hanya bisa digulir. */}
            <div className="border-b border-line px-3 py-2">
              <input
                type="search"
                value={searchInput}
                onChange={(e) => handleSearchChange(e.target.value)}
                placeholder={t("inbox.searchPlaceholder")}
                aria-label={t("inbox.searchPlaceholder")}
                className="w-full rounded-lg border border-line bg-bg px-2.5 py-1.5 text-xs text-ink placeholder:text-muted focus:border-accent focus:outline-none"
              />
            </div>
            {/* Fase 9C: filter penugasan — Semua | Milik saya | Belum ditugaskan */}
            <div className="flex gap-1 border-b border-line px-3 py-2">
              {(
                [
                  ["all", "inbox.assignment.filterAll"],
                  ["mine", "inbox.assignment.filterMine"],
                  ["unassigned", "inbox.assignment.filterUnassigned"],
                ] as const
              ).map(([value, labelKey]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => changeAssignmentFilter(value)}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
                    assignmentFilter === value
                      ? "bg-accent text-white"
                      : "bg-elevated text-muted hover:text-ink"
                  }`}
                >
                  {t(labelKey as TranslationKey)}
                </button>
              ))}
            </div>
            <ul className="flex-1 divide-y divide-line overflow-y-auto">
              {/* Daftar kosong di sini berarti FILTER atau PENCARIAN tidak
                  menemukan apa pun — bukan workspace yang kosong (kasus itu
                  ditangani blok di atas). Tanpa baris ini kolomnya hanya
                  kosong tanpa penjelasan. */}
              {conversations.length === 0 ? (
                <li className="px-3 py-6 text-center text-xs text-muted">
                  {searchInput.trim()
                    ? t("inbox.searchEmpty")
                    : t("inbox.filterEmpty")}
                </li>
              ) : null}
              {conversations.map((conv) => {
                const isActive = conv.id === selectedId;
                // Percakapan grup (Fase 6A.1) tampil dengan judul grupnya;
                // privat tetap nama kontak.
                const displayName = conv.title ?? conv.contactName;
                return (
                  <li key={conv.id}>
                    <button
                      type="button"
                      onClick={() => onConversationChange(conv.id)}
                      className={`flex w-full items-start gap-3 px-4 py-3 text-left ${
                        isActive ? "bg-accent/10" : "hover:bg-elevated"
                      }`}
                    >
                      <Avatar name={displayName} imageUrl={conv.contactAvatarUrl} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-sm font-semibold text-ink">
                            {displayName}
                          </span>
                          {conv.lastMessageAt ? (
                            <span className="shrink-0 text-[11px] text-muted">
                              {formatListTime(conv.lastMessageAt, locale)}
                            </span>
                          ) : null}
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-muted">
                          {conv.lastMessagePreview ?? t("inbox.mediaMessage")}
                        </span>
                        <span className="mt-1 flex flex-wrap items-center gap-1">
                          <span className="rounded-full bg-elevated px-2 py-0.5 text-[11px] font-medium text-ink">
                            {t(`inbox.providers.${conv.provider}` as TranslationKey)}
                          </span>
                          {conv.isGroup ? (
                            <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent">
                              {t("inbox.groupLabel")}
                            </span>
                          ) : null}
                          {conv.isChannel ? (
                            <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent">
                              {t("inbox.channelLabel")}
                            </span>
                          ) : null}
                          <span className="rounded-full bg-elevated px-2 py-0.5 text-[11px] font-medium text-muted">
                            {t(`inbox.status.${conv.status}` as TranslationKey)}
                          </span>
                          {conv.assigneeUserId ? (
                            <span
                              className="rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent"
                              title={t("inbox.assignment.assignedTo", {
                                name: conv.assigneeName ?? "",
                              })}
                            >
                              @{conv.assigneeName ?? "—"}
                            </span>
                          ) : null}
                        </span>
                      </span>
                      {conv.unreadCount > 0 ? (
                        <span className="mt-1 shrink-0 rounded-full bg-danger px-2 py-0.5 text-[11px] font-bold text-white">
                          {conv.unreadCount}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Kolom utas — di mobile hanya tampil saat ada pilihan */}
          <div
            className={`min-w-0 flex-1 flex-col ${
              selected ? "flex" : "hidden md:flex"
            }`}
          >
            {selected ? (
              <>
                <div className="flex items-center gap-3 border-b border-line px-4 py-3">
                  <button
                    type="button"
                    onClick={() => onConversationChange(null)}
                    className="rounded-lg bg-elevated px-3 py-1.5 text-sm font-medium text-ink md:hidden"
                  >
                    ← {t("common.back")}
                  </button>
                  <Avatar
                    name={selected.title ?? selected.contactName}
                    imageUrl={selected.contactAvatarUrl}
                  />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-bold text-ink">
                      {selected.title ?? selected.contactName}
                    </div>
                    <div className="text-xs text-muted">
                      {t(`inbox.providers.${selected.provider}` as TranslationKey)}
                      {selected.isChannel
                        ? ` · ${t("inbox.channelLabel")}`
                        : selected.isGroup
                          ? ` · ${t("inbox.groupLabel")}`
                          : ""}
                      {" · "}
                      {t(`inbox.status.${selected.status}` as TranslationKey)}
                      {selected.unreadCount > 0
                        ? ` · ${t("inbox.unreadLabel", { count: selected.unreadCount })}`
                        : ""}
                    </div>
                  </div>
                  {/* Fase 9C + 16C: status kerja, penerima tugas, AI */}
                  <div className="ml-auto flex shrink-0 flex-wrap items-end justify-end gap-2">
                    <div className="flex flex-col items-end gap-1">
                      <label
                        htmlFor="inbox-status"
                        className="text-[11px] font-medium text-muted"
                      >
                        {t("inbox.statusLabel")}
                      </label>
                      <select
                        id="inbox-status"
                        value={selected.status}
                        disabled={statusSaving}
                        onChange={(e) =>
                          void handleStatusChange(
                            selected.id,
                            e.target.value as ConversationStatus,
                          )
                        }
                        className="rounded-lg border border-line bg-surface px-2 py-1.5 text-xs text-ink disabled:opacity-60"
                      >
                        {(["open", "pending", "closed"] as const).map((s) => (
                          <option key={s} value={s}>
                            {t(`inbox.status.${s}` as TranslationKey)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <label
                        htmlFor="inbox-assignee"
                        className="text-[11px] font-medium text-muted"
                      >
                        {t("inbox.assignment.assignLabel")}
                      </label>
                      <select
                        id="inbox-assignee"
                        value={selected.assigneeUserId ?? ""}
                        onChange={(e) =>
                          void handleAssign(
                            selected.id,
                            e.target.value === "" ? null : e.target.value,
                          )
                        }
                        className="max-w-44 rounded-lg border border-line bg-surface px-2 py-1.5 text-xs text-ink"
                      >
                        <option value="">
                          {t("inbox.assignment.unassigned")}
                        </option>
                        {members.map((m) => (
                          <option key={m.userId} value={m.userId}>
                            {(m.name ?? m.email) +
                        (m.isSelf ? ` (${t("settings.team.youLabel")})` : "")}
                          </option>
                        ))}
                      </select>
                    </div>
                    {/*
                      Fase 16C: tombol AI. Sebelum ini `agentEnabled` hanya
                      bisa dibaca — nilainya hanya pernah ditulis false oleh
                      handoff, jadi sekali mati tidak pernah bisa dinyalakan.
                    */}
                    <button
                      type="button"
                      disabled={agentSaving}
                      onClick={() =>
                        void handleAgentToggle(selected.id, !selected.agentEnabled)
                      }
                      title={
                        selected.agentEnabled
                          ? t("inbox.agent.onHint")
                          : t("inbox.agent.offHint")
                      }
                      className={`rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-60 ${
                        selected.agentEnabled
                          ? "border-accent/40 bg-accent/10 text-accent"
                          : "border-line bg-elevated text-muted"
                      }`}
                    >
                      {selected.agentEnabled
                        ? t("inbox.agent.on")
                        : t("inbox.agent.off")}
                    </button>
                    {assignError || metaError ? (
                      <span className="w-full text-right text-[11px] text-danger">
                        {assignError ?? metaError}
                      </span>
                    ) : null}
                  </div>
                </div>

                {/* Fase 9C: tab panel — Pesan | Catatan internal */}
                <div className="flex gap-1 border-b border-line bg-surface px-4 pt-2">
                  {(
                    [
                      ["messages", "inbox.notes.tabMessages"],
                      ["notes", "inbox.notes.tabNotes"],
                    ] as const
                  ).map(([value, labelKey]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setPanelTab(value)}
                      className={`rounded-t-lg px-3 py-1.5 text-xs font-semibold ${
                        panelTab === value
                          ? "bg-bg text-accent"
                          : "text-muted hover:text-ink"
                      }`}
                    >
                      {t(labelKey as TranslationKey)}
                      {value === "notes" && notes.length > 0
                        ? ` (${notes.length})`
                        : ""}
                    </button>
                  ))}
                </div>

                {panelTab === "notes" ? (
                  <div className="flex min-h-0 flex-1 flex-col bg-bg">
                    <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
                      <p className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
                        {t("inbox.notes.hint")}
                      </p>
                      {notesLoading ? (
                        <p className="text-sm text-muted">{t("common.loading")}</p>
                      ) : notesError && notes.length === 0 ? (
                        <p className="text-sm text-danger">{notesError}</p>
                      ) : notes.length === 0 ? (
                        <p className="text-sm text-muted">{t("inbox.notes.empty")}</p>
                      ) : (
                        <ul className="space-y-3">
                          {notes.map((note) => (
                            <li
                              key={note.id}
                              className="rounded-xl border border-warning/30 bg-warning/10 px-3 py-2"
                            >
                              <div className="flex items-baseline justify-between gap-2">
                                <span className="text-xs font-semibold text-ink">
                                  {note.authorName ??
                                    t("inbox.notes.formerMember")}
                                </span>
                                <span className="flex shrink-0 items-center gap-2 text-[11px] text-muted">
                                  {formatTime(note.createdAt, locale)}
                                  {note.authorUserId === myMember?.userId ||
                                  canModerateNotes ? (
                                    <button
                                      type="button"
                                      onClick={() => void handleNoteDelete(note)}
                                      className="font-medium text-danger"
                                    >
                                      {t("inbox.notes.deleteButton")}
                                    </button>
                                  ) : null}
                                </span>
                              </div>
                              <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink">
                                {note.body}
                              </p>
                            </li>
                          ))}
                        </ul>
                      )}
                      {notesError && notes.length > 0 ? (
                        <p className="text-sm text-danger">{notesError}</p>
                      ) : null}
                    </div>
                    <form
                      onSubmit={handleNoteCreate}
                      className="border-t border-line bg-surface px-4 py-3"
                    >
                      <div className="flex items-end gap-2">
                        <textarea
                          value={noteDraft}
                          onChange={(e) => setNoteDraft(e.target.value)}
                          placeholder={t("inbox.notes.placeholder")}
                          rows={2}
                          maxLength={4000}
                          className={`${inputClassName} resize-none`}
                        />
                        <button
                          type="submit"
                          disabled={noteSaving || !noteDraft.trim()}
                          className="shrink-0 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                        >
                          {noteSaving
                            ? t("inbox.notes.adding")
                            : t("inbox.notes.addButton")}
                        </button>
                      </div>
                    </form>
                  </div>
                ) : (
                <>
                <div
                  ref={threadRef}
                  onScroll={handleThreadScroll}
                  className="flex-1 space-y-3 overflow-y-auto bg-bg px-4 py-4"
                >
                  {messagesLoading ? (
                    <p className="text-sm text-muted">{t("common.loading")}</p>
                  ) : messagesError ? (
                    <div>
                      <p className="text-sm text-danger">{messagesError}</p>
                      <button
                        type="button"
                        onClick={() => void loadMessages(selected.id)}
                        className="mt-2 rounded-lg bg-elevated px-3 py-1.5 text-sm font-medium text-ink"
                      >
                        {t("common.retry")}
                      </button>
                    </div>
                  ) : (
                    <>
                      {/* Fase 16C: halaman lebih lama. Sebelum ini hanya
                          50 pesan terakhir yang bisa dijangkau sama sekali. */}
                      {hasOlderMessages ? (
                        <div className="flex justify-center pb-1">
                          <button
                            type="button"
                            onClick={() => void handleLoadOlder()}
                            disabled={loadingOlder}
                            className="rounded-lg bg-elevated px-3 py-1.5 text-xs font-medium text-muted hover:text-ink disabled:opacity-60"
                          >
                            {loadingOlder
                              ? t("inbox.loadOlderLoading")
                              : t("inbox.loadOlder")}
                          </button>
                        </div>
                      ) : null}
                      {messages.map((msg) => {
                      const outbound = msg.direction === "outbound";
                      const highlighted = highlightedId === msg.id;
                      return (
                        <div
                          key={msg.id}
                          id={`inbox-msg-${msg.id}`}
                          className={`group flex flex-col ${
                            outbound ? "items-end" : "items-start"
                          }`}
                        >
                          <div
                            className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm transition-shadow md:max-w-[70%] ${
                              outbound
                                ? "rounded-br-sm bg-accent text-white"
                                : "rounded-bl-sm bg-surface text-ink shadow-sm"
                            } ${highlighted ? "ring-2 ring-accent ring-offset-2 ring-offset-bg" : ""}`}
                          >
                            {msg.replyTo ? (
                              <button
                                type="button"
                                onClick={() =>
                                  jumpToQuotedMessage(msg.replyTo!.id)
                                }
                                title={t("inbox.quoteJumpTitle")}
                                className={`mb-1.5 block w-full rounded-lg border-l-2 px-2 py-1 text-left ${
                                  outbound
                                    ? "border-white/70 bg-white/15 hover:bg-white/25"
                                    : "border-accent bg-elevated hover:bg-line/50"
                                }`}
                              >
                                <span
                                  className={`block truncate text-[11px] font-semibold ${
                                    outbound ? "text-white" : "text-accent"
                                  }`}
                                >
                                  {quoteAuthorOfReplyTo(msg.replyTo)}
                                </span>
                                <span
                                  className={`block truncate text-xs ${
                                    outbound ? "text-white/85" : "text-muted"
                                  }`}
                                >
                                  {quotePreviewOfReplyTo(msg.replyTo)}
                                </span>
                              </button>
                            ) : msg.replyToSnapshot ? (
                              // Hotfix 7B.6: blok snapshot cadangan —
                              // BUKAN tombol (tidak ada pesan asal yang
                              // bisa dilompati); penanda halusnya title/
                              // aria bahwa pesan asal tidak tersedia.
                              <div
                                title={t("inbox.quoteOriginalUnavailable")}
                                aria-label={t("inbox.quoteOriginalUnavailable")}
                                className={`mb-1.5 block w-full rounded-lg border-l-2 px-2 py-1 text-left ${
                                  outbound
                                    ? "border-white/70 bg-white/15"
                                    : "border-accent bg-elevated"
                                }`}
                              >
                                <span
                                  className={`block truncate text-[11px] font-semibold ${
                                    outbound ? "text-white" : "text-accent"
                                  }`}
                                >
                                  {quoteAuthorOfSnapshot(msg)}
                                </span>
                                <span
                                  className={`block truncate text-xs ${
                                    outbound ? "text-white/85" : "text-muted"
                                  }`}
                                >
                                  {quotePreviewOfSnapshot(msg)}
                                </span>
                              </div>
                            ) : null}
                            {!outbound && msg.senderName ? (
                              <p className="mb-0.5 text-[11px] font-semibold text-accent">
                                {msg.senderName}
                              </p>
                            ) : null}
                            <p className="whitespace-pre-wrap break-words">
                              {msg.contentText ?? (
                                <span className="italic">{t("inbox.mediaMessage")}</span>
                              )}
                            </p>
                            <div
                              className={`mt-1 flex items-center gap-2 text-[11px] ${
                                outbound ? "text-white/80" : "text-muted"
                              }`}
                            >
                              {msg.senderType === "agent" ? (
                                <span>{t("inbox.senderAgent")}</span>
                              ) : msg.senderType === "system" ? (
                                <span>{t("inbox.senderSystem")}</span>
                              ) : null}
                              <span>{formatTime(msg.createdAt, locale)}</span>
                              {outbound ? (
                                <span>
                                  {t(`inbox.messageStatus.${msg.status}` as TranslationKey)}
                                </span>
                              ) : null}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => setQuoteTarget(msg)}
                            className="mt-1 px-1 text-[11px] font-medium text-muted opacity-0 transition-opacity hover:text-accent focus-visible:opacity-100 group-hover:opacity-100"
                          >
                            ↩ {t("inbox.replyWithQuote")}
                          </button>
                        </div>
                      );
                    })}
                    </>
                  )}
                </div>

                <form
                  onSubmit={handleSend}
                  className="border-t border-line bg-surface px-4 py-3"
                >
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-[11px] text-muted">
                      {t("inbox.savedReplies.hint")}
                    </p>
                    <button
                      type="button"
                      onClick={() => setSrPanelOpen((o) => !o)}
                      className="shrink-0 rounded-lg bg-elevated px-2.5 py-1 text-[11px] font-medium text-ink"
                    >
                      {t("inbox.savedReplies.manageButton")}
                    </button>
                  </div>
                  {srPanelOpen ? (
                    <div className="mb-3 rounded-xl border border-line bg-elevated/40 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="text-sm font-semibold text-ink">
                          {t("inbox.savedReplies.title")}
                        </h3>
                        <button
                          type="button"
                          aria-label={t("inbox.savedReplies.closeButton")}
                          onClick={() => setSrPanelOpen(false)}
                          className="rounded px-1 text-sm leading-none text-muted hover:text-ink"
                        >
                          ✕
                        </button>
                      </div>
                      {savedRepliesError ? (
                        <p className="mt-2 text-xs text-danger">{savedRepliesError}</p>
                      ) : null}
                      {savedReplies.length === 0 ? (
                        <p className="mt-2 text-sm text-muted">
                          {t("inbox.savedReplies.empty")}
                        </p>
                      ) : (
                        <ul className="mt-2 max-h-56 space-y-2 overflow-y-auto">
                          {savedReplies.map((r) => (
                            <li
                              key={r.id}
                              className="rounded-lg border border-line bg-surface px-3 py-2"
                            >
                              <div className="flex items-start justify-between gap-2">
                                <button
                                  type="button"
                                  onClick={() => insertSavedReply(r)}
                                  className="min-w-0 flex-1 text-left"
                                  title={r.body}
                                >
                                  <span className="block truncate text-sm font-medium text-ink">
                                    {r.title}
                                  </span>
                                  <span className="block truncate text-xs text-muted">
                                    {r.body}
                                  </span>
                                </button>
                                {canManageReply(r) ? (
                                  <span className="flex shrink-0 gap-1">
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setSrForm({ id: r.id, title: r.title, body: r.body })
                                      }
                                      className="rounded bg-elevated px-2 py-0.5 text-[11px] font-medium text-ink"
                                    >
                                      {t("inbox.savedReplies.editButton")}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        srDeleteConfirmId === r.id
                                          ? void handleSrDelete(r)
                                          : setSrDeleteConfirmId(r.id)
                                      }
                                      className="rounded bg-elevated px-2 py-0.5 text-[11px] font-medium text-danger"
                                    >
                                      {srDeleteConfirmId === r.id
                                        ? t("inbox.savedReplies.deleteConfirm")
                                        : t("inbox.savedReplies.deleteButton")}
                                    </button>
                                  </span>
                                ) : null}
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                      <div className="mt-3 border-t border-line pt-3">
                        <p className="text-sm font-medium text-ink">
                          {srForm.id
                            ? t("inbox.savedReplies.editTitle")
                            : t("inbox.savedReplies.newTitle")}
                        </p>
                        <input
                          value={srForm.title}
                          onChange={(e) =>
                            setSrForm((f) => ({ ...f, title: e.target.value }))
                          }
                          onKeyDown={(e) => {
                            // Enter di judul TIDAK boleh mengirim balasan chat.
                            if (e.key === "Enter") e.preventDefault();
                          }}
                          placeholder={t("inbox.savedReplies.titlePlaceholder")}
                          maxLength={255}
                          className={`${inputClassName} mt-2`}
                          aria-label={t("inbox.savedReplies.titleLabel")}
                        />
                        <textarea
                          value={srForm.body}
                          onChange={(e) =>
                            setSrForm((f) => ({ ...f, body: e.target.value }))
                          }
                          placeholder={t("inbox.savedReplies.bodyPlaceholder")}
                          rows={3}
                          maxLength={4096}
                          className={`${inputClassName} mt-2 resize-none`}
                          aria-label={t("inbox.savedReplies.bodyLabel")}
                        />
                        <p className="mt-1 text-[11px] text-muted">
                          {t("inbox.savedReplies.bodyHint")}
                        </p>
                        <div className="mt-2 flex gap-2">
                          <button
                            type="button"
                            disabled={
                              srSaving || !srForm.title.trim() || !srForm.body.trim()
                            }
                            onClick={() => void handleSrSave()}
                            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
                          >
                            {srForm.id
                              ? t("inbox.savedReplies.saveButton")
                              : t("inbox.savedReplies.createButton")}
                          </button>
                          {srForm.id ? (
                            <button
                              type="button"
                              onClick={() =>
                                setSrForm({ id: null, title: "", body: "" })
                              }
                              className="rounded-lg bg-elevated px-3 py-1.5 text-xs font-medium text-ink"
                            >
                              {t("inbox.savedReplies.cancelButton")}
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ) : null}
                  {quoteTarget ? (
                    <div className="mb-2 flex items-start gap-2 rounded-lg border-l-2 border-accent bg-elevated px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[11px] font-semibold text-accent">
                          {quoteAuthorOfMessage(quoteTarget)}
                        </p>
                        <p className="truncate text-xs text-muted">
                          {quotePreviewOfMessage(quoteTarget)}
                        </p>
                      </div>
                      <button
                        type="button"
                        aria-label={t("inbox.quoteCancel")}
                        title={t("inbox.quoteCancel")}
                        onClick={() => setQuoteTarget(null)}
                        className="shrink-0 rounded px-1 text-sm leading-none text-muted hover:text-ink"
                      >
                        ✕
                      </button>
                    </div>
                  ) : null}
                  {windowClosed ? (
                    <div className="mb-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-ink">
                      <p className="font-semibold">
                        {t("inbox.window.closedTitle")}
                      </p>
                      <p className="mt-0.5 text-muted">
                        {selected?.messagingWindow.lastInboundAt
                          ? t("inbox.window.closedBody", {
                              time: formatTime(
                                selected.messagingWindow.lastInboundAt,
                                locale,
                              ),
                            })
                          : t("inbox.window.noInboundBody")}
                      </p>
                      {!templateOpen ? (
                        <button
                          type="button"
                          onClick={() => void openTemplatePanel()}
                          className="mt-2 rounded-lg bg-accent px-2.5 py-1 text-[11px] font-semibold text-white"
                        >
                          {t("inbox.window.templateButton")}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                  {/* Fase 16C: panel kirim template — jalan keluar dari
                      banner di atas. Hanya template APPROVED yang
                      ditawarkan; jumlah input variabel mengikuti
                      `variableCount` template yang dipilih. */}
                  {windowClosed && templateOpen ? (
                    <div className="mb-2 rounded-lg border border-line bg-surface p-3 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <label
                          htmlFor="inbox-template"
                          className="text-[11px] font-medium text-muted"
                        >
                          {t("inbox.window.templateLabel")}
                        </label>
                        <button
                          type="button"
                          onClick={closeTemplatePanel}
                          className="text-[11px] text-muted hover:text-ink"
                        >
                          {t("inbox.window.templateCancel")}
                        </button>
                      </div>
                      {templatesLoading ? (
                        <p className="mt-1 text-muted">{t("common.loading")}</p>
                      ) : approvedTemplates.length === 0 ? (
                        <p className="mt-1 text-muted">
                          {t("inbox.window.templateNone")}
                        </p>
                      ) : (
                        <>
                          <select
                            id="inbox-template"
                            value={templateId}
                            onChange={(e) => {
                              const next = approvedTemplates.find(
                                (tpl) => tpl.id === e.target.value,
                              );
                              if (next) selectTemplate(next);
                              else {
                                setTemplateId("");
                                setTemplateParams([]);
                              }
                            }}
                            className="mt-1 w-full rounded-lg border border-line bg-bg px-2 py-1.5 text-xs text-ink"
                          >
                            <option value="">
                              {t("inbox.window.templatePlaceholder")}
                            </option>
                            {approvedTemplates.map((tpl) => (
                              <option key={tpl.id} value={tpl.id}>
                                {tpl.name} · {tpl.language}
                              </option>
                            ))}
                          </select>
                          {selectedTemplate ? (
                            <div className="mt-2 space-y-1.5">
                              <p className="text-[11px] text-muted">
                                {t("inbox.window.templateHint")}
                              </p>
                              {selectedTemplate.bodyText ? (
                                <p className="whitespace-pre-wrap rounded bg-elevated px-2 py-1 text-[11px] text-ink">
                                  {selectedTemplate.bodyText}
                                </p>
                              ) : null}
                              {Array.from(
                                { length: selectedTemplate.variableCount },
                                (_, i) => (
                                  <input
                                    key={i}
                                    value={templateParams[i] ?? ""}
                                    onChange={(e) =>
                                      setTemplateParams((prev) => {
                                        const next = [...prev];
                                        next[i] = e.target.value;
                                        return next;
                                      })
                                    }
                                    placeholder={t(
                                      "inbox.window.templateParamLabel",
                                      { index: i + 1 },
                                    )}
                                    className="w-full rounded-lg border border-line bg-bg px-2 py-1.5 text-xs text-ink"
                                  />
                                ),
                              )}
                              <button
                                type="button"
                                disabled={
                                  templateSending ||
                                  templateParams.length !==
                                    selectedTemplate.variableCount ||
                                  templateParams.some(
                                    (value) => value.trim() === "",
                                  )
                                }
                                onClick={() => void handleSendTemplate()}
                                className="rounded-lg bg-accent px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-60"
                              >
                                {templateSending
                                  ? t("inbox.window.templateSending")
                                  : t("inbox.window.templateSend")}
                              </button>
                            </div>
                          ) : null}
                        </>
                      )}
                      {templatesError ? (
                        <p className="mt-1 text-danger">{templatesError}</p>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="relative">
                    {pickerOpen ? (
                      <div className="absolute bottom-full left-0 z-10 mb-2 max-h-64 w-full max-w-md overflow-y-auto rounded-xl border border-line bg-surface shadow-lg">
                        {pickerMatches.length === 0 ? (
                          <p className="px-3 py-2 text-sm text-muted">
                            {t("inbox.savedReplies.pickerEmpty")}
                          </p>
                        ) : (
                          pickerMatches.map((r, i) => (
                            <button
                              key={r.id}
                              type="button"
                              onMouseDown={(e) => {
                                e.preventDefault();
                                insertSavedReply(r);
                              }}
                              className={`block w-full px-3 py-2 text-left ${
                                i === pickerIndex ? "bg-elevated" : ""
                              }`}
                            >
                              <span className="block truncate text-sm font-medium text-ink">
                                {r.title}
                              </span>
                              <span className="block truncate text-xs text-muted">
                                {r.body}
                              </span>
                            </button>
                          ))
                        )}
                        <button
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            setSrPanelOpen(true);
                            setPickerDismissed(true);
                          }}
                          className="block w-full border-t border-line px-3 py-2 text-left text-xs font-medium text-accent"
                        >
                          {t("inbox.savedReplies.pickerManage")}
                        </button>
                      </div>
                    ) : null}
                  <div className="flex items-end gap-2">
                    <textarea
                      value={draft}
                      disabled={windowClosed}
                      onChange={(e) => {
                        setDraft(e.target.value);
                        setPickerIndex(0);
                        setPickerDismissed(false);
                      }}
                      onKeyDown={(e) => {
                        // Pemilih `/` (Fase 9A) didahulukan: panah
                        // menavigasi, Enter memilih (bukan mengirim),
                        // Esc menutup pemilih.
                        if (pickerOpen && pickerMatches.length > 0) {
                          if (e.key === "ArrowDown") {
                            e.preventDefault();
                            setPickerIndex((i) =>
                              Math.min(i + 1, pickerMatches.length - 1),
                            );
                            return;
                          }
                          if (e.key === "ArrowUp") {
                            e.preventDefault();
                            setPickerIndex((i) => Math.max(i - 1, 0));
                            return;
                          }
                          if (e.key === "Enter" && !e.shiftKey) {
                            const pick =
                              pickerMatches[pickerIndex] ?? pickerMatches[0];
                            if (pick) {
                              e.preventDefault();
                              insertSavedReply(pick);
                              return;
                            }
                          }
                        }
                        if (e.key === "Escape" && pickerOpen) {
                          setPickerDismissed(true);
                          return;
                        }
                        if (e.key === "Escape" && quoteTarget) {
                          // Esc membatalkan kutipan yang sedang disusun.
                          setQuoteTarget(null);
                          return;
                        }
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          e.currentTarget.form?.requestSubmit();
                        }
                      }}
                      placeholder={
                        windowClosed
                          ? t("inbox.window.placeholder")
                          : selected.isChannel
                            ? t("inbox.postPlaceholder")
                            : t("inbox.replyPlaceholder")
                      }
                      rows={2}
                      maxLength={4096}
                      className={`${inputClassName} resize-none disabled:opacity-60`}
                    />
                    <button
                      type="submit"
                      disabled={sending || !draft.trim() || windowClosed}
                      className="shrink-0 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                    >
                      {sending
                        ? t("inbox.sending")
                        : selected.isChannel
                          ? t("inbox.postButton")
                          : t("inbox.sendButton")}
                    </button>
                  </div>
                  </div>
                  <FieldError message={sendError} />
                  <p className="mt-2 text-[11px] text-muted">
                    {selected.isChannel
                      ? t("inbox.channelDeliveryNote")
                      : t("inbox.deliveryNote")}
                  </p>
                </form>
                </>
                )}
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center p-8 text-center">
                <div>
                  <h2 className="text-base font-semibold text-ink">
                    {t("inbox.selectPromptTitle")}
                  </h2>
                  <p className="mx-auto mt-1 max-w-xs text-sm text-muted">
                    {t("inbox.selectPromptBody")}
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
