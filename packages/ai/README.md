# @sahabat-kreator/ai

Lapisan "bicara ke model" untuk AI Agent: kontrak provider LLM, definisi
tool agent, dan dua implementasi provider. Loop agent-nya sendiri
(konteks percakapan, retrieval KB, eksekusi tool, caps, metering) hidup
di `@sahabat-kreator/core` (`agent-runtime.ts`) agar transport-agnostic.

**Status: live sejak Fase 3A.**

- `types.ts` — kontrak `LlmProvider.chat({system, messages, tools, kbChunks})`
  → `{text, toolCalls, usage, model, provider}`. Teks hasil = balasan yang
  dikirim; tool call = aksi (tidak ada tool `send_message`). Provider wajib
  menelan tool call yang tidak valid sebagai teks biasa (tanpa crash).
- `tools.ts` — tool v1: `tag_contact`, `move_pipeline_stage`
  (stage valid: `PIPELINE_STAGES`), `handoff_to_human`.
- `mock.ts` — **MockProvider** deterministik (default; `LLM_PROVIDER=mock`):
  mengutip kalimat pertama chunk KB teratas bila ada, selalu memanggil
  `tag_contact 'ai-lead'`, usage = estimasi karakter/4, biaya 0. Tidak
  pernah memanggil handoff/stage — jalur itu diuji lewat executor tool.
- `openrouter.ts` — **OpenRouterProvider** (`LLM_PROVIDER=openrouter` +
  `OPENROUTER_API_KEY`): chat completions + function calling, fallback
  aman, timeout 30 dtk. Model dari konfigurasi agent, atau env
  `OPENROUTER_MODEL`, atau default `openai/gpt-4o-mini`.
- `createLlmProvider(env)` — pemilihan provider; openrouter tanpa API key
  gagal cepat (fail-fast), tidak diam-diam jatuh ke mock.
