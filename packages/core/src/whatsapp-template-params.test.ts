import { describe, expect, it } from "vitest";
import {
  deriveTemplateParamSpec,
  renderTemplateContent,
  renderTemplateText,
} from "./whatsapp-template-params";

/**
 * Turunan spesifikasi parameter (Fase 17).
 *
 * Fungsi ini dibaca oleh tiga tempat sekaligus — validasi antrean,
 * pengiriman, dan UI — jadi salah membacanya berarti kolom input yang
 * salah jumlahnya DAN kiriman yang ditolak Meta. Karena `components`
 * berasal dari jsonb, masukannya diperlakukan sebagai data tak
 * tepercaya: bentuk apa pun harus menghasilkan sesuatu yang masuk akal,
 * bukan lemparan.
 */

describe("deriveTemplateParamSpec", () => {
  it("menghitung header teks, body, dan tombol URL secara terpisah", () => {
    const spec = deriveTemplateParamSpec([
      { type: "HEADER", format: "TEXT", text: "Pesanan {{1}}" },
      { type: "BODY", text: "Halo {{1}}, pesanan {{2}} dikirim." },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Batal" },
          { type: "URL", text: "Lacak", url: "https://toko.id/l/{{1}}" },
        ],
      },
    ]);
    expect(spec.header).toMatchObject({ format: "TEXT", variableCount: 1 });
    expect(spec.body.variableCount).toBe(2);
    // Index 1, bukan 0: posisi tombol pada array `buttons` — itu yang
    // dibaca Meta, bukan urutan di antara tombol URL.
    expect(spec.urlButtons).toEqual([{ index: 1, variableCount: 1 }]);
    expect(spec.total).toBe(4);
  });

  it("tidak menghitung variabel pada header media", () => {
    // Header IMAGE tidak membawa placeholder teks; parameternya media.
    // Menghitungnya sebagai variabel teks akan meminta input yang salah.
    const spec = deriveTemplateParamSpec([
      { type: "HEADER", format: "IMAGE" },
      { type: "BODY", text: "Lihat promo." },
    ]);
    expect(spec.header).toMatchObject({ format: "IMAGE", variableCount: 0 });
    expect(spec.total).toBe(0);
  });

  it("menghitung beberapa tombol URL ber-variabel", () => {
    const spec = deriveTemplateParamSpec([
      { type: "BODY", text: "Pilih." },
      {
        type: "BUTTONS",
        buttons: [
          { type: "URL", url: "https://a.id/{{1}}" },
          { type: "URL", url: "https://b.id/x/{{1}}" },
        ],
      },
    ]);
    expect(spec.urlButtons).toEqual([
      { index: 0, variableCount: 1 },
      { index: 1, variableCount: 1 },
    ]);
  });

  it("mengabaikan tombol URL tanpa variabel", () => {
    const spec = deriveTemplateParamSpec([
      { type: "BUTTONS", buttons: [{ type: "URL", url: "https://a.id/tetap" }] },
    ]);
    expect(spec.urlButtons).toEqual([]);
  });

  it("menerima tipe komponen huruf kecil dari respons Meta", () => {
    const spec = deriveTemplateParamSpec([
      { type: "header", format: "text", text: "Halo {{1}}" },
      { type: "body", text: "Isi {{1}}" },
    ]);
    expect(spec.header.variableCount).toBe(1);
    expect(spec.body.variableCount).toBe(1);
  });

  it("tidak melempar untuk masukan rusak", () => {
    // jsonb bisa berisi apa saja bila bentuk respons Meta berubah.
    for (const input of [null, undefined, "bukan-array", 42, {}, [null], [{}]]) {
      const spec = deriveTemplateParamSpec(input);
      expect(spec.total).toBe(0);
      expect(spec.urlButtons).toEqual([]);
    }
  });
});

describe("renderTemplateText / renderTemplateContent", () => {
  it("mengganti placeholder dengan parameter ke-n", () => {
    expect(renderTemplateText("Halo {{1}}, {{2}}!", ["Rina", "INV-42"])).toBe(
      "Halo Rina, INV-42!",
    );
  });

  it("mengosongkan placeholder tanpa parameter, bukan membiarkannya mentah", () => {
    // `{{1}}` yang lolos ke layar pelanggan lebih buruk daripada kosong:
    // ia terlihat seperti pesan yang belum jadi.
    expect(renderTemplateText("Halo {{1}}", [])).toBe("Halo ");
  });

  it("merender header lalu body sebagai isi pesan", () => {
    const spec = deriveTemplateParamSpec([
      { type: "HEADER", format: "TEXT", text: "Pesanan {{1}}" },
      { type: "BODY", text: "Halo {{1}}." },
    ]);
    expect(
      renderTemplateContent(spec, {
        headerParams: ["INV-42"],
        bodyParams: ["Rina"],
      }),
    ).toBe("Pesanan INV-42\n\nHalo Rina.");
  });

  it("hanya body bila template tidak punya header", () => {
    const spec = deriveTemplateParamSpec([{ type: "BODY", text: "Halo {{1}}" }]);
    expect(renderTemplateContent(spec, { bodyParams: ["Rina"] })).toBe("Halo Rina");
  });
});
