CREATE TABLE "billing_events" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"provider" varchar(10) NOT NULL,
	"provider_event_id" varchar(200) NOT NULL,
	"type" varchar(100) NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"outcome" varchar(40),
	CONSTRAINT "billing_events_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "billing_events_provider_ck" CHECK ("billing_events"."provider" in ('razorpay', 'stripe'))
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"key" varchar(20) PRIMARY KEY NOT NULL,
	"name" varchar(60) NOT NULL,
	"sort_order" smallint NOT NULL,
	"price_inr_minor" integer DEFAULT 0 NOT NULL,
	"price_usd_minor" integer DEFAULT 0 NOT NULL,
	"limits" jsonb NOT NULL,
	"razorpay_plan_id" varchar(80),
	"stripe_price_id" varchar(80),
	"is_public" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_invoices" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"invoice_number" varchar(30) NOT NULL,
	"sequence" integer NOT NULL,
	"provider" varchar(10) NOT NULL,
	"provider_payment_id" varchar(120) NOT NULL,
	"plan_key" varchar(20) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"amount_minor" integer NOT NULL,
	"gst_rate_bps" smallint DEFAULT 0 NOT NULL,
	"gst_minor" integer DEFAULT 0 NOT NULL,
	"total_minor" integer NOT NULL,
	"kalendr_gstin" varchar(15),
	"buyer_gstin" varchar(15),
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_invoices_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "platform_invoices_total_ck" CHECK ("platform_invoices"."total_minor" = "platform_invoices"."amount_minor" + "platform_invoices"."gst_minor" and "platform_invoices"."amount_minor" >= 0 and "platform_invoices"."gst_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "tenant_subscriptions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"plan_key" varchar(20) NOT NULL,
	"status" varchar(12) DEFAULT 'trialing' NOT NULL,
	"provider" varchar(10),
	"provider_customer_id" varchar(120),
	"provider_subscription_id" varchar(120),
	"trial_ends_at" timestamp with time zone,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"pending_plan_key" varchar(20),
	"past_due_since" timestamp with time zone,
	"overage_mode" varchar(16) DEFAULT 'stop_marketing' NOT NULL,
	"billing_gstin" varchar(15),
	"usage_alerts_sent" text[] DEFAULT '{}'::text[] NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_subscriptions_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "tenant_subscriptions_status_ck" CHECK ("tenant_subscriptions"."status" in ('trialing', 'active', 'past_due', 'paused', 'cancelled', 'free')),
	CONSTRAINT "tenant_subscriptions_provider_ck" CHECK ("tenant_subscriptions"."provider" is null or "tenant_subscriptions"."provider" in ('razorpay', 'stripe')),
	CONSTRAINT "tenant_subscriptions_overage_ck" CHECK ("tenant_subscriptions"."overage_mode" in ('stop_marketing', 'bill_overage'))
);
--> statement-breakpoint
CREATE TABLE "usage_counters" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"period" date NOT NULL,
	"metric" varchar(60) NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_counters_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "usage_counters_count_ck" CHECK ("usage_counters"."count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_plan_key_plans_key_fk" FOREIGN KEY ("plan_key") REFERENCES "public"."plans"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_pending_plan_key_plans_key_fk" FOREIGN KEY ("pending_plan_key") REFERENCES "public"."plans"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_events_provider_event_uq" ON "billing_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_invoices_number_uq" ON "platform_invoices" USING btree ("invoice_number");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_invoices_sequence_uq" ON "platform_invoices" USING btree ("sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_invoices_payment_uq" ON "platform_invoices" USING btree ("provider","provider_payment_id");--> statement-breakpoint
CREATE INDEX "platform_invoices_tenant_idx" ON "platform_invoices" USING btree ("tenant_id","issued_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_subscriptions_tenant_uq" ON "tenant_subscriptions" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_subscriptions_provider_uq" ON "tenant_subscriptions" USING btree ("provider","provider_subscription_id") WHERE "tenant_subscriptions"."provider_subscription_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "usage_counters_key_uq" ON "usage_counters" USING btree ("tenant_id","period","metric");--> statement-breakpoint
-- Plans and subscription billing (feature 14).
ALTER TABLE "plans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "plans" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "plans_readable" ON "plans" FOR SELECT USING (true);--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenant_subscriptions" FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "billing_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "billing_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "billing_events" FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "usage_counters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "usage_counters" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "usage_counters" FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "platform_invoices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "platform_invoices" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "platform_invoices" FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
-- Money rows are never edited. Invoices change not at all; a webhook event may only be marked processed.
CREATE TRIGGER "platform_invoices_immutable" BEFORE UPDATE OR DELETE ON "platform_invoices"
  FOR EACH ROW EXECUTE FUNCTION "kalendr_refuse_change"();--> statement-breakpoint
CREATE FUNCTION "kalendr_billing_event_guard"() RETURNS trigger LANGUAGE plpgsql AS $kalendr_billing_event_guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'billing_events rows are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - 'processed_at' - 'outcome') IS DISTINCT FROM (to_jsonb(OLD) - 'processed_at' - 'outcome') THEN
    RAISE EXCEPTION 'billing_events rows are never edited' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$kalendr_billing_event_guard$;--> statement-breakpoint
CREATE TRIGGER "billing_events_guard" BEFORE UPDATE OR DELETE ON "billing_events"
  FOR EACH ROW EXECUTE FUNCTION "kalendr_billing_event_guard"();--> statement-breakpoint
-- Plans as data. Adjust the prices with the owner; limits are read by src/lib/entitlements.ts (a test keeps the two in step).
INSERT INTO "plans" ("key", "name", "sort_order", "price_inr_minor", "price_usd_minor", "limits") VALUES
 ('free', 'Free', 0, 0, 0, '{"staffCalendars":1,"locations":1,"bookingsPerMonth":50,"messagesIncluded":{"whatsapp":0,"sms":0},"features":{"onlinePayments":false,"customDomain":false,"removeBadge":false,"calendarSync":"none","reports":false,"api":false,"assistant":false}}'),
 ('starter', 'Starter', 1, 49900, 900, '{"staffCalendars":3,"locations":1,"bookingsPerMonth":null,"messagesIncluded":{"whatsapp":200,"sms":100},"features":{"onlinePayments":true,"customDomain":false,"removeBadge":false,"calendarSync":"limited","reports":false,"api":false,"assistant":false}}'),
 ('growth', 'Growth', 2, 149900, 2900, '{"staffCalendars":10,"locations":3,"bookingsPerMonth":null,"messagesIncluded":{"whatsapp":1000,"sms":500},"features":{"onlinePayments":true,"customDomain":true,"removeBadge":true,"calendarSync":"full","reports":true,"api":true,"assistant":true}}'),
 ('scale', 'Scale', 3, 399900, 7900, '{"staffCalendars":null,"locations":null,"bookingsPerMonth":null,"messagesIncluded":{"whatsapp":5000,"sms":2500},"features":{"onlinePayments":true,"customDomain":true,"removeBadge":true,"calendarSync":"full","reports":true,"api":true,"assistant":true}}');--> statement-breakpoint
-- Businesses that already exist start a fresh 14-day Growth trial. New ones get theirs at sign-up (src/server/billing/subscriptions.ts).
INSERT INTO "tenant_subscriptions" ("tenant_id", "plan_key", "status", "trial_ends_at")
SELECT tenant.id, 'growth', 'trialing', now() + interval '14 days' FROM "tenants" AS tenant
ON CONFLICT ("tenant_id") DO NOTHING;--> statement-breakpoint
-- Gapless invoice numbers: one counter row, locked for the length of the transaction that issues the invoice.
CREATE TABLE "platform_invoice_counter" ("singleton" boolean PRIMARY KEY DEFAULT true CHECK ("singleton"), "last_sequence" integer NOT NULL DEFAULT 0);--> statement-breakpoint
INSERT INTO "platform_invoice_counter" ("singleton", "last_sequence") VALUES (true, 0);--> statement-breakpoint
ALTER TABLE "platform_invoice_counter" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "platform_invoice_counter" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE FUNCTION "kalendr_next_platform_invoice_number"() RETURNS TABLE ("sequence" integer, "invoice_number" text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $kalendr_next_platform_invoice_number$
DECLARE next_value integer;
BEGIN
  UPDATE public.platform_invoice_counter SET last_sequence = last_sequence + 1 WHERE singleton RETURNING last_sequence INTO next_value;
  RETURN QUERY SELECT next_value, 'KAL-' || lpad(next_value::text, 6, '0');
END
$kalendr_next_platform_invoice_number$;--> statement-breakpoint
-- Webhooks name a subscription by the provider's id only. This returns the business id and nothing else.
CREATE FUNCTION "kalendr_resolve_subscription_tenant"("p_provider" text, "p_subscription_id" text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $kalendr_resolve_subscription_tenant$
  SELECT subscription.tenant_id FROM public.tenant_subscriptions AS subscription
  WHERE subscription.provider = p_provider AND subscription.provider_subscription_id = p_subscription_id
    AND length(coalesce(p_subscription_id, '')) BETWEEN 1 AND 120
$kalendr_resolve_subscription_tenant$;--> statement-breakpoint
-- Same, by the provider's customer id (Stripe invoices name the customer first).
CREATE FUNCTION "kalendr_resolve_customer_tenant"("p_provider" text, "p_customer_id" text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $kalendr_resolve_customer_tenant$
  SELECT subscription.tenant_id FROM public.tenant_subscriptions AS subscription
  WHERE subscription.provider = p_provider AND subscription.provider_customer_id = p_customer_id
    AND length(coalesce(p_customer_id, '')) BETWEEN 1 AND 120
$kalendr_resolve_customer_tenant$;--> statement-breakpoint
-- Which businesses the billing sweep has work for: trial over, grace over, cancellation or downgrade reached, usage to check. Ids only. Worker role only.
CREATE FUNCTION "kalendr_billing_tenants"() RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $kalendr_billing_tenants$
  SELECT subscription.tenant_id FROM public.tenant_subscriptions AS subscription
  WHERE (subscription.status = 'trialing' AND subscription.trial_ends_at <= now() + interval '3 days')
     OR (subscription.status = 'past_due')
     OR (subscription.status IN ('active', 'cancelled') AND subscription.current_period_end IS NOT NULL AND subscription.current_period_end <= now() AND (subscription.cancel_at_period_end OR subscription.pending_plan_key IS NOT NULL OR subscription.status = 'cancelled'))
$kalendr_billing_tenants$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_billing_tenants"() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_next_platform_invoice_number"() FROM PUBLIC;--> statement-breakpoint
-- Operator views and actions (feature 15 console). Counts and codes only.
CREATE FUNCTION "admin_tenant_plans"("p_admin" text, "p_tenant_ids" text[]) RETURNS TABLE ("tenant_id" text, "plan_key" text, "status" text, "trial_ends_at" timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $admin_tenant_plans$
BEGIN
  PERFORM public.kalendr_admin_require(p_admin, ARRAY['support', 'billing', 'super']);
  RETURN QUERY
  SELECT subscription.tenant_id, subscription.plan_key::text, subscription.status::text, subscription.trial_ends_at
  FROM public.tenant_subscriptions AS subscription WHERE subscription.tenant_id = ANY (p_tenant_ids);
END
$admin_tenant_plans$;--> statement-breakpoint
CREATE FUNCTION "admin_tenant_billing"("p_admin" text, "p_tenant" text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $admin_tenant_billing$
DECLARE result jsonb;
BEGIN
  PERFORM public.kalendr_admin_require(p_admin, ARRAY['support', 'billing', 'super']);
  SELECT jsonb_build_object(
    'planKey', subscription.plan_key, 'status', subscription.status, 'trialEndsAt', subscription.trial_ends_at,
    'currentPeriodEnd', subscription.current_period_end, 'provider', subscription.provider, 'pastDueSince', subscription.past_due_since,
    'usage', coalesce((SELECT jsonb_object_agg(counter.metric, counter.count) FROM public.usage_counters AS counter
       WHERE counter.tenant_id = p_tenant AND counter.period = date_trunc('month', now() AT TIME ZONE 'UTC')::date), '{}'::jsonb)
  ) INTO result FROM public.tenant_subscriptions AS subscription WHERE subscription.tenant_id = p_tenant;
  RETURN result;
END
$admin_tenant_billing$;--> statement-breakpoint
CREATE FUNCTION "admin_extend_trial"("p_admin" text, "p_tenant" text, "p_days" integer, "p_reason" text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $admin_extend_trial$
DECLARE new_end timestamptz;
BEGIN
  PERFORM public.kalendr_admin_require(p_admin, ARRAY['billing', 'super']);
  IF length(trim(coalesce(p_reason, ''))) < 5 THEN RAISE EXCEPTION 'a reason is required' USING ERRCODE = 'check_violation'; END IF;
  IF coalesce(p_days, 0) NOT BETWEEN 1 AND 60 THEN RAISE EXCEPTION 'days must be between 1 and 60' USING ERRCODE = 'check_violation'; END IF;
  UPDATE public.tenant_subscriptions
  SET status = CASE WHEN status IN ('free', 'trialing') THEN 'trialing' ELSE status END,
      plan_key = CASE WHEN status IN ('free', 'trialing') THEN 'growth' ELSE plan_key END,
      trial_ends_at = CASE WHEN status IN ('free', 'trialing') THEN greatest(coalesce(trial_ends_at, now()), now()) + make_interval(days => p_days) ELSE trial_ends_at END,
      version = version + 1, updated_at = now()
  WHERE tenant_id = p_tenant AND status IN ('free', 'trialing') RETURNING trial_ends_at INTO new_end;
  IF new_end IS NULL THEN RAISE EXCEPTION 'only a trial or free business can have its trial extended' USING ERRCODE = 'check_violation'; END IF;
  PERFORM public.kalendr_admin_audit(p_admin, p_tenant, 'admin.billing.trial_extended', p_reason, jsonb_build_object('days', p_days));
  RETURN new_end;
END
$admin_extend_trial$;--> statement-breakpoint
-- A manual plan change, for billing fixes. It does not charge anyone; paid changes go through the provider.
CREATE FUNCTION "admin_change_plan"("p_admin" text, "p_tenant" text, "p_plan" text, "p_reason" text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $admin_change_plan$
BEGIN
  PERFORM public.kalendr_admin_require(p_admin, ARRAY['billing', 'super']);
  IF length(trim(coalesce(p_reason, ''))) < 5 THEN RAISE EXCEPTION 'a reason is required' USING ERRCODE = 'check_violation'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.plans WHERE key = p_plan) THEN RAISE EXCEPTION 'unknown plan' USING ERRCODE = 'no_data_found'; END IF;
  UPDATE public.tenant_subscriptions
  SET plan_key = p_plan, status = CASE WHEN p_plan = 'free' THEN 'free' WHEN status IN ('free', 'cancelled') THEN 'active' ELSE status END,
      pending_plan_key = NULL, version = version + 1, updated_at = now()
  WHERE tenant_id = p_tenant;
  IF NOT FOUND THEN RAISE EXCEPTION 'business not found' USING ERRCODE = 'no_data_found'; END IF;
  PERFORM public.kalendr_admin_audit(p_admin, p_tenant, 'admin.billing.plan_changed', p_reason, jsonb_build_object('plan', p_plan));
END
$admin_change_plan$;
