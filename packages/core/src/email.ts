import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  auditLogs,
  invitations,
  outboxEvents,
  tenants,
  users,
  type Database,
} from "@sahabat-kreator/db";
import {
  decryptChannelSecret,
  encryptChannelSecret,
} from "./channel-secrets";
import {
  getProviderSecret,
  type PlatformSettingsOptions,
} from "./platform-settings";
import { invitationStatus } from "./team";
import { withTenantDb } from "./tx";

/**
 * Email transaksional platform (Fase 11B) — provider **Resend**
 * (keputusan user 2026-11-02: "email menggunakan resend").
 *
 * Lapisan ini punya tiga bagian:
 * 1. RESOLUSI KONFIGURASI: kunci `resend_api_key` + identitas pengirim
 *    `resend_from_email` / `resend_from_name` dari Panel Admin dengan
 *    resolusi panel → env yang sama seperti kunci provider lain
 *    (`getProviderSecret`). Tanpa kunci ATAU tanpa alamat pengirim,
 *    email dianggap TIDAK TERKONFIGURASI — keadaan eksplisit yang
 *    dilaporkan pemanggil, bukan error lempar.
 * 2. KIRIM: `sendEmail` — REST API Resend lewat fetch polos (tanpa SDK),
 *    pola klien provider yang sama seperti Meta/OpenRouter. Kunci TIDAK
 *    PERNAH masuk hasil, log, atau pesan error yang dikembalikan.
 * 3. PENGIRIMAN UNDANGAN TIM: pembuatan undangan (9C) menulis event
 *    outbox `team.invitation_email_requested`; relay worker menerjemahkannya
 *    menjadi job BullMQ `team.invitation_email` yang menjalankan
 *    `deliverInvitationEmail` di sini. API tidak pernah menunggu HTTP
 *    email — respons pembuatan hanya menyatakan "queued" /
 *    "not_configured".
 *
 * TOKEN UNDANGAN DI PAYLOAD OUTBOX: token mentah hanya hidup saat
 * pembuatan (tabel invitations menyimpan HASH-nya saja — invariant 9C
 * tidak berubah). Agar job bisa menyusun tautan di email, token
 * disertakan ke payload outbox sebagai CIPHERTEXT envelope AES-256-GCM
 * (`v1:…`, helper yang sama dengan kredensial channel) di bawah secret
 * env `CHANNEL_TOKEN_SECRET` — teks terang token tidak pernah
 * tersimpan di mana pun. Masa berlaku token 7 hari membatasi umur
 * berguna ciphertext itu; baris outbox sendiri berpola sama dengan
 * kredensial channel terenkripsi yang memang tersimpan di DB.
 *
 * Hasil kirim tercatat di baris undangan: `email_sent_at` saat berhasil
 * dan `email_error` (kode + pesan singkat, TANPA token/isi) saat gagal.
 * Kegagalan kirim TIDAK menggagalkan undangan — tautan salin manual
 * tetap sah; pengiriman ulang manual tidak dibuat di fase ini.
 */

export const RESEND_DEFAULT_API_BASE = "https://api.resend.com";
export const INVITATION_EMAIL_OUTBOX_TYPE = "team.invitation_email_requested";

const EMAIL_SEND_TIMEOUT_MS = 10_000;
/** Batas ringkasan error yang disimpan di invitations.email_error (varchar 255). */
const EMAIL_ERROR_MAX = 255;

// ---------------------------------------------------------------------------
// Resolusi konfigurasi: panel → env (konsisten kunci provider lain)
// ---------------------------------------------------------------------------

export interface ResolvedEmailConfig {
  apiKey: string;
  fromEmail: string;
  /** Nama tampil pengirim; null = kirim dari alamat polos tanpa nama. */
  fromName: string | null;
}

/**
 * Konfigurasi email efektif, atau null bila TIDAK TERKONFIGURASI
 * (kunci Resend kosong di panel & env, atau identitas pengirim belum
 * diatur — dua-duanya wajib ada untuk bisa mengirim).
 */
