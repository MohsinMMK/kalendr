CREATE TABLE "oauth_device_codes" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"device_hash" varchar(64) NOT NULL,
	"user_code_hash" varchar(64) NOT NULL,
	"client_id" varchar(64) NOT NULL,
	"scopes" text[] NOT NULL,
	"status" varchar(10) DEFAULT 'pending' NOT NULL,
	"tenant_id" text,
	"grant_id" text,
	"last_polled_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_device_codes_status_ck" CHECK ("oauth_device_codes"."status" in ('pending', 'approved', 'denied', 'used')),
	CONSTRAINT "oauth_device_codes_approved_ck" CHECK ("oauth_device_codes"."status" not in ('approved', 'used') or ("oauth_device_codes"."tenant_id" is not null and "oauth_device_codes"."grant_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "oauth_device_codes" ADD CONSTRAINT "oauth_device_codes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_device_codes_device_uq" ON "oauth_device_codes" USING btree ("device_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_device_codes_user_uq" ON "oauth_device_codes" USING btree ("user_code_hash");--> statement-breakpoint
CREATE INDEX "oauth_device_codes_expiry_idx" ON "oauth_device_codes" USING btree ("expires_at");
--> statement-breakpoint
-- Feature 57, the hand-written part. A device sign-in starts in a browser that belongs to no business yet, so the table
-- refuses every direct read and write (the policy is false for the app's roles) and the app reaches it only through
-- these functions, which run as the owner. Each takes and returns hashes and ids, never a code or a token.
ALTER TABLE "oauth_device_codes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "oauth_device_codes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "deny_direct_access" ON "oauth_device_codes" FOR ALL USING (false) WITH CHECK (false);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "kalendr_device_create"("p_device" text, "p_user" text, "p_client" text, "p_scopes" text[], "p_expires" timestamptz)
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $kalendr_device_create$
BEGIN
  DELETE FROM oauth_device_codes WHERE expires_at < now() - interval '1 hour';
  INSERT INTO oauth_device_codes (device_hash, user_code_hash, client_id, scopes, expires_at) VALUES ("p_device", "p_user", "p_client", "p_scopes", "p_expires");
END
$kalendr_device_create$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "kalendr_device_poll"("p_device" text)
  RETURNS TABLE ("status" text, "previous_poll" timestamptz, "expires_at" timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $kalendr_device_poll$
DECLARE previous timestamptz;
BEGIN
  SELECT d.last_polled_at INTO previous FROM oauth_device_codes AS d WHERE d.device_hash = "p_device";
  RETURN QUERY
    UPDATE oauth_device_codes AS d SET last_polled_at = now() WHERE d.device_hash = "p_device"
    RETURNING d.status::text, previous, d.expires_at;
END
$kalendr_device_poll$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "kalendr_device_claim"("p_device" text)
  RETURNS TABLE ("tenant_id" text, "grant_id" text)
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $kalendr_device_claim$
  UPDATE oauth_device_codes AS d SET status = 'used'
  WHERE d.device_hash = "p_device" AND d.status = 'approved' AND d.expires_at > now()
  RETURNING d.tenant_id, d.grant_id
$kalendr_device_claim$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "kalendr_device_lookup"("p_user" text)
  RETURNS TABLE ("id" text, "client_id" text, "scopes" text[])
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $kalendr_device_lookup$
  SELECT d.id, d.client_id, d.scopes FROM oauth_device_codes AS d
  WHERE d.user_code_hash = "p_user" AND d.status = 'pending' AND d.expires_at > now()
$kalendr_device_lookup$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "kalendr_device_approve"("p_id" text, "p_tenant" text, "p_grant" text)
  RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $kalendr_device_approve$
  WITH changed AS (
    UPDATE oauth_device_codes AS d SET status = 'approved', tenant_id = "p_tenant", grant_id = "p_grant"
    WHERE d.id = "p_id" AND d.status = 'pending' AND d.expires_at > now() RETURNING 1
  ) SELECT EXISTS (SELECT 1 FROM changed)
$kalendr_device_approve$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "kalendr_device_deny"("p_id" text)
  RETURNS void LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $kalendr_device_deny$
  UPDATE oauth_device_codes SET status = 'denied' WHERE id = "p_id" AND status = 'pending'
$kalendr_device_deny$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_device_create"(text, text, text, text[], timestamptz) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_device_poll"(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_device_claim"(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_device_lookup"(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_device_approve"(text, text, text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_device_deny"(text) FROM PUBLIC;
