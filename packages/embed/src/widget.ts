/**
 * Widget webchat Sahabat Kreator (Fase 1F) — SATU file JS mandiri.
 *
 * Cara pasang di situs tenant:
 *   <script src="https://botara.my.id/widget.js" data-site-key="wc_..."></script>
 * Opsi: data-lang="id"|"en" (default: deteksi dari <html lang>, lalu
 * bahasa browser, terakhir "en"), data-title="Chat dengan kami",
 * data-api-base="https://botara.my.id" (default: origin file widget ini).
 *
 * Perilaku:
 * - Tombol chat melayang + panel percakapan, tema mengikuti sistem
 *   pengunjung (prefers-color-scheme terang/gelap). Root widget adalah
 *   flex column rata kanan — tombol TIDAK bergeser saat panel membuka.
 * - Sesi dibuka lewat POST /api/webchat/:siteKey/session; token pengunjung
 *   + visitorId persisten disimpan di localStorage SITUS ASAL.
 * - Tahan gangguan (hotfix 2026-11-02): pembuatan sesi yang gagal dicoba
 *   ulang otomatis dengan backoff + tombol "Coba lagi", status koneksi
 *   ditampilkan jujur (connecting/connected/error), pemulihan saat tab
 *   aktif lagi / browser online lagi, dan pesan yang gagal terkirim
 *   berlabel tap-to-retry. Widget tidak pernah gagal diam-diam.
 * - Pesan keluar masuk lewat REST; balasan masuk secara realtime lewat
 *   WebSocket apps/realtime (Fase 6G — socket menerima "nudge", lalu
 *   widget memuat ulang lewat REST), dengan polling cadangan bila WS
 *   gagal.
 * - Channel yang diputuskan pemilik workspace (hotfix Disconnect Gate):
 *   server menolak kirim/sinkronisasi dengan 409 CHANNEL_DISCONNECTED —
 *   widget menampilkannya sebagai keadaan error + gelembung gagal yang
 *   bisa diketuk untuk mencoba lagi, dan pulih sendiri begitu channel
 *   dihubungkan kembali (token lama tidak dibatalkan).
 * - Semua teks pesan dirender dengan textContent (tidak ada innerHTML dari
 *   data pengguna) — aman dari injeksi HTML.
 */

interface WidgetStrings {
  openLabel: string;
  defaultTitle: string;
  placeholder: string;
  send: string;
  connecting: string;
  emptyState: string;
  errorText: string;
  retry: string;
  sendFailed: string;
  /** Label cadangan penulis kutipan untuk pesan pengunjung sendiri. */
  quoteYou: string;
  /** Label cadangan penulis kutipan untuk pesan tim workspace. */
  quoteTeam: string;
  /** Cuplikan kutipan untuk pesan non-teks tanpa caption. */
  quoteMedia: string;
}

const STRINGS: Record<"en" | "id", WidgetStrings> = {
  en: {
    openLabel: "Chat with us",
    defaultTitle: "Chat with us",
    placeholder: "Type a message…",
    send: "Send",
    connecting: "Connecting…",
    emptyState: "Say hello — we usually reply in a moment.",
    errorText: "Couldn't connect. Check your connection, or try again.",
    retry: "Retry",
    sendFailed: "Failed to send — tap to retry",
    quoteYou: "You",
    quoteTeam: "Team",
    quoteMedia: "Media message",
  },
  id: {
    openLabel: "Chat dengan kami",
    defaultTitle: "Chat dengan kami",
    placeholder: "Tulis pesan…",
    send: "Kirim",
    connecting: "Menghubungkan…",
    emptyState: "Sapa kami — biasanya dibalas sebentar lagi.",
    errorText: "Tidak dapat terhubung. Periksa koneksi Anda, atau coba lagi.",
    retry: "Coba lagi",
    sendFailed: "Gagal terkirim — ketuk untuk coba lagi",
    quoteYou: "Anda",
    quoteTeam: "Tim",
    quoteMedia: "Pesan media",
  },
};

/** Ringkasan pesan yang dikutip (kontrak API Fase 7B.5, `replyTo`). */
interface ChatReplyTo {
  id: string;
  direction: "inbound" | "outbound";
  type: string;
  authorLabel: string | null;
  contentPreview: string | null;
}

