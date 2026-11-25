ALTER TYPE "public"."appointment_status" ADD VALUE 'pending_payment';--> statement-breakpoint
ALTER TYPE "public"."appointment_status" ADD VALUE 'expired';--> statement-breakpoint
ALTER TYPE "public"."payment_method" ADD VALUE 'other';--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"account_id" text NOT NULL,
	"provider" varchar(12) NOT NULL,
	"provider_event_id" varchar(120) NOT NULL,
	"type" varchar(80) NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_events_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "payment_events_event_uq" UNIQUE("account_id","provider_event_id")
);
--> statement-breakpoint
CREATE TABLE "payment_mismatches" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"account_id" text NOT NULL,
	"day" date NOT NULL,
	"kind" varchar(20) NOT NULL,
	"provider_payment_id" varchar(80) NOT NULL,
	"provider_amount_minor" integer,
	"ledger_amount_minor" integer,
	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_mismatches_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "payment_mismatches_uq" UNIQUE("account_id","provider_payment_id","kind"),
	CONSTRAINT "payment_mismatches_kind_ck" CHECK ("payment_mismatches"."kind" in ('missing_here', 'missing_at_provider', 'amount_differs'))
);
--> statement-breakpoint
CREATE TABLE "payment_orders" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"appointment_id" text NOT NULL,
	"account_id" text NOT NULL,
	"provider" varchar(12) NOT NULL,
	"mode" varchar(4) NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"status" varchar(10) DEFAULT 'created' NOT NULL,
	"provider_order_id" varchar(80),
	"checkout_url" text,
	"link_token_hash" varchar(64),
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_orders_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "payment_orders_amount_positive" CHECK ("payment_orders"."amount_minor" > 0),
	CONSTRAINT "payment_orders_status_ck" CHECK ("payment_orders"."status" in ('created', 'paid', 'failed', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "refund_requests" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"payment_id" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"reason" varchar(200) NOT NULL,
	"source" varchar(14) NOT NULL,
	"status" varchar(10) DEFAULT 'pending' NOT NULL,
	"provider_refund_id" varchar(80),
	"failure_code" varchar(60),
	"requested_by_user_id" text,
	"dedupe_key" varchar(160) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refund_requests_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "refund_requests_dedupe_uq" UNIQUE("tenant_id","dedupe_key"),
	CONSTRAINT "refund_requests_amount_positive" CHECK ("refund_requests"."amount_minor" > 0),
	CONSTRAINT "refund_requests_source_ck" CHECK ("refund_requests"."source" in ('policy', 'staff', 'late_payment', 'reschedule')),
	CONSTRAINT "refund_requests_status_ck" CHECK ("refund_requests"."status" in ('pending', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "tenant_payment_accounts" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"provider" varchar(12) NOT NULL,
	"mode" varchar(4) DEFAULT 'test' NOT NULL,
	"status" varchar(10) DEFAULT 'active' NOT NULL,
	"key_id" varchar(80) NOT NULL,
	"secret_ciphertext" text,
	"webhook_secret_ciphertext" text,
	"key_version" integer DEFAULT 0 NOT NULL,
	"public_id" varchar(48) NOT NULL,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_payment_accounts_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "tenant_payment_accounts_tenant_uq" UNIQUE("tenant_id"),
	CONSTRAINT "tenant_payment_accounts_provider_ck" CHECK ("tenant_payment_accounts"."provider" in ('razorpay', 'stripe', 'fake')),
	CONSTRAINT "tenant_payment_accounts_mode_ck" CHECK ("tenant_payment_accounts"."mode" in ('test', 'live')),
	CONSTRAINT "tenant_payment_accounts_status_ck" CHECK ("tenant_payment_accounts"."status" in ('active', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "tenant_payment_policies" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"free_cancel_hours" integer DEFAULT 24 NOT NULL,
	"after_window_rule" varchar(12) DEFAULT 'no_refund' NOT NULL,
	"no_show_rule" varchar(12) DEFAULT 'deposit' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_payment_policies_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "tenant_payment_policies_tenant_uq" UNIQUE("tenant_id"),
	CONSTRAINT "tenant_payment_policies_hours_ck" CHECK ("tenant_payment_policies"."free_cancel_hours" between 0 and 8760),
	CONSTRAINT "tenant_payment_policies_after_ck" CHECK ("tenant_payment_policies"."after_window_rule" in ('no_refund', 'keep_deposit')),
	CONSTRAINT "tenant_payment_policies_noshow_ck" CHECK ("tenant_payment_policies"."no_show_rule" in ('deposit', 'everything'))
);
--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "payment_terms" jsonb;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "payment_terms_text" text;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD COLUMN "request_id" text;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD COLUMN "provider_refund_id" varchar(80);--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD COLUMN "is_test" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "provider" varchar(12);--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "provider_payment_id" varchar(80);--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "order_id" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "is_test" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "payment_mode" varchar(8) DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "deposit_minor" integer;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."tenant_payment_accounts"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_mismatches" ADD CONSTRAINT "payment_mismatches_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."tenant_payment_accounts"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointments"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."tenant_payment_accounts"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_payment_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_payment_accounts" ADD CONSTRAINT "tenant_payment_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_payment_policies" ADD CONSTRAINT "tenant_payment_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_orders_provider_order_uq" ON "payment_orders" USING btree ("provider","provider_order_id") WHERE "payment_orders"."provider_order_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_orders_open_uq" ON "payment_orders" USING btree ("tenant_id","appointment_id") WHERE "payment_orders"."status" = 'created';--> statement-breakpoint
CREATE UNIQUE INDEX "payment_orders_link_uq" ON "payment_orders" USING btree ("link_token_hash") WHERE "payment_orders"."link_token_hash" is not null;--> statement-breakpoint
CREATE INDEX "payment_orders_appointment_idx" ON "payment_orders" USING btree ("tenant_id","appointment_id");--> statement-breakpoint
CREATE INDEX "refund_requests_payment_idx" ON "refund_requests" USING btree ("tenant_id","payment_id");--> statement-breakpoint
CREATE INDEX "refund_requests_open_idx" ON "refund_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_payment_accounts_public_uq" ON "tenant_payment_accounts" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_refunds_provider_refund_uq" ON "payment_refunds" USING btree ("tenant_id","provider_refund_id") WHERE "payment_refunds"."provider_refund_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_refunds_request_uq" ON "payment_refunds" USING btree ("tenant_id","request_id") WHERE "payment_refunds"."request_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_payment_uq" ON "payments" USING btree ("tenant_id","provider","provider_payment_id") WHERE "payments"."provider_payment_id" is not null;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_payment_mode_valid" CHECK ("services"."payment_mode" in ('none', 'deposit', 'full'));--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_payment_amounts_valid" CHECK ("services"."payment_mode" = 'none' or ("services"."payment_mode" = 'full') or ("services"."payment_mode" = 'deposit' and "services"."deposit_minor" > 0));
--> statement-breakpoint
-- Row-level security: each business sees only its own rows, even for the runtime role.
ALTER TABLE "tenant_payment_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_payment_accounts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenant_payment_accounts"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
ALTER TABLE "tenant_payment_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_payment_policies" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenant_payment_policies"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
ALTER TABLE "payment_orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payment_orders" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payment_orders"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
ALTER TABLE "refund_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "refund_requests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "refund_requests"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
ALTER TABLE "payment_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payment_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payment_events"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
ALTER TABLE "payment_mismatches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payment_mismatches" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payment_mismatches"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
-- A webhook arrives with no business signed in. These two return ids only, so the route can find the
-- business and then open its secrets inside that business's own scope.
CREATE OR REPLACE FUNCTION "kalendr_resolve_payment_account"("p_public_id" text)
  RETURNS TABLE (tenant_id text, account_id text, provider text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $kalendr_resolve_payment_account$
  select account.tenant_id, account.id, account.provider::text from tenant_payment_accounts as account
  where account.public_id = "p_public_id" and account.status = 'active'
$kalendr_resolve_payment_account$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "kalendr_resolve_stripe_account"("p_stripe_account" text)
  RETURNS TABLE (tenant_id text, account_id text, provider text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $kalendr_resolve_stripe_account$
  select account.tenant_id, account.id, account.provider::text from tenant_payment_accounts as account
  where account.provider = 'stripe' and account.key_id = "p_stripe_account" and account.status = 'active'
$kalendr_resolve_stripe_account$;
--> statement-breakpoint
-- Which businesses have payment work for one worker job. Ids only.
--   hold_expiry: unpaid holds that ran out
--   refunds: refunds waiting to be sent to the provider
--   reconcile: businesses with a live or test provider account (the fake one has nothing to compare)
CREATE OR REPLACE FUNCTION "kalendr_payment_tenants"("p_job" text) RETURNS SETOF text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $kalendr_payment_tenants$
  select distinct appointment.tenant_id from appointments as appointment
  join resource_reservations as reservation on reservation.tenant_id = appointment.tenant_id and reservation.appointment_id = appointment.id
  where "p_job" = 'hold_expiry' and appointment.status::text = 'pending_payment'
    and (reservation.state = 'released' or reservation.hold_expires_at <= now())
  union
  select request.tenant_id from refund_requests as request where "p_job" = 'refunds' and request.status = 'pending'
  union
  select account.tenant_id from tenant_payment_accounts as account
  where "p_job" = 'reconcile' and account.status = 'active' and account.provider <> 'fake'
$kalendr_payment_tenants$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_payment_tenants"(text) FROM PUBLIC;

--> statement-breakpoint
-- Same as 0041, plus payment account keys (feature 23): a business whose gateway secrets are on an older key needs re-encrypting.
CREATE OR REPLACE FUNCTION "kalendr_storage_tenants"("p_job" text) RETURNS SETOF text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $kalendr_storage_tenants$
  -- Which businesses have storage work for one worker job. Ids only, no row content.
  with business as (
    select tenant.id,
      greatest(coalesce((select max(data_key.version) from tenant_data_keys as data_key where data_key.tenant_id = tenant.id), 0), 1) as target
    from tenants as tenant
  )
  select business.id from business
  where case "p_job"
    when 're_encrypt' then
      exists (select 1 from visit_records as record where record.tenant_id = business.id and record.key_version < business.target)
      or exists (select 1 from visit_record_files as file where file.tenant_id = business.id and file.key_version < business.target and file.scan_status in ('clean', 'skipped'))
      or exists (select 1 from forms as form where form.tenant_id = business.id and form.response_ciphertext is not null and form.key_version < business.target)
      or exists (select 1 from media_assets as media where media.tenant_id = business.id and media.storage_key is not null and media.key_version < business.target and media.scan_status in ('clean', 'skipped'))
      or exists (select 1 from push_subscriptions as subscription where subscription.tenant_id = business.id and subscription.key_version < business.target)
      or exists (select 1 from calendar_connections as connection where connection.tenant_id = business.id and connection.key_version < business.target)
      or exists (select 1 from tenant_payment_accounts as account where account.tenant_id = business.id and account.key_version < business.target and (account.secret_ciphertext is not null or account.webhook_secret_ciphertext is not null))
      or exists (select 1 from tenant_data_keys as data_key where data_key.tenant_id = business.id and data_key.version < business.target and data_key.retired_at is null)
      or (exists (select 1 from tenant_data_keys as data_key where data_key.tenant_id = business.id and data_key.version > 0)
        and not exists (select 1 from tenant_data_keys as data_key where data_key.tenant_id = business.id and data_key.version = 0))
    when 'rotate_due' then
      exists (select 1 from tenant_data_keys as data_key
        where data_key.tenant_id = business.id and data_key.version = business.target and data_key.version > 0
          and data_key.created_at < now() - interval '365 days')
    when 'media_backfill' then
      exists (select 1 from media_assets as media where media.tenant_id = business.id and media.storage_key is null)
      or exists (select 1 from practitioners as practitioner where practitioner.tenant_id = business.id and practitioner.photo_data_url is not null)
    else false
  end
  order by business.id
$kalendr_storage_tenants$;
