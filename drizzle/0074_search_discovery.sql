-- Search and discovery (feature 29).
--   1. Listing controls: a business is not found by search engines or the /explore directory until the owner switches `listed` on.
--   2. Staff search: indexes and one narrow function, so the command palette finds customers, appointments, services, team
--      members, invoices and campaigns fast, inside the signed-in business only.
--   3. Public discovery: slugs-only reads for the sitemap and the directory.
ALTER TABLE "tenants" ADD COLUMN "listed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "seo" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "pg_trgm";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "btree_gin";--> statement-breakpoint
-- Every index starts with tenant_id (btree_gin), so a search only walks the signed-in business's entries however many
-- businesses share the table. Text is matched with trigrams (typing "ilike %x%" and typos) and with prefix full text.
CREATE INDEX "services_search_fts_idx" ON "services" USING gin ("tenant_id", (to_tsvector('simple', coalesce("name", '') || ' ' || coalesce("category", '') || ' ' || coalesce("description", ''))));--> statement-breakpoint
CREATE INDEX "services_name_trgm_idx" ON "services" USING gin ("tenant_id", ("name") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "practitioners_search_fts_idx" ON "practitioners" USING gin ("tenant_id", (to_tsvector('simple', coalesce("name", '') || ' ' || coalesce("title", '') || ' ' || coalesce("specialty", ''))));--> statement-breakpoint
CREATE INDEX "practitioners_name_trgm_idx" ON "practitioners" USING gin ("tenant_id", ("name") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "appointments_reason_fts_idx" ON "appointments" USING gin ("tenant_id", (to_tsvector('simple', coalesce("reason_for_visit", '')))) WHERE "reason_for_visit" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "invoices_number_trgm_idx" ON "invoices" USING gin ("tenant_id", ("number") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "invoices_buyer_trgm_idx" ON "invoices" USING gin ("tenant_id", ("buyer_name") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "campaigns_name_trgm_idx" ON "campaigns" USING gin ("tenant_id", ("name") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "routing_forms_name_trgm_idx" ON "routing_forms" USING gin ("tenant_id", ("name") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "tenants_listed_idx" ON "tenants" ("slug") WHERE "listed";--> statement-breakpoint
CREATE INDEX "tenants_directory_fts_idx" ON "tenants" USING gin ((to_tsvector('simple', coalesce("name", '') || ' ' || coalesce("about", '')))) WHERE "listed";--> statement-breakpoint
CREATE INDEX "tenants_directory_name_trgm_idx" ON "tenants" USING gin (("name") gin_trgm_ops) WHERE "listed";--> statement-breakpoint
CREATE INDEX "locations_city_trgm_idx" ON "locations" USING gin ("city" gin_trgm_ops);--> statement-breakpoint

-- What someone typed, as a LIKE pattern: the characters LIKE treats as special are escaped.
CREATE FUNCTION "kalendr_search_like"("p_query" text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $kalendr_search_like$
  select '%' || replace(replace(replace("p_query", '\', '\\'), '%', '\%'), '_', '\_') || '%'
$kalendr_search_like$;--> statement-breakpoint
-- What someone typed, as a prefix full-text query ("derm clin" finds "Dermatology clinic"). Only letters and digits
-- survive, so the text can never be read as query syntax. Null when nothing is left.
CREATE FUNCTION "kalendr_search_tsquery"("p_query" text) RETURNS tsquery
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $kalendr_search_tsquery$
  select to_tsquery('simple', string_agg(word || ':*', ' & '))
  from regexp_split_to_table(lower(regexp_replace("p_query", '[^[:alnum:]]+', ' ', 'g')), ' ') as word
  where word <> ''
$kalendr_search_tsquery$;--> statement-breakpoint

-- Staff search. SECURITY DEFINER on purpose: under forced row-level security the planner refuses to use a GIN index for
-- ILIKE, % or @@ (those operators are not leakproof), so the signed-in role would scan every row of the business. This
-- function runs as the table owner, where the indexes work, and fences itself: the business comes from the
-- `app.tenant_id` setting that withTenant made, never from a parameter, and nothing is returned without it.
--   p_kinds        the kinds this person's role may open (customer, appointment, service, person, invoice, campaign);
--                  the server decides from permissions, a kind not listed is never read
--   p_practitioner set for a team member who may only see their own customers and appointments
CREATE FUNCTION "kalendr_staff_search"("p_kinds" text[], "p_query" text, "p_practitioner" text, "p_limit" integer)
  RETURNS TABLE ("kind" text, "id" text, "title" text, "subtitle" text, "at" timestamptz, "ref" text, "rank" real)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  SET pg_trgm.word_similarity_threshold = '0.45' AS $kalendr_staff_search$
declare
  v_tenant text := nullif(current_setting('app.tenant_id', true), '');
  v_q text := left(btrim(regexp_replace(coalesce("p_query", ''), '\s+', ' ', 'g')), 80);
  v_like text;
  v_digits text;
  v_ts tsquery;
  v_limit integer := least(greatest(coalesce("p_limit", 5), 1), 20);
begin
  if v_tenant is null or "p_kinds" is null or char_length(v_q) < 2 then
    return;
  end if;
  v_like := kalendr_search_like(v_q);
  v_digits := regexp_replace(v_q, '\D', '', 'g');
  v_ts := kalendr_search_tsquery(v_q);

  if 'customer' = any ("p_kinds") then
    return query
      select 'customer'::text, pt.id::text, (pt.first_name || ' ' || pt.last_name)::text, pt.phone::text, null::timestamptz, null::text,
        greatest(word_similarity(v_q, pt.first_name || ' ' || pt.last_name), case when pt.email ilike v_like escape '\' then 0.6 else 0 end)::real as rank
      from patients as pt
      where pt.tenant_id = v_tenant and pt.merged_into_id is null and pt.erased_at is null
        and ("p_practitioner" is null or exists (select 1 from appointments as own where own.tenant_id = v_tenant and own.patient_id = pt.id and own.practitioner_id = "p_practitioner"))
        and ((pt.first_name || ' ' || pt.last_name) ilike v_like escape '\'
          or v_q <% (pt.first_name || ' ' || pt.last_name)
          or pt.email ilike v_like escape '\'
          or (char_length(v_digits) >= 3 and regexp_replace(pt.phone, '\D', '', 'g') like '%' || v_digits || '%'))
      order by 7 desc, pt.last_name, pt.first_name, pt.id
      limit v_limit;
  end if;

  if 'appointment' = any ("p_kinds") then
    return query
      with matched_customers as (
        select pt.id from patients as pt
        where pt.tenant_id = v_tenant and pt.merged_into_id is null and pt.erased_at is null
          and ((pt.first_name || ' ' || pt.last_name) ilike v_like escape '\' or v_q <% (pt.first_name || ' ' || pt.last_name))
        limit 100
      ), candidates as (
        select a.id from appointments as a
        where a.tenant_id = v_tenant and a.patient_id in (select m.id from matched_customers as m)
          and ("p_practitioner" is null or a.practitioner_id = "p_practitioner")
        union
        select a.id from appointments as a
        where a.tenant_id = v_tenant and v_ts is not null and a.reason_for_visit is not null
          and to_tsvector('simple', coalesce(a.reason_for_visit, '')) @@ v_ts
          and ("p_practitioner" is null or a.practitioner_id = "p_practitioner")
        union
        select a.id from appointments as a where a.tenant_id = v_tenant and a.id = v_q
          and ("p_practitioner" is null or a.practitioner_id = "p_practitioner")
      )
      select 'appointment'::text, a.id::text, (pt.first_name || ' ' || pt.last_name)::text, sv.name::text, a.starts_at, a.patient_id::text, 0.5::real
      from candidates as c
      join appointments as a on a.tenant_id = v_tenant and a.id = c.id
      join patients as pt on pt.tenant_id = v_tenant and pt.id = a.patient_id
      join services as sv on sv.tenant_id = v_tenant and sv.id = a.service_id
      order by a.starts_at desc, a.id
      limit v_limit;
  end if;

  if 'service' = any ("p_kinds") then
    return query
      select 'service'::text, s.id::text, s.name::text, coalesce(s.category, '')::text, null::timestamptz, null::text,
        word_similarity(v_q, s.name)::real
      from services as s
      where s.tenant_id = v_tenant
        and (s.name ilike v_like escape '\'
          or (v_ts is not null and to_tsvector('simple', coalesce(s.name, '') || ' ' || coalesce(s.category, '') || ' ' || coalesce(s.description, '')) @@ v_ts))
      order by s.is_active desc, 7 desc, s.name, s.id
      limit v_limit;
  end if;

  if 'person' = any ("p_kinds") then
    return query
      select 'person'::text, p.id::text, p.name::text, concat_ws(', ', nullif(p.title, ''), nullif(p.specialty, ''))::text, null::timestamptz, null::text,
        word_similarity(v_q, p.name)::real
      from practitioners as p
      where p.tenant_id = v_tenant
        and (p.name ilike v_like escape '\'
          or (v_ts is not null and to_tsvector('simple', coalesce(p.name, '') || ' ' || coalesce(p.title, '') || ' ' || coalesce(p.specialty, '')) @@ v_ts))
      order by p.is_active desc, 7 desc, p.name, p.id
      limit v_limit;
  end if;

  if 'invoice' = any ("p_kinds") then
    return query
      select 'invoice'::text, i.id::text, i.number::text, i.buyer_name::text, i.issued_at, i.patient_id::text, similarity(v_q, i.number)::real
      from invoices as i
      where i.tenant_id = v_tenant and (i.number ilike v_like escape '\' or i.buyer_name ilike v_like escape '\')
      order by i.issued_at desc, i.id
      limit v_limit;
  end if;

  if 'routing_form' = any ("p_kinds") then
    return query
      select 'routing_form'::text, f.id::text, f.name::text, f.status::text, null::timestamptz, null::text, word_similarity(v_q, f.name)::real
      from routing_forms as f
      where f.tenant_id = v_tenant and f.name ilike v_like escape '\'
      order by 7 desc, f.name, f.id
      limit v_limit;
  end if;

  if 'campaign' = any ("p_kinds") then
    return query
      select 'campaign'::text, c.id::text, c.name::text, c.status::text, null::timestamptz, null::text, word_similarity(v_q, c.name)::real
      from campaigns as c
      where c.tenant_id = v_tenant and c.name ilike v_like escape '\'
      order by 7 desc, c.name, c.id
      limit v_limit;
  end if;
end;
$kalendr_staff_search$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_staff_search"(text[], text, text, integer) FROM PUBLIC;--> statement-breakpoint

-- Can a business's public pages be shown to search engines right now? The same rule the staff screens use for the plan:
-- a trial that ended, a cancelled plan past its period and a failed payment past the 7-day grace all count as lapsed.
CREATE FUNCTION "kalendr_subscription_serves"("p_status" text, "p_trial_ends_at" timestamptz, "p_past_due_since" timestamptz, "p_period_end" timestamptz) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE AS $kalendr_subscription_serves$
  select case "p_status"
    when 'trialing' then coalesce("p_trial_ends_at" > now(), false)
    when 'past_due' then coalesce("p_past_due_since" > now() - interval '7 days', false)
    when 'cancelled' then coalesce("p_period_end" > now(), false)
    else true
  end
$kalendr_subscription_serves$;--> statement-breakpoint

-- The sitemap's rows, in a fixed order so a page of them is stable. Slugs and keys only: a business that did not switch
-- listing on, is switched off or paused, or has a lapsed plan never appears. `domain` is its verified own address, which
-- is the address its pages call canonical.
CREATE FUNCTION "kalendr_sitemap_entries"("p_offset" integer, "p_limit" integer)
  RETURNS TABLE ("slug" text, "kind" text, "key" text, "domain" text, "updated_at" timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $kalendr_sitemap_entries$
  with live as (
    select t.id, t.slug, t.updated_at,
      (select d.hostname from tenant_domains as d where d.tenant_id = t.id and d.status = 'active' order by d.created_at limit 1) as hostname
    from tenants as t
    left join tenant_subscriptions as s on s.tenant_id = t.id
    where t.listed and t.is_active and t.paused_at is null and t.slug <> ''
      and (s.id is null or kalendr_subscription_serves(s.status, s.trial_ends_at, s.past_due_since, s.current_period_end))
  ), entries as (
    select live.slug, 'business'::text as kind, ''::text as key, live.hostname as domain, live.updated_at from live
    union all
    select live.slug, 'service', sv.slug, live.hostname, sv.updated_at from live
      join services as sv on sv.tenant_id = live.id and sv.is_active and sv.kind = 'appointment' and sv.visibility = 'listed' and sv.slug <> ''
    union all
    select live.slug, 'person', p.id, live.hostname, p.updated_at from live
      join practitioners as p on p.tenant_id = live.id and p.is_active
  )
  select entries.slug, entries.kind, entries.key, entries.domain, entries.updated_at from entries
  order by entries.slug, entries.kind, entries.key
  offset greatest("p_offset", 0) limit least(greatest("p_limit", 1), 50000)
$kalendr_sitemap_entries$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_sitemap_entries"(integer, integer) FROM PUBLIC;--> statement-breakpoint
CREATE FUNCTION "kalendr_sitemap_count"() RETURNS bigint
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $kalendr_sitemap_count$
  with live as (
    select t.id from tenants as t
    left join tenant_subscriptions as s on s.tenant_id = t.id
    where t.listed and t.is_active and t.paused_at is null and t.slug <> ''
      and (s.id is null or kalendr_subscription_serves(s.status, s.trial_ends_at, s.past_due_since, s.current_period_end))
  )
  select (select count(*) from live)
    + (select count(*) from services as sv where sv.tenant_id in (select id from live) and sv.is_active and sv.kind = 'appointment' and sv.visibility = 'listed' and sv.slug <> '')
    + (select count(*) from practitioners as p where p.tenant_id in (select id from live) and p.is_active)
$kalendr_sitemap_count$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_sitemap_count"() FROM PUBLIC;--> statement-breakpoint

-- The /explore directory: listed businesses only, with the facts a card shows. p_city and p_type narrow it; p_query is
-- matched against the name and the description (prefix full text, and typos on the name). Public business facts only.
CREATE FUNCTION "kalendr_directory_search"("p_query" text, "p_city" text, "p_type" text, "p_offset" integer, "p_limit" integer)
  RETURNS TABLE ("slug" text, "name" text, "business_type" text, "city" text, "about" text, "domain" text, "total" bigint)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  SET pg_trgm.word_similarity_threshold = '0.45' AS $kalendr_directory_search$
declare
  v_q text := left(btrim(regexp_replace(coalesce("p_query", ''), '\s+', ' ', 'g')), 80);
  v_like text := kalendr_search_like(v_q);
  v_ts tsquery := kalendr_search_tsquery(v_q);
  v_city text := nullif(left(btrim(coalesce("p_city", '')), 120), '');
  v_city_like text := case when v_city is null then null else kalendr_search_like(v_city) end;
begin
  return query
    with live as (
      select t.id as tenant_id, t.slug as business_slug, t.name as business_name, t.business_type as kind, t.about as description
      from tenants as t
      left join tenant_subscriptions as s on s.tenant_id = t.id
      where t.listed and t.is_active and t.paused_at is null and t.slug <> ''
        and (s.id is null or kalendr_subscription_serves(s.status, s.trial_ends_at, s.past_due_since, s.current_period_end))
        and ("p_type" is null or t.business_type = "p_type")
        and (char_length(v_q) < 2
          or t.name ilike v_like escape '\'
          or v_q <% t.name
          or (v_ts is not null and to_tsvector('simple', coalesce(t.name, '') || ' ' || coalesce(t.about, '')) @@ v_ts)
          or exists (select 1 from locations as l where l.tenant_id = t.id and l.is_active and l.city ilike v_like escape '\'))
        and (v_city is null or exists (select 1 from locations as l where l.tenant_id = t.id and l.is_active and l.city ilike v_city_like escape '\'))
    ), page as (
      select live.*, count(*) over () as matches from live
      order by (case when char_length(v_q) < 2 then 0 else word_similarity(v_q, live.business_name) end) desc, live.business_name, live.business_slug
      offset greatest("p_offset", 0) limit least(greatest("p_limit", 1), 48)
    )
    select page.business_slug::text, page.business_name::text, page.kind::text,
      (select l.city from locations as l where l.tenant_id = page.tenant_id and l.is_active order by l.created_at, l.id limit 1)::text,
      left(page.description, 300)::text,
      (select d.hostname from tenant_domains as d where d.tenant_id = page.tenant_id and d.status = 'active' order by d.created_at limit 1)::text,
      page.matches
    from page
    order by (case when char_length(v_q) < 2 then 0 else word_similarity(v_q, page.business_name) end) desc, page.business_name, page.business_slug;
end;
$kalendr_directory_search$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_directory_search"(text, text, text, integer, integer) FROM PUBLIC;--> statement-breakpoint
-- The cities and business types that have a listed business, for the directory's filters.
CREATE FUNCTION "kalendr_directory_facets"() RETURNS TABLE ("facet" text, "value" text, "count" bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $kalendr_directory_facets$
  with live as (
    select t.id, t.business_type from tenants as t
    left join tenant_subscriptions as s on s.tenant_id = t.id
    where t.listed and t.is_active and t.paused_at is null and t.slug <> ''
      and (s.id is null or kalendr_subscription_serves(s.status, s.trial_ends_at, s.past_due_since, s.current_period_end))
  )
  select 'type'::text, live.business_type::text, count(*) from live group by live.business_type
  union all
  select * from (
    select 'city'::text, l.city::text, count(distinct l.tenant_id) from locations as l join live on live.id = l.tenant_id
    where l.is_active group by l.city order by 3 desc, 2 limit 60
  ) as cities
$kalendr_directory_facets$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_directory_facets"() FROM PUBLIC;
