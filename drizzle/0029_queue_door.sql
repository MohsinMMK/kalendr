ALTER TABLE "queue_counters" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "queue_counters" ADD COLUMN "closed_reason" varchar(200);--> statement-breakpoint
ALTER TABLE "queue_displays" ADD COLUMN "join_token_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "queue_displays" ADD COLUMN "self_join_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "queue_displays_join_token_uq" ON "queue_displays" USING btree ("join_token_hash");--> statement-breakpoint
-- The door QR code arrives with only a secret link. This finds the business and location it belongs to,
-- and nothing more; the sign-up itself then runs under that business's row-level security.
CREATE OR REPLACE FUNCTION "kalendr_resolve_queue_join"(p_token_hash text)
RETURNS TABLE (tenant_id text, location_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $kalendr_resolve_queue_join$
  SELECT display.tenant_id, display.location_id
  FROM queue_displays AS display
  JOIN tenants AS tenant ON tenant.id = display.tenant_id AND tenant.is_active
  WHERE display.join_token_hash = p_token_hash AND display.revoked_at IS NULL
  LIMIT 1
$kalendr_resolve_queue_join$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_resolve_queue_join"(text) FROM PUBLIC;
