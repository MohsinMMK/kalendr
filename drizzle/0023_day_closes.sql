CREATE TABLE "day_closes" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"location_id" text NOT NULL,
	"day" date NOT NULL,
	"summary" jsonb NOT NULL,
	"cash_expected_minor" integer NOT NULL,
	"cash_counted_minor" integer NOT NULL,
	"note" varchar(300),
	"closed_by_user_id" text,
	"closed_by_name" varchar(120) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "day_closes_location_day_uq" UNIQUE("tenant_id","location_id","day"),
	CONSTRAINT "day_closes_cash_not_negative" CHECK ("day_closes"."cash_counted_minor" >= 0 and "day_closes"."cash_expected_minor" >= 0)
);
--> statement-breakpoint
ALTER TABLE "day_closes" ADD CONSTRAINT "day_closes_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."locations"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "day_closes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "day_closes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "day_closes"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
-- A closed day is a record of what the desk counted that night. It is never edited or removed.
CREATE OR REPLACE FUNCTION "kalendr_day_close_is_final"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'a closed day cannot be changed' USING ERRCODE = 'check_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "day_closes_final" BEFORE UPDATE OR DELETE ON "day_closes"
  FOR EACH ROW EXECUTE FUNCTION "kalendr_day_close_is_final"();
--> statement-breakpoint
CREATE TRIGGER "day_closes_live" AFTER INSERT ON "day_closes"
  FOR EACH ROW EXECUTE FUNCTION "kalendr_notify_live"('payment');
