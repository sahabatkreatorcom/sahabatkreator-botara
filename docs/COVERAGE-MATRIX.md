# Matriks cakupan fitur

Status per 2026-11-06. Kolom **Bukti** menunjuk ke tempat perilakunya
dapat diverifikasi — bukan sekadar "ada file".

Legenda: ✅ selesai · ⚠️ sebagian · ❌ belum

---

## Kanal

| Fitur | Status | Bukti |
|---|---|---|
| WhatsApp Cloud API (kirim/terima, template) | ✅ | `channel-whatsapp`, `whatsapp_templates` |
| Messenger (Page token, Send API) | ✅ | `channel-messenger` |
| Instagram via Facebook Login | ✅ | `channel-messenger` (jalur sama) |
| Instagram API with Instagram Login | ❌ | sengaja belum ada (§12.7) |
| Telegram Bot API | ✅ | `channel-telegram`, `modules/telegram` |
| Webchat widget | ✅ | `packages/embed`, `modules/webchat` |
| OAuth "Lanjutkan dengan Facebook" | ✅ | `modules/meta-oauth` |
| Siklus hidup token Meta (refresh, tandai mati) | ✅ | `meta-token-lifecycle`, migrasi 0003 |

## Inbox

| Fitur | Status | Bukti |
|---|---|---|
| Daftar percakapan + filter status/penugasan | ✅ | `modules/inbox` |
| Kirim pesan + kutipan (reply) | ✅ | `SendMessageRequestSchema`, `reply_to_snapshot` |
| Penugasan agen, tandai dibaca | ✅ | `assignConversation`, `markConversationRead` |
| Catatan internal | ✅ | `conversation_notes` |
| Saved replies (macro) | ✅ | `saved_replies` |
| Avatar kontak & bot | ✅ | `profile_photos`, `modules/avatars` |
| Realtime (socket dashboard) | ✅ | `apps/realtime` |
| Pencarian percakapan (nama/nomor/judul) | ✅ | `listConversations({ search })`, `escapeLikePattern` |
| Status kerja open/pending/closed | ✅ | `setConversationStatus`, audit `conversation.status_changed` |
| Nyalakan/matikan AI per percakapan | ✅ | `setConversationAgentEnabled`, `POST …/agent` |
| Jendela 24 jam WhatsApp (tolak teks bebas di luar jendela) | ✅ | `computeMessagingWindow`, `MESSAGING_WINDOW_CLOSED` |
| Kirim template WhatsApp dari inbox (jalan keluar jendela tertutup) | ✅ | `queueTemplateMessage`, `POST …/template` |
| Paginasi pesan lama (`before` + `hasMore`) | ✅ | `listMessagesPage` |

## Otomasi

| Fitur | Status | Bukti |
|---|---|---|
| Automation keyword | ✅ | `core/automations.ts` |
| Sequence bertahap | ✅ | `sequence_enrollments`, `sequence.step` |
| Flow builder grafis | ✅ | `core/flows/` (11 modul), `FlowBuilderPage` |
| Node flow (15+ tipe: condition, delay, ai_response, http_request, goto_flow, ab_split, wait_reply, questionnaire, show_catalog, cart_checkout, book_appointment, …) | ✅ | `validateFlowNodeConfig` |
| Eksperimen A/B di flow | ✅ | `flow_experiment_assignments` |
| Broadcast kampanye | ✅ | `core/broadcasts.ts` |
| Segmen audiens | ✅ | `core/segments.ts` |
| Opt-in/opt-out consent | ✅ | `tenant_opt_in_settings` |

## AI

| Fitur | Status | Bukti |
|---|---|---|
| Agen dengan mode auto/suggest | ✅ | `core/agent-runtime.ts` |
| Knowledge base (dokumen, chunk, full-text) | ✅ | `kb_documents`, `kb_chunks.search_vector` |
| Embedding semantik (pgvector) | ✅ | `embedding vector(1536)`, `kb-embeddings` |
| Playground agen | ✅ | `verify:agent-playground`, `PlaygroundPanel` |
| Kuota & ledger token | ✅ | `usage_ledger`, `ai-usage` |
| Provider mock (tanpa biaya) | ✅ | `packages/ai/mock.ts` |
| Provider OpenRouter | ✅ | `packages/ai/openrouter.ts` |

## Commerce

| Fitur | Status | Bukti |
|---|---|---|
| Katalog produk | ✅ | `products` |
| Tautan bayar publik `/pay/:code` | ✅ | `modules/pay` |
| Keranjang & checkout | ✅ | `carts`, `cart_items`, `checkoutCartTx` |
| Order | ✅ | `orders`, `order_items` |
| Midtrans (webhook SHA512) | ✅ | `handleMidtransWebhook` |
| Xendit (callback token) | ✅ | `handleXenditWebhook` |
| Konfigurasi provider per tenant | ✅ | `payment_provider_configs` |

## Pertumbuhan & janji temu

| Fitur | Status | Bukti |
|---|---|---|
| Tautan pertumbuhan + landing picker | ✅ | `growth_links`, `/go/:slug` |
| Layanan & ketersediaan janji | ✅ | `appointment_*` |
| Booking dengan anti-double-booking | ✅ | constraint `bookings_no_overlap_confirmed` |
| Sinkron Google Calendar | ✅ | `google_calendar_connections` |

## Platform

| Fitur | Status | Bukti |
|---|---|---|
| Multi-tenant RLS | ✅ | 77 policy, `db verify` |
| Tim & undangan (email Resend) | ✅ | `modules/team`, `invitations` |
| API publik `/v1` + API key ber-scope | ✅ | `modules/public-v1` |
| SDK TypeScript | ✅ | `packages/sdk`, `verify:sdk` |
| CLI `sk` | ✅ | `apps/cli` |
| MCP server | ✅ | `apps/mcp-server` |
| Panel admin platform | ✅ | `modules/admin`, `AdminPage` |
| Audit log & integration log | ✅ | `audit_logs`, `integration_log` |
| Relay outbox: isolasi per event + karantina | ✅ | `outbox.ts` (`OUTBOX_MAX_ATTEMPTS`), `outbox.test.ts` |
| Jejak job latar yang menyerah | ✅ | `job-failures.ts`, audit `job.failed`, kategori "Background job" |
| Analytics & dashboard | ✅ | `modules/analytics`, `modules/dashboard` |
| i18n id/en | ✅ | `packages/i18n` |
| Rate limit in-app | ⚠️ | fallback in-memory bila Redis mati (salah untuk multi-replika) |
| Billing/subscription (paket berbayar) | ❌ | `subscriptions` ada, alur tagihan belum |

## Kualitas

| Fitur | Status | Bukti |
|---|---|---|
| Typecheck seluruh paket | ✅ | `pnpm typecheck` |
| ESLint | ✅ | `pnpm lint` (0 error, 20 warning) |
| Unit test (RLS, kontrak, jobId, webhook) | ✅ | `pnpm test` (186 test, 18 file) |
| Verifikasi migrasi + RLS penuh | ✅ | `pnpm --filter db verify` (44 seksi) |
| CI | ✅ | `.github/workflows/ci.yml` |
| Deploy Docker | ✅ | `Dockerfile`, `deploy/` |
| E2E browser (Playwright) | ❌ | belum ada |
