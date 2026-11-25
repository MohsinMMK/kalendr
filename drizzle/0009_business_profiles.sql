ALTER TYPE "public"."resource_kind" ADD VALUE 'space';--> statement-breakpoint
ALTER TYPE "public"."resource_kind" ADD VALUE 'station';--> statement-breakpoint
ALTER TYPE "public"."resource_kind" ADD VALUE 'vehicle';--> statement-breakpoint
ALTER TYPE "public"."resource_kind" ADD VALUE 'other';--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "business_type" varchar(40) DEFAULT 'healthcare' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "terminology" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "features" jsonb DEFAULT '{}'::jsonb NOT NULL;