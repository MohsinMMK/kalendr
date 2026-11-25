import "server-only";

import { X509Certificate, randomBytes } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import { withTenant } from "@/db/client";
import { auditEvents, memberships, ssoConnections, verifiedDomains } from "@/db/schema";
import { emailDomainRecordName, emailDomainRecordValue, hashDomainToken } from "@/lib/email-domain-rules";
import type { DomainUpdateInput, DomainView, SsoConnectionInput, SsoConnectionView } from "@/lib/enterprise-contracts";
import { serviceProviderUrls } from "@/lib/sso-urls";
import { ApiError, getPostgresErrorCode } from "@/server/api-error";
import { appOrigin } from "@/server/env";
import { prepareRecordKeys, sealText } from "@/server/record-crypto";
import type { StaffContext } from "@/server/staff-context";
import { revokeAllSessions } from "@/server/staff-invites";
import { getUserSecurity } from "@/server/staff-security";

import { guardOrgRead, guardOrgWrite } from "./guard";

type TenantTransaction = Parameters<Parameters<typeof withTenant>[1]>[0];

/** Free mail providers can never be proved by one business, so nobody is offered the chance. */
const sharedMailDomains = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "yahoo.in", "yahoo.co.in", "icloud.com", "me.com", "proton.me", "protonmail.com", "aol.com", "rediffmail.com", "zoho.com", "mail.com"]);

function connectionView(row: typeof ssoConnections.$inferSelect): SsoConnectionView {
  return {
    id: row.id, kind: row.kind as "saml" | "oidc", status: row.status as SsoConnectionView["status"],
    idpEntityId: row.idpEntityId, idpSsoUrl: row.idpSsoUrl, oidcIssuer: row.oidcIssuer, oidcClientId: row.oidcClientId,
    hasClientSecret: Boolean(row.oidcClientSecretEnc), version: row.version,
    serviceProvider: serviceProviderUrls(appOrigin(), row.id),
  };
}

function domainView(row: typeof verifiedDomains.$inferSelect, connection: typeof ssoConnections.$inferSelect | undefined): DomainView {
  return {
    id: row.id, domain: row.domain, verified: row.verifiedAt !== null, verifiedAt: row.verifiedAt?.toISOString() ?? null,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null, lastCheckNote: row.lastCheckNote, autoJoinEnabled: row.autoJoinEnabled,
    autoJoinRole: row.autoJoinRole as DomainView["autoJoinRole"], requireSso: row.requireSso, version: row.version,
    connection: connection ? connectionView(connection) : null,
  };
}

function newToken(): { token: string; hash: string; record: { host: string; value: string } } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashDomainToken(token), record: { host: "", value: emailDomainRecordValue(token) } };
}

export async function listDomains(context: StaffContext): Promise<DomainView[]> {
  guardOrgRead(context);
  if (context.preview) return [];
  return withTenant(context.tenantId, async (transaction) => {
    const domains = await transaction.select().from(verifiedDomains).where(eq(verifiedDomains.tenantId, context.tenantId)).orderBy(verifiedDomains.domain);
    const connections = await transaction.select().from(ssoConnections).where(eq(ssoConnections.tenantId, context.tenantId));
    const [breakGlass] = await transaction.execute<{ name: string }>(sql`
      select person.name from memberships as membership join auth_users as person on person.id = membership.user_id
      where membership.tenant_id = ${context.tenantId} and membership.break_glass and membership.is_active limit 1`);
    return domains.map((row) => ({ ...domainView(row, connections.find((connection) => connection.domainId === row.id)), breakGlassName: breakGlass?.name ?? null }));
  });
}

async function loadDomain(transaction: TenantTransaction, tenantId: string, domainId: string): Promise<typeof verifiedDomains.$inferSelect> {
  const [row] = await transaction.select().from(verifiedDomains).where(and(eq(verifiedDomains.tenantId, tenantId), eq(verifiedDomains.id, domainId))).for("update").limit(1);
  if (!row) throw new ApiError(404, "domain_not_found", "That domain could not be found.");
  return row;
}

