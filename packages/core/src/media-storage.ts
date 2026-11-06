import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Penyimpanan objek media (Fase 18).
 *
 * Antarmuka sekecil mungkin — `put`/`get`/`delete` — supaya dua
 * implementasi yang benar-benar berbeda bisa bertukar tempat tanpa
 * menyentuh domain: disk (default, jalan tanpa layanan luar) dan R2
 * (produksi). Yang TIDAK ada di sini sengaja: presigned URL,
 * multipart. Inbox menyajikan byte lewat endpoint API sendiri
 * (`GET /media/:id`) yang memeriksa sesi + tenant, jadi bucket boleh
 * tetap privat dan tidak ada URL yang perlu ditandatangani.
 *
 * Fase 19 menambahkan `list`: tanpa kemampuan menyebutkan isi
 * penyimpanan, berkas yang tidak dirujuk baris mana pun tidak akan
 * pernah bisa ditemukan — dan itulah satu-satunya cara membersihkannya.
 *
 * Kenapa disk lebih dulu, bukan R2: R2 memakai protokol S3 dengan tanda
 * tangan SigV4, dan tidak ada SDK S3 di repo ini (instalasi paket tidak
 * tersedia di lingkungan build). Menulis penanda tangan SigV4 tanpa
 * kemampuan mengujinya terhadap bucket sungguhan berarti mengirim kode
 * yang tidak pernah terbukti bekerja. Disk bisa diuji penuh hari ini;
 * R2 menjadi slot yang tinggal diisi (`MediaObjectStore` yang sama)
 * ketika kredensialnya bisa diuji.
 */
export interface MediaObjectEntry {
  /** Key relatif terhadap akar penyimpanan, selalu berpemisah `/`. */
  key: string;
  /**
   * Kapan objek terakhir ditulis. Dipakai masa tenggang GC: berkas
   * yang baru saja ditulis belum tentu yatim — barisnya bisa sedang
   * dalam perjalanan ke database.
   */
  lastModified: Date;
}

export interface MediaObjectStore {
  /** Simpan byte; menimpa bila key sudah ada. */
  put(key: string, data: Buffer, contentType: string | null): Promise<void>;
  /** Baca byte; null bila key tidak ada. */
  get(key: string): Promise<{ data: Buffer; contentType: string | null } | null>;
  /** Hapus; tidak melempar bila key sudah tidak ada. */
  delete(key: string): Promise<void>;
  /**
   * Apakah objek ada — TANPA membaca isinya.
   *
   * Dipakai GC untuk memeriksa baris yang berkasnya hilang. Memakai
   * `get` untuk itu berarti mengunduh setiap video 16 MB hanya untuk
   * mengetahui ketiadaannya.
   */
  exists(key: string): Promise<boolean>;
  /**
   * Semua objek di bawah `prefix` (rekursif), terurut naik menurut key.
   * Prefix dicocokkan sebagai awalan string, bukan sebagai direktori —
   * pemanggil yang menambahkan `/` sendiri bila itu yang dimaksud.
   */
  list(prefix: string): Promise<MediaObjectEntry[]>;
}

/**
 * Key objek: `tenants/{tenantId}/media/{yyyy-mm}/{uuid}{ext}`.
 *
 * Sengaja TIDAK memakai nama berkas asli sebagai key. Nama dari pengirim
 * adalah masukan tak tepercaya: bisa memuat `../`, karakter kontrol,
 * atau panjang ekstrem, dan `document.filename` di WhatsApp memang
 * datang dari pelanggan. Nama asli tetap disimpan di kolom
 * `media.file_name` untuk ditampilkan; yang menyentuh filesystem hanya
 * uuid. Bulan dipakai sebagai partisi supaya direktori tidak membengkak
 * dan penghapusan massal per periode tetap mungkin.
 */
export function buildMediaObjectKey(input: {
  tenantId: string;
  fileName: string | null;
  mimeType: string | null;
  now?: Date;
}): string {
  const now = input.now ?? new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return `tenants/${input.tenantId}/media/${month}/${randomUUID()}${extensionFor(
    input.fileName,
    input.mimeType,
  )}`;
}

/**
 * Ekstensi dari nama berkas bila wajar, selain itu dari MIME.
 *
 * Nama berkas dipakai lebih dulu karena `application/octet-stream`
 * (umum pada dokumen WhatsApp) tidak memberi petunjuk apa pun.
 * Hasilnya selalu `^[a-z0-9]{1,8}$` atau string kosong — tidak ada
 * pemisah path yang bisa lolos.
 */
export function extensionFor(
  fileName: string | null,
  mimeType: string | null,
): string {
  const fromName = /\.([A-Za-z0-9]{1,8})$/.exec(fileName ?? "")?.[1];
  if (fromName) return `.${fromName.toLowerCase()}`;
  const fromMime = MIME_EXTENSIONS[mimeType ?? ""];
  return fromMime ? `.${fromMime}` : "";
}

const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/amr": "amr",
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/plain": "txt",
};

