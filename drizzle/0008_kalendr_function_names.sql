-- The product is now Kalendr. Rename the database helper functions that carried the old product prefix.
-- ALTER FUNCTION ... RENAME keeps each function's body, owner, SECURITY DEFINER setting and grants, and the
-- patients_portal_phone_idx index keeps pointing at the same function.
ALTER FUNCTION "nira_resolve_tenant"(text, text) RENAME TO "kalendr_resolve_tenant";--> statement-breakpoint
ALTER FUNCTION "nira_resolve_manage_token"(text) RENAME TO "kalendr_resolve_manage_token";--> statement-breakpoint
ALTER FUNCTION "nira_resolve_staff_appointment"(text, text) RENAME TO "kalendr_resolve_staff_appointment";--> statement-breakpoint
ALTER FUNCTION "nira_resolve_staff_memberships"(text) RENAME TO "kalendr_resolve_staff_memberships";--> statement-breakpoint
ALTER FUNCTION "nira_resolve_staff_access"(text) RENAME TO "kalendr_resolve_staff_access";--> statement-breakpoint
ALTER FUNCTION "nira_normalize_phone"(text) RENAME TO "kalendr_normalize_phone";--> statement-breakpoint
ALTER FUNCTION "nira_portal_people"(text) RENAME TO "kalendr_portal_people";--> statement-breakpoint
-- A SQL function body is resolved by name when it runs, so the portal lookup must call the renamed phone helper.
CREATE OR REPLACE FUNCTION "kalendr_portal_people"(p_account_id text)
RETURNS TABLE (tenant_id text, clinic_slug text, clinic_name text, patient_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $kalendr_portal_people$
  SELECT patient.tenant_id, tenant.slug::text, tenant.name::text, patient.id
  FROM patient_accounts AS account
  JOIN patients AS patient
    ON account.contact_kind = 'phone' AND "kalendr_normalize_phone"(patient.phone) = account.contact_value
  JOIN tenants AS tenant ON tenant.id = patient.tenant_id AND tenant.is_active
  WHERE account.id = p_account_id AND account.contact_value <> ''
  UNION ALL
  SELECT patient.tenant_id, tenant.slug::text, tenant.name::text, patient.id
  FROM patient_accounts AS account
  JOIN patients AS patient
    ON account.contact_kind = 'email' AND lower(trim(patient.email)) = account.contact_value
  JOIN tenants AS tenant ON tenant.id = patient.tenant_id AND tenant.is_active
  WHERE account.id = p_account_id AND account.contact_value <> ''
$kalendr_portal_people$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_portal_people"(text) FROM PUBLIC;
