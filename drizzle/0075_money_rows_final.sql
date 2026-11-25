-- Payment and refund rows were guarded against UPDATE only. A DELETE would drop money history,
-- so the same guard now covers both. Cleanup that must remove rows disables the trigger by name.
DROP TRIGGER IF EXISTS "payments_final" ON "payments";--> statement-breakpoint
CREATE TRIGGER "payments_final" BEFORE UPDATE OR DELETE ON "payments" FOR EACH ROW EXECUTE FUNCTION "kalendr_money_is_final"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "payment_refunds_final" ON "payment_refunds";--> statement-breakpoint
CREATE TRIGGER "payment_refunds_final" BEFORE UPDATE OR DELETE ON "payment_refunds" FOR EACH ROW EXECUTE FUNCTION "kalendr_money_is_final"();