/**
 * Penyimpanan di disk lokal — default untuk dev, self-host, dan test.
 *
 * `root` wajib absolut; path key di-`resolve` lalu diperiksa masih di
 * dalam root. Pemeriksaan itu bukan formalitas: key diturunkan dari
 * uuid di `buildMediaObjectKey`, tetapi `get`/`delete` bisa dipanggil
 * dengan key dari DB yang (secara teori) sudah diubah. Tanpa
 * pemeriksaan ini satu key berisi `../..` menjadi baca/tulis berkas
 * sembarang di mesin.
 */
export function createDiskMediaStore(root: string): MediaObjectStore {
  const absoluteRoot = path.resolve(root);

  const resolveKey = (key: string): string => {
    const target = path.resolve(absoluteRoot, key);
    if (target !== absoluteRoot && !target.startsWith(absoluteRoot + path.sep)) {
      throw new Error("media_key_outside_root");
    }
    return target;
  };

  return {
    async put(key, data, contentType) {
      const target = resolveKey(key);
      await mkdir(path.dirname(target), { recursive: true });
      // Tulis ke berkas sementara lalu rename: pembaca tidak pernah
      // melihat berkas setengah jadi, dan kegagalan di tengah tidak
      // meninggalkan media rusak yang tampak sah.
      const temp = `${target}.${randomUUID()}.part`;
      await writeFile(temp, data);
      await rename(temp, target);
      // Content-type tidak punya tempat di filesystem; disimpan
      // berdampingan supaya `get` bisa mengembalikannya tanpa menebak
      // dari ekstensi (yang bisa tidak ada).
      await writeFile(`${target}.meta`, contentType ?? "", "utf8");
    },
    async get(key) {
      const target = resolveKey(key);
      let data: Buffer;
      try {
        data = await readFile(target);
      } catch {
        return null;
      }
      let contentType: string | null = null;
      try {
        const meta = (await readFile(`${target}.meta`, "utf8")).trim();
        contentType = meta || null;
      } catch {
        /* meta hilang: content-type null, byte tetap disajikan */
      }
      return { data, contentType };
    },
    async delete(key) {
      const target = resolveKey(key);
      await rm(target, { force: true });
      await rm(`${target}.meta`, { force: true });
    },
    async exists(key) {
      try {
        const info = await stat(resolveKey(key));
        return info.isFile();
      } catch {
        return false;
      }
    },
    async list(prefix) {
      // Prefix juga harus di dalam root: `list` bisa dipanggil dengan
      // nilai dari luar (mis. dari env), dan menjelajah `..` berarti
      // menyebutkan isi mesin ini ke pemanggil.
      const start = resolveKey(prefix);
      const entries: MediaObjectEntry[] = [];

      const walk = async (dir: string): Promise<void> => {
        let items;
        try {
          items = await readdir(dir, { withFileTypes: true });
        } catch {
          // Direktori belum ada = tidak ada objek. Bukan kegagalan.
          return;
        }
        for (const item of items) {
          const full = path.join(dir, item.name);
          if (item.isDirectory()) {
            await walk(full);
            continue;
          }
          // Sampingan `put` bukan objek media: `.meta` menyimpan
          // content-type, `.part` adalah berkas sementara yang mungkin
          // tertinggal bila proses mati di tengah rename. Keduanya
          // dilaporkan sebagai objek akan membuat GC menghapusnya
          // berulang kali dan melaporkan angka yang salah.
          if (item.name.endsWith(".meta") || item.name.endsWith(".part")) continue;
          let info;
          try {
            info = await stat(full);
          } catch {
            continue; // hilang di antara readdir dan stat
          }
          entries.push({
            key: path.relative(absoluteRoot, full).split(path.sep).join("/"),
            lastModified: info.mtime,
          });
        }
      };

      await walk(start);
      return entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    },
  };
}

/**
 * Penyimpanan di memori — untuk test dan untuk `verify:*`.
 *
 * Tidak dipakai di produksi: isinya hilang saat proses mati, dan tidak
 * ada batas ukuran. Kehadirannya membuat ingest media bisa diuji tanpa
 * menulis ke disk sama sekali.
 */
export function createMemoryMediaStore(): MediaObjectStore & {
  readonly objects: Map<
    string,
    { data: Buffer; contentType: string | null; lastModified: Date }
  >;
} {
  const objects = new Map<
    string,
    { data: Buffer; contentType: string | null; lastModified: Date }
  >();
  return {
    objects,
    async put(key, data, contentType) {
      objects.set(key, { data, contentType, lastModified: new Date() });
    },
    async get(key) {
      return objects.get(key) ?? null;
    },
    async delete(key) {
      objects.delete(key);
    },
    async exists(key) {
      return objects.has(key);
    },
    async list(prefix) {
      return [...objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, lastModified: value.lastModified }))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    },
  };
}

/**
 * Sidik jari isi berkas — dipakai sebagai `r2_key` alternatif saat
 * mendeteksi duplikat (berkas sama dikirim dua kali) dan untuk
 * memverifikasi unduhan tidak terpotong.
 */
export function mediaChecksum(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
