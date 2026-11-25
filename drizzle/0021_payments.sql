CREATE TYPE "public"."payment_method" AS ENUM('cash', 'upi', 'card', 'bank');--> statement-breakpoint
CREATE TABLE "payment_refunds" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"payment_id" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"reason" varchar(200) NOT NULL,
	"recorded_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_refunds_amount_positive" CHECK ("payment_refunds"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"appointment_id" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"method" "payment_method" NOT NULL,
	"recorded_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "payments_amount_positive" CHECK ("payments"."amount_minor" > 0)
);
--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "price_minor" integer;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "price_minor" integer;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "currency" varchar(3) DEFAULT 'INR' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_payment_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointments"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_refunds_payment_idx" ON "payment_refunds" USING btree ("tenant_id","payment_id");--> statement-breakpoint
CREATE INDEX "payments_appointment_idx" ON "payments" USING btree ("tenant_id","appointment_id");--> statement-breakpoint
CREATE INDEX "payments_created_idx" ON "payments" USING btree ("tenant_id","created_at");--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_price_not_negative" CHECK ("appointments"."price_minor" >= 0);--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_price_not_negative" CHECK ("services"."price_minor" >= 0);--> statement-breakpoint
ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payments"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
ALTER TABLE "payment_refunds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payment_refunds" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payment_refunds"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
-- Money rows are written once. A correction is a refund, never an edit.
CREATE OR REPLACE FUNCTION "kalendr_money_is_final"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'payments and refunds cannot be changed' USING ERRCODE = 'check_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "payments_final" BEFORE UPDATE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION "kalendr_money_is_final"();
--> statement-breakpoint
CREATE TRIGGER "payment_refunds_final" BEFORE UPDATE ON "payment_refunds"
  FOR EACH ROW EXECUTE FUNCTION "kalendr_money_is_final"();
--> statement-breakpoint
-- A new visit costs what its service costs at the moment it is booked.
CREATE OR REPLACE FUNCTION "kalendr_price_from_service"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.price_minor IS NULL THEN
    SELECT price_minor INTO NEW.price_minor FROM services
      WHERE tenant_id = NEW.tenant_id AND id = NEW.service_id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "appointments_price" BEFORE INSERT ON "appointments"
  FOR EACH ROW EXECUTE FUNCTION "kalendr_price_from_service"();
--> statement-breakpoint
CREATE TRIGGER "payments_live" AFTER INSERT OR UPDATE OR DELETE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION "kalendr_notify_live"('payment');
--> statement-breakpoint
CREATE TRIGGER "payment_refunds_live" AFTER INSERT OR UPDATE OR DELETE ON "payment_refunds"
  FOR EACH ROW EXECUTE FUNCTION "kalendr_notify_live"('payment');
