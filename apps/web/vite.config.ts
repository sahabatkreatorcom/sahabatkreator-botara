import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Host tunnel uji lokal (Cloudflare Tunnel / ngrok), dibaca dari env
 * `DEV_TUNNEL_HOST` — diisi di `.env` lalu di-export ke shell
 * (`set -a; . ./.env; set +a`). Vite TIDAK memuat `.env` ke `process.env`
 * untuk berkas config, jadi variabelnya harus benar-benar ada di
 * lingkungan proses.
 *
 * Sejak Vite 5.4.12 dev server menolak Host yang tidak dikenal (proteksi
 * DNS rebinding) dan menjawab 403, sama seperti `preview.allowedHosts`
 * yang sudah memuat `botara.my.id`. Kosong = perilaku bawaan (localhost
 * saja), alur dev biasa tidak berubah.
 */
const devTunnelHost = process.env.DEV_TUNNEL_HOST?.trim();

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Fase 13A: pisahkan React ke chunk vendor tersendiri agar
        // cache-nya bertahan lintas rilis aplikasi; halaman berat
        // terpisah otomatis lewat React.lazy di App.tsx (chunk per rute,
        // mis. builder flow + @xyflow/react tidak lagi di chunk utama).
        manualChunks: {
          "vendor-react": ["react", "react-dom"],
        },
      },
    },
  },
  server: {
    port: 5173,
    host: true,
    // Tunnel uji lokal: daftarkan host tunnel agar dev server tidak 403.
    // Kosong (default) = hanya localhost, alur dev biasa tidak berubah.
    allowedHosts: devTunnelHost ? [devTunnelHost] : undefined,
    // HMR lewat tunnel: klien Vite menyambung balik ke port dev server
    // (5173) yang TIDAK di-proxy Cloudflare, jadi hot reload gagal dan
    // konsol browser dipenuhi "WebSocket connection failed". Arahkan ke
    // 443/wss — jalur yang sama dengan trafik halaman.
    hmr: devTunnelHost ? { protocol: "wss", clientPort: 443 } : undefined,
    // Dev lokal: teruskan /api ke API lokal dan /realtime ke gateway
    // WebSocket apps/realtime lokal (Fase 6G).
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3101",
        changeOrigin: true,
        ws: true,
      },
      "/realtime": {
        target: "http://127.0.0.1:3103",
        changeOrigin: true,
        ws: true,
      },
      // Fase 13B: tautan growth publik /go/:slug hidup di API (302 ke
      // platform / landing picker server-rendered) — teruskan utuh.
      "/go": {
        target: "http://127.0.0.1:3101",
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 5173,
    host: true,
    // CORS bawaan Vite preview DIMATIKAN (hotfix webchat 2026-11-02):
    // middleware CORS Vite menjawab preflight OPTIONS /api/* SENDIRI
    // (allow-methods/headers generik TANPA Access-Control-Allow-Origin)
    // sehingga browser memblokir widget webchat yang dipasang di situs
    // lain, walau API sudah benar. Dengan cors:false, preflight
    // diteruskan proxy ke API Hono yang menerapkan CORS permisif HANYA
    // untuk endpoint publik /api/webchat/* (lihat
    // apps/api/src/modules/webchat/routes.ts). Dashboard tetap
    // satu-origin; tidak ada CORS permisif di lapisan ini.
    cors: false,
    // Vite preview menolak Host yang tidak dikenal (proteksi DNS rebinding).
    // Domain staging publik wajib didaftarkan eksplisit, kalau tidak semua
    // request lewat Cloudflare Tunnel (Host: botara.my.id) dijawab 403.
    allowedHosts: ["botara.my.id"],
    // Staging/prod: web dan API satu origin. Vite preview meneruskan /api/*
    // (path utuh, tanpa strip) ke API Hono lokal di port 3101, yang memang
    // melayani route di bawah prefix /api (lihat apps/api/src/index.ts).
    // Port/host aktual di server diatur lewat flag CLI unit systemd.
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3101",
        changeOrigin: true,
        ws: true,
      },
      // Fase 6G: satu-satunya jalur WebSocket publik kini /realtime/*
      // menuju apps/realtime (gateway mandiri, port 3103) — socket
      // dashboard (/realtime/dashboard) & widget (/realtime/webchat).
      // (Jalur lama /api/webchat/ws pensiun bersama hub di apps/api.)
      // Di produksi jalur ini pindah ke edge/reverse-proxy, bukan Vite.
      "/realtime": {
        target: "http://127.0.0.1:3103",
        changeOrigin: true,
        ws: true,
      },
      // Fase 13B: tautan growth publik /go/:slug hidup di API (302 ke
      // platform / landing picker server-rendered) — teruskan utuh
      // (API melayani route yang sama di root, tanpa prefix /api).
      "/go": {
        target: "http://127.0.0.1:3101",
        changeOrigin: true,
      },
    },
  },
});