export async function addDomain(context: StaffContext, input: { domain: string }): Promise<DomainView> {
  guardOrgWrite(context, { plan: true, stepUp: true });
  if (sharedMailDomains.has(input.domain)) throw new ApiError(400, "shared_mail_domain", "That is a public email service, not a company domain. Use your own domain, such as yourcompany.com.", { domain: ["Use your company's own domain."] });
  const secret = newToken();
  try {
    return await withTenant(context.tenantId, async (transaction) => {
      const [row] = await transaction.insert(verifiedDomains).values({ tenantId: context.tenantId, domain: input.domain, tokenHash: secret.hash }).returning();
      if (!row) throw new Error("Domain insert returned no row");
      await transaction.insert(auditEvents).values({
        tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "enterprise.domain.added", outcome: "success", metadata: { domainId: row.id },
      });
      return { ...domainView(row, undefined), dnsRecord: { host: emailDomainRecordName(row.domain), value: secret.record.value } };
    });
  } catch (error: unknown) {
    if (getPostgresErrorCode(error) === "23505") throw new ApiError(409, "duplicate", "You already added that domain.");
    throw error;
  }
}

/** A new record to publish, for a domain that is not proved yet. The old value stops working. */
export async function regenerateDomainRecord(context: StaffContext, domainId: string): Promise<DomainView> {
  guardOrgWrite(context, { plan: true, stepUp: true });
  const secret = newToken();
  return withTenant(context.tenantId, async (transaction) => {
    const current = await loadDomain(transaction, context.tenantId, domainId);
    if (current.verifiedAt) throw new ApiError(409, "domain_verified", "This domain is already proved.");
    // The week-long check window starts again with the new record.
    const [row] = await transaction.update(verifiedDomains).set({ tokenHash: secret.hash, createdAt: new Date(), lastCheckedAt: null, lastCheckNote: null, updatedAt: new Date(), version: current.version + 1 })
      .where(and(eq(verifiedDomains.tenantId, context.tenantId), eq(verifiedDomains.id, domainId))).returning();
    return { ...domainView(row!, undefined), dnsRecord: { host: emailDomainRecordName(row!.domain), value: secret.record.value } };
  });
}

/** Whether this person has a second factor: required of the break-glass owner, who signs in with a password when company sign-in is down. */
async function hasSecondFactor(userId: string): Promise<boolean> {
  const security = await getUserSecurity(userId);
  return security.twoFactorEnabled || security.passkeyCount > 0;
}

export async function setBreakGlassOwner(context: StaffContext, membershipId: string): Promise<{ membershipId: string }> {
  guardOrgWrite(context, { plan: true, stepUp: true });
  if (context.role !== "owner") throw new ApiError(403, "owner_only", "Only the owner can choose the break-glass owner.");
  return withTenant(context.tenantId, async (transaction) => {
    const [target] = await transaction.select({ id: memberships.id, role: memberships.role, userId: memberships.userId, isActive: memberships.isActive }).from(memberships)
      .where(and(eq(memberships.tenantId, context.tenantId), eq(memberships.id, membershipId))).limit(1);
    if (!target || target.role !== "owner" || !target.isActive) throw new ApiError(400, "not_an_owner", "The break-glass account must be an active owner.");
    if (!(await hasSecondFactor(target.userId))) throw new ApiError(400, "second_factor_required", "That owner needs an authenticator app or a passkey first, so the account stays safe when it is the only way in.");
    await transaction.update(memberships).set({ breakGlass: false, updatedAt: new Date() }).where(and(eq(memberships.tenantId, context.tenantId), eq(memberships.breakGlass, true)));
    await transaction.update(memberships).set({ breakGlass: true, updatedAt: new Date() }).where(and(eq(memberships.tenantId, context.tenantId), eq(memberships.id, membershipId)));
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "enterprise.domain.updated", outcome: "success", metadata: { breakGlassMembershipId: membershipId },
    });
    return { membershipId };
  });
}

