CREATE TABLE "slot_offers" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"entry_id" text NOT NULL,
	"service_id" text NOT NULL,
	"location_id" text NOT NULL,
	"practitioner_id" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"chain_id" text NOT NULL,
	"position" smallint DEFAULT 1 NOT NULL,
	"origin" varchar(12) DEFAULT 'automatic' NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"token_sealed" text,
	"status" varchar(12) DEFAULT 'scheduled' NOT NULL,
	"hold_id" text,
	"send_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"answered_at" timestamp with time zone,
	"appointment_id" text,
	"ended_reason" varchar(24),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slot_offers_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "slot_offers_token_uq" UNIQUE("token_hash"),
	CONSTRAINT "slot_offers_time_order_ck" CHECK ("slot_offers"."ends_at" > "slot_offers"."starts_at"),
	CONSTRAINT "slot_offers_status_ck" CHECK ("slot_offers"."status" in ('scheduled', 'sent', 'accepted', 'declined', 'expired', 'withdrawn')),
	CONSTRAINT "slot_offers_origin_ck" CHECK ("slot_offers"."origin" in ('automatic', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "waitlist_service_switches" (
	"tenant_id" text NOT NULL,
	"service_id" text NOT NULL,
	"automatic_offers" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waitlist_service_switches_pk" PRIMARY KEY("tenant_id","service_id")
);
--> statement-breakpoint
CREATE TABLE "waitlist_settings" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"order_rule" varchar(20) DEFAULT 'longest_waiting' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waitlist_settings_order_ck" CHECK ("waitlist_settings"."order_rule" in ('longest_waiting', 'soonest_existing'))
);
--> statement-breakpoint
ALTER TABLE "slot_offers" ADD CONSTRAINT "slot_offers_entry_fk" FOREIGN KEY ("tenant_id","entry_id") REFERENCES "public"."waitlist_entries"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_offers" ADD CONSTRAINT "slot_offers_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_offers" ADD CONSTRAINT "slot_offers_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."locations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_offers" ADD CONSTRAINT "slot_offers_practitioner_fk" FOREIGN KEY ("tenant_id","practitioner_id") REFERENCES "public"."practitioners"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_service_switches" ADD CONSTRAINT "waitlist_service_switches_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_settings" ADD CONSTRAINT "waitlist_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "slot_offers_live_slot_uq" ON "slot_offers" USING btree ("tenant_id","practitioner_id","starts_at") WHERE "slot_offers"."status" in ('scheduled', 'sent');--> statement-breakpoint
CREATE UNIQUE INDEX "slot_offers_chain_entry_uq" ON "slot_offers" USING btree ("tenant_id","chain_id","entry_id");--> statement-breakpoint
CREATE INDEX "slot_offers_chain_idx" ON "slot_offers" USING btree ("tenant_id","chain_id","position");--> statement-breakpoint
CREATE INDEX "slot_offers_live_idx" ON "slot_offers" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "slot_offers_entry_idx" ON "slot_offers" USING btree ("tenant_id","entry_id","status");--> statement-breakpoint
-- Feature 21, the hand-written part: row-level security on the three new tables, the hold purpose for a waitlist offer,
-- the token lookup for the public offer page, and the worker's way to find businesses with offers to move on.
ALTER TABLE "slot_offers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "slot_offers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "slot_offers"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
ALTER TABLE "waitlist_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "waitlist_settings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "waitlist_settings"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
ALTER TABLE "waitlist_service_switches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "waitlist_service_switches" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "waitlist_service_switches"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
-- An offered time is kept in slot_holds like a time a customer is filling in a form for. The engine already reads
-- every live hold as busy, so the time leaves the public page for as long as the offer lives.
ALTER TABLE "slot_holds" DROP CONSTRAINT "slot_holds_purpose_valid";--> statement-breakpoint
ALTER TABLE "slot_holds" ADD CONSTRAINT "slot_holds_purpose_valid" CHECK ("purpose" IN ('booking','payment','waitlist'));--> statement-breakpoint
-- The public offer link arrives with only a secret token. This finds the business and the offer and nothing more;
-- everything shown is then read under that business's row-level security.
CREATE OR REPLACE FUNCTION "kalendr_resolve_slot_offer"(p_token_hash text)
RETURNS TABLE (tenant_id text, offer_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $kalendr_resolve_slot_offer$
  SELECT offer.tenant_id, offer.id
  FROM slot_offers AS offer
  JOIN tenants AS tenant ON tenant.id = offer.tenant_id AND tenant.is_active
  WHERE offer.token_hash = p_token_hash
  LIMIT 1
$kalendr_resolve_slot_offer$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_resolve_slot_offer"(text) FROM PUBLIC;--> statement-breakpoint
-- The same function as 0015 with one more job. waitlist_sweep: an offer's answer time has passed, or its message is overdue.
CREATE OR REPLACE FUNCTION "kalendr_worker_tenants"("p_job" text)
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $kalendr_worker_tenants$
  SELECT appointment.tenant_id
  FROM public.appointments AS appointment
  WHERE p_job = 'reminder_sweep'
    AND appointment.reminder_status = 'queued'
    AND appointment.status IN ('requested', 'booked')
    AND appointment.starts_at > now()
    AND appointment.starts_at <= now() + interval '24 hours'
  UNION
  SELECT reservation.tenant_id
  FROM public.resource_reservations AS reservation
  WHERE p_job = 'hold_expiry'
    AND reservation.state = 'held'
    AND reservation.hold_expires_at <= now()
  UNION
  SELECT tenant.id FROM public.tenants AS tenant WHERE p_job = 'retention'
  UNION
  SELECT event.tenant_id
  FROM public.outbox_events AS event
  WHERE p_job = 'dead_letter_report' AND event.status = 'dead_letter'
  UNION
  SELECT appointment.tenant_id
  FROM public.appointments AS appointment
  WHERE p_job = 'request_expiry'
    AND appointment.status = 'requested'
  UNION
  SELECT appointment.tenant_id
  FROM public.appointments AS appointment
  WHERE p_job = 'reschedule_expiry'
    AND appointment.reschedule_requested_at IS NOT NULL
  UNION
  SELECT offer.tenant_id
  FROM public.slot_offers AS offer
  WHERE p_job = 'waitlist_sweep'
    AND ((offer.status = 'sent' AND offer.expires_at <= now())
      OR (offer.status = 'scheduled' AND offer.send_at <= now() - interval '2 minutes'))
$kalendr_worker_tenants$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_worker_tenants"(text) FROM PUBLIC;
--> statement-breakpoint
-- A waitlist entry that is deleted (an erasure request removes a customer's entries) takes its live offers with it through the
-- foreign key, and this trigger lets go of the time they were holding, so the time goes back to public booking at once instead
-- of staying hidden until the hold lapses.
CREATE OR REPLACE FUNCTION "kalendr_release_offer_holds"() RETURNS trigger
LANGUAGE plpgsql
AS $kalendr_release_offer_holds$
BEGIN
  DELETE FROM slot_holds AS hold
  USING slot_offers AS offer
  WHERE offer.tenant_id = OLD.tenant_id AND offer.entry_id = OLD.id AND offer.status IN ('scheduled', 'sent')
    AND hold.tenant_id = offer.tenant_id AND hold.id = offer.hold_id;
  RETURN OLD;
END
$kalendr_release_offer_holds$;--> statement-breakpoint
CREATE TRIGGER "waitlist_entries_release_offer_holds" BEFORE DELETE ON "waitlist_entries"
  FOR EACH ROW EXECUTE FUNCTION "kalendr_release_offer_holds"();
