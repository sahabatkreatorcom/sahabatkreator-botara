import { z } from "zod";

// ---------------------------------------------------------------------------
// Konsol Admin Platform (migrasi 0010) — Ringkasan, Tenant, Pengguna,
// Operasional, Sistem.
//
// Berbeda dari `admin.ts` yang hanya mengurus KREDENSIAL (status isSet,
// tanpa nilai), kontrak di sini mengangkut DATA OPERASIONAL lintas tenant.
// Batas yang dipegang: konsol TIDAK pernah menerima isi pesan pelanggan —
// hanya hitungan, status, dan metadata. Semua bentuk respons di sini
// diturunkan dari fungsi `platform-console` di core, sehingga UI dan API
// tidak bisa menyimpang tanpa gagal typecheck.
// ---------------------------------------------------------------------------

export const TenantStatusSchema = z.enum(["active", "suspended"]);
export type TenantStatus = z.infer<typeof TenantStatusSchema>;

export const PlatformOverviewResponseSchema = z.object({
  tenants: z.object({
    total: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    suspended: z.number().int().nonnegative(),
    newLast7d: z.number().int().nonnegative(),
  }),
  users: z.object({
    total: z.number().int().nonnegative(),
    newLast7d: z.number().int().nonnegative(),
  }),
  channels: z.object({
    total: z.number().int().nonnegative(),
    connected: z.number().int().nonnegative(),
  }),
  messages: z.object({
    last24h: z.number().int().nonnegative(),
    last7d: z.number().int().nonnegative(),
    outbound24h: z.number().int().nonnegative(),
  }),
  conversations: z.object({ open: z.number().int().nonnegative() }),
  outbox: z.object({
    pending: z.number().int().nonnegative(),
    deadLettered: z.number().int().nonnegative(),
  }),
  audit: z.object({ last24h: z.number().int().nonnegative() }),
});
export type PlatformOverviewResponse = z.infer<
  typeof PlatformOverviewResponseSchema
>;

export const PlatformTenantRowSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  status: TenantStatusSchema,
  statusReason: z.string().nullable(),
  createdAt: z.string().datetime(),
  members: z.number().int().nonnegative(),
  channels: z.number().int().nonnegative(),
  channelsConnected: z.number().int().nonnegative(),
  messages7d: z.number().int().nonnegative(),
  planCode: z.string().nullable(),
  subscriptionStatus: z.string().nullable(),
});
export type PlatformTenantRow = z.infer<typeof PlatformTenantRowSchema>;

