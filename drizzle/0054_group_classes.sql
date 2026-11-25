CREATE TABLE "class_enrolments" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"session_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"status" varchar(10) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"token_sealed" text,
	"source" varchar(10) DEFAULT 'online' NOT NULL,
	"offer_expires_at" timestamp with time zone,
	"offered_at" timestamp with time zone,
	"offer_passed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" varchar(10),
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "class_enrolments_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "class_enrolments_session_customer_uq" UNIQUE("tenant_id","session_id","patient_id"),
	CONSTRAINT "class_enrolments_token_uq" UNIQUE("token_hash"),
	CONSTRAINT "class_enrolments_status_valid" CHECK ("class_enrolments"."status" in ('booked', 'waitlisted', 'attended', 'cancelled', 'no_show')),
	CONSTRAINT "class_enrolments_source_valid" CHECK ("class_enrolments"."source" in ('online', 'staff', 'walk_in')),
	CONSTRAINT "class_enrolments_cancelled_by_valid" CHECK ("class_enrolments"."cancelled_by" is null or "class_enrolments"."cancelled_by" in ('customer', 'business')),
	CONSTRAINT "class_enrolments_offer_only_waiting" CHECK ("class_enrolments"."offer_expires_at" is null or "class_enrolments"."status" = 'waitlisted')
);
--> statement-breakpoint
CREATE TABLE "class_sessions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"service_id" text NOT NULL,
	"practitioner_id" text NOT NULL,
	"location_id" text NOT NULL,
	"resource_id" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"capacity" smallint NOT NULL,
	"status" varchar(10) DEFAULT 'scheduled' NOT NULL,
	"series_id" text,
	"cancelled_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "class_sessions_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "class_sessions_time_order" CHECK ("class_sessions"."ends_at" > "class_sessions"."starts_at"),
	CONSTRAINT "class_sessions_capacity_range" CHECK ("class_sessions"."capacity" between 1 and 500),
	CONSTRAINT "class_sessions_status_valid" CHECK ("class_sessions"."status" in ('scheduled', 'cancelled', 'completed'))
);
--> statement-breakpoint
ALTER TABLE "resource_reservations" ALTER COLUMN "appointment_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "resource_reservations" ADD COLUMN "class_session_id" text;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "kind" varchar(12) DEFAULT 'appointment' NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "capacity" smallint;--> statement-breakpoint
ALTER TABLE "class_enrolments" ADD CONSTRAINT "class_enrolments_session_fk" FOREIGN KEY ("tenant_id","session_id") REFERENCES "public"."class_sessions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_enrolments" ADD CONSTRAINT "class_enrolments_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patients"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_practitioner_fk" FOREIGN KEY ("tenant_id","practitioner_id") REFERENCES "public"."practitioners"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."locations"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_resource_fk" FOREIGN KEY ("tenant_id","resource_id") REFERENCES "public"."resources"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "class_enrolments_session_idx" ON "class_enrolments" USING btree ("tenant_id","session_id","status","created_at");--> statement-breakpoint
CREATE INDEX "class_enrolments_patient_idx" ON "class_enrolments" USING btree ("tenant_id","patient_id");--> statement-breakpoint
CREATE INDEX "class_sessions_timetable_idx" ON "class_sessions" USING btree ("tenant_id","starts_at");--> statement-breakpoint
CREATE INDEX "class_sessions_service_idx" ON "class_sessions" USING btree ("tenant_id","service_id","starts_at");--> statement-breakpoint
CREATE INDEX "class_sessions_series_idx" ON "class_sessions" USING btree ("tenant_id","series_id") WHERE "class_sessions"."series_id" is not null;--> statement-breakpoint
ALTER TABLE "resource_reservations" ADD CONSTRAINT "resource_reservations_class_session_fk" FOREIGN KEY ("tenant_id","class_session_id") REFERENCES "public"."class_sessions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_reservations" ADD CONSTRAINT "resource_reservations_owner_check" CHECK (num_nonnulls("resource_reservations"."appointment_id", "resource_reservations"."class_session_id") = 1);--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_kind_valid" CHECK ("services"."kind" in ('appointment', 'class'));--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_class_capacity" CHECK (("services"."kind" = 'class' and "services"."capacity" between 1 and 500) or ("services"."kind" = 'appointment' and "services"."capacity" is null));--> statement-breakpoint
-- Feature 18, the hand-written part: row-level security on the two new tables, the guard that no database write can hold
-- more seats than a session has, and the lookup that turns a customer's secret link into a business.
ALTER TABLE "class_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "class_sessions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "class_sessions"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
ALTER TABLE "class_enrolments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "class_enrolments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "class_enrolments"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
-- A seat is held by someone booked, attended or marked absent, and by a waiting person holding a live offer. The app locks
-- the session row before it counts; this trigger takes the same lock, so even a code path that forgets cannot oversell.
CREATE OR REPLACE FUNCTION "kalendr_class_capacity_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $kalendr_class_capacity_guard$
DECLARE
  seats integer;
  held integer;
BEGIN
  IF NOT (NEW.status IN ('booked', 'attended', 'no_show')
       OR (NEW.status = 'waitlisted' AND NEW.offer_expires_at IS NOT NULL AND NEW.offer_expires_at > now())) THEN
    RETURN NEW;
  END IF;
  SELECT capacity INTO seats FROM class_sessions WHERE tenant_id = NEW.tenant_id AND id = NEW.session_id FOR UPDATE;
  SELECT count(*) INTO held FROM class_enrolments AS other
   WHERE other.tenant_id = NEW.tenant_id AND other.session_id = NEW.session_id AND other.id <> NEW.id
     AND (other.status IN ('booked', 'attended', 'no_show')
       OR (other.status = 'waitlisted' AND other.offer_expires_at IS NOT NULL AND other.offer_expires_at > now()));
  IF held + 1 > seats THEN
    RAISE EXCEPTION 'class_over_capacity' USING ERRCODE = '23514', CONSTRAINT = 'class_enrolments_within_capacity';
  END IF;
  RETURN NEW;
END
$kalendr_class_capacity_guard$;--> statement-breakpoint
CREATE TRIGGER "class_enrolments_within_capacity"
  BEFORE INSERT OR UPDATE OF status, offer_expires_at ON "class_enrolments"
  FOR EACH ROW EXECUTE FUNCTION "kalendr_class_capacity_guard"();--> statement-breakpoint
-- The customer's link arrives with only a secret token. This finds the business and nothing more; everything shown is then
-- read under that business's row-level security.
CREATE OR REPLACE FUNCTION "kalendr_resolve_class_seat"(p_token_hash text)
RETURNS TABLE (tenant_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $kalendr_resolve_class_seat$
  SELECT enrolment.tenant_id
  FROM class_enrolments AS enrolment
  JOIN tenants AS tenant ON tenant.id = enrolment.tenant_id AND tenant.is_active
  WHERE enrolment.token_hash = p_token_hash
  LIMIT 1
$kalendr_resolve_class_seat$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_resolve_class_seat"(text) FROM PUBLIC;
