-- Live updates: tell open staff screens that something changed for a business.
-- The notice carries only the business id and what kind of thing changed, never personal data.
-- Postgres sends it only when the transaction commits, and merges identical notices in one
-- transaction, so a bulk change (a running-late notice to 40 people) is one notice per kind.
CREATE OR REPLACE FUNCTION "kalendr_notify_live"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  row_tenant text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    row_tenant := OLD.tenant_id;
  ELSE
    row_tenant := NEW.tenant_id;
  END IF;
  PERFORM pg_notify('kalendr_live', json_build_object('t', row_tenant, 'k', TG_ARGV[0])::text);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "appointments_live" AFTER INSERT OR UPDATE OR DELETE ON "appointments"
  FOR EACH ROW EXECUTE FUNCTION "kalendr_notify_live"('appointment');
--> statement-breakpoint
CREATE TRIGGER "queue_tickets_live" AFTER INSERT OR UPDATE OR DELETE ON "queue_tickets"
  FOR EACH ROW EXECUTE FUNCTION "kalendr_notify_live"('queue');
--> statement-breakpoint
CREATE TRIGGER "notifications_live" AFTER INSERT OR UPDATE OR DELETE ON "notifications"
  FOR EACH ROW EXECUTE FUNCTION "kalendr_notify_live"('message');
--> statement-breakpoint
CREATE TRIGGER "handover_notes_live" AFTER INSERT OR UPDATE OR DELETE ON "handover_notes"
  FOR EACH ROW EXECUTE FUNCTION "kalendr_notify_live"('note');
