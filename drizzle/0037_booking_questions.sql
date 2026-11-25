-- Feature 40: booking questions 2.0. Required switches per service, guests, contact mode, the email code
-- check, and the sealed guest list on a booking. Written by hand like 0025 to 0033.
ALTER TABLE "form_definition_services" ADD COLUMN "required_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "allow_guests" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "max_guests" smallint DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "contact_mode" varchar(16) DEFAULT 'email_or_phone' NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "verify_email" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_contact_mode_valid" CHECK ("contact_mode" IN ('email_or_phone','email_required','phone_only'));--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_max_guests_valid" CHECK ("max_guests" BETWEEN 1 AND 10);--> statement-breakpoint
-- Guest emails are sealed, never stored as text and never logged.
ALTER TABLE "appointments" ADD COLUMN "guest_emails_ciphertext" text;--> statement-breakpoint
CREATE TABLE "email_checks" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	-- SHA-256 of the lower-cased address: lets sends be counted per address without keeping it readable.
	"email_hash" varchar(64) NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	-- What the worker needs to send the message; sealed and cleared once it has been sent.
	"delivery_sealed" text,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"proof_hash" varchar(64),
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_checks_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "email_checks_attempts_valid" CHECK ("attempts" >= 0)
);--> statement-breakpoint
ALTER TABLE "email_checks" ADD CONSTRAINT "email_checks_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_checks_email_idx" ON "email_checks" USING btree ("tenant_id","email_hash","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "email_checks_proof_uq" ON "email_checks" USING btree ("proof_hash") WHERE "proof_hash" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "email_checks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "email_checks" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "email_checks" FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