export async function resolveEmailConfig(
  db: Database,
  opts: PlatformSettingsOptions,
): Promise<ResolvedEmailConfig | null> {
  const [apiKey, fromEmail, fromName] = await Promise.all([
    getProviderSecret(db, "resend_api_key", opts),
    getProviderSecret(db, "resend_from_email", opts),
    getProviderSecret(db, "resend_from_name", opts),
  ]);
  if (!apiKey || !fromEmail) return null;
  return { apiKey, fromEmail, fromName: fromName || null };
}

// ---------------------------------------------------------------------------
// Kirim email lewat REST API Resend
// ---------------------------------------------------------------------------

export interface SendEmailInput {
  /** Null = tidak terkonfigurasi (hasil eksplisit, bukan lemparan). */
  config: ResolvedEmailConfig | null;
  /** Override base URL API (mock rantai); default https://api.resend.com. */
  apiBase?: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

export type SendEmailResult =
  | { kind: "sent"; providerId: string | null }
  | { kind: "not_configured" }
  | { kind: "failed"; code: string; message: string };

interface ResendErrorBody {
  name?: string;
  message?: string;
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  if (!input.config) return { kind: "not_configured" };
  const { apiKey, fromEmail, fromName } = input.config;
  const base = (input.apiBase ?? RESEND_DEFAULT_API_BASE).replace(/\/+$/, "");
  const from = fromName ? `${fromName} <${fromEmail}>` : fromEmail;
  let res: Response;
  try {
    res = await fetch(`${base}/emails`, {
      method: "POST",
      signal: AbortSignal.timeout(EMAIL_SEND_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
      }),
    });
  } catch {
    // Jaringan/timeout — kunci tidak pernah menjadi bagian hasil.
    return {
      kind: "failed",
      code: "RESEND_UNREACHABLE",
      message: "Resend API could not be reached",
    };
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ResendErrorBody | null;
    return {
      kind: "failed",
      code: body?.name ?? `RESEND_HTTP_${res.status}`,
      message: (body?.message ?? `HTTP ${res.status}`).slice(0, 200),
    };
  }
  const body = (await res.json().catch(() => null)) as { id?: string } | null;
  return { kind: "sent", providerId: body?.id ?? null };
}

// ---------------------------------------------------------------------------
// Isi email undangan — DWIBAHASA dalam satu pesan (Inggris utama, lalu
// Indonesia): penerima belum tentu tahu locale tenant pengundang.
// ---------------------------------------------------------------------------

