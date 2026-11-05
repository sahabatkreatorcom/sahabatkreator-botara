import {
  EMBEDDING_DIMENSIONS,
  type EmbeddingProvider,
  type EmbeddingResult,
} from "./types";

/**
 * OpenRouterEmbeddingProvider — embedding sungguhan lewat endpoint
 * `/embeddings` OpenRouter yang kompatibel OpenAI (Fase 12D).
 *
 * Model default `openai/text-embedding-3-small` — 1536 dimensi, cocok
 * dengan kolom `kb_chunks.embedding` vector(1536) yang disiapkan sejak
 * Fase 3A. Penjaga keras: vektor yang dimensinya bukan 1536 DITOLAK
 * dengan error jelas (model salah dimensi tidak boleh mencemari kolom;
 * job pemanggil akan retry lalu gagal terlihat, bukan diam-diam
 * menyimpan vektor dari ruang yang berbeda).
 *
 * Biaya: dibaca dari `usage.cost` HANYA bila provider melaporkannya
 * sebagai angka sah pada respons ini — selain itu undefined (aturan
 * kejujuran metering Fase 9B; tidak ada tabel harga/estimasi).
 * Timeout 30 detik via AbortSignal; non-2xx melempar Error berisi
 * status + potongan body agar tercatat di log job.
 */

const OPENROUTER_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";
export const DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-small";
const TIMEOUT_MS = 30_000;

export interface OpenRouterEmbeddingProviderOptions {
  apiKey: string;
  /** Override model (env OPENROUTER_EMBEDDING_MODEL); default 3-small. */
  model?: string;
  /** Override base URL (pengujian); default endpoint OpenRouter. */
  baseUrl?: string;
}

interface OpenRouterEmbeddingResponse {
  model?: string;
  data?: Array<{ index?: number; embedding?: number[] }>;
  usage?: {
    prompt_tokens?: number;
    total_tokens?: number;
    /** Biaya aktual USD bila dilaporkan provider pada respons ini. */
    cost?: number;
  };
}

export class OpenRouterEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openrouter";
  readonly model: string;
  private readonly apiKey: string;
  private readonly url: string;

  constructor(options: OpenRouterEmbeddingProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model || DEFAULT_EMBEDDING_MODEL;
    this.url = options.baseUrl ?? OPENROUTER_EMBEDDINGS_URL;
  }

  async embed(texts: string[]): Promise<EmbeddingResult> {
    if (texts.length === 0) {
      return {
        vectors: [],
        usage: { tokensIn: 0 },
        model: this.model,
        provider: this.name,
      };
    }
    const response = await fetch(this.url, {
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "Sahabat Kreator",
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `OpenRouter embeddings HTTP ${response.status}: ${body.slice(0, 300)}`,
      );
    }

    const data = (await response.json()) as OpenRouterEmbeddingResponse;
    const rows = [...(data.data ?? [])].sort(
      (a, b) => (a.index ?? 0) - (b.index ?? 0),
    );
    if (rows.length !== texts.length) {
      throw new Error(
        `OpenRouter embeddings: jumlah vektor ${rows.length} != jumlah input ${texts.length}`,
      );
    }
    const vectors = rows.map((row) => {
      const vector = row.embedding;
      if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(
          `OpenRouter embeddings: model ${this.model} menghasilkan ${Array.isArray(vector) ? vector.length : "bukan-vektor"} dimensi, diharapkan ${EMBEDDING_DIMENSIONS}`,
        );
      }
      return vector;
    });

    return {
      vectors,
      usage: {
        tokensIn: data.usage?.prompt_tokens ?? data.usage?.total_tokens ?? 0,
        ...(typeof data.usage?.cost === "number" &&
        Number.isFinite(data.usage.cost) &&
        data.usage.cost >= 0
          ? { costUsd: data.usage.cost }
          : {}),
      },
      model: data.model ?? this.model,
      provider: this.name,
    };
  }
}
