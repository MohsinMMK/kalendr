ALTER TYPE "public"."booking_source" ADD VALUE 'iframe';--> statement-breakpoint
ALTER TYPE "public"."booking_source" ADD VALUE 'phone';--> statement-breakpoint
ALTER TYPE "public"."booking_source" ADD VALUE 'walk_in';--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "reason_for_visit" varchar(500);--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "referrer_host" varchar(253);--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "utm_source" varchar(100);--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "utm_medium" varchar(100);--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "utm_campaign" varchar(100);--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "privacy_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "messaging_consent_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "patients_tenant_email_idx" ON "patients" USING btree ("tenant_id","email");