export interface InvitationEmailContent {
  subject: string;
  html: string;
  text: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatExpiry(expiresAt: Date): string {
  return `${expiresAt.toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

export function buildInvitationEmail(input: {
  tenantName: string;
  /** Nama pengundang; null → kalimat tanpa nama ("You have been invited…"). */
  inviterName: string | null;
  /** Email penerima (disebut di isi agar syarat email-sama jelas). */
  email: string;
  role: string;
  inviteUrl: string;
  expiresAt: Date;
}): InvitationEmailContent {
  const expiry = formatExpiry(input.expiresAt);
  const inviter = input.inviterName?.trim() ? input.inviterName.trim() : null;

  const subject = `You're invited to join ${input.tenantName} on Sahabat Kreator`;

  const enIntro = inviter
    ? `${inviter} has invited you to join the "${input.tenantName}" workspace on Sahabat Kreator as ${input.role}.`
    : `You have been invited to join the "${input.tenantName}" workspace on Sahabat Kreator as ${input.role}.`;
  const idIntro = inviter
    ? `${inviter} mengundang Anda untuk bergabung ke workspace "${input.tenantName}" di Sahabat Kreator sebagai ${input.role}.`
    : `Anda diundang untuk bergabung ke workspace "${input.tenantName}" di Sahabat Kreator sebagai ${input.role}.`;

  const text = [
    "Hello,",
    "",
    enIntro,
    "",
    "Accept your invitation:",
    input.inviteUrl,
    "",
    `This link expires on ${expiry} (7 days after it was sent) and works only for this email address (${input.email}). If you weren't expecting this invitation, you can safely ignore this email.`,
    "",
    "—",
    "",
    "Halo,",
    "",
    idIntro,
    "",
    "Terima undangan Anda:",
    input.inviteUrl,
    "",
    `Tautan ini kedaluwarsa pada ${expiry} (7 hari sejak dikirim) dan hanya berlaku untuk alamat email ini (${input.email}). Jika Anda tidak merasa meminta undangan ini, abaikan saja email ini.`,
    "",
    "— Sahabat Kreator",
    "",
  ].join("\n");

  const html = [
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#1a1a1a">`,
    `<p>Hello,</p>`,
    `<p>${escapeHtml(enIntro)}</p>`,
    `<p><a href="${escapeHtml(input.inviteUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">Accept invitation</a></p>`,
    `<p style="font-size:13px;color:#555">Or open this link: <a href="${escapeHtml(input.inviteUrl)}">${escapeHtml(input.inviteUrl)}</a></p>`,
    `<p style="font-size:13px;color:#555">This link expires on ${escapeHtml(expiry)} (7 days after it was sent) and works only for this email address (${escapeHtml(input.email)}). If you weren't expecting this invitation, you can safely ignore this email.</p>`,
    `<hr style="border:none;border-top:1px solid #ddd;margin:24px 0">`,
    `<p>Halo,</p>`,
    `<p>${escapeHtml(idIntro)}</p>`,
    `<p><a href="${escapeHtml(input.inviteUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">Terima undangan</a></p>`,
    `<p style="font-size:13px;color:#555">Atau buka tautan ini: <a href="${escapeHtml(input.inviteUrl)}">${escapeHtml(input.inviteUrl)}</a></p>`,
    `<p style="font-size:13px;color:#555">Tautan ini kedaluwarsa pada ${escapeHtml(expiry)} (7 hari sejak dikirim) dan hanya berlaku untuk alamat email ini (${escapeHtml(input.email)}). Jika Anda tidak merasa meminta undangan ini, abaikan saja email ini.</p>`,
    `<p style="font-size:13px;color:#555">— Sahabat Kreator</p>`,
    `</div>`,
  ].join("");

  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// Antrean pengiriman (dipanggil lapisan API sesudah undangan tercipta)
// ---------------------------------------------------------------------------

/**
 * Tulis event outbox permintaan kirim email undangan (transaksi tenant
 * sendiri; relay worker yang meneruskannya ke job). Token disertakan
 * sebagai ciphertext envelope di bawah `encryptionSecret`
 * (CHANNEL_TOKEN_SECRET) — lihat catatan keamanan di kepala modul.
 * Mengembalikan false bila secret enkripsi tidak tersedia (pemanggil
 * melaporkan pengiriman sebagai tidak terkonfigurasi alih-alih
 * mengantrekan email yang tidak akan pernah bisa disusun).
 */
export async function queueInvitationEmail(
  db: Database,
  input: {
    tenantId: string;
    invitationId: string;
    token: string;
    encryptionSecret?: string;
  },
): Promise<boolean> {
  if (!input.encryptionSecret) return false;
  const tokenEnc = encryptChannelSecret(input.encryptionSecret, input.token);
  await withTenantDb(db, input.tenantId, async (tx) => {
    await tx.insert(outboxEvents).values({
      tenantId: input.tenantId,
      type: INVITATION_EMAIL_OUTBOX_TYPE,
      payload: { invitationId: input.invitationId, tokenEnc },
    });
  });
  return true;
}

// ---------------------------------------------------------------------------
// Pengiriman (dijalankan job worker `team.invitation_email`)
// ---------------------------------------------------------------------------

export interface InvitationEmailDeps {
  /** Opsi resolver Panel Admin proses pemanggil (panel → env). */
  platform: PlatformSettingsOptions;
  /** Secret env untuk membuka ciphertext token (CHANNEL_TOKEN_SECRET). */
  tokenSecret?: string;
  /** Override base URL API Resend (mock rantai). */
  apiBase?: string;
  /** Basis URL publik web untuk merakit tautan /invite/:token. */
  publicBaseUrl?: string;
}

export type InvitationEmailDeliveryResult =
  | { kind: "sent"; providerId: string | null }
  | { kind: "not_configured" }
  | { kind: "skipped"; reason: "not_found" | "not_pending" | "already_sent" }
  | { kind: "failed"; code: string; message: string };

async function recordInvitationEmailError(
  db: Database,
  tenantId: string,
  invitationId: string,
  error: string,
): Promise<void> {
  await withTenantDb(db, tenantId, async (tx) => {
    await tx
      .update(invitations)
      .set({ emailError: error.slice(0, EMAIL_ERROR_MAX), updatedAt: new Date() })
      .where(
        and(
          eq(invitations.id, invitationId),
          eq(invitations.tenantId, tenantId),
          isNull(invitations.emailSentAt),
        ),
      );
  });
}

/**
 * Kirim email untuk SATU undangan. Idempoten: undangan yang sudah
 * terkirim / tidak lagi pending dilewati tanpa efek. Kegagalan provider
 * tercatat di `email_error` lalu dikembalikan sebagai { kind: "failed" }
 * — worker yang memutuskan retry BullMQ (attempts terbatas pola job
 * lain); undangan sendiri tidak pernah diubah statusnya oleh kegagalan
 * email.
 */
export async function deliverInvitationEmail(
  db: Database,
  deps: InvitationEmailDeps,
  data: { tenantId: string; invitationId: string; tokenEnc: string },
): Promise<InvitationEmailDeliveryResult> {
  const token = deps.tokenSecret
    ? decryptChannelSecret(deps.tokenSecret, data.tokenEnc)
    : null;
  if (!token) {
    await recordInvitationEmailError(
      db,
      data.tenantId,
      data.invitationId,
      "INVITATION_TOKEN_UNREADABLE: invitation token could not be decrypted",
    );
    return {
      kind: "failed",
      code: "INVITATION_TOKEN_UNREADABLE",
      message: "invitation token could not be decrypted",
    };
  }

  // Baca keadaan undangan + konteks email dalam konteks tenant pemilik.
  const prepared = await withTenantDb(db, data.tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.id, data.invitationId),
          eq(invitations.tenantId, data.tenantId),
        ),
      )
      .limit(1);
    if (!row) return { state: "not_found" as const };
    if (row.emailSentAt) return { state: "already_sent" as const };
    if (invitationStatus(row) !== "pending") {
      return { state: "not_pending" as const };
    }
    const [tenant] = await tx
      .select({ name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, data.tenantId))
      .limit(1);
    // Nama pengundang dari audit pembuatan (meta hanya berisi ID —
    // pola 9C); aktor audit → baris users untuk nama tampilnya.
    const [audit] = await tx
      .select({ actorId: auditLogs.actorId })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.tenantId, data.tenantId),
          eq(auditLogs.action, "team.invited"),
          sql`${auditLogs.meta}->>'invitationId' = ${data.invitationId}`,
        ),
      )
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);
    let inviterName: string | null = null;
    if (audit?.actorId) {
      const [actor] = await tx
        .select({ name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, audit.actorId))
        .limit(1);
      inviterName = actor?.name?.trim() ? actor.name : (actor?.email ?? null);
    }
    return {
      state: "ready" as const,
      invitation: row,
      tenantName: tenant?.name ?? "",
      inviterName,
    };
  });
  if (prepared.state === "not_found") return { kind: "skipped", reason: "not_found" };
  if (prepared.state === "already_sent") {
    return { kind: "skipped", reason: "already_sent" };
  }
  if (prepared.state === "not_pending") {
    return { kind: "skipped", reason: "not_pending" };
  }

  const config = await resolveEmailConfig(db, deps.platform);
  if (!config) {
    // Konfigurasi dicabut di antara pembuatan & job berjalan — catat
    // alasannya di baris undangan, selesaikan TANPA retry (bukan
    // kegagalan provider; mengantre ulang tidak mengubah apa pun).
    await recordInvitationEmailError(
      db,
      data.tenantId,
      data.invitationId,
      "not_configured: platform email (Resend) is not configured",
    );
    return { kind: "not_configured" };
  }

  const base = (deps.publicBaseUrl ?? "").replace(/\/+$/, "");
  const content = buildInvitationEmail({
    tenantName: prepared.tenantName,
    inviterName: prepared.inviterName,
    email: prepared.invitation.email,
    role: prepared.invitation.role,
    inviteUrl: `${base}/invite/${token}`,
    expiresAt: prepared.invitation.expiresAt,
  });
  const result = await sendEmail({
    config,
    apiBase: deps.apiBase,
    to: prepared.invitation.email,
    subject: content.subject,
    html: content.html,
    text: content.text,
  });
  if (result.kind === "failed") {
    await recordInvitationEmailError(
      db,
      data.tenantId,
      data.invitationId,
      `${result.code}: ${result.message}`,
    );
    return { kind: "failed", code: result.code, message: result.message };
  }
  if (result.kind === "not_configured") {
    // Tak terjangkau (config sudah diperiksa di atas) — dipertahankan
    // demi kejujuran tipe: perlakukan persis seperti cabang config null.
    await recordInvitationEmailError(
      db,
      data.tenantId,
      data.invitationId,
      "not_configured: platform email (Resend) is not configured",
    );
    return { kind: "not_configured" };
  }
  await withTenantDb(db, data.tenantId, async (tx) => {
    await tx
      .update(invitations)
      .set({ emailSentAt: new Date(), emailError: null, updatedAt: new Date() })
      .where(
        and(
          eq(invitations.id, data.invitationId),
          eq(invitations.tenantId, data.tenantId),
          isNull(invitations.emailSentAt),
        ),
      );
  });
  return { kind: "sent", providerId: result.providerId };
}

