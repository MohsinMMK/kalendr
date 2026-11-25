CREATE TABLE "queue_displays" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"location_id" text NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "queue_tickets" ADD COLUMN "phone_token_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "queue_tickets" ADD COLUMN "notify_when_next" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "queue_tickets" ADD COLUMN "next_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "queue_displays" ADD CONSTRAINT "queue_displays_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."locations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "queue_displays_token_uq" ON "queue_displays" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "queue_displays_live_uq" ON "queue_displays" USING btree ("tenant_id","location_id") WHERE "queue_displays"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "queue_tickets_phone_token_uq" ON "queue_tickets" USING btree ("phone_token_hash");--> statement-breakpoint
ALTER TABLE "queue_displays" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "queue_displays" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "queue_displays"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
-- Public screens arrive with only a secret link. These find the business it belongs to, and nothing more;
-- everything shown is then read under that business's row-level security.
CREATE OR REPLACE FUNCTION "kalendr_resolve_queue_display"(p_token_hash text)
RETURNS TABLE (tenant_id text, location_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $kalendr_resolve_queue_display$
  SELECT display.tenant_id, display.location_id
  FROM queue_displays AS display
  JOIN tenants AS tenant ON tenant.id = display.tenant_id AND tenant.is_active
  WHERE display.token_hash = p_token_hash AND display.revoked_at IS NULL
  LIMIT 1
$kalendr_resolve_queue_display$;--> statement-breakpoint
-- A customer's queue link works on the day of the ticket only.
CREATE OR REPLACE FUNCTION "kalendr_resolve_queue_ticket"(p_token_hash text)
RETURNS TABLE (tenant_id text, ticket_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $kalendr_resolve_queue_ticket$
  SELECT ticket.tenant_id, ticket.id
  FROM queue_tickets AS ticket
  JOIN locations AS location ON location.tenant_id = ticket.tenant_id AND location.id = ticket.location_id
  JOIN tenants AS tenant ON tenant.id = ticket.tenant_id AND tenant.is_active
  WHERE ticket.phone_token_hash = p_token_hash
    AND ticket.day = (now() AT TIME ZONE location.timezone)::date
  LIMIT 1
$kalendr_resolve_queue_ticket$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_resolve_queue_display"(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_resolve_queue_ticket"(text) FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "queue_displays_live" AFTER INSERT OR UPDATE ON "queue_displays"
  FOR EACH ROW EXECUTE FUNCTION "kalendr_notify_live"('queue');
