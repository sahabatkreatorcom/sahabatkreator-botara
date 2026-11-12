-- G18 butir 4: gamifikasi — buku besar poin kontak + level loyalitas
-- tenant. Saldo poin adalah SUM atas buku besar (tidak ada kolom
-- saldo); pemberian poin flow idempoten per run+node lewat
-- event_id deterministik + unique parsial (pola G16).
CREATE TABLE "loyalty_levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(64) NOT NULL,
	"min_points" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loyalty_levels_min_points_nonneg" CHECK ("min_points" >= 0)
);
--> statement-breakpoint
CREATE TABLE "contact_point_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"points" integer NOT NULL,
	"source" varchar(16) NOT NULL,
	"event_id" varchar(80),
	"run_id" uuid,
	"node_id" varchar(128),
	"note" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_point_ledger_source_valid" CHECK ("source" IN ('flow_award', 'manual')),
	CONSTRAINT "contact_point_ledger_points_nonzero" CHECK ("points" <> 0)
);
--> statement-breakpoint
ALTER TABLE "loyalty_levels" ADD CONSTRAINT "loyalty_levels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "contact_point_ledger" ADD CONSTRAINT "contact_point_ledger_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "contact_point_ledger" ADD CONSTRAINT "contact_point_ledger_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "contact_point_ledger" ADD CONSTRAINT "contact_point_ledger_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "loyalty_levels_tenant_min_points_unique" ON "loyalty_levels" USING btree ("tenant_id","min_points");
--> statement-breakpoint
CREATE INDEX "loyalty_levels_tenant_id_idx" ON "loyalty_levels" USING btree ("tenant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "contact_point_ledger_tenant_event_unique" ON "contact_point_ledger" USING btree ("tenant_id","event_id") WHERE "event_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "contact_point_ledger_contact_idx" ON "contact_point_ledger" USING btree ("tenant_id","contact_id");
--> statement-breakpoint
CREATE INDEX "contact_point_ledger_tenant_created_idx" ON "contact_point_ledger" USING btree ("tenant_id","created_at");
--> statement-breakpoint
ALTER TABLE "loyalty_levels" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "contact_point_ledger" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "loyalty_levels" USING ("tenant_id" = (SELECT app_tenant_id()));
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "contact_point_ledger" USING ("tenant_id" = (SELECT app_tenant_id()));
