ALTER TABLE "customer_field_definitions" DROP CONSTRAINT "customer_field_definitions_kind_ck";--> statement-breakpoint
ALTER TABLE "customer_field_values" DROP CONSTRAINT "customer_field_values_length_ck";--> statement-breakpoint
ALTER TABLE "customer_field_definitions" ALTER COLUMN "kind" SET DATA TYPE varchar(16);--> statement-breakpoint
ALTER TABLE "customer_field_definitions" ADD CONSTRAINT "customer_field_definitions_kind_ck" CHECK ("customer_field_definitions"."kind" in ('text', 'number', 'date', 'choice', 'multichoice', 'boolean', 'phone', 'email', 'link'));--> statement-breakpoint
ALTER TABLE "customer_field_values" ADD CONSTRAINT "customer_field_values_length_ck" CHECK (char_length("customer_field_values"."value") between 1 and 2500);