// ---------------------------------------------------------------------------
// Email reset kata sandi (Fase 14C — menutup sisa 11B)
// ---------------------------------------------------------------------------

/**
 * Masa berlaku token reset Better Auth (detik). Auth mengoper nilai ini
 * sebagai `resetPasswordTokenExpiresIn` dan isi email menyebut angka
 * yang sama — satu konstanta agar keduanya tidak pernah berbeda.
 */
export const PASSWORD_RESET_EXPIRES_IN_SECONDS = 3600;

export interface PasswordResetEmailContent {
  subject: string;
  html: string;
  text: string;
}

/**
 * Isi email reset — DWIBAHASA satu pesan seperti undangan (Inggris
 * utama, Indonesia di bawah pemisah). Tautan adalah URL utuh yang
 * dibangun Better Auth (`{baseURL}/reset-password/{token}?callbackURL=…`);
 * modul ini tidak pernah melihat tokennya secara terpisah dan tidak
 * menyimpan apa pun — token hidup hanya di tabel `auth_verification`
 * milik Better Auth (hash-side library) dan di email penerima.
 */
export function buildPasswordResetEmail(input: {
  resetUrl: string;
  expiresInMinutes: number;
}): PasswordResetEmailContent {
  const subject = "Reset your Sahabat Kreator password";

  const enBody = `We received a request to reset the password for your Sahabat Kreator account. Open the link below to choose a new password — it expires in ${input.expiresInMinutes} minutes and can be used once. If you didn't request this, you can safely ignore this email; your password will not change.`;
  const idBody = `Kami menerima permintaan untuk mengatur ulang kata sandi akun Sahabat Kreator Anda. Buka tautan di bawah untuk memilih kata sandi baru — tautan berlaku ${input.expiresInMinutes} menit dan hanya bisa dipakai sekali. Jika Anda tidak meminta ini, abaikan saja email ini; kata sandi Anda tidak akan berubah.`;

  const text = [
    "Hello,",
    "",
    enBody,
    "",
    "Reset your password:",
    input.resetUrl,
    "",
    "—",
    "",
    "Halo,",
    "",
    idBody,
    "",
    "Atur ulang kata sandi Anda:",
    input.resetUrl,
    "",
    "— Sahabat Kreator",
    "",
  ].join("\n");

  const html = [
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#1a1a1a">`,
    `<p>Hello,</p>`,
    `<p>${escapeHtml(enBody)}</p>`,
    `<p><a href="${escapeHtml(input.resetUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">Reset password</a></p>`,
    `<p style="font-size:13px;color:#555">Or open this link: <a href="${escapeHtml(input.resetUrl)}">${escapeHtml(input.resetUrl)}</a></p>`,
    `<hr style="border:none;border-top:1px solid #ddd;margin:24px 0">`,
    `<p>Halo,</p>`,
    `<p>${escapeHtml(idBody)}</p>`,
    `<p><a href="${escapeHtml(input.resetUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">Atur ulang kata sandi</a></p>`,
    `<p style="font-size:13px;color:#555">Atau buka tautan ini: <a href="${escapeHtml(input.resetUrl)}">${escapeHtml(input.resetUrl)}</a></p>`,
    `<p style="font-size:13px;color:#555">— Sahabat Kreator</p>`,
    `</div>`,
  ].join("");

  return { subject, html, text };
}

