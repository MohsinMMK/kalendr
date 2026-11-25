CREATE TABLE "rating_requests" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"appointment_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"token_ciphertext" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_at" timestamp with time zone,
	"answered_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rating_requests_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "rating_requests_appointment_uq" UNIQUE("tenant_id","appointment_id")
);
--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "visibility" varchar(8) DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "source" varchar(12) DEFAULT 'manage_link' NOT NULL;--> statement-breakpoint
ALTER TABLE "rating_requests" ADD CONSTRAINT "rating_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rating_requests" ADD CONSTRAINT "rating_requests_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointments"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rating_requests" ADD CONSTRAINT "rating_requests_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patients"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rating_requests_token_hash_uq" ON "rating_requests" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "rating_requests_patient_idx" ON "rating_requests" USING btree ("tenant_id","patient_id","sent_at");--> statement-breakpoint
CREATE INDEX "reviews_created_idx" ON "reviews" USING btree ("tenant_id","created_at");--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_visibility_ck" CHECK ("reviews"."visibility" in ('public', 'private'));--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_source_ck" CHECK ("reviews"."source" in ('manage_link', 'rating_link', 'staff'));--> statement-breakpoint
ALTER TABLE "rating_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "rating_requests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "rating_requests" FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint

-- Feature 51, the hand-written part: the public rating page knows only a token, so this finds its business and request the way
-- kalendr_resolve_manage_token does: by hash, ids only. Expiry is judged by the caller (so the page can say the link has expired).
CREATE OR REPLACE FUNCTION "kalendr_resolve_rating_token"(p_token_hash text)
RETURNS TABLE (tenant_id text, request_id text, appointment_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $kalendr_resolve_rating_token$
  SELECT request.tenant_id, request.id, request.appointment_id
  FROM rating_requests AS request
  WHERE request.token_hash = p_token_hash
  LIMIT 1
$kalendr_resolve_rating_token$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_resolve_rating_token"(text) FROM PUBLIC;
--> statement-breakpoint

-- The standard "Ask for a review" message now carries the one-tap rating link. Owners who kept the standard wording move over; a
-- message they rewrote keeps its own words (and its manage link, which still opens the review box on the manage page).
UPDATE "workflow_steps" AS step
SET "body" = replace(step."body", E'Leave a review: {manage_link}', E'Rate your visit in one tap: {rating_link}')
FROM "workflows" AS workflow
WHERE workflow."tenant_id" = step."tenant_id" AND workflow."id" = step."workflow_id" AND workflow."preset_key" = 'review_request'
  AND step."body" LIKE E'%Leave a review: {manage_link}%';