export async function updateDomain(context: StaffContext, domainId: string, input: DomainUpdateInput): Promise<DomainView> {
  guardOrgWrite(context, { plan: true, stepUp: true });
  const affected: string[] = [];
  const view = await withTenant(context.tenantId, async (transaction) => {
    const current = await loadDomain(transaction, context.tenantId, domainId);
    if (current.version !== input.version) throw new ApiError(409, "version_conflict", "Someone else changed this domain. Reload and try again.");
    if (!current.verifiedAt) throw new ApiError(409, "domain_not_verified", "Prove the domain first. These rules apply once it is proved.");
    const [connection] = await transaction.select().from(ssoConnections).where(and(eq(ssoConnections.tenantId, context.tenantId), eq(ssoConnections.domainId, domainId))).limit(1);
    const turningOn = input.requireSso === true && !current.requireSso;
    if (turningOn) {
      if (!connection || connection.status !== "active") throw new ApiError(409, "sso_not_active", "Switch the company sign-in connection on before requiring it.");
      const [breakGlass] = await transaction.select({ userId: memberships.userId }).from(memberships)
        .where(and(eq(memberships.tenantId, context.tenantId), eq(memberships.breakGlass, true), eq(memberships.isActive, true), eq(memberships.role, "owner"))).limit(1);
      if (!breakGlass || !(await hasSecondFactor(breakGlass.userId))) {
        throw new ApiError(409, "break_glass_required", "Choose a break-glass owner first. They keep a password and a second factor, so you can still get in if the company sign-in fails.");
      }
      const people = await transaction.execute<{ user_id: string }>(sql`
        select membership.user_id from memberships as membership join auth_users on auth_users.id = membership.user_id
        where membership.tenant_id = ${context.tenantId} and membership.is_active and not membership.break_glass
          and lower(split_part(auth_users.email, '@', 2)) = ${current.domain}`);
      affected.push(...people.map((row) => row.user_id));
    }
    const [row] = await transaction.update(verifiedDomains).set({
      ...(input.autoJoinEnabled !== undefined ? { autoJoinEnabled: input.autoJoinEnabled } : {}),
      ...(input.autoJoinRole !== undefined ? { autoJoinRole: input.autoJoinRole } : {}),
      ...(input.requireSso !== undefined ? { requireSso: input.requireSso } : {}),
      version: current.version + 1, updatedAt: new Date(),
    }).where(and(eq(verifiedDomains.tenantId, context.tenantId), eq(verifiedDomains.id, domainId))).returning();
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "enterprise.domain.updated", outcome: "success",
      metadata: { domainId, changed: Object.keys(input).filter((key) => key !== "version"), ...(turningOn ? { signedOut: affected.length } : {}) },
    });
    return domainView(row!, connection);
  });
  // Everyone on the domain signs in again through the company; the break-glass owner keeps their session.
  for (const userId of affected) await revokeAllSessions(userId);
  return view;
}

export async function removeDomain(context: StaffContext, domainId: string): Promise<{ deleted: true }> {
  guardOrgWrite(context, { plan: true, stepUp: true });
  return withTenant(context.tenantId, async (transaction) => {
    const current = await loadDomain(transaction, context.tenantId, domainId);
    if (current.requireSso) throw new ApiError(409, "sso_required", "Turn off required company sign-in for this domain first.");
    await transaction.delete(verifiedDomains).where(and(eq(verifiedDomains.tenantId, context.tenantId), eq(verifiedDomains.id, domainId)));
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "enterprise.domain.removed", outcome: "success", metadata: { domainId },
    });
    return { deleted: true as const };
  });
}

/** A signing certificate pasted from the provider, as a clean PEM. Refused unless it parses and has not already expired. */
export function normalizeCertificate(input: string): string {
  const body = input.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");
  const pem = `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)?.join("\n") ?? ""}\n-----END CERTIFICATE-----`;
  try {
    const certificate = new X509Certificate(pem);
    if (new Date(certificate.validTo) < new Date()) throw new Error("expired");
  } catch {
    throw new ApiError(400, "invalid_certificate", "That certificate could not be read, or it has expired. Paste the current signing certificate from your identity provider.", { idpCertificate: ["Paste the current signing certificate."] });
  }
  return pem;
}

