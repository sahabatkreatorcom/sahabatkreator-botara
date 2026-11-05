import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { customSession } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import {
  deliverPasswordResetEmail,
  isPlatformAdminEmail,
  PASSWORD_RESET_EXPIRES_IN_SECONDS,
  type PlatformSettingsOptions,
} from "@sahabat-kreator/core";
import {
  authAccount,
  authSession,
  authUser,
  authVerification,
  createDb,
  users,
  type Database,
  type User,
} from "@sahabat-kreator/db";
import type { RateLimitStorage } from "./rate-limit-store";

/**
 * Integrasi Better Auth (Fase 1B) — email + password, sesi cookie httpOnly.
 *
 * Pemisahan tanggung jawab (keputusan desain Fase 1B):
 * - Better Auth memiliki tabelnya sendiri (`auth_user`, `auth_session`,
 *   `auth_account`, `auth_verification`) dan mengurus hashing password,
 *   token sesi, dan cookie.
 * - Sumber kebenaran workspace tetap tabel Fase 1A (`users`, `tenants`,
 *   `tenant_members`). Baris `users` kita dihubungkan ke `auth_user`
 *   lewat kolom `users.auth_user_id` dan dibuat otomatis saat sign-up
 *   (database hook di bawah) atau disinkronkan malas (lazy) pada request
 *   terautentikasi pertama — lihat `syncAppUser`.
 * - Plugin organization Better Auth SENGAJA tidak dipakai; keanggotaan
 *   tenant dikelola core kita + RLS.
 */

export interface AuthBundle {
  auth: ReturnType<typeof createAuthInstance>;
  db: Database;
  /**
   * Pool koneksi milik bundle. Dipakai readiness check (`SELECT 1`) dan
   * shutdown; jangan membuat pool kedua untuk keperluan yang sama.
   */
  pool: ReturnType<typeof createDb>["pool"];
}

/** Dependensi email reset kata sandi (Fase 14C) — resolver Panel Admin + override base Resend untuk mock rantai. */
export interface PasswordResetEmailOptions {
  platform: PlatformSettingsOptions;
  apiBase?: string;
}

