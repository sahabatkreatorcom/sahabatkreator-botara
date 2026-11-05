import type {
  LlmChatRequest,
  LlmChatResult,
  LlmProvider,
  LlmToolCall,
} from "./types";

/**
 * OpenRouterProvider — jalur model sungguhan (aktif bila
 * LLM_PROVIDER=openrouter DAN OPENROUTER_API_KEY tersedia).
 *
 * Memakai endpoint chat completions OpenRouter yang kompatibel OpenAI,
 * termasuk function calling. Fallback yang dijaga:
 * - respons tanpa tool_calls valid → teks biasa, toolCalls kosong;
 * - argumen tool yang bukan JSON valid → tool call itu DIBUANG (bukan crash);
 * - content null → teks kosong (runtime memperlakukan sebagai tanpa balasan).
 * Timeout 30 detik via AbortSignal; respons non-2xx melempar Error dengan
 * status + potongan body agar tercatat di audit `agent.failed`.
 */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "openai/gpt-4o-mini";
const TIMEOUT_MS = 30_000;

export interface OpenRouterProviderOptions {
  apiKey: string;
  /** Default bila agent tidak menentukan model (env OPENROUTER_MODEL). */
  defaultModel?: string;
}

interface OpenRouterToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenRouterResponse {
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: OpenRouterToolCall[];
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** Biaya aktual USD — hanya hadir bila request meminta `usage.include`. */
    cost?: number;
  };
}

export class OpenRouterProvider implements LlmProvider {
  readonly name = "openrouter";
  private readonly apiKey: string;
  private readonly defaultModel: string;

  constructor(options: OpenRouterProviderOptions) {
    this.apiKey = options.apiKey;
    this.defaultModel = options.defaultModel || DEFAULT_MODEL;
  }

  async chat(request: LlmChatRequest): Promise<LlmChatResult> {
    const model = request.model || this.defaultModel;
    const chunks = (request.kbChunks ?? []).filter((c) => c.trim().length > 0);
    const system =
      chunks.length > 0
        ? `${request.system}\n\nBasis pengetahuan (jawab hanya berdasarkan fakta ini bila relevan):\n${chunks
            .map((c) => `- ${c}`)
            .join("\n")}`
        : request.system;

    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "Sahabat Kreator",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          ...request.messages.map((m) => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.content,
          })),
        ],
        tools: request.tools.map((t) => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          },
        })),
        tool_choice: "auto",
        // Fase 9B: minta rincian usage LENGKAP termasuk biaya aktual
        // (usage.cost, USD) agar metering mencatat biaya yang benar-benar
        // dilaporkan provider — bukan estimasi tabel harga.
        usage: { include: true },
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `OpenRouter HTTP ${response.status}: ${body.slice(0, 300)}`,
      );
    }

    const data = (await response.json()) as OpenRouterResponse;
    const message = data.choices?.[0]?.message;
    const toolCalls: LlmToolCall[] = [];
    for (const [i, raw] of (message?.tool_calls ?? []).entries()) {
      const name = raw.function?.name;
      if (!name) continue;
      let args: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(raw.function?.arguments ?? "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        // Argumen rusak: buang tool call ini, jangan gagalkan seluruh chat.
        continue;
      }
      toolCalls.push({ id: raw.id ?? `openrouter-call-${i}`, name, arguments: args });
    }

    return {
      text: (message?.content ?? "").trim(),
      toolCalls,
      usage: {
        tokensIn: data.usage?.prompt_tokens ?? 0,
        tokensOut: data.usage?.completion_tokens ?? 0,
        // Biaya hanya dicatat bila provider melaporkannya sebagai angka
        // sah pada respons ini; selain itu undefined (tidak dikarang).
        ...(typeof data.usage?.cost === "number" &&
        Number.isFinite(data.usage.cost) &&
        data.usage.cost >= 0
          ? { costUsd: data.usage.cost }
          : {}),
      },
      model: data.model ?? model,
      provider: this.name,
    };
  }
}
