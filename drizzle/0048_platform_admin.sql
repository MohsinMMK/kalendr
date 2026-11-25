CREATE TABLE "feature_rollouts" (
	"feature_key" varchar(60) PRIMARY KEY NOT NULL,
	"mode" varchar(8) DEFAULT 'off' NOT NULL,
	"percent" smallint DEFAULT 0 NOT NULL,
	"tenant_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feature_rollouts_mode_ck" CHECK ("feature_rollouts"."mode" in ('off', 'listed', 'percent', 'all')),
	CONSTRAINT "feature_rollouts_percent_ck" CHECK ("feature_rollouts"."percent" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "impersonation_sessions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"admin_user_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"reason" varchar(300) NOT NULL,
	"write_access" boolean DEFAULT false NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "impersonation_sessions_window_ck" CHECK ("impersonation_sessions"."ends_at" > "impersonation_sessions"."created_at" and "impersonation_sessions"."ends_at" <= "impersonation_sessions"."created_at" + interval '30 minutes')
);
--> statement-breakpoint
CREATE TABLE "platform_admins" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"user_id" text NOT NULL,
	"role" varchar(12) NOT NULL,
	"added_by" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_admins_role_ck" CHECK ("platform_admins"."role" in ('support', 'billing', 'super'))
);
--> statement-breakpoint
CREATE TABLE "platform_audit_events" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"admin_user_id" text NOT NULL,
	"tenant_id" text,
	"action" varchar(120) NOT NULL,
	"reason" varchar(300),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_admins" ADD CONSTRAINT "platform_admins_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "impersonation_sessions_token_uq" ON "impersonation_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "impersonation_sessions_tenant_idx" ON "impersonation_sessions" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_admins_user_uq" ON "platform_admins" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "platform_audit_events_tenant_idx" ON "platform_audit_events" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "platform_audit_events_time_idx" ON "platform_audit_events" USING btree ("occurred_at");--> statement-breakpoint
-- Platform admin console (feature 15). Operators cross businesses only through the named admin_* functions below.
-- The runtime role is never BYPASSRLS. Each function runs as the migration owner and starts by checking the caller's
-- platform role, so a staff session that somehow reached one still gets nothing.
ALTER TABLE "platform_admins" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "platform_admins" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "platform_audit_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "platform_audit_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "impersonation_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "impersonation_sessions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- A business may read its own support sessions (for its Activity log) and nothing else about them.
CREATE POLICY "tenant_reads_own_support_sessions" ON "impersonation_sessions"
  FOR SELECT
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "feature_rollouts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "feature_rollouts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "rollouts_readable" ON "feature_rollouts" FOR SELECT USING (true);--> statement-breakpoint
CREATE FUNCTION "kalendr_refuse_change"() RETURNS trigger LANGUAGE plpgsql AS $kalendr_refuse_change$
BEGIN
  RAISE EXCEPTION '% rows are never edited or deleted', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END
$kalendr_refuse_change$;--> statement-breakpoint
CREATE TRIGGER "platform_audit_events_append_only" BEFORE UPDATE OR DELETE ON "platform_audit_events"
  FOR EACH ROW EXECUTE FUNCTION "kalendr_refuse_change"();--> statement-breakpoint