function createAuthInstance(
  db: Database,
  opts: {
    secret: string;
    baseURL: string;
    platformAdminEmails?: string;
    passwordResetEmail?: PasswordResetEmailOptions;
    /** Storage rate limit bersama (Redis) — Fase 13D; null = in-memory bawaan. */
    rateLimitStorage?: RateLimitStorage | null;
  },
) {
  return betterAuth({
    appName: "Sahabat Kreator",
    secret: opts.secret,
    baseURL: opts.baseURL,
    plugins: [
      // Fase 6C: respons get-session diperkaya flag `isPlatformAdmin`
      // pada user (dicocokkan dari allowlist env PLATFORM_ADMIN_EMAILS)
      // agar web bisa menyembunyikan menu Admin dari non-admin. Gerbang
      // sesungguhnya tetap di endpoint /api/admin/* (404 untuk non-admin);
      // flag ini murni petunjuk tampilan.
      customSession(async ({ session, user }) => ({
        session,
        user: {
          ...user,
          isPlatformAdmin: isPlatformAdminEmail(
            user.email,
            opts.platformAdminEmails,
          ),
        },
      })),
    ],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: authUser,
        session: authSession,
        account: authAccount,
        verification: authVerification,
      },
    }),
    emailAndPassword: {
      enabled: true,
      /**
       * Reset kata sandi via email (Fase 14C — menutup sisa 11B).
       *
       * Jalur yang dipilih: hook `sendResetPassword` Better Auth →
       * `deliverPasswordResetEmail` di core → Resend `sendEmail` yang
       * sama dengan email undangan. BUKAN pola outbox + job 11B:
       * undangan membutuhkannya karena lapisan API yang membuat token
       * dan pengiriman harus selamat lintas proses; di sini Better Auth
       * sendiri yang membuat token, menyimpannya di `auth_verification`,
       * dan menyerahkan URL jadi ke hook — tidak ada kustodi token untuk
       * dipecahkan, dan reset adalah urusan pengguna/platform (bukan
       * tenant) sedangkan outbox kita tenant-sentris.
       *
       * KEJUJURAN STATUS: hook TIDAK PERNAH melempar — endpoint
       * `/request-password-reset` selalu menjawab sukses ke peminta
       * (anti-enumerasi, perilaku library), sementara hasil pengiriman
       * sebenarnya dicatat satu baris terstruktur di log proses:
       * `password_reset_email … status=sent|not_configured|failed`.
       * Tanpa konfigurasi Resend email memang tidak terkirim dan log
       * mengatakannya persis begitu — tidak ada keadaan "terkirim"
       * karangan. Baris log hanya memuat id pengguna + status (+ kode
       * gagal); alamat email, token, dan URL tidak pernah ditulis.
       *
       * Token berlaku 1 jam (konstanta core yang sama dengan yang
       * disebut isi email) dan sekali pakai (library menghapus baris
       * verifikasi saat reset selesai).
       */
      resetPasswordTokenExpiresIn: PASSWORD_RESET_EXPIRES_IN_SECONDS,
      ...(opts.passwordResetEmail
        ? {
            sendResetPassword: async ({
              user,
              url,
            }: {
              user: { id: string; email: string };
              url: string;
            }) => {
              const deps = opts.passwordResetEmail;
              if (!deps) return;
              try {
                const result = await deliverPasswordResetEmail(db, deps, {
                  email: user.email,
                  resetUrl: url,
                });
                if (result.kind === "sent") {
                  console.log(
                    `[auth] password_reset_email user=${user.id} status=sent providerId=${result.providerId ?? "-"}`,
                  );
                } else if (result.kind === "not_configured") {
                  console.warn(
                    `[auth] password_reset_email user=${user.id} status=not_configured`,
                  );
                } else {
                  console.error(
                    `[auth] password_reset_email user=${user.id} status=failed code=${result.code}`,
                  );
                }
              } catch {
                console.error(
                  `[auth] password_reset_email user=${user.id} status=failed code=UNEXPECTED`,
                );
              }
            },
          }
        : {}),
    },
    /**
     * Rate limit auth (Fase 6B — menutup catatan pra-produksi QA-1).
     *
     * Masalah lama: Better Auth mengunci rate limit per IP sumber
     * koneksi. Di balik Cloudflare Tunnel semua trafik tampak berasal
     * dari 127.0.0.1 (cloudflared), sehingga ember per-IP TERBAGI untuk
     * semua pengguna — pendaftaran ke-±9 yang cepat dari mana pun sudah
     * menghabiskan jatah bersama (aturan khusus bawaan library untuk
     * /sign-in|/sign-up adalah 3 req/10 dtk per IP+jalur).
     *
     * Perbaikan: identitas IP diambil dari header lewat
     * `advanced.ipAddress.ipAddressHeaders` di bawah (urutan diperiksa
     * dari depan; IP valid pertama yang menang — lihat getIp di
     * better-auth). `cf-connecting-ip` adalah IP pengunjung asli yang
     * diset edge Cloudflare.
     *
     * ASUMSI KEPERCAYAAN (penting): header `cf-connecting-ip` hanya
     * boleh dipercaya karena origin staging ter-bind 127.0.0.1 dan
     * HANYA bisa dicapai lewat cloudflared — tidak ada jalur bagi klien
     * untuk menyuntikkan header ini sendiri, dan edge Cloudflare selalu
     * menimpa/menyetelnya dari IP koneksi sebenarnya. Bila suatu hari
     * API diekspos langsung tanpa Cloudflare di depannya, header ini
     * menjadi bisa dipalsukan klien dan asumsi ini WAJIB ditinjau ulang.
     * Fallback `x-forwarded-for` (default library) dipertahankan untuk
     * pengembangan lokal; di dev tanpa header apa pun library sendiri
     * jatuh ke 127.0.0.1.
     *
     * Batas per IP ASLI (customRules menimpa aturan khusus bawaan
     * 3/10 dtk untuk jalur ini):
     * - sign-up: 10 req / 60 dtk per IP
     * - sign-in: 20 req / 60 dtk per IP
     * Jalur sensitif lain (/change-password, /change-email) sengaja
     * tetap pada aturan khusus bawaan library yang ketat (3/10 dtk).
     * Default global 10 dtk/100 req adalah default library, ditulis
     * eksplisit agar konfigurasi efektif terlihat utuh di satu tempat.
     *
     * Penyimpanan (Fase 13D): dengan `REDIS_URL` terisi, penghitung
     * disimpan di Redis lewat `customStorage` sehingga berlaku lintas
     * proses/replika dan tidak reset saat API restart. Tanpa Redis
     * (pengembangan lokal) kita JATUH ke storage in-memory bawaan
     * library — perilaku lama, satu ember per proses. Jalur
     * `customStorage` sengaja dipilih alih-alih `secondaryStorage`
     * agar sesi TETAP sepenuhnya di Postgres dan tidak ada perilaku
     * auth lain yang ikut berubah.
     *
     * `enabled: true` ditulis eksplisit (default library: hanya aktif
     * di production) agar perilaku tidak bergantung pada NODE_ENV.
     */
    rateLimit: {
      enabled: true,
      window: 10,
      max: 100,
      customRules: {
        "/sign-up/*": { window: 60, max: 10 },
        "/sign-in/*": { window: 60, max: 20 },
      },
      ...(opts.rateLimitStorage
        ? { customStorage: opts.rateLimitStorage }
        : {}),
    },
    advanced: {
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"],
      },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await syncAppUser(db, {
              authUserId: user.id,
              email: user.email,
              name: user.name,
            });
          },
        },
      },
    },
  });
}

