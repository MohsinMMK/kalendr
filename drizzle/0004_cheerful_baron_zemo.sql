ALTER TABLE "appointments" ADD COLUMN "clinic_moved_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "clinic_moved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "practitioners" ADD COLUMN "photo_data_url" text;--> statement-breakpoint
ALTER TABLE "practitioners" ADD COLUMN "bio" text;--> statement-breakpoint
ALTER TABLE "practitioners" ADD COLUMN "qualifications" varchar(200);--> statement-breakpoint
ALTER TABLE "practitioners" ADD COLUMN "registration_number" varchar(60);--> statement-breakpoint
ALTER TABLE "practitioners" ADD COLUMN "experience_years" smallint;--> statement-breakpoint
ALTER TABLE "practitioners" ADD COLUMN "languages" varchar(200);--> statement-breakpoint
ALTER TABLE "practitioners" ADD COLUMN "phone" varchar(30);