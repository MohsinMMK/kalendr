CREATE TABLE "appointment_discounts" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"appointment_id" text NOT NULL,
	"kind" varchar(12) NOT NULL,
	"list_price_minor" integer NOT NULL,
	"amount_minor" integer NOT NULL,
	"coupon_id" text,
	"membership_id" text,
	"customer_package_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_discounts_kind_uq" UNIQUE("tenant_id","appointment_id","kind"),
	CONSTRAINT "appointment_discounts_kind_ck" CHECK ("appointment_discounts"."kind" in ('member_price', 'coupon', 'package')),
	CONSTRAINT "appointment_discounts_amount_ck" CHECK ("appointment_discounts"."amount_minor" > 0 and "appointment_discounts"."list_price_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "coupon_redemptions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"coupon_id" text NOT NULL,
	"appointment_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"discount_minor" integer NOT NULL,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coupon_redemptions_coupon_appointment_uq" UNIQUE("tenant_id","coupon_id","appointment_id"),
	CONSTRAINT "coupon_redemptions_discount_ck" CHECK ("coupon_redemptions"."discount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "coupons" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"code" varchar(32) NOT NULL,
	"kind" varchar(7) NOT NULL,
	"value" integer NOT NULL,
	"max_uses" integer,
	"per_customer_limit" smallint,
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone,
	"service_ids" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"first_visit_only" boolean DEFAULT false NOT NULL,
	"stackable" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coupons_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "coupons_kind_ck" CHECK ("coupons"."kind" in ('percent', 'fixed')),
	CONSTRAINT "coupons_value_ck" CHECK (("coupons"."kind" = 'percent' and "coupons"."value" between 1 and 100) or ("coupons"."kind" = 'fixed' and "coupons"."value" > 0)),
	CONSTRAINT "coupons_limits_ck" CHECK (("coupons"."max_uses" is null or "coupons"."max_uses" > 0) and ("coupons"."per_customer_limit" is null or "coupons"."per_customer_limit" > 0)),
	CONSTRAINT "coupons_dates_ck" CHECK ("coupons"."valid_from" is null or "coupons"."valid_to" is null or "coupons"."valid_from" < "coupons"."valid_to")
);
--> statement-breakpoint
CREATE TABLE "customer_credits" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"customer_package_id" text NOT NULL,
	"change" smallint NOT NULL,
	"kind" varchar(10) NOT NULL,
	"appointment_id" text,
	"reason" varchar(200) NOT NULL,
	"actor_user_id" text,
	"dedupe_key" varchar(160),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_credits_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "customer_credits_kind_ck" CHECK ("customer_credits"."kind" in ('purchase', 'renewal', 'grant', 'use', 'return', 'expiry', 'adjust')),
	CONSTRAINT "customer_credits_sign_ck" CHECK ("customer_credits"."change" <> 0 and (
    ("customer_credits"."kind" in ('purchase', 'renewal', 'grant', 'return') and "customer_credits"."change" > 0) or
    ("customer_credits"."kind" in ('use', 'expiry') and "customer_credits"."change" < 0) or "customer_credits"."kind" = 'adjust'))
);
--> statement-breakpoint
CREATE TABLE "customer_memberships" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"provider" varchar(12) NOT NULL,
	"provider_subscription_id" varchar(120) NOT NULL,
	"status" varchar(10) DEFAULT 'active' NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"past_due_since" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"created_by_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_memberships_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "customer_memberships_status_ck" CHECK ("customer_memberships"."status" in ('active', 'past_due', 'paused', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "customer_packages" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"package_id" text,
	"membership_id" text,
	"period_start" timestamp with time zone,
	"source" varchar(10) DEFAULT 'package' NOT NULL,
	"name" varchar(120) NOT NULL,
	"credits_total" smallint NOT NULL,
	"price_minor" integer DEFAULT 0 NOT NULL,
	"service_ids" text[] NOT NULL,
	"bought_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"invoice_id" text,
	"sold_by_user_id" text,
	"reminded_14_at" timestamp with time zone,
	"reminded_3_at" timestamp with time zone,
	CONSTRAINT "customer_packages_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "customer_packages_source_ck" CHECK ("customer_packages"."source" in ('package', 'membership', 'gift')),
	CONSTRAINT "customer_packages_credits_ck" CHECK ("customer_packages"."credits_total" between 1 and 200 and "customer_packages"."price_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "membership_events" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"provider" varchar(12) NOT NULL,
	"provider_event_id" varchar(120) NOT NULL,
	"type" varchar(40) NOT NULL,
	"membership_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "membership_plans" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" varchar(400),
	"price_minor" integer NOT NULL,
	"credits_per_period" smallint DEFAULT 0 NOT NULL,
	"member_discount_percent" smallint DEFAULT 0 NOT NULL,
	"service_ids" text[] NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_plans_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "membership_plans_price_ck" CHECK ("membership_plans"."price_minor" > 0),
	CONSTRAINT "membership_plans_benefit_ck" CHECK ("membership_plans"."credits_per_period" between 0 and 100 and "membership_plans"."member_discount_percent" between 0 and 100 and ("membership_plans"."credits_per_period" > 0 or "membership_plans"."member_discount_percent" > 0)),
	CONSTRAINT "membership_plans_services_ck" CHECK (cardinality("membership_plans"."service_ids") between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "packages" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" varchar(400),
	"price_minor" integer NOT NULL,
	"credits" smallint NOT NULL,
	"valid_days" smallint NOT NULL,
	"service_ids" text[] NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "packages_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "packages_price_ck" CHECK ("packages"."price_minor" > 0),
	CONSTRAINT "packages_credits_ck" CHECK ("packages"."credits" between 1 and 200),
	CONSTRAINT "packages_valid_ck" CHECK ("packages"."valid_days" between 1 and 3650),
	CONSTRAINT "packages_services_ck" CHECK (cardinality("packages"."service_ids") between 1 and 100)
);
--> statement-breakpoint
ALTER TABLE "appointment_discounts" ADD CONSTRAINT "appointment_discounts_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointments"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_coupon_fk" FOREIGN KEY ("tenant_id","coupon_id") REFERENCES "public"."coupons"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointments"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patients"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credits" ADD CONSTRAINT "customer_credits_package_fk" FOREIGN KEY ("tenant_id","customer_package_id") REFERENCES "public"."customer_packages"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credits" ADD CONSTRAINT "customer_credits_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointments"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_memberships" ADD CONSTRAINT "customer_memberships_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patients"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_memberships" ADD CONSTRAINT "customer_memberships_plan_fk" FOREIGN KEY ("tenant_id","plan_id") REFERENCES "public"."membership_plans"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_packages" ADD CONSTRAINT "customer_packages_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patients"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_packages" ADD CONSTRAINT "customer_packages_package_fk" FOREIGN KEY ("tenant_id","package_id") REFERENCES "public"."packages"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_packages" ADD CONSTRAINT "customer_packages_membership_fk" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."customer_memberships"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_packages" ADD CONSTRAINT "customer_packages_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_plans" ADD CONSTRAINT "membership_plans_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coupon_redemptions_count_idx" ON "coupon_redemptions" USING btree ("tenant_id","coupon_id") WHERE "coupon_redemptions"."released_at" is null;--> statement-breakpoint
CREATE INDEX "coupon_redemptions_patient_idx" ON "coupon_redemptions" USING btree ("tenant_id","coupon_id","patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "coupons_code_uq" ON "coupons" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_credits_use_uq" ON "customer_credits" USING btree ("tenant_id","customer_package_id","appointment_id") WHERE "customer_credits"."kind" = 'use';--> statement-breakpoint
CREATE UNIQUE INDEX "customer_credits_return_uq" ON "customer_credits" USING btree ("tenant_id","customer_package_id","appointment_id") WHERE "customer_credits"."kind" = 'return';--> statement-breakpoint
CREATE UNIQUE INDEX "customer_credits_dedupe_uq" ON "customer_credits" USING btree ("tenant_id","dedupe_key") WHERE "customer_credits"."dedupe_key" is not null;--> statement-breakpoint
CREATE INDEX "customer_credits_package_idx" ON "customer_credits" USING btree ("tenant_id","customer_package_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_memberships_subscription_uq" ON "customer_memberships" USING btree ("provider","provider_subscription_id");--> statement-breakpoint
CREATE INDEX "customer_memberships_patient_idx" ON "customer_memberships" USING btree ("tenant_id","patient_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_packages_period_uq" ON "customer_packages" USING btree ("tenant_id","membership_id","period_start") WHERE "customer_packages"."membership_id" is not null;--> statement-breakpoint
CREATE INDEX "customer_packages_patient_idx" ON "customer_packages" USING btree ("tenant_id","patient_id","expires_at");--> statement-breakpoint
CREATE INDEX "customer_packages_expiry_idx" ON "customer_packages" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "membership_events_event_uq" ON "membership_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "membership_events_membership_idx" ON "membership_events" USING btree ("tenant_id","membership_id");--> statement-breakpoint
-- Feature 25, the hand-written part: row-level security on every new table, a credit ledger that only ever grows and can
-- never take a package below zero, and a redemption row whose only editable field is the moment it was released.
ALTER TABLE "packages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "packages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "packages" FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "customer_packages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customer_packages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "customer_packages" FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "customer_credits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customer_credits" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "customer_credits" FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "membership_plans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "membership_plans" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "membership_plans" FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "customer_memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customer_memberships" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "customer_memberships" FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "membership_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "membership_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "membership_events" FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "coupons" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "coupons" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "coupons" FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "coupon_redemptions" FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "appointment_discounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "appointment_discounts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "appointment_discounts" FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE TRIGGER "customer_credits_immutable" BEFORE UPDATE OR DELETE ON "customer_credits" FOR EACH ROW EXECUTE FUNCTION "kalendr_refuse_change"();--> statement-breakpoint
CREATE TRIGGER "appointment_discounts_immutable" BEFORE UPDATE OR DELETE ON "appointment_discounts" FOR EACH ROW EXECUTE FUNCTION "kalendr_refuse_change"();--> statement-breakpoint
CREATE TRIGGER "membership_events_immutable" BEFORE UPDATE OR DELETE ON "membership_events" FOR EACH ROW EXECUTE FUNCTION "kalendr_refuse_change"();--> statement-breakpoint
CREATE FUNCTION "kalendr_credit_balance_guard"() RETURNS trigger LANGUAGE plpgsql AS $kalendr_credit_balance_guard$
DECLARE
  balance bigint;
BEGIN
  SELECT coalesce(sum("change"), 0) INTO balance FROM customer_credits WHERE tenant_id = NEW.tenant_id AND customer_package_id = NEW.customer_package_id;
  IF balance < 0 THEN
    RAISE EXCEPTION 'A package cannot go below zero credits' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$kalendr_credit_balance_guard$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "customer_credits_balance_check" AFTER INSERT ON "customer_credits" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "kalendr_credit_balance_guard"();--> statement-breakpoint
CREATE FUNCTION "kalendr_coupon_redemption_guard"() RETURNS trigger LANGUAGE plpgsql AS $kalendr_coupon_redemption_guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'coupon_redemptions rows are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - 'released_at') IS DISTINCT FROM (to_jsonb(OLD) - 'released_at') OR (OLD.released_at IS NOT NULL AND NEW.released_at IS DISTINCT FROM OLD.released_at) THEN
    RAISE EXCEPTION 'coupon_redemptions rows are never edited' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$kalendr_coupon_redemption_guard$;--> statement-breakpoint
CREATE TRIGGER "coupon_redemptions_guard" BEFORE UPDATE OR DELETE ON "coupon_redemptions" FOR EACH ROW EXECUTE FUNCTION "kalendr_coupon_redemption_guard"();
--> statement-breakpoint
-- Which businesses have package or membership work for one worker job (ids only, no row content), like kalendr_payment_tenants.
--   credit_expiry:    a package that ran out of time with credits left, or that is inside the 14-day reminder window
--   membership_grace: a membership whose failed renewal has run past its 7 days' grace
CREATE FUNCTION "kalendr_offers_tenants"("p_job" text) RETURNS SETOF text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $kalendr_offers_tenants$
  select distinct package.tenant_id from customer_packages as package
  where "p_job" = 'credit_expiry' and package.expires_at <= now() + interval '14 days'
    and (select coalesce(sum(credit."change"), 0) from customer_credits as credit where credit.tenant_id = package.tenant_id and credit.customer_package_id = package.id) > 0
  union
  select membership.tenant_id from customer_memberships as membership
  where "p_job" = 'membership_grace' and membership.status = 'past_due' and membership.past_due_since <= now() - interval '7 days'
$kalendr_offers_tenants$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_offers_tenants"(text) FROM PUBLIC;
