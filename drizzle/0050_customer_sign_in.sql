CREATE TABLE "booking_step_ups" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"appointment_id" text NOT NULL,
	"action" varchar(12) NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"attempt_count" smallint DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"grant_hash" varchar(64),
	"grant_expires_at" timestamp with time zone,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_step_ups_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "booking_step_ups_action_ck" CHECK ("booking_step_ups"."action" in ('cancel', 'reschedule', 'contact'))
);
--> statement-breakpoint
CREATE TABLE "patient_code_deliveries" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"purpose" varchar(20) NOT NULL,
	"via" varchar(8) DEFAULT 'auto' NOT NULL,
	"sealed" text,
	"status" varchar(12) DEFAULT 'pending' NOT NULL,
	"attempt_count" smallint DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" varchar(120),
	"last_error_code" varchar(60),
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "patient_code_deliveries_purpose_ck" CHECK ("patient_code_deliveries"."purpose" in ('sign_in', 'step_up', 'contact_changed')),
	CONSTRAINT "patient_code_deliveries_via_ck" CHECK ("patient_code_deliveries"."via" in ('auto', 'text')),
	CONSTRAINT "patient_code_deliveries_status_ck" CHECK ("patient_code_deliveries"."status" in ('pending', 'processing', 'sent', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "manage_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "patient_login_codes" ADD COLUMN "locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "patient_sessions" ADD COLUMN "device_label" varchar(80);--> statement-breakpoint
ALTER TABLE "patient_sessions" ADD COLUMN "remember" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_step_ups" ADD CONSTRAINT "booking_step_ups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_step_ups" ADD CONSTRAINT "booking_step_ups_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointments"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "booking_step_ups_grant_uq" ON "booking_step_ups" USING btree ("grant_hash");--> statement-breakpoint
CREATE INDEX "booking_step_ups_appointment_idx" ON "booking_step_ups" USING btree ("tenant_id","appointment_id","created_at");--> statement-breakpoint
CREATE INDEX "patient_code_deliveries_due_idx" ON "patient_code_deliveries" USING btree ("status","available_at");--> statement-breakpoint
-- Feature 8: customer sign-in upgrade. The hand-written part: row-level security, definer functions, the manage-link
-- expiry and the contact-changed templates.

-- Step-up codes belong to one business, like every other tenant table.
ALTER TABLE "booking_step_ups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "booking_step_ups" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "booking_step_ups"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint

-- Sealed codes and destinations: no policy, so no role without BYPASSRLS can read or write the table directly.
-- The functions below are owned by the migrating role and are the only way in.
ALTER TABLE "patient_code_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "patient_code_deliveries" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "kalendr_queue_code_delivery"(
  "p_id" text, "p_purpose" text, "p_via" text, "p_sealed" text, "p_expires_at" timestamptz
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $kalendr_queue_code_delivery$
  INSERT INTO public.patient_code_deliveries (id, purpose, via, sealed, expires_at)
  VALUES (p_id, p_purpose, p_via, p_sealed, p_expires_at)
$kalendr_queue_code_delivery$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_queue_code_delivery"(text, text, text, text, timestamptz) FROM PUBLIC;--> statement-breakpoint

-- Worker only. Takes due rows (a row whose worker stopped for a minute counts as due again), drops finished rows after a
-- day, and ends rows whose code has expired without sending them.
CREATE OR REPLACE FUNCTION "kalendr_claim_code_deliveries"("p_token" text, "p_limit" integer)
RETURNS TABLE ("out_id" text, "out_purpose" text, "out_via" text, "out_sealed" text, "out_attempts" integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $kalendr_claim_code_deliveries$
BEGIN
  DELETE FROM public.patient_code_deliveries
  WHERE status IN ('sent', 'failed') AND finished_at < now() - interval '1 day';
  UPDATE public.patient_code_deliveries
  SET status = 'failed', sealed = NULL, last_error_code = 'expired', finished_at = now(), locked_by = NULL
  WHERE status IN ('pending', 'processing') AND expires_at <= now();
  RETURN QUERY
  WITH due AS (
    SELECT d.id FROM public.patient_code_deliveries AS d
    WHERE (d.status = 'pending' AND d.available_at <= now())
       OR (d.status = 'processing' AND d.available_at <= now() - interval '60 seconds')
    ORDER BY d.created_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.patient_code_deliveries AS d
  SET status = 'processing', locked_by = p_token, available_at = now(), attempt_count = d.attempt_count + 1
  FROM due WHERE d.id = due.id
  RETURNING d.id, d.purpose::text, d.via::text, d.sealed, d.attempt_count::integer;
END
$kalendr_claim_code_deliveries$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_claim_code_deliveries"(text, integer) FROM PUBLIC;--> statement-breakpoint

-- Worker only. 'sent' and 'failed' clear the sealed payload; 'retry' tries again after a short wait, up to four times.
CREATE OR REPLACE FUNCTION "kalendr_finish_code_delivery"("p_id" text, "p_token" text, "p_outcome" text, "p_code" text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $kalendr_finish_code_delivery$
  UPDATE public.patient_code_deliveries
  SET
    status = CASE
      WHEN p_outcome = 'sent' THEN 'sent'
      WHEN p_outcome = 'retry' AND attempt_count < 4 THEN 'pending'
      ELSE 'failed' END,
    sealed = CASE WHEN p_outcome = 'retry' AND attempt_count < 4 THEN sealed ELSE NULL END,
    available_at = CASE WHEN p_outcome = 'retry' THEN now() + (attempt_count * 10) * interval '1 second' ELSE available_at END,
    last_error_code = left(p_code, 60),
    finished_at = CASE WHEN p_outcome = 'retry' AND attempt_count < 4 THEN NULL ELSE now() END,
    locked_by = NULL
  WHERE id = p_id AND locked_by = p_token AND status = 'processing'
$kalendr_finish_code_delivery$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_finish_code_delivery"(text, text, text, text) FROM PUBLIC;--> statement-breakpoint

-- A manage link works until 30 days after the booking ends. The trigger keeps the date right when the booking is
-- made or moved, so the places that write bookings need no change.
CREATE OR REPLACE FUNCTION "kalendr_set_manage_expiry"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.manage_token_expires_at := NEW.ends_at + interval '30 days';
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "appointments_manage_expiry" BEFORE INSERT OR UPDATE OF ends_at ON "appointments"
  FOR EACH ROW EXECUTE FUNCTION "kalendr_set_manage_expiry"();
--> statement-breakpoint
UPDATE "appointments" SET "manage_token_expires_at" = "ends_at" + interval '30 days' WHERE "manage_token_expires_at" IS NULL;--> statement-breakpoint

-- Same signature as before, so every caller (manage page, calendar file, review, video visit) is covered.
CREATE OR REPLACE FUNCTION "kalendr_resolve_manage_token"(p_token_hash text)
RETURNS TABLE (tenant_id text, appointment_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $kalendr_resolve_manage_token$
  SELECT appointment.tenant_id, appointment.id
  FROM appointments AS appointment
  WHERE appointment.manage_token_hash = p_token_hash
    AND (appointment.manage_token_expires_at IS NULL OR appointment.manage_token_expires_at > now())
  LIMIT 1
$kalendr_resolve_manage_token$;--> statement-breakpoint

-- True only for a real token whose link has expired, so the page can say "Sign in to see this booking".
CREATE OR REPLACE FUNCTION "kalendr_manage_token_expired"(p_token_hash text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $kalendr_manage_token_expired$
  SELECT EXISTS (
    SELECT 1 FROM appointments AS appointment
    WHERE appointment.manage_token_hash = p_token_hash
      AND appointment.manage_token_expires_at IS NOT NULL
      AND appointment.manage_token_expires_at <= now()
  )
$kalendr_manage_token_expired$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_manage_token_expired"(text) FROM PUBLIC;--> statement-breakpoint

-- The sign-in code on WhatsApp is the copy-code button template; the same wording serves the booking step-up code.
-- This one tells a customer, on their other channel, that the contact details on a booking changed. It names no contact.
INSERT INTO "message_templates" ("channel", "key", "language", "provider_name", "provider_template_id", "status", "variables", "buttons", "body", "cost_category") VALUES
('whatsapp', 'contact_changed', 'en', 'kalendr_contact_changed', NULL, 'pending', '["business"]', '[]', NULL, 'utility'),
('sms', 'contact_changed', 'en', 'contact_changed', NULL, 'pending', '["business"]', '[]', 'The contact details on your booking with {#var#} were changed. If this was not you, please contact them.', 'utility')
ON CONFLICT DO NOTHING;