export const PlatformTenantListResponseSchema = z.object({
  rows: z.array(PlatformTenantRowSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export type PlatformTenantListResponse = z.infer<
  typeof PlatformTenantListResponseSchema
>;

export const PlatformTenantMemberSchema = z.object({
  userId: z.string().uuid(),
  email: z.string(),
  name: z.string().nullable(),
  role: z.string(),
  joinedAt: z.string().datetime(),
});

export const PlatformTenantChannelSchema = z.object({
  id: z.string().uuid(),
  provider: z.string(),
  displayName: z.string().nullable(),
  status: z.string(),
});

export const PlatformTenantDetailResponseSchema = z.object({
  tenant: PlatformTenantRowSchema,
  members: z.array(PlatformTenantMemberSchema),
  channels: z.array(PlatformTenantChannelSchema),
  counts: z.object({
    contacts: z.number().int().nonnegative(),
    conversations: z.number().int().nonnegative(),
    messages: z.number().int().nonnegative(),
  }),
  recentAudit: z.array(
    z.object({
      id: z.string().uuid(),
      action: z.string(),
      actorType: z.string(),
      actorId: z.string().nullable(),
      createdAt: z.string().datetime(),
    }),
  ),
});
export type PlatformTenantDetailResponse = z.infer<
  typeof PlatformTenantDetailResponseSchema
>;

/**
 * Alasan penangguhan dibatasi 500 karakter: ia ditampilkan apa adanya kepada
 * pemilik tenant saat mereka bertanya, dan tidak boleh menjadi tempat
 * menuliskan catatan internal yang tidak pantas dibaca pelanggan.
 */
export const SetPlatformTenantStatusRequestSchema = z.object({
  status: TenantStatusSchema,
  reason: z.string().trim().max(500).optional(),
});
export type SetPlatformTenantStatusRequest = z.infer<
  typeof SetPlatformTenantStatusRequestSchema
>;

export const SetPlatformTenantStatusResponseSchema = z.object({
  id: z.string().uuid(),
  status: TenantStatusSchema,
  changed: z.boolean(),
});
export type SetPlatformTenantStatusResponse = z.infer<
  typeof SetPlatformTenantStatusResponseSchema
>;

export const PlatformUserListResponseSchema = z.object({
  rows: z.array(
    z.object({
      id: z.string().uuid(),
      email: z.string(),
      name: z.string().nullable(),
      createdAt: z.string().datetime(),
      memberships: z.array(
        z.object({
          tenantId: z.string().uuid(),
          tenantName: z.string(),
          role: z.string(),
        }),
      ),
      activeSessions: z.number().int().nonnegative(),
    }),
  ),
  /** Kata kunci < 2 karakter tidak dijalankan — UI memakai ini untuk diam. */
  tooShort: z.boolean(),
});
export type PlatformUserListResponse = z.infer<
  typeof PlatformUserListResponseSchema
>;

export const RevokeSessionsResponseSchema = z.object({
  revoked: z.number().int().nonnegative(),
});
export type RevokeSessionsResponse = z.infer<
  typeof RevokeSessionsResponseSchema
>;

export const DeadLetterOutboxListResponseSchema = z.object({
  rows: z.array(
    z.object({
      id: z.string().uuid(),
      type: z.string(),
      tenantId: z.string().uuid().nullable(),
      tenantName: z.string().nullable(),
      attempts: z.number().int().nonnegative(),
      lastError: z.string().nullable(),
      deadLetteredAt: z.string().datetime(),
      createdAt: z.string().datetime(),
    }),
  ),
});
export type DeadLetterOutboxListResponse = z.infer<
  typeof DeadLetterOutboxListResponseSchema
>;

export const RetryOutboxResponseSchema = z.object({
  id: z.string().uuid(),
  retried: z.boolean(),
});
export type RetryOutboxResponse = z.infer<typeof RetryOutboxResponseSchema>;

export const PlatformSystemResponseSchema = z.object({
  app: z.object({
    version: z.string(),
    buildSha: z.string().nullable(),
    uptimeSeconds: z.number().nonnegative(),
    nodeVersion: z.string(),
    environment: z.string(),
  }),
  database: z.object({
    size: z.string(),
    serverVersion: z.string(),
    serverTime: z.string(),
  }),
  tables: z.object({
    tenants: z.number().int().nonnegative(),
    users: z.number().int().nonnegative(),
    contacts: z.number().int().nonnegative(),
    conversations: z.number().int().nonnegative(),
    messages: z.number().int().nonnegative(),
  }),
});
export type PlatformSystemResponse = z.infer<
  typeof PlatformSystemResponseSchema
>;

// ---------------------------------------------------------------------------
// Manajemen admin platform & status backup (migrasi 0011)
// ---------------------------------------------------------------------------

export const PlatformAdminEntrySchema = z.object({
  email: z.string(),
  source: z.enum(["env", "panel"]),
  /** Baris env tidak bisa dicabut dari panel (harus lewat .env + deploy). */
  removable: z.boolean(),
  /** False = email ini belum punya akun yang terdaftar. */
  registered: z.boolean(),
  addedByEmail: z.string().nullable(),
  createdAt: z.string().datetime().nullable(),
});

export const PlatformAdminListResponseSchema = z.object({
  rows: z.array(PlatformAdminEntrySchema),
});
export type PlatformAdminListResponse = z.infer<
  typeof PlatformAdminListResponseSchema
>;

export const AddPlatformAdminRequestSchema = z.object({
  email: z.string().trim().email().max(320),
});
export type AddPlatformAdminRequest = z.infer<
  typeof AddPlatformAdminRequestSchema
>;

export const AddPlatformAdminResponseSchema = z.object({
  email: z.string(),
  created: z.boolean(),
});
export type AddPlatformAdminResponse = z.infer<
  typeof AddPlatformAdminResponseSchema
>;

export const RemovePlatformAdminResponseSchema = z.object({
  removed: z.boolean(),
  reason: z
    .enum(["not_found", "env_locked", "self", "last_admin"])
    .optional(),
  email: z.string().optional(),
});
export type RemovePlatformAdminResponse = z.infer<
  typeof RemovePlatformAdminResponseSchema
>;

export const BackupRunEntrySchema = z.object({
  id: z.string().uuid(),
  kind: z.string(),
  status: z.string(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  detail: z.string().nullable(),
  createdAt: z.string().datetime(),
});

export const PlatformBackupResponseSchema = z.object({
  rows: z.array(BackupRunEntrySchema),
  lastDaily: z.string().datetime().nullable(),
  lastDrill: z.string().datetime().nullable(),
});
export type PlatformBackupResponse = z.infer<
  typeof PlatformBackupResponseSchema
>;
