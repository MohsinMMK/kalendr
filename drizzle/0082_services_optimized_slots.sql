CREATE TABLE "retired_manage_tokens" (
	"tenant_id" text NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"appointment_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"retired_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retired_manage_tokens_pk" PRIMARY KEY("tenant_id","token_hash"),
	CONSTRAINT "retired_manage_tokens_hash_uq" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "optimized_slots" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "rebook_from_old_link" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "retired_manage_tokens" ADD CONSTRAINT "retired_manage_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retired_manage_tokens" ADD CONSTRAINT "retired_manage_tokens_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointments"("tenant_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Same tenant-isolation policy as every other business table.
ALTER TABLE "retired_manage_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "retired_manage_tokens" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "retired_manage_tokens"
  FOR ALL
  USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
-- The old link's page does not know the business yet. This returns ids only; the page then reads the details inside that business.
CREATE FUNCTION "kalendr_resolve_retired_manage_token"(p_token_hash text)
RETURNS TABLE (tenant_id text, appointment_id text, patient_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $kalendr_resolve_retired$
  SELECT retired.tenant_id, retired.appointment_id, retired.patient_id
  FROM retired_manage_tokens AS retired
  WHERE retired.token_hash = p_token_hash
$kalendr_resolve_retired$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_resolve_retired_manage_token"(text) FROM PUBLIC;
