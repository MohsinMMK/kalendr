ALTER TABLE "practitioner_services" ADD COLUMN "priority" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "practitioner_services" ADD COLUMN "weight" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "assignment" varchar(16) DEFAULT 'customer_chooses' NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "prefer_returning_person" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "appointments_routing_idx" ON "appointments" USING btree ("tenant_id","practitioner_id","created_at");--> statement-breakpoint
ALTER TABLE "practitioner_services" ADD CONSTRAINT "practitioner_services_priority_range" CHECK ("practitioner_services"."priority" between 0 and 100);--> statement-breakpoint
ALTER TABLE "practitioner_services" ADD CONSTRAINT "practitioner_services_weight_range" CHECK ("practitioner_services"."weight" between 1 and 100);--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_assignment_valid" CHECK ("services"."assignment" in ('customer_chooses', 'any_available', 'round_robin'));