export interface PasswordResetEmailDeps {
  /** Opsi resolver Panel Admin proses pemanggil (panel → env). */
  platform: PlatformSettingsOptions;
  /** Override base URL API Resend (mock rantai). */
  apiBase?: string;
}

export type PasswordResetEmailResult =
  | { kind: "sent"; providerId: string | null }
  | { kind: "not_configured" }
  | { kind: "failed"; code: string; message: string };

/**
 * Kirim SATU email reset untuk hook `sendResetPassword` Better Auth.
 *
 * Bentuk pengiriman SENGAJA berbeda dari undangan tim (outbox + job):
 * reset kata sandi adalah urusan pengguna/platform, bukan tenant —
 * outbox kita tenant-sentris (tenant_id + relay RLS) sehingga memaksanya
 * ke sana berarti event platform ber-tenant NULL plus ciphertext URL.
 * Di sini Better Auth sendiri yang membuat & menyimpan token (tabel
 * verifikasinya) dan menyerahkan URL jadi ke hook; tidak ada kustodi
 * token yang perlu dipecahkan modul ini, jadi pengiriman langsung lewat
 * `sendEmail` adalah bentuk yang pas. Hasilnya dikembalikan apa adanya
 * (sent / not_configured / failed) agar pemanggil mencatatnya dengan
 * jujur — fungsi ini tidak pernah berpura-pura terkirim.
 */
export async function deliverPasswordResetEmail(
  db: Database,
  deps: PasswordResetEmailDeps,
  input: { email: string; resetUrl: string },
): Promise<PasswordResetEmailResult> {
  const config = await resolveEmailConfig(db, deps.platform);
  if (!config) return { kind: "not_configured" };
  const content = buildPasswordResetEmail({
    resetUrl: input.resetUrl,
    expiresInMinutes: Math.round(PASSWORD_RESET_EXPIRES_IN_SECONDS / 60),
  });
  const result = await sendEmail({
    config,
    apiBase: deps.apiBase,
    to: input.email,
    subject: content.subject,
    html: content.html,
    text: content.text,
  });
  if (result.kind === "sent") {
    return { kind: "sent", providerId: result.providerId };
  }
  if (result.kind === "failed") {
    return { kind: "failed", code: result.code, message: result.message };
  }
  // Tak terjangkau (config sudah diperiksa di atas) — dipertahankan
  // demi kejujuran tipe, persis pola deliverInvitationEmail.
  return { kind: "not_configured" };
}