/** Creates or replaces the company sign-in connection for a proved domain. It starts switched off; the owner tests it, then turns it on. */
export async function saveSsoConnection(context: StaffContext, domainId: string, input: SsoConnectionInput): Promise<SsoConnectionView> {
  guardOrgWrite(context, { plan: true, stepUp: true });
  const certificate = input.kind === "saml" ? normalizeCertificate(input.idpCertificate) : null;
  if (input.kind === "oidc") await prepareRecordKeys(context.tenantId, { forWrite: true });
  return withTenant(context.tenantId, async (transaction) => {
    const domain = await loadDomain(transaction, context.tenantId, domainId);
    if (!domain.verifiedAt) throw new ApiError(409, "domain_not_verified", "Prove the domain first, then connect your identity provider.");
    const [existing] = await transaction.select().from(ssoConnections).where(and(eq(ssoConnections.tenantId, context.tenantId), eq(ssoConnections.domainId, domainId))).for("update").limit(1);
    if (existing?.status === "active" && domain.requireSso) throw new ApiError(409, "sso_required", "Turn off required company sign-in before changing the connection.");
    const fields = input.kind === "saml"
      ? { kind: "saml", idpEntityId: input.idpEntityId, idpSsoUrl: input.idpSsoUrl, idpCertificate: certificate, oidcIssuer: null, oidcClientId: null, oidcClientSecretEnc: null }
      : {
          kind: "oidc", idpEntityId: null, idpSsoUrl: null, idpCertificate: null, oidcIssuer: input.oidcIssuer, oidcClientId: input.oidcClientId,
          oidcClientSecretEnc: input.oidcClientSecret ? sealText(context.tenantId, input.oidcClientSecret) : existing?.oidcClientSecretEnc ?? null,
        };
    if (input.kind === "oidc" && !fields.oidcClientSecretEnc) throw new ApiError(400, "secret_required", "Enter the client secret from your identity provider.", { oidcClientSecret: ["Enter the client secret."] });
    // Changing the connection switches it off, so a half-edited one never signs anybody in.
    const values = { ...fields, status: "draft", updatedAt: new Date() };
    const [row] = existing
      ? await transaction.update(ssoConnections).set({ ...values, version: existing.version + 1 }).where(and(eq(ssoConnections.tenantId, context.tenantId), eq(ssoConnections.id, existing.id))).returning()
      : await transaction.insert(ssoConnections).values({ tenantId: context.tenantId, domainId, ...values }).returning();
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "enterprise.sso.saved", outcome: "success", metadata: { connectionId: row!.id, kind: input.kind },
    });
    return connectionView(row!);
  });
}

export async function setSsoStatus(context: StaffContext, domainId: string, status: "active" | "disabled"): Promise<SsoConnectionView> {
  guardOrgWrite(context, { plan: true, stepUp: true });
  return withTenant(context.tenantId, async (transaction) => {
    const domain = await loadDomain(transaction, context.tenantId, domainId);
    const [connection] = await transaction.select().from(ssoConnections).where(and(eq(ssoConnections.tenantId, context.tenantId), eq(ssoConnections.domainId, domainId))).for("update").limit(1);
    if (!connection) throw new ApiError(404, "sso_not_found", "Add the connection first.");
    if (status === "disabled" && domain.requireSso) throw new ApiError(409, "sso_required", "Turn off required company sign-in first, or people on this domain would be locked out.");
    if (status === "active" && !domain.verifiedAt) throw new ApiError(409, "domain_not_verified", "Prove the domain first.");
    const [row] = await transaction.update(ssoConnections).set({ status, version: connection.version + 1, updatedAt: new Date() })
      .where(and(eq(ssoConnections.tenantId, context.tenantId), eq(ssoConnections.id, connection.id))).returning();
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "enterprise.sso.status", outcome: "success", metadata: { connectionId: connection.id, status },
    });
    return connectionView(row!);
  });
}

export async function removeSsoConnection(context: StaffContext, domainId: string): Promise<{ deleted: true }> {
  guardOrgWrite(context, { plan: true, stepUp: true });
  return withTenant(context.tenantId, async (transaction) => {
    const domain = await loadDomain(transaction, context.tenantId, domainId);
    if (domain.requireSso) throw new ApiError(409, "sso_required", "Turn off required company sign-in first.");
    const removed = await transaction.delete(ssoConnections).where(and(eq(ssoConnections.tenantId, context.tenantId), eq(ssoConnections.domainId, domainId))).returning({ id: ssoConnections.id });
    if (removed.length === 0) throw new ApiError(404, "sso_not_found", "There is no connection to remove.");
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "enterprise.sso.removed", outcome: "success", metadata: { connectionId: removed[0]!.id },
    });
    return { deleted: true as const };
  });
}
