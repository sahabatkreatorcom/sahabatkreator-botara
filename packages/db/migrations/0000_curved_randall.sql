CREATE EXTENSION IF NOT EXISTS "vector";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "btree_gist";--> statement-breakpoint
CREATE TYPE "public"."user_theme" AS ENUM('system', 'light', 'dark');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'admin', 'agent', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('trialing', 'active', 'past_due', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."audit_actor_type" AS ENUM('user', 'agent', 'system', 'api_key');--> statement-breakpoint
CREATE TYPE "public"."integration_direction" AS ENUM('in', 'out');--> statement-breakpoint
CREATE TYPE "public"."usage_type" AS ENUM('message', 'ai_token', 'contact');--> statement-breakpoint
CREATE TYPE "public"."channel_account_status" AS ENUM('connected', 'disconnected', 'error');--> statement-breakpoint
CREATE TYPE "public"."channel_provider" AS ENUM('whatsapp', 'instagram', 'messenger', 'telegram', 'webchat');--> statement-breakpoint
CREATE TYPE "public"."channel_token_health" AS ENUM('ok', 'expiring', 'expired', 'refresh_failed');--> statement-breakpoint
CREATE TYPE "public"."channel_token_type" AS ENUM('page_access_token', 'system_user_token', 'business_token');--> statement-breakpoint
CREATE TYPE "public"."conversation_status" AS ENUM('open', 'pending', 'closed');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."message_sender_type" AS ENUM('contact', 'user', 'agent', 'system');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('queued', 'sent', 'delivered', 'read', 'failed', 'received');--> statement-breakpoint
CREATE TYPE "public"."message_type" AS ENUM('text', 'image', 'audio', 'video', 'document', 'sticker', 'template', 'other');--> statement-breakpoint
CREATE TYPE "public"."opt_in_status" AS ENUM('unknown', 'opted_in', 'opted_out');--> statement-breakpoint
CREATE TYPE "public"."automation_action_type" AS ENUM('send_message');--> statement-breakpoint
CREATE TYPE "public"."automation_kind" AS ENUM('keyword', 'sequence', 'comment');--> statement-breakpoint
CREATE TYPE "public"."automation_run_status" AS ENUM('completed', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."automation_trigger_type" AS ENUM('keyword', 'comment');--> statement-breakpoint
CREATE TYPE "public"."sequence_enrollment_status" AS ENUM('active', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."agent_mode" AS ENUM('auto', 'suggest');--> statement-breakpoint
CREATE TYPE "public"."agent_suggestion_status" AS ENUM('pending', 'approved', 'rejected', 'sent');--> statement-breakpoint
CREATE TYPE "public"."cart_status" AS ENUM('open', 'checked_out', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('pending', 'paid', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."payment_link_status" AS ENUM('pending', 'paid', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."broadcast_recipient_status" AS ENUM('queued', 'sent', 'delivered', 'read', 'failed', 'skipped', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."broadcast_status" AS ENUM('draft', 'scheduled', 'sending', 'completed', 'partially_failed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."comment_moderation_status" AS ENUM('visible', 'hidden');--> statement-breakpoint
CREATE TYPE "public"."flow_run_status" AS ENUM('running', 'waiting', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."flow_status" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."growth_link_event_kind" AS ENUM('click', 'picker_view', 'conversion');--> statement-breakpoint
CREATE TYPE "public"."growth_link_kind" AS ENUM('single', 'picker');--> statement-breakpoint
CREATE TYPE "public"."booking_google_sync_status" AS ENUM('not_connected', 'pending', 'synced', 'failed');--> statement-breakpoint
CREATE TYPE "public"."booking_status" AS ENUM('confirmed', 'cancelled');--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(64) NOT NULL,
	"name" varchar(128) NOT NULL,
	"limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(320) NOT NULL,
	"auth_user_id" text,
	"name" varchar(255),
	"locale" varchar(10) DEFAULT 'en' NOT NULL,
	"theme" "user_theme" DEFAULT 'system' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_auth_user_id_unique" UNIQUE("auth_user_id")
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(128) NOT NULL,
	"key_hash" varchar(255) NOT NULL,
	"key_prefix" varchar(16) DEFAULT '' NOT NULL,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" varchar(320) NOT NULL,
	"role" "member_role" DEFAULT 'agent' NOT NULL,
	"token_hash" varchar(255) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"email_sent_at" timestamp with time zone,
	"email_error" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"status" "subscription_status" DEFAULT 'active' NOT NULL,
	"current_period_end" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "member_role" DEFAULT 'agent' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(128) NOT NULL,
	"default_locale" varchar(10) DEFAULT 'en' NOT NULL,
	"timezone" varchar(64) DEFAULT 'Asia/Jakarta' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_id" varchar(255),
	"action" varchar(128) NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"direction" "integration_direction" NOT NULL,
	"provider" varchar(32) NOT NULL,
	"tenant_id" uuid,
	"channel_account_id" uuid,
	"message_id" uuid,
	"signature_valid" boolean,
	"outcome" varchar(32) NOT NULL,
	"error_code" varchar(128),
	"summary" varchar(255),
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"type" varchar(128) NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" "usage_type" NOT NULL,
	"qty" numeric(18, 6) NOT NULL,
	"cost_model" numeric(18, 6) DEFAULT '0' NOT NULL,
	"cost_provider" numeric(18, 6) DEFAULT '0' NOT NULL,
	"currency" varchar(3) DEFAULT 'IDR' NOT NULL,
	"ref_type" varchar(64),
	"ref_id" varchar(255),
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"provider" varchar(32) NOT NULL,
	"provider_event_id" varchar(255) NOT NULL,
	"payload" jsonb NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "auth_session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "auth_user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "auth_verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" "channel_provider" NOT NULL,
	"external_id" varchar(255) NOT NULL,
	"display_name" varchar(255),
	"status" "channel_account_status" DEFAULT 'disconnected' NOT NULL,
	"access_token_encrypted" text,
	"webhook_secret" varchar(255),
	"bot_username" varchar(255),
	"public_handle" varchar(255),
	"parent_external_id" varchar(255),
	"graph_api_version" varchar(16),
	"token_type" "channel_token_type",
	"token_expires_at" timestamp with time zone,
	"token_refreshed_at" timestamp with time zone,
	"token_health" "channel_token_health",
	"error_code" varchar(128),
	"trashed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"channel_account_id" uuid NOT NULL,
	"provider" "channel_provider" NOT NULL,
	"external_user_id" varchar(255) NOT NULL,
	"username" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"email" varchar(320),
	"phone" varchar(32),
	"tags" text[] DEFAULT '{}' NOT NULL,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pipeline_stage" varchar(64) DEFAULT 'new' NOT NULL,
	"source" varchar(128),
	"opt_in_status" "opt_in_status" DEFAULT 'unknown' NOT NULL,
	"consent_at" timestamp with time zone,
	"opt_in_source" varchar(64),
	"opt_in_at" timestamp with time zone,
	"last_contacted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"author_user_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"channel_account_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"provider" "channel_provider" NOT NULL,
	"provider_chat_id" varchar(255),
	"title" varchar(255),
	"kind" varchar(16) DEFAULT 'private' NOT NULL,
	"status" "conversation_status" DEFAULT 'open' NOT NULL,
	"assignee_user_id" uuid,
	"agent_enabled" boolean DEFAULT true NOT NULL,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_kind_valid" CHECK ("conversations"."kind" IN ('private', 'group', 'channel'))
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"r2_key" varchar(512) NOT NULL,
	"file_name" varchar(255),
	"mime_type" varchar(128),
	"size_bytes" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"direction" "message_direction" NOT NULL,
	"sender_type" "message_sender_type" NOT NULL,
	"sender_name" varchar(255),
	"type" "message_type" DEFAULT 'text' NOT NULL,
	"content_text" text,
	"media_id" uuid,
	"provider_message_id" varchar(255),
	"status" "message_status" DEFAULT 'received' NOT NULL,
	"error_code" varchar(128),
	"claimed_at" timestamp with time zone,
	"sent_by_user_id" uuid,
	"reply_to_message_id" uuid,
	"reply_to_snapshot" jsonb,
	"template_payload" jsonb,
	"provider_comment_id" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"automation_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"trigger_message_id" uuid,
	"status" "automation_run_status" NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"automation_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"delay_minutes" integer DEFAULT 0 NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_steps_delay_minutes_nonnegative" CHECK ("automation_steps"."delay_minutes" >= 0),
	CONSTRAINT "automation_steps_position_positive" CHECK ("automation_steps"."position" >= 1)
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"trigger_type" "automation_trigger_type" DEFAULT 'keyword' NOT NULL,
	"trigger_config" jsonb DEFAULT '{"keywords":[],"match":"exact"}'::jsonb NOT NULL,
	"action_type" "automation_action_type" DEFAULT 'send_message' NOT NULL,
	"action_config" jsonb DEFAULT '{"text":""}'::jsonb NOT NULL,
	"kind" "automation_kind" DEFAULT 'keyword' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sequence_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"automation_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"trigger_message_id" uuid,
	"current_step" integer DEFAULT 0 NOT NULL,
	"status" "sequence_enrollment_status" DEFAULT 'active' NOT NULL,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"trigger_message_id" uuid,
	"contact_id" uuid,
	"suggested_text" text NOT NULL,
	"status" "agent_suggestion_status" DEFAULT 'pending' NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"system_prompt" text DEFAULT '' NOT NULL,
	"model" varchar(128) DEFAULT '' NOT NULL,
	"mode" "agent_mode" DEFAULT 'suggest' NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', "content")) STORED,
	"embedding" vector(1536),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" varchar(255) NOT NULL,
	"content" text NOT NULL,
	"source_document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_source_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"file_name" varchar(255) NOT NULL,
	"mime_type" varchar(128) NOT NULL,
	"byte_size" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cart_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"cart_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"qty" integer NOT NULL,
	"unit_price_idr" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cart_items_qty_positive" CHECK ("cart_items"."qty" > 0),
	CONSTRAINT "cart_items_unit_price_nonnegative" CHECK ("cart_items"."unit_price_idr" >= 0)
);
--> statement-breakpoint
CREATE TABLE "carts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"status" "cart_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid,
	"product_name" varchar(255) NOT NULL,
	"qty" integer NOT NULL,
	"unit_price_idr" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_items_qty_positive" CHECK ("order_items"."qty" > 0),
	CONSTRAINT "order_items_unit_price_nonnegative" CHECK ("order_items"."unit_price_idr" >= 0)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"conversation_id" uuid,
	"status" "order_status" DEFAULT 'pending' NOT NULL,
	"total_idr" bigint NOT NULL,
	"payment_link_id" uuid,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_total_idr_nonnegative" CHECK ("orders"."total_idr" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payment_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid,
	"order_id" uuid,
	"contact_id" uuid,
	"conversation_id" uuid,
	"code" varchar(64) NOT NULL,
	"amount_idr" bigint NOT NULL,
	"status" "payment_link_status" DEFAULT 'pending' NOT NULL,
	"provider" varchar(32) DEFAULT 'simulation' NOT NULL,
	"provider_environment" varchar(16) DEFAULT 'sandbox' NOT NULL,
	"provider_ref" varchar(255),
	"checkout_url" text,
	"paid_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_links_amount_idr_nonnegative" CHECK ("payment_links"."amount_idr" >= 0),
	CONSTRAINT "payment_links_exactly_one_target" CHECK (("payment_links"."product_id" IS NOT NULL) <> ("payment_links"."order_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"price_idr" bigint NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_price_idr_nonnegative" CHECK ("products"."price_idr" >= 0)
);
--> statement-breakpoint
CREATE TABLE "platform_settings" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"value_encrypted" text NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profile_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"owner_type" varchar(32) NOT NULL,
	"owner_id" uuid NOT NULL,
	"content_type" varchar(128) NOT NULL,
	"data" "bytea" NOT NULL,
	"etag" varchar(64) NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_photos_owner_type_valid" CHECK ("profile_photos"."owner_type" IN ('channel_account', 'contact'))
);
--> statement-breakpoint
CREATE TABLE "broadcast_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"broadcast_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"conversation_id" uuid,
	"message_id" uuid,
	"status" "broadcast_recipient_status" DEFAULT 'queued' NOT NULL,
	"variant" varchar(8) DEFAULT 'a' NOT NULL,
	"skip_reason" varchar(64),
	"error_code" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "broadcasts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"channel_account_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"message_text" varchar(4096) NOT NULL,
	"whatsapp_template_id" uuid,
	"template_variable_sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"audience_filter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"require_opt_in" boolean DEFAULT false NOT NULL,
	"ab_split_percent_b" integer,
	"variant_b_message_text" varchar(4096),
	"variant_b_whatsapp_template_id" uuid,
	"variant_b_template_variable_sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "broadcast_status" DEFAULT 'draft' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error_code" varchar(128),
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"channel_account_id" uuid NOT NULL,
	"meta_template_id" varchar(255),
	"name" varchar(512) NOT NULL,
	"language" varchar(32) NOT NULL,
	"category" varchar(32) NOT NULL,
	"status" varchar(32) NOT NULL,
	"components" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"body_text" text,
	"variable_count" integer DEFAULT 0 NOT NULL,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"channel_account_id" uuid NOT NULL,
	"provider" varchar(32) NOT NULL,
	"provider_comment_id" varchar(255) NOT NULL,
	"media_id" varchar(255),
	"post_id" varchar(255),
	"parent_id" varchar(255),
	"author_external_id" varchar(255) NOT NULL,
	"author_username" varchar(255),
	"text" text NOT NULL,
	"provider_created_at" timestamp with time zone,
	"moderation_status" "comment_moderation_status" DEFAULT 'visible' NOT NULL,
	"contact_id" uuid,
	"conversation_id" uuid,
	"matched_automation_id" uuid,
	"actions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flow_experiment_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"flow_id" uuid NOT NULL,
	"node_id" varchar(128) NOT NULL,
	"contact_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"branch" varchar(8) NOT NULL,
	"label" varchar(255),
	"percent_a" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flow_run_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"node_id" varchar(128) NOT NULL,
	"node_type" varchar(64) NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flow_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"flow_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"trigger_message_id" uuid,
	"status" "flow_run_status" DEFAULT 'running' NOT NULL,
	"current_node_id" varchar(128),
	"next_step_seq" integer DEFAULT 1 NOT NULL,
	"step_count" integer DEFAULT 0 NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" varchar(128),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"status" "flow_status" DEFAULT 'draft' NOT NULL,
	"graph" jsonb DEFAULT '{"nodes":[],"edges":[]}'::jsonb NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" varchar(255) NOT NULL,
	"body" text NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "growth_link_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"growth_link_id" uuid NOT NULL,
	"kind" "growth_link_event_kind" NOT NULL,
	"contact_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "growth_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" "growth_link_kind" NOT NULL,
	"label" varchar(128) NOT NULL,
	"slug" varchar(64) NOT NULL,
	"channel_account_id" uuid,
	"picker_channel_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"auto_tag" varchar(64),
	"prefill_text" varchar(1000),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "growth_links_kind_channel_check" CHECK (("growth_links"."kind" = 'single' AND "growth_links"."channel_account_id" IS NOT NULL AND jsonb_array_length("growth_links"."picker_channel_ids") = 0)
        OR ("growth_links"."kind" = 'picker' AND "growth_links"."channel_account_id" IS NULL AND jsonb_array_length("growth_links"."picker_channel_ids") >= 2))
);
--> statement-breakpoint
CREATE TABLE "segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(128) NOT NULL,
	"definition" jsonb NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_opt_in_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"opt_in_keywords" jsonb NOT NULL,
	"opt_in_confirmation_text" varchar(1000),
	"opt_out_extra_keywords" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appointment_availability" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"weekday" integer NOT NULL,
	"start_time" varchar(5) NOT NULL,
	"end_time" varchar(5) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_availability_weekday_range" CHECK ("appointment_availability"."weekday" >= 0 AND "appointment_availability"."weekday" <= 6),
	CONSTRAINT "appointment_availability_start_format" CHECK ("appointment_availability"."start_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
	CONSTRAINT "appointment_availability_end_format" CHECK ("appointment_availability"."end_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
	CONSTRAINT "appointment_availability_end_after_start" CHECK ("appointment_availability"."end_time" > "appointment_availability"."start_time")
);
--> statement-breakpoint
CREATE TABLE "appointment_services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"duration_minutes" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_services_duration_positive" CHECK ("appointment_services"."duration_minutes" > 0)
);
--> statement-breakpoint
CREATE TABLE "appointment_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"timezone" varchar(64) DEFAULT 'Asia/Jakarta' NOT NULL,
	"min_lead_minutes" integer DEFAULT 120 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"conversation_id" uuid,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" "booking_status" DEFAULT 'confirmed' NOT NULL,
	"source" varchar(16) NOT NULL,
	"google_event_id" varchar(255),
	"google_sync_status" "booking_google_sync_status" DEFAULT 'not_connected' NOT NULL,
	"google_sync_error" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "bookings_end_after_start" CHECK ("bookings"."ends_at" > "bookings"."starts_at"),
	CONSTRAINT "bookings_source_valid" CHECK ("bookings"."source" IN ('flow', 'dashboard'))
);
--> statement-breakpoint
CREATE TABLE "google_calendar_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_email" varchar(320),
	"calendar_id" varchar(255) DEFAULT 'primary' NOT NULL,
	"access_token_encrypted" text NOT NULL,
	"refresh_token_encrypted" text,
	"token_expires_at" timestamp with time zone NOT NULL,
	"scopes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_provider_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" varchar(32) DEFAULT 'simulation' NOT NULL,
	"environment" varchar(16) DEFAULT 'sandbox' NOT NULL,
	"midtrans_sandbox_server_key_encrypted" text,
	"midtrans_sandbox_client_key_encrypted" text,
	"midtrans_production_server_key_encrypted" text,
	"midtrans_production_client_key_encrypted" text,
	"xendit_sandbox_server_key_encrypted" text,
	"xendit_sandbox_client_key_encrypted" text,
	"xendit_production_server_key_encrypted" text,
	"xendit_production_client_key_encrypted" text,
	"xendit_sandbox_callback_token_encrypted" text,
	"xendit_production_callback_token_encrypted" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_provider_configs_provider_valid" CHECK ("payment_provider_configs"."provider" IN ('simulation', 'midtrans', 'xendit')),
	CONSTRAINT "payment_provider_configs_environment_valid" CHECK ("payment_provider_configs"."environment" IN ('sandbox', 'production'))
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_members" ADD CONSTRAINT "tenant_members_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_members" ADD CONSTRAINT "tenant_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_log" ADD CONSTRAINT "integration_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_log" ADD CONSTRAINT "integration_log_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_log" ADD CONSTRAINT "integration_log_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_inbox" ADD CONSTRAINT "webhook_inbox_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_accounts" ADD CONSTRAINT "channel_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_identities" ADD CONSTRAINT "channel_identities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_identities" ADD CONSTRAINT "channel_identities_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_identities" ADD CONSTRAINT "channel_identities_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_notes" ADD CONSTRAINT "conversation_notes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_notes" ADD CONSTRAINT "conversation_notes_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_notes" ADD CONSTRAINT "conversation_notes_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assignee_user_id_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sent_by_user_id_users_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_to_message_id_messages_id_fk" FOREIGN KEY ("reply_to_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_trigger_message_id_messages_id_fk" FOREIGN KEY ("trigger_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_steps" ADD CONSTRAINT "automation_steps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_steps" ADD CONSTRAINT "automation_steps_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_trigger_message_id_messages_id_fk" FOREIGN KEY ("trigger_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_suggestions" ADD CONSTRAINT "agent_suggestions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_suggestions" ADD CONSTRAINT "agent_suggestions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_suggestions" ADD CONSTRAINT "agent_suggestions_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_suggestions" ADD CONSTRAINT "agent_suggestions_trigger_message_id_messages_id_fk" FOREIGN KEY ("trigger_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_suggestions" ADD CONSTRAINT "agent_suggestions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_document_id_kb_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."kb_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_documents" ADD CONSTRAINT "kb_documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_documents" ADD CONSTRAINT "kb_documents_source_document_id_kb_source_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."kb_source_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_source_documents" ADD CONSTRAINT "kb_source_documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_source_documents" ADD CONSTRAINT "kb_source_documents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_photos" ADD CONSTRAINT "profile_photos_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_broadcast_id_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_whatsapp_template_id_whatsapp_templates_id_fk" FOREIGN KEY ("whatsapp_template_id") REFERENCES "public"."whatsapp_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_variant_b_whatsapp_template_id_whatsapp_templates_id_fk" FOREIGN KEY ("variant_b_whatsapp_template_id") REFERENCES "public"."whatsapp_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_templates" ADD CONSTRAINT "whatsapp_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_templates" ADD CONSTRAINT "whatsapp_templates_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_matched_automation_id_automations_id_fk" FOREIGN KEY ("matched_automation_id") REFERENCES "public"."automations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_experiment_assignments" ADD CONSTRAINT "flow_experiment_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_experiment_assignments" ADD CONSTRAINT "flow_experiment_assignments_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_experiment_assignments" ADD CONSTRAINT "flow_experiment_assignments_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_experiment_assignments" ADD CONSTRAINT "flow_experiment_assignments_run_id_flow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."flow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_run_steps" ADD CONSTRAINT "flow_run_steps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_run_steps" ADD CONSTRAINT "flow_run_steps_run_id_flow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."flow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_trigger_message_id_messages_id_fk" FOREIGN KEY ("trigger_message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flows" ADD CONSTRAINT "flows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flows" ADD CONSTRAINT "flows_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_replies" ADD CONSTRAINT "saved_replies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_replies" ADD CONSTRAINT "saved_replies_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_link_events" ADD CONSTRAINT "growth_link_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_link_events" ADD CONSTRAINT "growth_link_events_growth_link_id_growth_links_id_fk" FOREIGN KEY ("growth_link_id") REFERENCES "public"."growth_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_link_events" ADD CONSTRAINT "growth_link_events_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_links" ADD CONSTRAINT "growth_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_links" ADD CONSTRAINT "growth_links_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_links" ADD CONSTRAINT "growth_links_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segments" ADD CONSTRAINT "segments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segments" ADD CONSTRAINT "segments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_opt_in_settings" ADD CONSTRAINT "tenant_opt_in_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_availability" ADD CONSTRAINT "appointment_availability_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_services" ADD CONSTRAINT "appointment_services_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_settings" ADD CONSTRAINT "appointment_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_service_id_appointment_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."appointment_services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_calendar_connections" ADD CONSTRAINT "google_calendar_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_provider_configs" ADD CONSTRAINT "payment_provider_configs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_tenant_id_idx" ON "api_keys" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "invitations_tenant_id_idx" ON "invitations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "subscriptions_tenant_id_idx" ON "subscriptions" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_members_tenant_user_unique" ON "tenant_members" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "tenant_members_tenant_id_idx" ON "tenant_members" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "tenant_members_user_id_idx" ON "tenant_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_logs_tenant_id_idx" ON "audit_logs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "audit_logs_tenant_created_idx" ON "audit_logs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "integration_log_tenant_created_idx" ON "integration_log" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "integration_log_created_at_idx" ON "integration_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "integration_log_channel_account_idx" ON "integration_log" USING btree ("channel_account_id");--> statement-breakpoint
CREATE INDEX "outbox_events_published_at_idx" ON "outbox_events" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "outbox_events_tenant_id_idx" ON "outbox_events" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "usage_ledger_tenant_id_idx" ON "usage_ledger" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "usage_ledger_tenant_created_idx" ON "usage_ledger" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_inbox_provider_event_unique" ON "webhook_inbox" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "webhook_inbox_tenant_id_idx" ON "webhook_inbox" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "auth_account_user_id_idx" ON "auth_account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_session_user_id_idx" ON "auth_session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_verification_identifier_idx" ON "auth_verification" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_accounts_tenant_provider_external_unique" ON "channel_accounts" USING btree ("tenant_id","provider","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_accounts_provider_external_active_unique" ON "channel_accounts" USING btree ("provider","external_id") WHERE "channel_accounts"."status" <> 'disconnected';--> statement-breakpoint
CREATE INDEX "channel_accounts_tenant_id_idx" ON "channel_accounts" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "channel_accounts_trashed_at_idx" ON "channel_accounts" USING btree ("trashed_at") WHERE "channel_accounts"."trashed_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "channel_accounts_token_expires_at_idx" ON "channel_accounts" USING btree ("token_expires_at") WHERE "channel_accounts"."token_expires_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_identities_account_external_user_unique" ON "channel_identities" USING btree ("channel_account_id","external_user_id");--> statement-breakpoint
CREATE INDEX "channel_identities_tenant_id_idx" ON "channel_identities" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "channel_identities_contact_id_idx" ON "channel_identities" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "contacts_tenant_id_idx" ON "contacts" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "contacts_tenant_phone_idx" ON "contacts" USING btree ("tenant_id","phone");--> statement-breakpoint
CREATE INDEX "contacts_tenant_email_idx" ON "contacts" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE INDEX "conversation_notes_tenant_id_idx" ON "conversation_notes" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "conversation_notes_conversation_created_idx" ON "conversation_notes" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "conversations_tenant_id_idx" ON "conversations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "conversations_tenant_assignee_idx" ON "conversations" USING btree ("tenant_id","assignee_user_id");--> statement-breakpoint
CREATE INDEX "conversations_tenant_status_last_message_idx" ON "conversations" USING btree ("tenant_id","status","last_message_at");--> statement-breakpoint
CREATE INDEX "conversations_contact_id_idx" ON "conversations" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "conversations_channel_account_id_idx" ON "conversations" USING btree ("channel_account_id");--> statement-breakpoint
CREATE INDEX "media_tenant_id_idx" ON "media" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "messages_tenant_id_idx" ON "messages" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_created_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_reply_to_message_id_idx" ON "messages" USING btree ("reply_to_message_id");--> statement-breakpoint
CREATE INDEX "messages_outbound_queued_created_idx" ON "messages" USING btree ("created_at") WHERE "messages"."direction" = 'outbound' AND "messages"."status" = 'queued';--> statement-breakpoint
CREATE UNIQUE INDEX "messages_provider_message_id_unique" ON "messages" USING btree ("provider_message_id") WHERE "messages"."provider_message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "automation_runs_tenant_id_idx" ON "automation_runs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "automation_runs_contact_id_idx" ON "automation_runs" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "automation_runs_conversation_id_idx" ON "automation_runs" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "automation_runs_automation_created_idx" ON "automation_runs" USING btree ("automation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_runs_automation_trigger_message_unique" ON "automation_runs" USING btree ("automation_id","trigger_message_id") WHERE "automation_runs"."trigger_message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "automation_steps_tenant_id_idx" ON "automation_steps" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "automation_steps_automation_idx" ON "automation_steps" USING btree ("automation_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_steps_automation_position_unique" ON "automation_steps" USING btree ("automation_id","position");--> statement-breakpoint
CREATE INDEX "automations_tenant_id_idx" ON "automations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "automations_tenant_active_idx" ON "automations" USING btree ("tenant_id","is_active");--> statement-breakpoint
CREATE INDEX "sequence_enrollments_tenant_id_idx" ON "sequence_enrollments" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "sequence_enrollments_contact_id_idx" ON "sequence_enrollments" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "sequence_enrollments_conversation_idx" ON "sequence_enrollments" USING btree ("tenant_id","conversation_id","status");--> statement-breakpoint
CREATE INDEX "sequence_enrollments_automation_idx" ON "sequence_enrollments" USING btree ("automation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sequence_enrollments_active_unique" ON "sequence_enrollments" USING btree ("automation_id","contact_id") WHERE "sequence_enrollments"."status" = 'active';--> statement-breakpoint
CREATE INDEX "agent_suggestions_tenant_id_idx" ON "agent_suggestions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "agent_suggestions_tenant_status_idx" ON "agent_suggestions" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "agent_suggestions_conversation_idx" ON "agent_suggestions" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "agent_suggestions_agent_id_idx" ON "agent_suggestions" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_suggestions_contact_id_idx" ON "agent_suggestions" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "agents_tenant_id_idx" ON "agents" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "agents_tenant_active_idx" ON "agents" USING btree ("tenant_id","is_active","created_at");--> statement-breakpoint
CREATE INDEX "kb_chunks_tenant_id_idx" ON "kb_chunks" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "kb_chunks_document_idx" ON "kb_chunks" USING btree ("document_id","chunk_index");--> statement-breakpoint
CREATE INDEX "kb_chunks_search_vector_gin_idx" ON "kb_chunks" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "kb_documents_tenant_id_idx" ON "kb_documents" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "kb_documents_source_document_idx" ON "kb_documents" USING btree ("source_document_id");--> statement-breakpoint
CREATE INDEX "kb_source_documents_tenant_id_idx" ON "kb_source_documents" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "cart_items_tenant_id_idx" ON "cart_items" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "cart_items_cart_idx" ON "cart_items" USING btree ("cart_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cart_items_cart_product_unique" ON "cart_items" USING btree ("cart_id","product_id");--> statement-breakpoint
CREATE INDEX "carts_tenant_id_idx" ON "carts" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "carts_contact_idx" ON "carts" USING btree ("tenant_id","contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "carts_one_open_per_contact" ON "carts" USING btree ("tenant_id","contact_id") WHERE "carts"."status" = 'open';--> statement-breakpoint
CREATE INDEX "order_items_tenant_id_idx" ON "order_items" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "orders_tenant_id_idx" ON "orders" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "orders_tenant_created_idx" ON "orders" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_contact_idx" ON "orders" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "payment_links_tenant_id_idx" ON "payment_links" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "payment_links_tenant_created_idx" ON "payment_links" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "payment_links_product_idx" ON "payment_links" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "payment_links_order_idx" ON "payment_links" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "payment_links_contact_id_idx" ON "payment_links" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "payment_links_conversation_id_idx" ON "payment_links" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_links_code_unique" ON "payment_links" USING btree ("code");--> statement-breakpoint
CREATE INDEX "products_tenant_id_idx" ON "products" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "products_tenant_active_idx" ON "products" USING btree ("tenant_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_photos_tenant_owner_unique" ON "profile_photos" USING btree ("tenant_id","owner_type","owner_id");--> statement-breakpoint
CREATE INDEX "profile_photos_tenant_id_idx" ON "profile_photos" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "broadcast_recipients_broadcast_contact_unique" ON "broadcast_recipients" USING btree ("broadcast_id","contact_id");--> statement-breakpoint
CREATE INDEX "broadcast_recipients_tenant_id_idx" ON "broadcast_recipients" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "broadcast_recipients_contact_id_idx" ON "broadcast_recipients" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "broadcast_recipients_conversation_id_idx" ON "broadcast_recipients" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "broadcast_recipients_broadcast_status_idx" ON "broadcast_recipients" USING btree ("broadcast_id","status");--> statement-breakpoint
CREATE INDEX "broadcast_recipients_broadcast_variant_idx" ON "broadcast_recipients" USING btree ("broadcast_id","variant");--> statement-breakpoint
CREATE INDEX "broadcast_recipients_message_id_idx" ON "broadcast_recipients" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "broadcasts_tenant_id_idx" ON "broadcasts" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "broadcasts_tenant_status_idx" ON "broadcasts" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "broadcasts_channel_account_id_idx" ON "broadcasts" USING btree ("channel_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_templates_account_name_language_unique" ON "whatsapp_templates" USING btree ("channel_account_id","name","language");--> statement-breakpoint
CREATE INDEX "whatsapp_templates_tenant_id_idx" ON "whatsapp_templates" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "whatsapp_templates_channel_account_id_idx" ON "whatsapp_templates" USING btree ("channel_account_id");--> statement-breakpoint
CREATE INDEX "comments_tenant_id_idx" ON "comments" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "comments_tenant_account_created_idx" ON "comments" USING btree ("tenant_id","channel_account_id","created_at");--> statement-breakpoint
CREATE INDEX "comments_tenant_automation_idx" ON "comments" USING btree ("tenant_id","matched_automation_id");--> statement-breakpoint
CREATE INDEX "comments_contact_id_idx" ON "comments" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "comments_conversation_id_idx" ON "comments" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "comments_account_provider_comment_unique" ON "comments" USING btree ("channel_account_id","provider_comment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "flow_experiment_assignments_sticky_unique" ON "flow_experiment_assignments" USING btree ("tenant_id","flow_id","node_id","contact_id");--> statement-breakpoint
CREATE INDEX "flow_experiment_assignments_tenant_id_idx" ON "flow_experiment_assignments" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "flow_experiment_assignments_split_idx" ON "flow_experiment_assignments" USING btree ("tenant_id","flow_id","node_id","branch");--> statement-breakpoint
CREATE INDEX "flow_run_steps_tenant_id_idx" ON "flow_run_steps" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "flow_run_steps_run_id_idx" ON "flow_run_steps" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "flow_run_steps_run_seq_unique" ON "flow_run_steps" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "flow_runs_tenant_id_idx" ON "flow_runs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "flow_runs_flow_id_idx" ON "flow_runs" USING btree ("flow_id");--> statement-breakpoint
CREATE INDEX "flow_runs_contact_id_idx" ON "flow_runs" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "flow_runs_conversation_id_idx" ON "flow_runs" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "flow_runs_tenant_status_idx" ON "flow_runs" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "flow_runs_flow_trigger_message_unique" ON "flow_runs" USING btree ("flow_id","trigger_message_id") WHERE "flow_runs"."trigger_message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "flows_tenant_id_idx" ON "flows" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "flows_tenant_status_idx" ON "flows" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "saved_replies_tenant_id_idx" ON "saved_replies" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "growth_link_events_tenant_id_idx" ON "growth_link_events" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "growth_link_events_link_kind_idx" ON "growth_link_events" USING btree ("growth_link_id","kind");--> statement-breakpoint
CREATE INDEX "growth_link_events_contact_id_idx" ON "growth_link_events" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "growth_link_events_conversion_unique" ON "growth_link_events" USING btree ("growth_link_id","contact_id") WHERE "growth_link_events"."kind" = 'conversion' AND "growth_link_events"."contact_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "growth_links_slug_unique" ON "growth_links" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "growth_links_tenant_id_idx" ON "growth_links" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "segments_tenant_id_idx" ON "segments" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "tenant_opt_in_settings_tenant_id_idx" ON "tenant_opt_in_settings" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "appointment_availability_tenant_id_idx" ON "appointment_availability" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "appointment_availability_tenant_weekday_idx" ON "appointment_availability" USING btree ("tenant_id","weekday");--> statement-breakpoint
CREATE INDEX "appointment_services_tenant_id_idx" ON "appointment_services" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "appointment_services_tenant_active_idx" ON "appointment_services" USING btree ("tenant_id","is_active");--> statement-breakpoint
CREATE INDEX "bookings_tenant_id_idx" ON "bookings" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "bookings_tenant_starts_idx" ON "bookings" USING btree ("tenant_id","starts_at");--> statement-breakpoint
CREATE INDEX "bookings_contact_idx" ON "bookings" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "bookings_service_idx" ON "bookings" USING btree ("service_id");--> statement-breakpoint
CREATE UNIQUE INDEX "google_calendar_connections_tenant_unique" ON "google_calendar_connections" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_provider_configs_tenant_unique" ON "payment_provider_configs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "payment_provider_configs_tenant_id_idx" ON "payment_provider_configs" USING btree ("tenant_id");