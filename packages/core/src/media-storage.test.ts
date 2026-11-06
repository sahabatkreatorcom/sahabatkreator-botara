import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildMediaObjectKey,
  createDiskMediaStore,
  createMemoryMediaStore,
  extensionFor,
  mediaChecksum,
} from "./media-storage";

/**
 * Penyimpanan objek media (Fase 18).
 *
 * Yang diuji bukan hanya "byte masuk lalu keluar", tetapi dua hal yang
 * membuat penyimpanan ini aman dipakai pada masukan tak tepercaya:
 * nama berkas dari pengirim TIDAK PERNAH menyentuh path filesystem, dan
 * key yang mencoba keluar dari root ditolak.
 */

describe("extensionFor", () => {
  it("mengutamakan ekstensi nama berkas", () => {
    expect(extensionFor("Invoice.PDF", null)).toBe(".pdf");
  });

  it("jatuh ke MIME saat nama berkas tidak ada", () => {
    expect(extensionFor(null, "image/jpeg")).toBe(".jpg");
  });

  it("tidak pernah menghasilkan pemisah path", () => {
    // Nama berkas datang dari pelanggan; yang dikembalikan hanya
    // ekstensi alfanumerik, jadi `../../etc/passwd` tidak bisa lolos.
    expect(extensionFor("../../etc/passwd", null)).toBe("");
    expect(extensionFor("a/b\\c.png", null)).toBe(".png");
  });
});

describe("buildMediaObjectKey", () => {
  const tenantId = "11111111-1111-4111-8111-111111111111";

  it("memakai uuid, bukan nama berkas asli", () => {
    const key = buildMediaObjectKey({
      tenantId,
      fileName: "../../rahasia.pdf",
      mimeType: "application/pdf",
      now: new Date("2026-11-06T00:00:00Z"),
    });
    expect(key).toMatch(
      /^tenants\/11111111-1111-4111-8111-111111111111\/media\/2026-11\/[0-9a-f-]{36}\.pdf$/,
    );
    expect(key).not.toContain("rahasia");
  });

  it("tanpa ekstensi bila jenis tidak dikenal", () => {
    const key = buildMediaObjectKey({
      tenantId,
      fileName: null,
      mimeType: "application/octet-stream",
      now: new Date("2026-01-02T00:00:00Z"),
    });
    expect(key).toContain("/media/2026-01/");
    expect(path.basename(key)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("createDiskMediaStore", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "sk-media-"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("menyimpan lalu membaca kembali byte + content-type", async () => {
    const store = createDiskMediaStore(root);
    const key = "tenants/t/media/2026-11/a.png";
    await store.put(key, Buffer.from("png-bytes"), "image/png");
    const got = await store.get(key);
    expect(got?.data.toString()).toBe("png-bytes");
    expect(got?.contentType).toBe("image/png");
  });

  it("mengembalikan null untuk key yang tidak ada", async () => {
    const store = createDiskMediaStore(root);
    expect(await store.get("tenants/t/media/2026-11/hilang.png")).toBeNull();
  });

  it("menghapus objek beserta metadatanya", async () => {
    const store = createDiskMediaStore(root);
    const key = "tenants/t/media/2026-11/hapus.png";
    await store.put(key, Buffer.from("x"), "image/png");
    await store.delete(key);
    expect(await store.get(key)).toBeNull();
    // Hapus kedua tidak melempar — pembersihan harus idempoten.
    await expect(store.delete(key)).resolves.toBeUndefined();
  });

  it("menolak key yang keluar dari root", async () => {
    const store = createDiskMediaStore(root);
    await expect(store.get("../../etc/passwd")).rejects.toThrow(
      "media_key_outside_root",
    );
  });

  it("menyebutkan objek tanpa menyertakan berkas sampingan", async () => {
    // `put` menulis `<key>.meta`. Kalau sampingan itu ikut terdaftar
    // sebagai objek, GC akan menganggapnya yatim, menghapusnya, dan
    // content-type hilang — sambil melaporkan angka yang salah.
    const store = createDiskMediaStore(root);
    await store.put("tenants/lists/1.png", Buffer.from("a"), "image/png");
    await store.put("tenants/lists/2.mp4", Buffer.from("b"), "video/mp4");
    const entries = await store.list("tenants/lists/");
    expect(entries.map((e) => e.key)).toEqual([
      "tenants/lists/1.png",
      "tenants/lists/2.mp4",
    ]);
    expect(entries[0]?.lastModified).toBeInstanceOf(Date);
  });

  it("tidak melempar saat prefix belum ada", async () => {
    const store = createDiskMediaStore(root);
    expect(await store.list("tenants/belum-ada/")).toEqual([]);
  });

  it("menolak prefix yang keluar dari root", async () => {
    // Prefix bisa datang dari env atau konfigurasi; menjelajah `..`
    // berarti menyebutkan isi mesin ini ke pemanggil.
    const store = createDiskMediaStore(root);
    await expect(store.list("../../")).rejects.toThrow("media_key_outside_root");
  });
});

describe("createMemoryMediaStore", () => {
  it("menyimpan di memori tanpa menyentuh disk", async () => {
    const store = createMemoryMediaStore();
    await store.put("k", Buffer.from("abc"), "text/plain");
    expect((await store.get("k"))?.data.toString()).toBe("abc");
    expect(store.objects.size).toBe(1);
    await store.delete("k");
    expect(await store.get("k")).toBeNull();
  });

  it("menyaring list menurut prefix", async () => {
    const store = createMemoryMediaStore();
    await store.put("tenants/a/1.png", Buffer.from("a"), "image/png");
    await store.put("tenants/b/2.png", Buffer.from("b"), "image/png");
    expect((await store.list("tenants/a/")).map((e) => e.key)).toEqual([
      "tenants/a/1.png",
    ]);
  });
});

describe("mediaChecksum", () => {
  it("stabil untuk isi yang sama", () => {
    expect(mediaChecksum(Buffer.from("a"))).toBe(
      mediaChecksum(Buffer.from("a")),
    );
    expect(mediaChecksum(Buffer.from("a"))).not.toBe(
      mediaChecksum(Buffer.from("b")),
    );
  });
});
