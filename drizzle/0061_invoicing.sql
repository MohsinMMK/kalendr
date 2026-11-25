CREATE TABLE "credit_note_lines" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"credit_note_id" text NOT NULL,
	"invoice_line_id" text NOT NULL,
	"taxable_minor" integer NOT NULL,
	"cgst_minor" integer DEFAULT 0 NOT NULL,
	"sgst_minor" integer DEFAULT 0 NOT NULL,
	"igst_minor" integer DEFAULT 0 NOT NULL,
	"total_minor" integer NOT NULL,
	CONSTRAINT "credit_note_lines_line_uq" UNIQUE("tenant_id","invoice_line_id"),
	CONSTRAINT "credit_note_lines_total_ck" CHECK ("credit_note_lines"."total_minor" = "credit_note_lines"."taxable_minor" + "credit_note_lines"."cgst_minor" + "credit_note_lines"."sgst_minor" + "credit_note_lines"."igst_minor")
);
--> statement-breakpoint
CREATE TABLE "credit_notes" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"invoice_id" text NOT NULL,
	"financial_year" varchar(7) NOT NULL,
	"series" varchar(4) DEFAULT 'CN' NOT NULL,
	"sequence" integer NOT NULL,
	"number" varchar(24) NOT NULL,
	"reason" varchar(200) NOT NULL,
	"taxable_minor" integer NOT NULL,
	"cgst_minor" integer DEFAULT 0 NOT NULL,
	"sgst_minor" integer DEFAULT 0 NOT NULL,
	"igst_minor" integer DEFAULT 0 NOT NULL,
	"total_minor" integer NOT NULL,
	"issued_by_user_id" text,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_notes_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "credit_notes_total_ck" CHECK ("credit_notes"."total_minor" = "credit_notes"."taxable_minor" + "credit_notes"."cgst_minor" + "credit_notes"."sgst_minor" + "credit_notes"."igst_minor" and "credit_notes"."total_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "invoice_counters" (
	"tenant_id" text NOT NULL,
	"financial_year" varchar(7) NOT NULL,
	"series" varchar(4) NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_counters_pk" PRIMARY KEY("tenant_id","financial_year","series"),
	CONSTRAINT "invoice_counters_number_ck" CHECK ("invoice_counters"."last_number" >= 0)
);
--> statement-breakpoint
CREATE TABLE "invoice_documents" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"invoice_id" text,
	"credit_note_id" text,
	"file_key" varchar(200) NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_documents_one_ck" CHECK (("invoice_documents"."invoice_id" is null) <> ("invoice_documents"."credit_note_id" is null))
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"invoice_id" text NOT NULL,
	"position" smallint NOT NULL,
	"description" varchar(200) NOT NULL,
	"sac_code" varchar(8),
	"quantity" integer NOT NULL,
	"unit_price_minor" integer NOT NULL,
	"discount_minor" integer DEFAULT 0 NOT NULL,
	"treatment" varchar(8) NOT NULL,
	"rate_bps" smallint DEFAULT 0 NOT NULL,
	"taxable_minor" integer NOT NULL,
	"cgst_minor" integer DEFAULT 0 NOT NULL,
	"sgst_minor" integer DEFAULT 0 NOT NULL,
	"igst_minor" integer DEFAULT 0 NOT NULL,
	"total_minor" integer NOT NULL,
	CONSTRAINT "invoice_lines_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "invoice_lines_position_uq" UNIQUE("invoice_id","position"),
	CONSTRAINT "invoice_lines_treatment_ck" CHECK ("invoice_lines"."treatment" in ('taxable', 'exempt', 'nil')),
	CONSTRAINT "invoice_lines_total_ck" CHECK ("invoice_lines"."total_minor" = "invoice_lines"."taxable_minor" + "invoice_lines"."cgst_minor" + "invoice_lines"."sgst_minor" + "invoice_lines"."igst_minor" and "invoice_lines"."quantity" > 0 and "invoice_lines"."unit_price_minor" >= 0 and "invoice_lines"."discount_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "invoice_links" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"invoice_id" text,
	"credit_note_id" text,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_links_one_ck" CHECK (("invoice_links"."invoice_id" is null) <> ("invoice_links"."credit_note_id" is null))
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"financial_year" varchar(7) NOT NULL,
	"series" varchar(4) DEFAULT 'INV' NOT NULL,
	"sequence" integer NOT NULL,
	"number" varchar(24) NOT NULL,
	"patient_id" text NOT NULL,
	"appointment_id" text,
	"location_id" text NOT NULL,
	"source" varchar(12) DEFAULT 'visit' NOT NULL,
	"kind" varchar(14) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"prices_include_tax" boolean NOT NULL,
	"taxable_minor" integer NOT NULL,
	"cgst_minor" integer DEFAULT 0 NOT NULL,
	"sgst_minor" integer DEFAULT 0 NOT NULL,
	"igst_minor" integer DEFAULT 0 NOT NULL,
	"total_minor" integer NOT NULL,
	"supply" varchar(5) NOT NULL,
	"place_of_supply_state" varchar(2),
	"seller_gstin" varchar(15),
	"seller_legal_name" varchar(200) NOT NULL,
	"seller_address" varchar(400),
	"seller_state_code" varchar(2),
	"buyer_name" varchar(200) NOT NULL,
	"buyer_gstin" varchar(15),
	"buyer_state_code" varchar(2),
	"exemption_note" varchar(200),
	"issued_by_user_id" text,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "invoices_source_ck" CHECK ("invoices"."source" in ('visit', 'package', 'membership')),
	CONSTRAINT "invoices_kind_ck" CHECK ("invoices"."kind" in ('tax_invoice', 'bill_of_supply', 'receipt')),
	CONSTRAINT "invoices_supply_ck" CHECK ("invoices"."supply" in ('intra', 'inter', 'none')),
	CONSTRAINT "invoices_split_ck" CHECK (("invoices"."supply" = 'inter' and "invoices"."cgst_minor" = 0 and "invoices"."sgst_minor" = 0) or ("invoices"."supply" <> 'inter' and "invoices"."igst_minor" = 0)),
	CONSTRAINT "invoices_total_ck" CHECK ("invoices"."total_minor" = "invoices"."taxable_minor" + "invoices"."cgst_minor" + "invoices"."sgst_minor" + "invoices"."igst_minor" and "invoices"."taxable_minor" >= 0 and "invoices"."cgst_minor" >= 0 and "invoices"."sgst_minor" >= 0 and "invoices"."igst_minor" >= 0),
	CONSTRAINT "invoices_sequence_ck" CHECK ("invoices"."sequence" > 0)
);
--> statement-breakpoint
CREATE TABLE "service_tax_rules" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"service_id" text NOT NULL,
	"treatment" varchar(8) NOT NULL,
	"rate_bps" smallint DEFAULT 0 NOT NULL,
	"sac_code" varchar(8),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_tax_rules_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "service_tax_rules_service_uq" UNIQUE("tenant_id","service_id"),
	CONSTRAINT "service_tax_rules_treatment_ck" CHECK ("service_tax_rules"."treatment" in ('taxable', 'exempt', 'nil')),
	CONSTRAINT "service_tax_rules_rate_ck" CHECK ("service_tax_rules"."rate_bps" between 0 and 4000)
);
--> statement-breakpoint
CREATE TABLE "tax_settings" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"registered" boolean DEFAULT false NOT NULL,
	"gstin" varchar(15),
	"legal_name" varchar(200),
	"address" varchar(400),
	"state_code" varchar(2),
	"prices_include_tax" boolean DEFAULT true NOT NULL,
	"default_treatment" varchar(8) DEFAULT 'exempt' NOT NULL,
	"default_rate_bps" smallint DEFAULT 0 NOT NULL,
	"default_sac_code" varchar(8),
	"confirmed_at" timestamp with time zone,
	"confirmed_by_user_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_settings_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "tax_settings_tenant_uq" UNIQUE("tenant_id"),
	CONSTRAINT "tax_settings_treatment_ck" CHECK ("tax_settings"."default_treatment" in ('taxable', 'exempt', 'nil')),
	CONSTRAINT "tax_settings_rate_ck" CHECK ("tax_settings"."default_rate_bps" between 0 and 4000),
	CONSTRAINT "tax_settings_registered_ck" CHECK (not "tax_settings"."registered" or ("tax_settings"."gstin" is not null and "tax_settings"."state_code" is not null and "tax_settings"."legal_name" is not null))
);
--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "appointment_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "patient_id" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "location_id" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "invoice_id" text;--> statement-breakpoint
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_note_fk" FOREIGN KEY ("tenant_id","credit_note_id") REFERENCES "public"."credit_notes"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_line_fk" FOREIGN KEY ("tenant_id","invoice_line_id") REFERENCES "public"."invoice_lines"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_counters" ADD CONSTRAINT "invoice_counters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_documents" ADD CONSTRAINT "invoice_documents_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_documents" ADD CONSTRAINT "invoice_documents_note_fk" FOREIGN KEY ("tenant_id","credit_note_id") REFERENCES "public"."credit_notes"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_links" ADD CONSTRAINT "invoice_links_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_links" ADD CONSTRAINT "invoice_links_note_fk" FOREIGN KEY ("tenant_id","credit_note_id") REFERENCES "public"."credit_notes"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patients"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointments"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."locations"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_tax_rules" ADD CONSTRAINT "service_tax_rules_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_settings" ADD CONSTRAINT "tax_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_notes_number_uq" ON "credit_notes" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_notes_sequence_uq" ON "credit_notes" USING btree ("tenant_id","financial_year","series","sequence");--> statement-breakpoint
CREATE INDEX "credit_notes_invoice_idx" ON "credit_notes" USING btree ("tenant_id","invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_documents_invoice_uq" ON "invoice_documents" USING btree ("tenant_id","invoice_id") WHERE "invoice_documents"."invoice_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_documents_note_uq" ON "invoice_documents" USING btree ("tenant_id","credit_note_id") WHERE "invoice_documents"."credit_note_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_links_token_uq" ON "invoice_links" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_number_uq" ON "invoices" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_sequence_uq" ON "invoices" USING btree ("tenant_id","financial_year","series","sequence");--> statement-breakpoint
CREATE INDEX "invoices_patient_idx" ON "invoices" USING btree ("tenant_id","patient_id","issued_at");--> statement-breakpoint
CREATE INDEX "invoices_appointment_idx" ON "invoices" USING btree ("tenant_id","appointment_id");--> statement-breakpoint
CREATE INDEX "invoices_issued_idx" ON "invoices" USING btree ("tenant_id","issued_at");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patients"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."locations"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_target_ck" CHECK ("payments"."appointment_id" is not null or ("payments"."patient_id" is not null and "payments"."location_id" is not null));--> statement-breakpoint
-- Feature 24, the hand-written part: row-level security on every new table (the policy every business table has),
-- the refusal to edit or delete an invoice or credit note, and a commit-time check that an invoice's header is exactly
-- the sum of its lines (and a credit note's, of its lines), so no code path can write totals that do not add up.
ALTER TABLE "tax_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tax_settings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tax_settings" FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "service_tax_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "service_tax_rules" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "service_tax_rules" FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "invoice_counters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invoice_counters" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "invoice_counters" FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invoices" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "invoices" FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "invoice_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invoice_lines" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "invoice_lines" FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "credit_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_notes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "credit_notes" FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "credit_note_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_note_lines" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "credit_note_lines" FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "invoice_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invoice_documents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "invoice_documents" FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "invoice_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invoice_links" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "invoice_links" FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE TRIGGER "invoices_immutable" BEFORE UPDATE OR DELETE ON "invoices" FOR EACH ROW EXECUTE FUNCTION "kalendr_refuse_change"();--> statement-breakpoint
CREATE TRIGGER "invoice_lines_immutable" BEFORE UPDATE OR DELETE ON "invoice_lines" FOR EACH ROW EXECUTE FUNCTION "kalendr_refuse_change"();--> statement-breakpoint
CREATE TRIGGER "credit_notes_immutable" BEFORE UPDATE OR DELETE ON "credit_notes" FOR EACH ROW EXECUTE FUNCTION "kalendr_refuse_change"();--> statement-breakpoint
CREATE TRIGGER "credit_note_lines_immutable" BEFORE UPDATE OR DELETE ON "credit_note_lines" FOR EACH ROW EXECUTE FUNCTION "kalendr_refuse_change"();--> statement-breakpoint
CREATE TRIGGER "invoice_documents_immutable" BEFORE UPDATE OR DELETE ON "invoice_documents" FOR EACH ROW EXECUTE FUNCTION "kalendr_refuse_change"();--> statement-breakpoint
CREATE TRIGGER "invoice_links_immutable" BEFORE UPDATE OR DELETE ON "invoice_links" FOR EACH ROW EXECUTE FUNCTION "kalendr_refuse_change"();--> statement-breakpoint
CREATE FUNCTION "kalendr_check_invoice_sums"() RETURNS trigger LANGUAGE plpgsql AS $kalendr_check_invoice_sums$
DECLARE
  lines_count integer;
  taxable bigint; cgst bigint; sgst bigint; igst bigint; total bigint;
BEGIN
  IF TG_TABLE_NAME = 'invoices' THEN
    SELECT count(*), coalesce(sum(taxable_minor), 0), coalesce(sum(cgst_minor), 0), coalesce(sum(sgst_minor), 0), coalesce(sum(igst_minor), 0), coalesce(sum(total_minor), 0)
      INTO lines_count, taxable, cgst, sgst, igst, total
      FROM invoice_lines WHERE tenant_id = NEW.tenant_id AND invoice_id = NEW.id;
  ELSE
    SELECT count(*), coalesce(sum(taxable_minor), 0), coalesce(sum(cgst_minor), 0), coalesce(sum(sgst_minor), 0), coalesce(sum(igst_minor), 0), coalesce(sum(total_minor), 0)
      INTO lines_count, taxable, cgst, sgst, igst, total
      FROM credit_note_lines WHERE tenant_id = NEW.tenant_id AND credit_note_id = NEW.id;
  END IF;
  IF lines_count = 0 OR taxable <> NEW.taxable_minor OR cgst <> NEW.cgst_minor OR sgst <> NEW.sgst_minor OR igst <> NEW.igst_minor OR total <> NEW.total_minor THEN
    RAISE EXCEPTION 'The lines of % % do not add up to its totals', TG_TABLE_NAME, NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$kalendr_check_invoice_sums$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "invoices_sums_check" AFTER INSERT ON "invoices" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "kalendr_check_invoice_sums"();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "credit_notes_sums_check" AFTER INSERT ON "credit_notes" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "kalendr_check_invoice_sums"();
--> statement-breakpoint
-- The public invoice page has no business to scope to until the token is looked up, so this one function (ids only,
-- like kalendr_resolve_manage_token) finds the business a link belongs to. Only the hash of the token is ever stored.
CREATE FUNCTION "kalendr_resolve_invoice_link"(p_token_hash text)
RETURNS TABLE (tenant_id text, invoice_id text, credit_note_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $kalendr_resolve_invoice_link$
  SELECT link.tenant_id, link.invoice_id, link.credit_note_id
  FROM invoice_links AS link
  WHERE link.token_hash = p_token_hash AND link.expires_at > now()
  LIMIT 1
$kalendr_resolve_invoice_link$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_resolve_invoice_link"(text) FROM PUBLIC;
