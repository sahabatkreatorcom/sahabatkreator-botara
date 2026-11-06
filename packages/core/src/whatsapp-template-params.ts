/**
 * Parameter template WhatsApp per KOMPONEN (Fase 17).
 *
 * Sebelum ini seluruh aplikasi hanya mengenal variabel BODY:
 * `deriveTemplateBody` mengambil `components.find(c => c.type === "BODY")`
 * lalu menghitung `{{n}}` di teksnya. HEADER dan tombol URL diabaikan
 * sepenuhnya — tipe `HEADER` bahkan hanya muncul di satu komentar.
 *
 * Akibatnya template yang header-nya `{{1}}` atau tombol URL-nya
 * `{{1}}` TIDAK BISA DIKIRIM dari aplikasi ini: Meta menolak dengan
 * parameter-mismatch, pesannya `failed`, dan panel inbox hanya
 * menawarkan kolom sebanyak variabel BODY — pengguna disuruh "isi semua
 * variabel" padahal tidak ada tempat untuk mengisinya. Jalan buntu.
 *
 * Modul ini murni: masuk `components` (jsonb apa adanya dari Meta),
 * keluar spesifikasi yang bisa dipakai validasi, pengiriman, dan UI.
 * Ditaruh di core — bukan di paket channel — karena core tidak boleh
 * bergantung pada adapter, sementara validasi antrean dan pratinjau
 * broadcast hidup di sini.
 */

/** Batas Meta: satu variabel untuk header teks dan satu per tombol URL. */
const TEMPLATE_PLACEHOLDER_RE = /\{\{(\d+)\}\}/g;

/**
 * Jumlah variabel sebuah teks template = indeks `{{n}}` TERBESAR yang
 * muncul (Meta menomori mulai 1 tanpa celah; teks tanpa placeholder = 0).
 */
export function countTemplateVariables(text: string | null | undefined): number {
  if (!text) return 0;
  let max = 0;
  for (const match of text.matchAll(TEMPLATE_PLACEHOLDER_RE)) {
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

/** Render `{{n}}` dengan parameter ke-n (1-based); kosong bila tidak ada. */
export function renderTemplateText(
  text: string,
  params: readonly string[],
): string {
  return text.replace(TEMPLATE_PLACEHOLDER_RE, (_whole, raw: string) => {
    const idx = Number(raw) - 1;
    return idx >= 0 && idx < params.length ? params[idx] : "";
  });
}

export interface WhatsAppTemplateParamSpec {
  /**
   * HEADER template. `format` menentukan jenis parameternya: `TEXT`
   * memakai satu variabel teks, sedangkan `IMAGE`/`VIDEO`/`DOCUMENT`
   * memerlukan unggahan media — belum didukung, dan UI harus
   * mengatakannya alih-alih mengirim lalu gagal.
   */
  header: { format: string | null; text: string | null; variableCount: number };
  body: { text: string | null; variableCount: number };
  /**
   * Tombol URL yang memuat variabel. `index` = posisi tombol pada array
   * `buttons` (0-based) — itu yang dibaca Meta sebagai `index`, BUKAN
   * posisi relatif di antara tombol URL saja.
   */
  urlButtons: Array<{ index: number; variableCount: number }>;
  /** Total parameter yang wajib diisi = header + body + semua tombol URL. */
  total: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Baca komponen template secara defensif: `components` datang dari jsonb
 * (bentuk apa pun bisa tersimpan bila Meta mengubah responsnya), jadi
 * tidak boleh ada `as` yang berani.
 */
export function deriveTemplateParamSpec(
  components: unknown,
): WhatsAppTemplateParamSpec {
  const list = Array.isArray(components) ? components : [];

  let header: WhatsAppTemplateParamSpec["header"] = {
    format: null,
    text: null,
    variableCount: 0,
  };
  let body: WhatsAppTemplateParamSpec["body"] = { text: null, variableCount: 0 };
  const urlButtons: Array<{ index: number; variableCount: number }> = [];

  for (const entry of list) {
    const component = asRecord(entry);
    if (!component) continue;
    const type = asText(component.type)?.toUpperCase();

    if (type === "HEADER") {
      const format = asText(component.format)?.toUpperCase() ?? null;
      const text = asText(component.text);
      // Media header tidak punya placeholder teks; parameternya berupa
      // media, bukan string.
      header = {
        format,
        text,
        variableCount: format === "TEXT" ? countTemplateVariables(text) : 0,
      };
      continue;
    }

    if (type === "BODY") {
      const text = asText(component.text);
      body = { text, variableCount: countTemplateVariables(text) };
      continue;
    }

    if (type === "BUTTONS" && Array.isArray(component.buttons)) {
      component.buttons.forEach((rawButton, index) => {
        const button = asRecord(rawButton);
        if (!button) return;
        const buttonType = asText(button.type)?.toUpperCase();
        if (buttonType !== "URL") return;
        const url = asText(button.url);
        const variableCount = countTemplateVariables(url);
        if (variableCount > 0) urlButtons.push({ index, variableCount });
      });
    }
  }

  return {
    header,
    body,
    urlButtons,
    total:
      header.variableCount +
      body.variableCount +
      urlButtons.reduce((sum, button) => sum + button.variableCount, 0),
  };
}

/**
 * Teks yang disimpan di `messages.content_text` untuk pesan template:
 * header (bila ada) lalu body, masing-masing sudah terisi parameter.
 *
 * Inbox menampilkan kolom ini apa adanya. Tanpa header, agen melihat
 * balasan yang berbeda dari yang diterima pelanggan — dan `{{1}}` mentah
 * di header akan terlihat seperti pesan yang belum jadi.
 */
export function renderTemplateContent(
  spec: WhatsAppTemplateParamSpec,
  params: { headerParams?: readonly string[]; bodyParams?: readonly string[] },
): string {
  const parts: string[] = [];
  if (spec.header.text) {
    parts.push(renderTemplateText(spec.header.text, params.headerParams ?? []));
  }
  if (spec.body.text) {
    parts.push(renderTemplateText(spec.body.text, params.bodyParams ?? []));
  }
  return parts.join("\n\n");
}
