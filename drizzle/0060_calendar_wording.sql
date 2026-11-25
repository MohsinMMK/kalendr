ALTER TABLE "services" ADD COLUMN "customer_event_title" varchar(200);--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "staff_event_title" varchar(200);--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "event_description" text;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "hide_notes_in_calendar" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "hide_details_in_calendar" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "reply_to_email" varchar(254);--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "reply_to_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_event_description_len" CHECK ("services"."event_description" is null or char_length("services"."event_description") <= 1000);--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_reply_to_pair_ck" CHECK (("tenants"."reply_to_email" is null) = ("tenants"."reply_to_verified_at" is null));