-- The caller's platform role, or null when they are not an active operator.
CREATE FUNCTION "kalendr_admin_role"("p_user_id" text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $kalendr_admin_role$
  SELECT admin.role FROM public.platform_admins AS admin WHERE admin.user_id = p_user_id AND admin.is_active
$kalendr_admin_role$;--> statement-breakpoint
-- Raises unless the caller holds one of the roles. Used at the top of every admin_* function.
CREATE FUNCTION "kalendr_admin_require"("p_user_id" text, "p_roles" text[]) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $kalendr_admin_require$
DECLARE found_role text;
BEGIN
  found_role := public.kalendr_admin_role(p_user_id);
  IF found_role IS NULL OR NOT (found_role = ANY (p_roles)) THEN
    RAISE EXCEPTION 'platform role required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN found_role;
END
$kalendr_admin_require$;--> statement-breakpoint
CREATE FUNCTION "kalendr_admin_audit"("p_user_id" text, "p_tenant_id" text, "p_action" text, "p_reason" text, "p_metadata" jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $kalendr_admin_audit$
  INSERT INTO public.platform_audit_events (admin_user_id, tenant_id, action, reason, metadata)
  VALUES (p_user_id, p_tenant_id, left(p_action, 120), left(p_reason, 300), coalesce(p_metadata, '{}'::jsonb))
$kalendr_admin_audit$;--> statement-breakpoint
-- Who the operators are. Ids and roles only.
CREATE FUNCTION "admin_whoami"("p_admin" text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $admin_whoami$ SELECT public.kalendr_admin_role(p_admin) $admin_whoami$;--> statement-breakpoint
-- Businesses: counts and statuses only, never a customer.
CREATE FUNCTION "admin_list_tenants"("p_admin" text, "p_search" text, "p_status" text, "p_limit" integer, "p_offset" integer)
RETURNS TABLE (
  "tenant_id" text, "slug" text, "name" text, "business_type" text, "created_at" timestamptz, "last_active_at" timestamptz,
  "is_active" boolean, "paused_at" timestamptz, "staff_count" integer, "setup_stage" text, "total" bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $admin_list_tenants$
BEGIN
  PERFORM public.kalendr_admin_require(p_admin, ARRAY['support', 'billing', 'super']);
  RETURN QUERY
  SELECT
    tenant.id, tenant.slug::text, tenant.name::text, tenant.business_type::text, tenant.created_at,
    (SELECT max(event.occurred_at) FROM public.audit_events AS event WHERE event.tenant_id = tenant.id AND event.actor_type = 'staff'),
    tenant.is_active, tenant.paused_at,
    (SELECT count(*)::integer FROM public.memberships AS member WHERE member.tenant_id = tenant.id AND member.is_active),
    CASE
      WHEN EXISTS (SELECT 1 FROM public.appointments AS appointment WHERE appointment.tenant_id = tenant.id) THEN 'first_booking'
      WHEN EXISTS (SELECT 1 FROM public.services AS service WHERE service.tenant_id = tenant.id) THEN 'services_added'
      ELSE 'signed_up'
    END,
    count(*) OVER ()
  FROM public.tenants AS tenant
  WHERE (coalesce(p_search, '') = '' OR tenant.name ILIKE '%' || replace(replace(p_search, '%', ''), '_', '') || '%' OR tenant.slug ILIKE '%' || replace(replace(p_search, '%', ''), '_', '') || '%' OR tenant.id = p_search)
    AND CASE coalesce(p_status, 'all')
      WHEN 'paused' THEN tenant.paused_at IS NOT NULL
      WHEN 'active' THEN tenant.paused_at IS NULL AND tenant.is_active
      ELSE true END
  ORDER BY tenant.created_at DESC
  LIMIT greatest(1, least(coalesce(p_limit, 25), 100)) OFFSET greatest(coalesce(p_offset, 0), 0);
END
$admin_list_tenants$;--> statement-breakpoint
CREATE FUNCTION "admin_signups_by_day"("p_admin" text, "p_days" integer)
RETURNS TABLE ("day" date, "signups" integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $admin_signups_by_day$
BEGIN
  PERFORM public.kalendr_admin_require(p_admin, ARRAY['support', 'billing', 'super']);
  RETURN QUERY
  SELECT series.day::date, (SELECT count(*)::integer FROM public.tenants AS tenant WHERE tenant.created_at::date = series.day::date)
  FROM generate_series((current_date - (greatest(1, least(coalesce(p_days, 30), 180)) - 1))::timestamp, current_date::timestamp, interval '1 day') AS series(day)
  ORDER BY series.day;
END
$admin_signups_by_day$;--> statement-breakpoint
-- One business's health: numbers and codes. No names, no destinations, no message text.
CREATE FUNCTION "admin_tenant_health"("p_admin" text, "p_tenant" text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $admin_tenant_health$
DECLARE result jsonb;
BEGIN
  PERFORM public.kalendr_admin_require(p_admin, ARRAY['support', 'billing', 'super']);
  SELECT jsonb_build_object(
    'tenantId', tenant.id, 'slug', tenant.slug, 'name', tenant.name, 'businessType', tenant.business_type,
    'createdAt', tenant.created_at, 'isActive', tenant.is_active, 'pausedAt', tenant.paused_at,
    'features', tenant.features,
    'staffCount', (SELECT count(*) FROM public.memberships AS member WHERE member.tenant_id = tenant.id AND member.is_active),
    'appointments30d', (SELECT count(*) FROM public.appointments AS appointment WHERE appointment.tenant_id = tenant.id AND appointment.created_at > now() - interval '30 days'),
    'messages7d', coalesce((
      SELECT jsonb_object_agg(grouped.key, grouped.total) FROM (
        SELECT notification.channel::text || ':' || notification.status::text AS key, count(*) AS total
        FROM public.notifications AS notification
        WHERE notification.tenant_id = tenant.id AND notification.created_at > now() - interval '7 days'
        GROUP BY 1) AS grouped), '{}'::jsonb),
    'recentErrors', coalesce((
      SELECT jsonb_agg(jsonb_build_object('code', grouped.code, 'count', grouped.total) ORDER BY grouped.total DESC) FROM (
        SELECT notification.failure_code AS code, count(*) AS total
        FROM public.notifications AS notification
        WHERE notification.tenant_id = tenant.id AND notification.failure_code IS NOT NULL AND notification.created_at > now() - interval '7 days'
        GROUP BY 1 ORDER BY 2 DESC LIMIT 8) AS grouped), '[]'::jsonb),
    'deadLetters', (SELECT count(*) FROM public.outbox_events AS event WHERE event.tenant_id = tenant.id AND event.status = 'dead_letter'),
    'lastStaffActivityAt', (SELECT max(event.occurred_at) FROM public.audit_events AS event WHERE event.tenant_id = tenant.id AND event.actor_type = 'staff')
  ) INTO result
  FROM public.tenants AS tenant WHERE tenant.id = p_tenant;
  IF result IS NULL THEN RAISE EXCEPTION 'business not found' USING ERRCODE = 'no_data_found'; END IF;
  PERFORM public.kalendr_admin_audit(p_admin, p_tenant, 'admin.tenant.viewed', NULL, '{}'::jsonb);
  RETURN result;
END
$admin_tenant_health$;--> statement-breakpoint
-- Find one message by its id or its appointment's id: every field that explains a delivery, none that identifies a person.
CREATE FUNCTION "admin_find_notification"("p_admin" text, "p_id" text)
RETURNS TABLE (
  "notification_id" text, "tenant_id" text, "appointment_id" text, "channel" text, "template_key" text, "status" text,
  "attempt_count" integer, "scheduled_at" timestamptz, "sent_at" timestamptz, "delivered_at" timestamptz, "failed_at" timestamptz,
  "failure_code" text, "cost_category" text, "has_provider_id" boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $admin_find_notification$
BEGIN
  PERFORM public.kalendr_admin_require(p_admin, ARRAY['support', 'super']);
  IF length(coalesce(p_id, '')) NOT BETWEEN 8 AND 80 THEN RETURN; END IF;
  PERFORM public.kalendr_admin_audit(p_admin, NULL, 'admin.message.searched', NULL, '{}'::jsonb);
  RETURN QUERY
  SELECT notification.id, notification.tenant_id, notification.appointment_id, notification.channel::text, notification.template_key::text,
    notification.status::text, notification.attempt_count::integer, notification.scheduled_at, notification.sent_at, notification.delivered_at,
    notification.failed_at, notification.failure_code::text, notification.cost_category::text, notification.provider_message_id IS NOT NULL
  FROM public.notifications AS notification
  WHERE notification.id = p_id OR notification.appointment_id = p_id
  ORDER BY notification.scheduled_at DESC
  LIMIT 50;
END
$admin_find_notification$;--> statement-breakpoint
-- The outbox events behind a message (attempts and the code of the last error), by appointment or notification id.
CREATE FUNCTION "admin_find_outbox"("p_admin" text, "p_tenant" text, "p_aggregate_id" text)
RETURNS TABLE ("event_id" text, "event_type" text, "status" text, "attempt_count" integer, "last_error_code" text, "available_at" timestamptz, "created_at" timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $admin_find_outbox$
BEGIN
  PERFORM public.kalendr_admin_require(p_admin, ARRAY['support', 'super']);
  RETURN QUERY
  SELECT event.id, event.event_type::text, event.status::text, event.attempt_count::integer, event.last_error_code::text, event.available_at, event.created_at
  FROM public.outbox_events AS event
  WHERE event.tenant_id = p_tenant AND event.aggregate_id = p_aggregate_id
  ORDER BY event.created_at DESC LIMIT 50;
END
$admin_find_outbox$;--> statement-breakpoint
CREATE FUNCTION "admin_worker_health"("p_admin" text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $admin_worker_health$
BEGIN
  PERFORM public.kalendr_admin_require(p_admin, ARRAY['support', 'billing', 'super']);
  RETURN jsonb_build_object(
    'pending', (SELECT count(*) FROM public.outbox_events WHERE status IN ('pending', 'failed', 'processing')),
    'oldestPendingSeconds', coalesce((SELECT extract(epoch FROM now() - min(available_at))::integer FROM public.outbox_events WHERE status IN ('pending', 'failed') AND available_at <= now()), 0),
    'deadLetters', (SELECT count(*) FROM public.outbox_events WHERE status = 'dead_letter'),
    'heartbeats', coalesce((SELECT jsonb_agg(jsonb_build_object('workerId', heartbeat.worker_id, 'mode', heartbeat.mode, 'version', heartbeat.version, 'lastSeenAt', heartbeat.last_seen_at, 'stoppedAt', heartbeat.stopped_at) ORDER BY heartbeat.last_seen_at DESC)
      FROM (SELECT * FROM public.worker_heartbeats ORDER BY last_seen_at DESC LIMIT 20) AS heartbeat), '[]'::jsonb),
    'deadLetterItems', coalesce((SELECT jsonb_agg(jsonb_build_object('eventId', item.id, 'tenantId', item.tenant_id, 'eventType', item.event_type, 'attempts', item.attempt_count, 'lastErrorCode', item.last_error_code, 'createdAt', item.created_at) ORDER BY item.created_at DESC)
      FROM (SELECT * FROM public.outbox_events WHERE status = 'dead_letter' ORDER BY created_at DESC LIMIT 50) AS item), '[]'::jsonb)
  );
END
$admin_worker_health$;--> statement-breakpoint
CREATE FUNCTION "admin_retry_dead_letter"("p_admin" text, "p_event_id" text, "p_reason" text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $admin_retry_dead_letter$
DECLARE target_tenant text;
BEGIN
  PERFORM public.kalendr_admin_require(p_admin, ARRAY['support', 'super']);
  IF length(trim(coalesce(p_reason, ''))) < 5 THEN RAISE EXCEPTION 'a reason is required' USING ERRCODE = 'check_violation'; END IF;
  UPDATE public.outbox_events SET status = 'pending', attempt_count = 0, available_at = now(), locked_at = NULL, locked_by = NULL, updated_at = now()
  WHERE id = p_event_id AND status = 'dead_letter' RETURNING tenant_id INTO target_tenant;
  IF target_tenant IS NULL THEN RETURN false; END IF;
  PERFORM public.kalendr_admin_audit(p_admin, target_tenant, 'admin.worker.retry', p_reason, jsonb_build_object('eventId', p_event_id));
  RETURN true;
END
$admin_retry_dead_letter$;--> statement-breakpoint
-- Unusual volume and suppression counts per business. Counts only.
CREATE FUNCTION "admin_abuse_overview"("p_admin" text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $admin_abuse_overview$
BEGIN
  PERFORM public.kalendr_admin_require(p_admin, ARRAY['support', 'billing', 'super']);
  RETURN jsonb_build_object(
    'highVolume', coalesce((SELECT jsonb_agg(jsonb_build_object('tenantId', row.tenant_id, 'name', row.name, 'messages24h', row.sent) ORDER BY row.sent DESC)
      FROM (SELECT notification.tenant_id, tenant.name, count(*) AS sent
            FROM public.notifications AS notification JOIN public.tenants AS tenant ON tenant.id = notification.tenant_id
            WHERE notification.created_at > now() - interval '24 hours'
            GROUP BY notification.tenant_id, tenant.name HAVING count(*) >= 200 ORDER BY 3 DESC LIMIT 20) AS row), '[]'::jsonb),
    'suppressions', coalesce((SELECT jsonb_agg(jsonb_build_object('tenantId', row.tenant_id, 'name', row.name, 'count', row.total) ORDER BY row.total DESC)
      FROM (SELECT suppression.tenant_id, tenant.name, count(*) AS total
            FROM public.message_suppressions AS suppression JOIN public.tenants AS tenant ON tenant.id = suppression.tenant_id
            GROUP BY suppression.tenant_id, tenant.name ORDER BY 3 DESC LIMIT 20) AS row), '[]'::jsonb),
    'newBusinesses24h', (SELECT count(*) FROM public.tenants WHERE created_at > now() - interval '24 hours')
  );
END
$admin_abuse_overview$;--> statement-breakpoint
-- Feature rollout. Whether a feature is on for a business: the rollout layer (this function) and then the business's own switch.
CREATE FUNCTION "kalendr_rollout_enabled"("p_feature" text, "p_tenant" text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $kalendr_rollout_enabled$
  SELECT coalesce((
    SELECT CASE rollout.mode
      WHEN 'all' THEN true
      WHEN 'listed' THEN p_tenant = ANY (rollout.tenant_ids)
      WHEN 'percent' THEN (('x' || substr(md5(p_feature || ':' || p_tenant), 1, 8))::bit(32)::bigint % 100) < rollout.percent
      ELSE false END
    FROM public.feature_rollouts AS rollout WHERE rollout.feature_key = p_feature), false)
$kalendr_rollout_enabled$;--> statement-breakpoint
CREATE FUNCTION "admin_set_feature_rollout"("p_admin" text, "p_feature" text, "p_mode" text, "p_percent" integer, "p_tenant_ids" text[], "p_reason" text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $admin_set_feature_rollout$
BEGIN
  PERFORM public.kalendr_admin_require(p_admin, ARRAY['super']);
  IF length(trim(coalesce(p_reason, ''))) < 5 THEN RAISE EXCEPTION 'a reason is required' USING ERRCODE = 'check_violation'; END IF;
  INSERT INTO public.feature_rollouts (feature_key, mode, percent, tenant_ids, updated_at)
  VALUES (p_feature, p_mode, coalesce(p_percent, 0), coalesce(p_tenant_ids, '{}'), now())
  ON CONFLICT (feature_key) DO UPDATE SET mode = excluded.mode, percent = excluded.percent, tenant_ids = excluded.tenant_ids, updated_at = now();
  PERFORM public.kalendr_admin_audit(p_admin, NULL, 'admin.rollout.set', p_reason, jsonb_build_object('feature', p_feature, 'mode', p_mode, 'percent', coalesce(p_percent, 0), 'listed', cardinality(coalesce(p_tenant_ids, '{}'))));
END
$admin_set_feature_rollout$;--> statement-breakpoint
-- Pause or resume a business's public pages.
CREATE FUNCTION "admin_set_tenant_paused"("p_admin" text, "p_tenant" text, "p_paused" boolean, "p_reason" text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $admin_set_tenant_paused$
BEGIN
  PERFORM public.kalendr_admin_require(p_admin, ARRAY['support', 'super']);
  IF length(trim(coalesce(p_reason, ''))) < 5 THEN RAISE EXCEPTION 'a reason is required' USING ERRCODE = 'check_violation'; END IF;
  UPDATE public.tenants SET paused_at = CASE WHEN p_paused THEN coalesce(paused_at, now()) ELSE NULL END, updated_at = now() WHERE id = p_tenant;
  IF NOT FOUND THEN RAISE EXCEPTION 'business not found' USING ERRCODE = 'no_data_found'; END IF;
  INSERT INTO public.audit_events (tenant_id, actor_type, action, outcome, metadata)
  VALUES (p_tenant, 'platform_support', CASE WHEN p_paused THEN 'support.business.paused' ELSE 'support.business.resumed' END, 'success', '{}'::jsonb);
  PERFORM public.kalendr_admin_audit(p_admin, p_tenant, CASE WHEN p_paused THEN 'admin.tenant.paused' ELSE 'admin.tenant.resumed' END, p_reason, '{}'::jsonb);
END
$admin_set_tenant_paused$;--> statement-breakpoint
-- Impersonation. The token is made by the app and arrives hashed; the session lasts 30 minutes and cannot be extended.
CREATE FUNCTION "admin_start_impersonation"("p_admin" text, "p_tenant" text, "p_reason" text, "p_write" boolean, "p_token_hash" text)
RETURNS TABLE ("session_id" text, "ends_at" timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $admin_start_impersonation$
DECLARE found_role text; new_id text; new_end timestamptz;
BEGIN
  found_role := public.kalendr_admin_require(p_admin, ARRAY['support', 'super']);
  IF length(trim(coalesce(p_reason, ''))) < 10 THEN RAISE EXCEPTION 'a reason of at least 10 characters is required' USING ERRCODE = 'check_violation'; END IF;
  IF coalesce(p_write, false) AND found_role <> 'super' THEN RAISE EXCEPTION 'write access needs the super role' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = p_tenant) THEN RAISE EXCEPTION 'business not found' USING ERRCODE = 'no_data_found'; END IF;
  UPDATE public.impersonation_sessions AS previous SET ended_at = now() WHERE previous.admin_user_id = p_admin AND previous.ended_at IS NULL AND previous.ends_at > now();
  new_end := now() + interval '30 minutes';
  INSERT INTO public.impersonation_sessions (admin_user_id, tenant_id, reason, write_access, token_hash, ends_at)
  VALUES (p_admin, p_tenant, left(trim(p_reason), 300), coalesce(p_write, false), p_token_hash, new_end) RETURNING id INTO new_id;
  INSERT INTO public.audit_events (tenant_id, actor_type, action, outcome, metadata)
  VALUES (p_tenant, 'platform_support', 'support.session.started', 'success', jsonb_build_object('sessionId', new_id, 'write', coalesce(p_write, false)));
  PERFORM public.kalendr_admin_audit(p_admin, p_tenant, 'admin.impersonation.started', p_reason, jsonb_build_object('sessionId', new_id, 'write', coalesce(p_write, false)));
  RETURN QUERY SELECT new_id, new_end;
END
$admin_start_impersonation$;--> statement-breakpoint
CREATE FUNCTION "admin_resolve_impersonation"("p_admin" text, "p_token_hash" text)
RETURNS TABLE ("session_id" text, "tenant_id" text, "write_access" boolean, "ends_at" timestamptz, "reason" text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $admin_resolve_impersonation$
BEGIN
  IF public.kalendr_admin_role(p_admin) IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT session.id, session.tenant_id, session.write_access, session.ends_at, session.reason::text
  FROM public.impersonation_sessions AS session
  WHERE session.token_hash = p_token_hash AND session.admin_user_id = p_admin AND session.ended_at IS NULL AND session.ends_at > now();
END
$admin_resolve_impersonation$;--> statement-breakpoint
CREATE FUNCTION "admin_end_impersonation"("p_admin" text, "p_session_id" text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $admin_end_impersonation$
DECLARE target_tenant text;
BEGIN
  IF public.kalendr_admin_role(p_admin) IS NULL THEN RAISE EXCEPTION 'platform role required' USING ERRCODE = 'insufficient_privilege'; END IF;
  UPDATE public.impersonation_sessions SET ended_at = now() WHERE id = p_session_id AND admin_user_id = p_admin AND ended_at IS NULL RETURNING tenant_id INTO target_tenant;
  IF target_tenant IS NULL THEN RETURN false; END IF;
  INSERT INTO public.audit_events (tenant_id, actor_type, action, outcome, metadata)
  VALUES (target_tenant, 'platform_support', 'support.session.ended', 'success', jsonb_build_object('sessionId', p_session_id));
  PERFORM public.kalendr_admin_audit(p_admin, target_tenant, 'admin.impersonation.ended', NULL, jsonb_build_object('sessionId', p_session_id));
  RETURN true;
END
$admin_end_impersonation$;--> statement-breakpoint
-- Every page viewed while impersonating: the path only, with no query string.
CREATE FUNCTION "admin_record_impersonation_view"("p_admin" text, "p_session_id" text, "p_path" text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $admin_record_impersonation_view$
DECLARE target_tenant text;
BEGIN
  SELECT session.tenant_id INTO target_tenant FROM public.impersonation_sessions AS session
  WHERE session.id = p_session_id AND session.admin_user_id = p_admin AND session.ended_at IS NULL AND session.ends_at > now();
  IF target_tenant IS NULL THEN RETURN; END IF;
  PERFORM public.kalendr_admin_audit(p_admin, target_tenant, 'admin.impersonation.view', NULL, jsonb_build_object('sessionId', p_session_id, 'path', left(split_part(p_path, '?', 1), 200)));
END
$admin_record_impersonation_view$;--> statement-breakpoint
-- A generic record of an operator action done in app code (for example "resend a verification email").
CREATE FUNCTION "admin_record_action"("p_admin" text, "p_tenant" text, "p_action" text, "p_reason" text, "p_metadata" jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $admin_record_action$
BEGIN
  PERFORM public.kalendr_admin_require(p_admin, ARRAY['support', 'billing', 'super']);
  PERFORM public.kalendr_admin_audit(p_admin, p_tenant, p_action, p_reason, p_metadata);
END
$admin_record_action$;--> statement-breakpoint
-- The business's owner user, for "resend verification". Ids and a verified flag; the worker reads the address itself.
CREATE FUNCTION "admin_tenant_owner"("p_admin" text, "p_tenant" text) RETURNS TABLE ("user_id" text, "email_verified" boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $admin_tenant_owner$
BEGIN
  PERFORM public.kalendr_admin_require(p_admin, ARRAY['support', 'super']);
  RETURN QUERY
  SELECT member.user_id, account.email_verified FROM public.memberships AS member JOIN public.auth_users AS account ON account.id = member.user_id
  WHERE member.tenant_id = p_tenant AND member.role = 'owner' ORDER BY member.created_at LIMIT 1;
END
$admin_tenant_owner$;--> statement-breakpoint
CREATE FUNCTION "admin_list_platform_admins"("p_admin" text) RETURNS TABLE ("user_id" text, "role" text, "is_active" boolean, "created_at" timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $admin_list_platform_admins$
BEGIN
  PERFORM public.kalendr_admin_require(p_admin, ARRAY['super']);
  RETURN QUERY SELECT admin.user_id, admin.role::text, admin.is_active, admin.created_at FROM public.platform_admins AS admin ORDER BY admin.created_at;
END
$admin_list_platform_admins$;--> statement-breakpoint
-- Adding an operator is a super-only act, by the address of an existing user. The first operator is made from the command line.
CREATE FUNCTION "admin_set_platform_admin"("p_admin" text, "p_email" text, "p_role" text, "p_active" boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $admin_set_platform_admin$
DECLARE target_user text;
BEGIN
  PERFORM public.kalendr_admin_require(p_admin, ARRAY['super']);
  SELECT account.id INTO target_user FROM public.auth_users AS account WHERE lower(account.email) = lower(p_email);
  IF target_user IS NULL THEN RETURN false; END IF;
  IF target_user = p_admin AND NOT coalesce(p_active, true) THEN RAISE EXCEPTION 'you cannot remove yourself' USING ERRCODE = 'check_violation'; END IF;
  INSERT INTO public.platform_admins (user_id, role, added_by, is_active) VALUES (target_user, p_role, p_admin, coalesce(p_active, true))
  ON CONFLICT (user_id) DO UPDATE SET role = excluded.role, is_active = excluded.is_active;
  PERFORM public.kalendr_admin_audit(p_admin, NULL, 'admin.operator.set', NULL, jsonb_build_object('operatorId', target_user, 'role', p_role, 'active', coalesce(p_active, true)));
  RETURN true;
END
$admin_set_platform_admin$;--> statement-breakpoint
-- The audit trail, newest first. For the console and its tests.
CREATE FUNCTION "admin_list_audit"("p_admin" text, "p_tenant" text, "p_limit" integer)
RETURNS TABLE ("id" text, "admin_user_id" text, "tenant_id" text, "action" text, "reason" text, "metadata" jsonb, "occurred_at" timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $admin_list_audit$
BEGIN
  PERFORM public.kalendr_admin_require(p_admin, ARRAY['support', 'billing', 'super']);
  RETURN QUERY
  SELECT event.id, event.admin_user_id, event.tenant_id, event.action::text, event.reason::text, event.metadata, event.occurred_at
  FROM public.platform_audit_events AS event WHERE p_tenant IS NULL OR event.tenant_id = p_tenant
  ORDER BY event.occurred_at DESC LIMIT greatest(1, least(coalesce(p_limit, 50), 200));
END
$admin_list_audit$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_admin_role"(text), "kalendr_admin_require"(text, text[]), "kalendr_admin_audit"(text, text, text, text, jsonb) FROM PUBLIC;
