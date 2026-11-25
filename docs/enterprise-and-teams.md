# Enterprise and teams (feature 53)

Written 20 November 2026. For hospital groups and chains: departments with their own pages, roles shaped to the organisation, company sign-in, directory sync, attributes, defaults and a filterable audit trail.

## What is where

| Piece | Where |
| --- | --- |
| Tables (migration `0067_enterprise`) | `teams`, `team_members`, `custom_roles`, `verified_domains`, `sso_connections`, `scim_tokens`, `attribute_definitions`, `practitioner_attributes`; `memberships.custom_role_id`, `scim_external_id`, `break_glass`; `tenants.defaults`. All have forced row-level security. |
| Contracts | `src/lib/enterprise-contracts.ts`, `src/lib/email-domain-rules.ts`, `src/lib/sso-urls.ts` |
| Server | `src/server/enterprise/` (roles, teams, attributes, defaults, domains, SSO login, SAML, OIDC), `src/server/scim/` (directory), `src/server/activity-export.ts` |
| Worker | `src/worker/email-domain-jobs.ts` (the TXT lookup, every 5 minutes for a week after a domain is added) |
| Staff routes | `/api/staff/roles`, `teams`, `attributes`, `org-defaults`, `org/domains`, `org/break-glass`, `org/scim/tokens`, `org/reassign`, `activity` (filters), `activity/export`, `activity/people` |
| Public routes | `/api/sso/lookup`, `/api/sso/saml/<id>/{start,acs,metadata}`, `/api/sso/oidc/<id>/{start,callback}`, `/api/auth/sso/complete`, `/api/scim/v2/*`, page `/b/<business>/t/<team>` |
| Screens | Settings, Organisation (Teams, Roles, Sign-in, Provisioning, Attributes, Defaults); Settings, Activity (filters and CSV); the access dialog in Team and access offers custom roles; the sign-in page has "Continue with your company account" |

## Rules worth knowing

- **Plan.** Company sign-in, directory sync, domains and custom roles need the `enterprise` plan feature (Scale only; migration 0067 sets it in the `plans` table). Teams, attributes, defaults and the audit viewer are on every plan.
- **Permission.** New key `org.manage` ("Manage the organisation"). Owners and admins have it by default. Teams and attributes can also be managed with `team.manage`.
- **Second factor.** Every change to roles, domains, sign-in connections and directory tokens needs a second-factor check from the last 10 minutes, as does the CSV export. Support sessions can do none of the secret-handling ones.
- **Custom roles** (a role that starts as Admin can only be made or changed by the owner) replace a built-in role's preset with a list of permission keys; `memberships.role` stays as the built-in base so second-factor and owner rules still apply. A role may only contain permissions its author holds. The role can't be deleted while anyone has it.
- **Last owner.** The database refuses to deactivate, demote or delete a business's last active owner (`kalendr_keep_one_owner`), and the server says why first. SCIM never touches an owner at all.
- **Domains.** The owner publishes `_kalendr-verify.<domain>` TXT `kalendr-verify=<token>`. Only the token's SHA-256 is stored, so it is shown once; a lost record is replaced. A proved domain belongs to one business (a unique index), so company sign-in can never be pointed at the wrong one.
- **Company sign-in** (SAML with `@node-saml/node-saml`, OIDC with `openid-client`; better-auth 1.7.21 here has no SSO plugin, and its separate `@better-auth/sso` stores providers without a business). A reply is accepted only if it answers a request we made (consumed on use, so a replay fails), its assertion is signed by the connection's certificate, the audience and issuer match, its clock window holds, and the address is on the connection's own verified domain. The reply never makes a session itself: it leaves a 256-bit one-time ticket, and `/api/auth/sso/complete` (a Better Auth endpoint) trades it for a session through the normal session rules. A removed person stays removed; a stranger joins only if the owner turned auto-join on for the domain, with the role the owner chose.
- **Required sign-in.** Turning it on needs an active connection and a break-glass owner with an authenticator or passkey. It signs everyone else on the domain out, and from then on any other way of creating a session (password, link, Google, passkey) is refused for them and written to the activity log. Company sign-in does not replace the second-factor rule: owners and admins still enrol and use one.
- **Directory sync (SCIM v2).** Bearer token (`kscim_` + 256 random bits, hash only), per-token rate limit, resolved to a business by a narrow database function. Users: create, read, filter by `userName` or `externalId`, PUT, PATCH (Okta and Azure AD shapes), DELETE (= deactivate). Groups map to teams. Deactivating (only through the directory; deactivating by hand in Team and access does not close the calendar) signs the person out of the business at once (and everywhere if it was their last business), closes their calendar with a long time off, and leaves their bookings on feature 20's reassign list (Provisioning shows "Bookings that need someone new"). Nothing a directory does deletes a booking, record or history entry.
- **Audit.** Failed and refused company sign-ins and every organisation change write audit rows with ids and counts only; no email address, name or free text.

