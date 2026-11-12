import { z } from "zod";

// ---------------------------------------------------------------------------
// Pemilih board Pinterest — board tujuan Pin PER AKUN (lanjutan
// Gelombang 3 + gelombang Semua OAuth).
//
// Pin Pinterest WAJIB masuk sebuah board (`board_id` pada
// POST /v5/pins — tidak ada Pin tanpa board). Sejak Gelombang 3
// adapter memakai board PERTAMA akun; pemilih ini memberi pemilik
// workspace kendali: board tujuan dipilih dari daftar board akun
// itu sendiri (GET /v5/boards) dan disimpan per akun channel
// (kolom pinterest_board_id + snapshot pinterest_board_name,
// migrasi 0025). Board baru juga bisa DIBUAT dari pemilih yang
// sama (POST /v5/boards, scope boards:write yang sudah diminta
// connect) dan otomatis menjadi pilihan.
//
// Endpoint (modul channels, owner/admin saja):
//   GET  /tenants/:tenantId/channels/:channelId/pinterest-boards
//        daftar board akun + pilihan tersimpan saat ini
//   PUT  /tenants/:tenantId/channels/:channelId/pinterest-board
//        simpan pilihan (boardId divalidasi ke daftar board akun;
//        null = bersihkan → kembali ke board pertama)
//   POST /tenants/:tenantId/channels/:channelId/pinterest-boards
//        buat board baru → otomatis menjadi pilihan
//
// Token akun TIDAK PERNAH muncul di skema mana pun di sini — server
// memakai token tersimpan akun untuk memanggil API v5.
// ---------------------------------------------------------------------------

/** Satu board milik akun Pinterest (bentuk ringkas daftar API v5). */
export const PinterestBoardSchema = z.object({
  /** Id board API v5 (string numerik). */
  id: z.string(),
  /** Nama board; null bila provider tidak mengembalikannya. */
  name: z.string().nullable(),
});
export type PinterestBoard = z.infer<typeof PinterestBoardSchema>;

/**
 * Daftar board akun + pilihan tujuan tersimpan — respons GET daftar
 * dan PUT simpan (bentuk sama agar UI menyegarkan dari satu respons).
 * `selectedBoardId` null = belum memilih (penerbit memakai board
 * pertama); `selectedBoardName` adalah snapshot saat pilihan
 * disimpan — board terpilih yang sudah dihapus di Pinterest tetap
 * tampil dari snapshot ini sampai pemilik memilih ulang.
 */
export const PinterestBoardsResponseSchema = z.object({
  boards: z.array(PinterestBoardSchema),
  selectedBoardId: z.string().nullable(),
  selectedBoardName: z.string().nullable(),
});
export type PinterestBoardsResponse = z.infer<
  typeof PinterestBoardsResponseSchema
>;

/**
 * Simpan pilihan board. `boardId` wajib ada di daftar board akun
 * saat disimpan (server memvalidasinya; board asing → 422
 * PINTEREST_BOARD_NOT_FOUND). `null` membersihkan pilihan →
 * penerbit kembali ke board pertama akun.
 */
export const PinterestBoardSelectRequestSchema = z.object({
  boardId: z.string().min(1).max(64).nullable(),
});
export type PinterestBoardSelectRequest = z.infer<
  typeof PinterestBoardSelectRequestSchema
>;

/**
 * Privasi board baru yang ditawarkan pemilih. API v5 mengenal juga
 * SECRET, tetapi board rahasia menuntut scope `boards:write_secret`
 * yang tidak diminta connect kita — tidak ditawarkan.
 */
export const PinterestBoardPrivacySchema = z.enum(["PUBLIC", "PROTECTED"]);
export type PinterestBoardPrivacy = z.infer<
  typeof PinterestBoardPrivacySchema
>;

/**
 * Buat board baru (POST /v5/boards API v5): `name` wajib,
 * `description` opsional, `privacy` bawaan PUBLIC. Board hasil buat
 * langsung menjadi pilihan akun (itulah alur pemilih: buat → pakai).
 */
export const PinterestBoardCreateRequestSchema = z.object({
  name: z.string().trim().min(1).max(180),
  description: z.string().trim().max(500).optional(),
  privacy: PinterestBoardPrivacySchema.default("PUBLIC"),
});
export type PinterestBoardCreateRequest = z.infer<
  typeof PinterestBoardCreateRequestSchema
>;

/**
 * Hasil buat board: board yang baru dibuat (sudah menjadi pilihan)
 * + daftar board terbaru akun termasuk pilihan tersimpan — bentuk
 * yang sama seperti respons daftar agar UI menyegarkan sekali.
 */
export const PinterestBoardCreateResponseSchema =
  PinterestBoardsResponseSchema.extend({
    /** Board yang baru dibuat lewat permintaan ini. */
    createdBoard: PinterestBoardSchema,
  });
export type PinterestBoardCreateResponse = z.infer<
  typeof PinterestBoardCreateResponseSchema
>;