interface ChatMessage {
  id: string;
  direction: "inbound" | "outbound";
  contentText: string | null;
  status: string;
  createdAt: string;
  /** Kutipan pesan lain (Fase 7B.5); null/absen = tanpa kutipan. */
  replyTo?: ChatReplyTo | null;
}

interface SessionResponse {
  token: string;
  conversationId: string;
  messages: ChatMessage[];
}

(function initWebchatWidget() {
  const script = document.currentScript as HTMLScriptElement | null;
  const siteKey = script?.dataset.siteKey?.trim();
  if (!script || !siteKey) {
    console.warn("[sahabat-kreator] widget: atribut data-site-key wajib diisi");
    return;
  }
  // Bahasa: data-lang eksplisit menang; lalu atribut lang halaman;
  // lalu bahasa browser pengunjung; default Inggris.
  const docLang = document.documentElement.lang || "";
  const navLang = navigator.language || "";
  const lang: "en" | "id" =
    script.dataset.lang === "id" || script.dataset.lang === "en"
      ? script.dataset.lang
      : (docLang || navLang).toLowerCase().startsWith("id")
        ? "id"
        : "en";
  const t = STRINGS[lang];
  const apiBase = (
    script.dataset.apiBase || new URL(script.src).origin
  ).replace(/\/$/, "");
  const title = script.dataset.title || t.defaultTitle;
  // Slug atribusi growth link (Fase 13B): halaman chat yang dibuka dari
  // tautan /go/<slug> meneruskannya sebagai data-src; widget mengirim-
  // kannya pada pembukaan sesi agar kontak teratribusi ke tautan itu.
  const src = script.dataset.src?.trim() || null;

  const storeKey = `sk_webchat_${siteKey}`;
  interface Stored {
    token?: string;
    visitorId?: string;
  }
  function loadStore(): Stored {
    try {
      return JSON.parse(localStorage.getItem(storeKey) ?? "{}") as Stored;
    } catch {
      return {};
    }
  }
  function saveStore(next: Stored): void {
    try {
      localStorage.setItem(storeKey, JSON.stringify(next));
    } catch {
      /* localStorage tidak tersedia — sesi tetap jalan di memori */
    }
  }
  function randomId(prefix: string): string {
    const bytes = new Uint8Array(18);
    crypto.getRandomValues(bytes);
    let bin = "";
    bytes.forEach((b) => (bin += String.fromCharCode(b)));
    return prefix + btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  const stored = loadStore();
  const visitorId = stored.visitorId ?? randomId("vis_");
  if (!stored.visitorId) saveStore({ ...stored, visitorId });
  let token: string | null = stored.token ?? null;

  // ---------- Tema mengikuti sistem pengunjung ----------
  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
  function palette() {
    return darkQuery.matches
      ? {
          panel: "#171a21",
          header: "#1f6feb",
          text: "#e8eaed",
          muted: "#9aa3af",
          mine: "#1f6feb",
          mineText: "#ffffff",
          theirs: "#262b36",
          theirsText: "#e8eaed",
          inputBg: "#10131a",
          border: "#2b303c",
        }
      : {
          panel: "#ffffff",
          header: "#2563eb",
          text: "#111827",
          muted: "#6b7280",
          mine: "#2563eb",
          mineText: "#ffffff",
          theirs: "#f3f4f6",
          theirsText: "#111827",
          inputBg: "#ffffff",
          border: "#e5e7eb",
        };
  }

  // ---------- DOM ----------
  const root = document.createElement("div");
  // Root = flex column RATA KANAN: tombol chat selalu berlabuh di pojok
  // kanan bawah. Tanpa ini, saat panel membuka root melebar mengikuti
  // panel dan tombol (flow normal di bawah panel) melompat ke kiri.
  root.style.cssText =
    "position:fixed;right:20px;bottom:20px;z-index:2147483000;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;display:flex;flex-direction:column;align-items:flex-end;gap:12px;";

  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("aria-label", t.openLabel);
  button.textContent = "💬";
  button.style.cssText =
    "width:56px;height:56px;border-radius:9999px;border:none;cursor:pointer;font-size:24px;color:#fff;background:#2563eb;box-shadow:0 8px 24px rgba(0,0,0,.25);";

  const panel = document.createElement("div");
  panel.style.cssText =
    "display:none;width:min(360px,calc(100vw - 32px));height:min(520px,calc(100vh - 120px));border-radius:16px;overflow:hidden;box-shadow:0 16px 48px rgba(0,0,0,.3);flex-direction:column;";

  const header = document.createElement("div");
  header.style.cssText =
    "padding:14px 16px;color:#fff;font-weight:600;font-size:15px;display:flex;justify-content:space-between;align-items:center;";
  const headerTitle = document.createElement("span");
  headerTitle.textContent = title;
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = "✕";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.style.cssText =
    "background:transparent;border:none;color:#fff;font-size:16px;cursor:pointer;";
  header.append(headerTitle, closeBtn);

  const messagesEl = document.createElement("div");
  messagesEl.style.cssText =
    "flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;";

  const form = document.createElement("form");
  form.style.cssText = "display:flex;gap:8px;padding:10px;border-top:1px solid;";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = t.placeholder;
  input.maxLength = 4096;
  // font-size 16px WAJIB: di bawah itu iOS Safari auto-zoom saat input
  // difokuskan, dan seluruh halaman tampak "bergeser" setiap kali diklik.
  input.style.cssText =
    "flex:1;border-radius:9999px;padding:10px 14px;font-size:16px;outline:none;border:1px solid;";
  const sendBtn = document.createElement("button");
  sendBtn.type = "submit";
  sendBtn.textContent = t.send;
  sendBtn.style.cssText =
    "border:none;border-radius:9999px;padding:10px 16px;font-size:14px;font-weight:600;color:#fff;background:#2563eb;cursor:pointer;";
  form.append(input, sendBtn);

  // Bar status koneksi di dalam panel (di atas form): menampilkan keadaan
  // connecting/error secara jujur — widget TIDAK BOLEH gagal diam-diam
  // di "Connecting…" selamanya (keluhan pengguna, hotfix 2026-11-02).
  const statusEl = document.createElement("div");
  statusEl.style.cssText =
    "display:none;padding:8px 12px;font-size:13px;text-align:center;border-top:1px solid;";
  const statusText = document.createElement("span");
  const retryBtn = document.createElement("button");
  retryBtn.type = "button";
  retryBtn.textContent = t.retry;
  retryBtn.style.cssText =
    "margin-left:8px;border:1px solid;border-radius:9999px;padding:2px 10px;font-size:12px;font-weight:600;background:transparent;cursor:pointer;color:inherit;";
  statusEl.append(statusText, retryBtn);

  panel.append(header, messagesEl, statusEl, form);
  root.append(panel, button);
  document.body.appendChild(root);

  function applyTheme(): void {
    const p = palette();
    panel.style.background = p.panel;
    panel.style.color = p.text;
    header.style.background = p.header;
    form.style.borderTopColor = p.border;
    statusEl.style.borderTopColor = p.border;
    statusEl.style.color = p.muted;
    input.style.background = p.inputBg;
    input.style.color = p.text;
    input.style.borderColor = p.border;
    for (const el of Array.from(messagesEl.children) as HTMLElement[]) {
      const mine = el.dataset.mine === "1";
      el.style.background = mine ? p.mine : p.theirs;
      el.style.color = mine ? p.mineText : p.theirsText;
    }
  }
  darkQuery.addEventListener?.("change", applyTheme);

  // ---------- Rendering pesan ----------
  const seen = new Set<string>();
  function appendMessage(msg: ChatMessage): void {
    if (seen.has(msg.id)) return;
    seen.add(msg.id);
    if (messagesEl.dataset.empty === "1") {
      messagesEl.textContent = "";
      delete messagesEl.dataset.empty;
    }
    // Model data Sahabat Kreator: direction "inbound" = dari kontak
    // (pengunjung) menuju tenant → tampil sebagai pesan "saya" (kanan);
    // "outbound" = dari tenant menuju pengunjung → kiri.
    const mine = msg.direction === "inbound";
    const bubble = document.createElement("div");
    bubble.dataset.mine = mine ? "1" : "0";
    bubble.style.cssText = `max-width:80%;padding:8px 12px;border-radius:14px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-break:break-word;align-self:${mine ? "flex-end" : "flex-start"};`;
    // Fase 7B.5: blok kutipan di dalam gelembung bila payload membawa
    // replyTo (balasan dashboard yang mengutip pesan pengunjung, atau
    // pesan pengunjung yang tercatat mengutip — render sama untuk
    // riwayat sesi maupun sinkronisasi realtime). Warna netral
    // semi-transparan agar terbaca di gelembung terang maupun biru,
    // tema terang maupun gelap. Semua teks via textContent.
    if (msg.replyTo) {
      const quote = document.createElement("div");
      quote.style.cssText =
        "border-left:3px solid rgba(127,127,127,.55);background:rgba(127,127,127,.16);border-radius:6px;padding:4px 8px;margin-bottom:6px;font-size:12px;line-height:1.35;white-space:normal;";
      const quoteAuthor = document.createElement("div");
      quoteAuthor.style.cssText =
        "font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
      quoteAuthor.textContent =
        msg.replyTo.authorLabel ??
        (msg.replyTo.direction === "inbound" ? t.quoteYou : t.quoteTeam);
      const quotePreview = document.createElement("div");
      quotePreview.style.cssText =
        "opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
      quotePreview.textContent = msg.replyTo.contentPreview ?? t.quoteMedia;
      quote.append(quoteAuthor, quotePreview);
      bubble.appendChild(quote);
    }
    const textEl = document.createElement("div");
    textEl.textContent = msg.contentText ?? "";
    bubble.appendChild(textEl);
    messagesEl.appendChild(bubble);
    applyTheme();
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  function showEmptyState(): void {
    messagesEl.dataset.empty = "1";
    const el = document.createElement("div");
    el.style.cssText = "text-align:center;font-size:13px;padding:16px 8px;";
    el.style.color = palette().muted;
    el.textContent = t.emptyState;
    messagesEl.appendChild(el);
  }

  // ---------- API ----------
  async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${apiBase}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {}),
      },
    });
  }

  let sessionPromise: Promise<void> | null = null;
  async function ensureSession(force = false): Promise<void> {
    if (token && !force) return;
    if (sessionPromise && !force) return sessionPromise;
    sessionPromise = (async () => {
      const res = await fetch(
        `${apiBase}/api/webchat/${encodeURIComponent(String(siteKey))}/session`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ visitorId, ...(src ? { src } : {}) }),
        },
      );
      if (!res.ok) throw new Error(`session failed: ${res.status}`);
      const data = (await res.json()) as SessionResponse;
      token = data.token;
      saveStore({ visitorId, token });
      messagesEl.textContent = "";
      seen.clear();
      if (data.messages.length === 0) showEmptyState();
      for (const m of data.messages) appendMessage(m);
    })();
    try {
      await sessionPromise;
    } finally {
      sessionPromise = null;
    }
  }

  // ---------- Status koneksi yang jujur: connecting / connected / error ----------
  type ConnState = "idle" | "connecting" | "connected" | "error";
  function setConnState(next: ConnState): void {
    if (next === "connected" || next === "idle") {
      statusEl.style.display = "none";
      return;
    }
    statusEl.style.display = "block";
    statusText.textContent = next === "connecting" ? t.connecting : t.errorText;
    retryBtn.style.display = next === "error" ? "" : "none";
  }

  // ---------- Pembuatan sesi dengan retry otomatis ----------
  // Kegagalan sesaat (API restart saat deploy, jaringan pengunjung
  // berkedip, halaman dibuka tepat saat server sibuk) TIDAK BOLEH
  // membuat widget mati sampai reload manual: sesi dicoba ulang dengan
  // backoff 1s → 2s → 5s → 10s → 15s (lalu tetap 15s) sampai berhasil,
  // dan selama itu panel menampilkan status error + tombol coba lagi.
  const RETRY_DELAYS_MS = [1000, 2000, 5000, 10000, 15000];
  let retryStep = 0;
  let retryTimer: number | null = null;
  let sessionAttemptRunning = false;

  function clearRetryTimer(): void {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  async function attemptSession(): Promise<void> {
    if (token || sessionAttemptRunning) return;
    sessionAttemptRunning = true;
    setConnState("connecting");
    try {
      await ensureSession(true);
      retryStep = 0;
      clearRetryTimer();
      setConnState("connected");
      connectWs();
      void syncMessages();
    } catch {
      setConnState("error");
      const delay =
        RETRY_DELAYS_MS[Math.min(retryStep, RETRY_DELAYS_MS.length - 1)];
      retryStep += 1;
      clearRetryTimer();
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        void attemptSession();
      }, delay);
    } finally {
      sessionAttemptRunning = false;
    }
  }

  retryBtn.addEventListener("click", () => {
    retryStep = 0;
    clearRetryTimer();
    void attemptSession();
  });

  // Kode error kontrak dari respons gagal ({error:{code}}) — dipakai
  // untuk membedakan penolakan yang bermakna (channel diputuskan
  // pemilik workspace) dari kegagalan jaringan/umum yang cukup ditelan.
  async function readApiErrorCode(res: Response): Promise<string | null> {
    try {
      const data = (await res.json()) as { error?: { code?: string } };
      return data.error?.code ?? null;
    } catch {
      return null;
    }
  }

  async function syncMessages(): Promise<void> {
    if (!token) {
      // Polling ikut memicu pembuatan sesi — jalur pemulihan kedua
      // selain timer backoff (mis. tab yang lama tidak aktif).
      void attemptSession();
      return;
    }
    let res: Response;
    try {
      res = await apiFetch("/api/webchat/messages");
    } catch {
      return; // jaringan berkedip — polling berikutnya mencoba lagi
    }
    if (res.status === 401) {
      token = null;
      saveStore({ visitorId });
      void attemptSession();
      return;
    }
    if (!res.ok) {
      // Channel diputuskan pemiliknya (409 CHANNEL_DISCONNECTED):
      // tampilkan keadaan error yang jujur — JANGAN diam seolah
      // terhubung. Token SENGAJA dipertahankan: ia berlaku lagi
      // begitu channel dihubungkan kembali, dan sinkronisasi
      // berikutnya yang berhasil membersihkan keadaan error ini.
      if ((await readApiErrorCode(res)) === "CHANNEL_DISCONNECTED") {
        setConnState("error");
      }
      return;
    }
    const data = (await res.json()) as { messages: ChatMessage[] };
    for (const m of data.messages) appendMessage(m);
    setConnState("connected");
  }

  // ---------- WebSocket + polling cadangan ----------
  let ws: WebSocket | null = null;
  let pollTimer: number | null = null;
  let opened = false;
  // Reconnect WS dengan backoff yang sama seperti retry sesi: selama
  // panel terbuka, socket yang putus dicoba sambung ulang bertahap dan
  // polling menutupi jedanya — widget tidak bergantung pada reload.
  let wsRetryStep = 0;
  let wsRetryTimer: number | null = null;

  function startPolling(): void {
    if (pollTimer !== null) return;
    pollTimer = window.setInterval(() => void syncMessages(), 4000);
  }
  function stopPolling(): void {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }
  function clearWsRetryTimer(): void {
    if (wsRetryTimer !== null) {
      clearTimeout(wsRetryTimer);
      wsRetryTimer = null;
    }
  }
  function scheduleWsReconnect(): void {
    if (!opened || wsRetryTimer !== null) return;
    const delay =
      RETRY_DELAYS_MS[Math.min(wsRetryStep, RETRY_DELAYS_MS.length - 1)];
    wsRetryStep += 1;
    wsRetryTimer = window.setTimeout(() => {
      wsRetryTimer = null;
      if (opened) connectWs();
    }, delay);
  }
  function connectWs(): void {
    if (!token) return;
    try {
      ws?.close();
    } catch {
      /* abaikan */
    }
    // Fase 6G: socket kini ke apps/realtime (dulu hub di apps/api).
    // Frame dari gateway berupa nudge ("ada perubahan") — muatan pesan
    // selalu dimuat ulang lewat REST agar status & isi bersumber dari
    // satu kebenaran yang sama seperti jalur polling.
    const wsUrl = `${apiBase.replace(/^http/, "ws")}/realtime/webchat?token=${encodeURIComponent(token)}`;
    let socket: WebSocket;
    try {
      socket = new WebSocket(wsUrl);
    } catch {
      startPolling();
      return;
    }
    ws = socket;
    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(String(event.data)) as {
          type?: string;
          message?: ChatMessage;
        };
        if (data.type === "nudge" || data.type === "ready") {
          void syncMessages();
        } else if (data.type === "message" && data.message) {
          // Kompatibilitas mundur (gateway lama) — tidak lagi dikirim.
          appendMessage(data.message);
        }
      } catch {
        /* abaikan frame tidak dikenal */
      }
    };
    socket.onopen = () => {
      wsRetryStep = 0;
      clearWsRetryTimer();
      stopPolling();
    };
    socket.onclose = () => {
      if (opened) {
        startPolling();
        scheduleWsReconnect();
      }
    };
    socket.onerror = () => startPolling();
  }

  // ---------- Interaksi ----------
  function openPanel(): void {
    opened = true;
    panel.style.display = "flex";
    applyTheme();
    if (token) {
      // Token tersimpan dari kunjungan sebelumnya: langsung terhubung,
      // lalu sinkronkan riwayat (WS juga mem-flush balasan yang menunggu).
      setConnState("connected");
      connectWs();
      void syncMessages();
    } else {
      void attemptSession();
    }
    input.focus();
  }
  function closePanel(): void {
    opened = false;
    panel.style.display = "none";
    stopPolling();
    clearWsRetryTimer();
    wsRetryStep = 0;
    try {
      ws?.close();
    } catch {
      /* abaikan */
    }
  }
  button.addEventListener("click", () => {
    if (opened) closePanel();
    else openPanel();
  });
  closeBtn.addEventListener("click", closePanel);

  // Pemulihan otomatis tanpa reload: tab kembali aktif atau browser
  // kembali online → bila sesi belum terbentuk, coba lagi SEGERA
  // (tanpa menunggu sisa backoff); bila sudah, sinkronkan pesan.
  function recoverWhenBack(): void {
    if (!token) {
      retryStep = 0;
      clearRetryTimer();
      void attemptSession();
    } else if (opened) {
      void syncMessages();
    }
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) recoverWhenBack();
  });
  window.addEventListener("online", recoverWhenBack);

  // ---------- Kirim pesan: gelembung lokal + indikator gagal ----------
  // Pesan langsung tampil sebagai gelembung lokal; bila pengiriman
  // gagal, gelembung menjadi redup dengan label "gagal — ketuk untuk
  // coba lagi" dan ketukan mengirim ulang. Tidak ada kegagalan diam.
  function appendLocalBubble(text: string): HTMLDivElement {
    if (messagesEl.dataset.empty === "1") {
      messagesEl.textContent = "";
      delete messagesEl.dataset.empty;
    }
    const bubble = document.createElement("div");
    bubble.dataset.mine = "1";
    bubble.style.cssText =
      "max-width:80%;padding:8px 12px;border-radius:14px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-break:break-word;align-self:flex-end;";
    const textEl = document.createElement("div");
    textEl.textContent = text;
    const failEl = document.createElement("div");
    failEl.style.cssText =
      "display:none;font-size:11px;margin-top:4px;text-decoration:underline;";
    failEl.textContent = t.sendFailed;
    bubble.append(textEl, failEl);
    messagesEl.appendChild(bubble);
    applyTheme();
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return bubble;
  }

  function markSendFailed(bubble: HTMLDivElement, text: string): void {
    bubble.style.opacity = "0.65";
    bubble.style.cursor = "pointer";
    const failEl = bubble.lastElementChild as HTMLElement | null;
    if (failEl) failEl.style.display = "block";
    bubble.onclick = () => {
      bubble.onclick = null;
      bubble.style.opacity = "";
      bubble.style.cursor = "default";
      if (failEl) failEl.style.display = "none";
      void deliverMessage(bubble, text);
    };
  }

  async function deliverMessage(
    bubble: HTMLDivElement,
    text: string,
  ): Promise<void> {
    try {
      if (!token) {
        setConnState("connecting");
        await ensureSession(true);
        setConnState("connected");
        connectWs();
      }
      let res = await apiFetch("/api/webchat/messages", {
        method: "POST",
        body: JSON.stringify({ contentText: text }),
      });
      if (res.status === 401) {
        token = null;
        saveStore({ visitorId });
        await ensureSession(true);
        setConnState("connected");
        connectWs();
        res = await apiFetch("/api/webchat/messages", {
          method: "POST",
          body: JSON.stringify({ contentText: text }),
        });
      }
      if (!res.ok) {
        // Channel diputuskan pemiliknya: gelembung tetap menjadi
        // gelembung gagal (ketuk-untuk-coba-lagi) lewat catch di bawah,
        // dan panel menampilkan keadaan error — bukan diam "terhubung".
        if ((await readApiErrorCode(res)) === "CHANNEL_DISCONNECTED") {
          setConnState("error");
        }
        throw new Error(`send failed: ${res.status}`);
      }
      const msg = (await res.json()) as ChatMessage;
      bubble.remove();
      appendMessage(msg);
      setConnState("connected");
    } catch {
      if (!token) void attemptSession();
      markSendFailed(bubble, text);
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    const bubble = appendLocalBubble(text);
    void deliverMessage(bubble, text);
  });

  applyTheme();
})();
