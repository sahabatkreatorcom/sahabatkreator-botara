/**
 * @sahabat-kreator/ai — runtime LLM Sahabat Kreator (Fase 3A).
 *
 * Isi: kontrak provider (`types.ts`), definisi tool agent (`tools.ts`),
 * MockProvider deterministik (default dev/test/staging), dan
 * OpenRouterProvider untuk model sungguhan. Loop agent-nya sendiri
 * (konteks, retrieval, eksekusi tool, metering) hidup di
 * @sahabat-kreator/core (`agent-runtime.ts`) agar transport-agnostic —
 * paket ini murni soal "bicara ke model".
 */
export {
  EMBEDDING_DIMENSIONS,
  type EmbeddingProvider,
  type EmbeddingResult,
  type EmbeddingUsage,
  type LlmChatMessage,
  type LlmChatRequest,
  type LlmChatResult,
  type LlmProvider,
  type LlmToolCall,
  type LlmToolDefinition,
  type LlmToolParameterProperty,
  type LlmUsage,
} from "./types";
export {
  AGENT_TOOLS,
  PIPELINE_STAGES,
  isPipelineStage,
  type PipelineStage,
} from "./tools";
export { MockProvider } from "./mock";
export { OpenRouterProvider, type OpenRouterProviderOptions } from "./openrouter";
export { MockEmbeddingProvider, MOCK_EMBEDDING_MODEL } from "./mock-embedding";
export {
  OpenRouterEmbeddingProvider,
  DEFAULT_EMBEDDING_MODEL,
  type OpenRouterEmbeddingProviderOptions,
} from "./openrouter-embedding";

import { MockProvider } from "./mock";
import { OpenRouterProvider } from "./openrouter";
import { MockEmbeddingProvider } from "./mock-embedding";
import { OpenRouterEmbeddingProvider } from "./openrouter-embedding";
import type { EmbeddingProvider, LlmProvider } from "./types";

export interface CreateLlmProviderOptions {
  /** Nilai env LLM_PROVIDER: 'mock' (default) | 'openrouter'. */
  provider?: string;
  openrouterApiKey?: string;
  openrouterModel?: string;
}

/**
 * Memilih provider dari konfigurasi env. 'openrouter' tanpa API key adalah
 * kesalahan konfigurasi yang disengaja dibuat GAGAL CEPAT (fail-fast di
 * proses worker) — diam-diam jatuh ke mock akan menyembunyikan fakta bahwa
 * staging tidak memakai model sungguhan.
 */
export function createLlmProvider(options: CreateLlmProviderOptions): LlmProvider {
  if (options.provider === "openrouter") {
    if (!options.openrouterApiKey) {
      throw new Error(
        "LLM_PROVIDER=openrouter tetapi OPENROUTER_API_KEY tidak tersedia di env",
      );
    }
    return new OpenRouterProvider({
      apiKey: options.openrouterApiKey,
      defaultModel: options.openrouterModel,
    });
  }
  return new MockProvider();
}

export interface CreateEmbeddingProviderOptions {
  /** 'mock' (eksplisit, untuk rantai uji) | 'openrouter' | undefined (auto dari kunci). */
  provider?: string;
  openrouterApiKey?: string;
  /** Override model embedding (env OPENROUTER_EMBEDDING_MODEL). */
  openrouterEmbeddingModel?: string;
}

/**
 * Memilih provider embedding (Fase 12D). Berbeda SENGAJA dari
 * `createLlmProvider`: embedding adalah fitur PENINGKAT — tanpa kunci
 * ia NONAKTIF dengan anggun (mengembalikan null dan retrieval jatuh ke
 * full-text murni), tidak pernah gagal keras dan tidak pernah diam-diam
 * memakai mock (mock hanya bila diminta eksplisit 'mock').
 */
export function createEmbeddingProvider(
  options: CreateEmbeddingProviderOptions,
): EmbeddingProvider | null {
  if (options.provider === "mock") return new MockEmbeddingProvider();
  if (options.openrouterApiKey) {
    return new OpenRouterEmbeddingProvider({
      apiKey: options.openrouterApiKey,
      model: options.openrouterEmbeddingModel,
    });
  }
  return null;
}