## Needs your credentials

- An identity provider for each business that wants company sign-in: for **Okta**, **Azure AD (Entra ID)** or **Google Workspace**: the SAML sign-in address, entity id and signing certificate, or the OIDC issuer, client id and secret. Kalendr's side (entity id, reply address, metadata address, redirect address) is shown on the Sign-in tab.
- A real domain with DNS access to publish the verification record: lookups are proved with a fake resolver, never real DNS.
- A directory tool (Okta, Azure AD, Google Workspace) configured with the SCIM address and a token from the Provisioning tab.

Nothing here was tried against a real Okta, Azure AD or Google Workspace: the tests use a throwaway SAML provider that signs real responses with a generated key.

## Known limits

- A person who belongs to two businesses always opens the first one the app finds: the staff app has no business switcher yet (`getStaffContext` is called without a business name), so company sign-in cannot choose the landing business either. The ticket does carry the business for when a switcher exists.
- Company sign-in does not satisfy the second-factor rule by itself; owners and admins still use Kalendr's own. (A provider's MFA is not visible to us.)
- IdP-initiated SAML (starting from the provider's tile) is not accepted; people start from Kalendr's sign-in page. SAML single logout is not implemented.
- OIDC needs two calls to the provider while the person waits (discovery, token exchange), the one place a sign-in calls out inside a request. Tests cover the sign-in address (PKCE, state, nonce, our own reply address), a reply with a missing, unknown, reused or other connection's state, a refused code and an unreachable provider, against a stand-in provider. **The success path (a signed ID token read into an email address) was not tested**, and nothing was tried against a real provider.
- Auto-join works through company sign-in only, not for people who arrive by password, link or Google.
- Organisation defaults are stored and served (`orgDefaultsFor`), but no branch-creation path or service message field exists yet to apply them to, so nothing reads them today except the Defaults screen. They are ready for the first screen that creates a branch.
- The read, create, update and delete ticks in the spec map to Kalendr's existing permission keys (which are not per-verb); the role editor groups them by area. There is no separate "see payments" key: the payments screens are guarded by the take and refund payments keys.
- Alerts, the morning digest and request reminders now read a person's custom role, like every screen. Teams do not yet feed feature 38's limit pools or feature 20's pools; those keep their own hand-picked pools.
- SCIM `emails`, `phoneNumbers`, `roles` and `title` are ignored; only name, email, active and externalId matter. Bulk, sort and ETags are not supported.

## Packages and shared files

- New packages: `@node-saml/node-saml` and `openid-client` (the spec's own fallback, since better-auth 1.7.21 has no SSO or SCIM plugin and its separate `@better-auth/sso` stores providers with no business), and dev-only `xml-crypto` (already a dependency of node-saml) so tests can sign SAML replies.
- Additions to shared files: permission `org.manage` (`src/lib/permissions.ts`, `staff-context.ts`); plan feature `enterprise` (`src/lib/entitlements.ts`, plus the `plans` update in migration 0067); rate rules `sso.ip`, `scim.token`, `scim.bad_token`; worker schedule `email-domain-sweep`; auth hooks and a Better Auth plugin in `src/lib/auth.ts`; `resolvePermissions` takes an optional custom permission list; the access dialog in `team-workspace.tsx`; the sign-in controls; the activity log and its route; `src/test/isolated-database.ts` allows port 5661.
- "Every failed sign-in" means failures for a known account (the audit trail is per business, and an unknown address belongs to none).
