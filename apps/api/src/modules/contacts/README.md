# Modul `contacts`

CRUD kontak audiens per workspace. **Fase 1D terimplementasi** (`routes.ts`):

- `POST /tenants/:tenantId/contacts` — buat kontak {name, phone?, email?, tags?} → 201
- `GET /tenants/:tenantId/contacts?search=&limit=&offset=&segmentId=&stage=` — daftar + total
- `GET /tenants/:tenantId/contacts/:id` — detail; bukan milik tenant → 404
- `PATCH /tenants/:tenantId/contacts/:id` — name, tags, pipeline_stage, opt_in_status, customFields (+ customFieldsDelete)

Wajib sesi + membership workspace (non-member → 404 `TENANT_NOT_FOUND`).
Logika domain di `@sahabat-kreator/core` (`contacts.ts`), validasi Zod dari
`@sahabat-kreator/contracts`. Custom fields & segmentasi lanjutan menyusul.

## Gelombang Perbaikan /contacts

Route tambahan:

- `GET /tenants/:tenantId/contacts/export?search=&segmentId=&stage=` — unduh
  CSV seluruh kontak sesuai filter daftar utama yang aktif.
- `POST /tenants/:tenantId/contacts/import` {csv} — impor CSV; jawaban
  berupa laporan per baris (masuk / duplikat terlewat / tidak sah beralasan).
- `POST /tenants/:tenantId/contacts/bulk` — satu aksi (beri/lepas tag,
  pindah tahap, opt-out, hapus) untuk banyak kontak; hasil per aksi
  dilaporkan. Aksi `delete` digerbang owner/admin.
- `GET /tenants/:tenantId/contacts/:id/conversations` — percakapan milik
  kontak untuk panel detail.

### Saringan kontak akun-sendiri di daftar utama

Daftar utama (GET daftar, dan ekspor yang berbagi filternya) meneruskan
`excludeSelfChannelContacts` ke core `listContacts`. Kontak yang disaring
adalah kontak AKUN-SENDIRI: identitas channel-nya adalah akun itu sendiri
(`channel_identities.external_user_id = channel_accounts.external_id` —
uji yang sama seperti resolusi avatar) DAN satu-satunya relasi
percakapannya adalah `kind='channel'` (jangkar sasaran linimasa).
Kontak jangkar yang juga punya percakapan private/group TIDAK disaring.

Peta audit permukaan kontak (keputusan saring per permukaan):

| Permukaan | Melihat akun-sendiri? |
| --- | --- |
| Daftar utama /contacts + ekspor CSV (filter yang sama) | TIDAK (tersaring) |
| Deteksi duplikat & kandidat merge (`findDuplicateContacts`) | Ya (permukaan pembersihan) |
| Evaluator segmen & keanggotaan (`listSegmentMemberIds`) | Ya — daftar utama berkomposisi di atasnya |
| Audiens broadcast (pratinjau & materialisasi, evaluator segmen yang sama) | Ya |
| Materialisasi sasaran postingan (`ensureTimelineTargets`/`listPostTargets`) | Ya (justru membuat jangkarnya) |
| Penilaian opt-in per kontak (`setContactConsent`, status efektif) | Ya (per kontak, bukan daftar) |
| API publik v1 (`GET /v1/contacts`) | Ya — tidak meneruskan opsi saringan |
| Ringkasan dashboard (hitungan kontak baru) | Ya (bukan permukaan daftar) |

Data tidak pernah dihapus oleh saringan ini — murni saringan tampilan
daftar, sejajar saringan `kinds` Inbox untuk percakapan channel.