/**
 * Membuat/menyinkronkan baris `users` kita untuk satu pengguna Better Auth.
 * Upsert berbasis email (unik): bila email sudah ada (mis. hasil seed),
 * kolom auth_user_id-nya yang diisi.
 */
export async function syncAppUser(
  db: Database,
  input: { authUserId: string; email: string; name?: string | null },
): Promise<User> {
  await db
    .insert(users)
    .values({
      email: input.email,
      name: input.name ?? null,
      authUserId: input.authUserId,
    })
    .onConflictDoUpdate({
      target: users.email,
      set: { authUserId: input.authUserId, updatedAt: new Date() },
    });
  const [row] = await db
    .select()
    .from(users)
    .where(eq(users.authUserId, input.authUserId))
    .limit(1);
  if (!row) {
    throw new Error(`syncAppUser: users untuk auth ${input.authUserId} tidak ditemukan`);
  }
  return row;
}

/** Membuat bundle auth hanya bila env DB + secret tersedia (mode Fase 0 tanpa DB tetap bisa /health). */
export function createAuthBundle(opts: {
  databaseUrl: string;
  secret: string;
  baseURL: string;
  /** Allowlist email platform-admin mentah (env PLATFORM_ADMIN_EMAILS) — Fase 6C. */
  platformAdminEmails?: string;
  /** Dependensi email reset kata sandi (Fase 14C); tanpa ini endpoint reset menjawab tidak-aktif dari library. */
  passwordResetEmail?: PasswordResetEmailOptions;
  /** Storage rate limit bersama (Redis) — Fase 13D; null/kosong = in-memory. */
  rateLimitStorage?: RateLimitStorage | null;
}): AuthBundle {
  const { db, pool } = createDb(opts.databaseUrl, { applicationName: "sk-api" });
  return { auth: createAuthInstance(db, opts), db, pool };
}
