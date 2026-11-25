import "server-only";

import { randomBytes } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import { getDatabase, withTenant } from "@/db/client";
import { auditEvents, authUsers, memberships, ssoConnections, verifiedDomains } from "@/db/schema";
import { emailDomainOf } from "@/lib/email-domain-rules";
import { insertCredentialUser } from "@/server/staff-credentials";

import { issueSsoTicket } from "./sso-state";

/** Why a company sign-in was refused. The sign-in page words each one; none says more than the person needs. */
export const ssoRefusals = ["invalid_response", "no_email", "wrong_domain", "not_invited", "access_removed", "connection_off", "provider_error"] as const;
export type SsoRefusal = (typeof ssoRefusals)[number];

export class SsoSignInError extends Error {
  constructor(readonly reason: SsoRefusal) {
    super(reason);
    this.name = "SsoSignInError";
  }
}

export const ssoRefusalText: Record<SsoRefusal, string> = {
  invalid_response: "The company sign-in could not be checked. Try again from the start.",
  no_email: "Your company sign-in did not share an email address. Ask your IT team to include it.",
  wrong_domain: "That email address does not belong to this company sign-in.",
  not_invited: "Ask your manager to invite you.",
  access_removed: "Your access to this workspace was removed. Ask your manager.",
  connection_off: "Company sign-in is switched off for this business.",
  provider_error: "Your company sign-in did not finish. Try again.",
};

export interface SsoLookup {
  tenantId: string;
  connectionId: string;
  kind: "saml" | "oidc";
  requireSso: boolean;
}

/** Finds the active company sign-in for an email domain. Returns ids only, through a narrow database function. */
export async function resolveSsoDomain(domain: string): Promise<SsoLookup | null> {
  const database = getDatabase();
  if (!database) return null;
  const rows = await database.execute<{ tenant_id: string; connection_id: string; kind: "saml" | "oidc"; require_sso: boolean }>(
    sql`select * from kalendr_resolve_sso_domain(${domain.toLowerCase()})`);
  const row = rows[0];
  return row ? { tenantId: row.tenant_id, connectionId: row.connection_id, kind: row.kind, requireSso: row.require_sso } : null;
}

export async function resolveSsoConnection(connectionId: string): Promise<{ tenantId: string; domain: string } | null> {
  const database = getDatabase();
  if (!database) return null;
  const rows = await database.execute<{ tenant_id: string; domain: string }>(sql`select * from kalendr_resolve_sso_connection(${connectionId})`);
  return rows[0] ? { tenantId: rows[0].tenant_id, domain: rows[0].domain } : null;
}

export interface ConnectionRecord {
  id: string;
  kind: "saml" | "oidc";
  idpEntityId: string | null;
  idpSsoUrl: string | null;
  idpCertificate: string | null;
  oidcIssuer: string | null;
  oidcClientId: string | null;
  oidcClientSecretEnc: string | null;
  domain: string;
  autoJoinEnabled: boolean;
  autoJoinRole: "receptionist" | "practitioner" | "billing" | "read_only";
}

/** The connection and its domain's rules, read in the business's own scope. */
export async function loadConnection(tenantId: string, connectionId: string): Promise<ConnectionRecord | null> {
  return withTenant(tenantId, async (transaction) => {
    const [row] = await transaction.select({
      id: ssoConnections.id, kind: ssoConnections.kind, idpEntityId: ssoConnections.idpEntityId, idpSsoUrl: ssoConnections.idpSsoUrl,
      idpCertificate: ssoConnections.idpCertificate, oidcIssuer: ssoConnections.oidcIssuer, oidcClientId: ssoConnections.oidcClientId,
      oidcClientSecretEnc: ssoConnections.oidcClientSecretEnc, domain: verifiedDomains.domain, autoJoinEnabled: verifiedDomains.autoJoinEnabled,
      autoJoinRole: verifiedDomains.autoJoinRole,
    }).from(ssoConnections)
      .innerJoin(verifiedDomains, and(eq(verifiedDomains.tenantId, ssoConnections.tenantId), eq(verifiedDomains.id, ssoConnections.domainId)))
      .where(and(eq(ssoConnections.tenantId, tenantId), eq(ssoConnections.id, connectionId), eq(ssoConnections.status, "active")))
      .limit(1);
    return row ? { ...row, kind: row.kind as "saml" | "oidc", autoJoinRole: row.autoJoinRole as ConnectionRecord["autoJoinRole"] } : null;
  });
}

async function recordRefusal(tenantId: string, connectionId: string, reason: SsoRefusal, userId: string | null): Promise<void> {
  try {
    await withTenant(tenantId, (transaction) => transaction.insert(auditEvents).values({
      tenantId, actorUserId: userId, actorType: "staff", action: "staff.sso.sign_in.failed", outcome: "failed",
      // Never the email address or name the provider sent.
      metadata: { reason, connectionId },
    }));
  } catch {
    // A failed audit write must not turn a refusal into an error page.
  }
}

/** Records a refusal that happens before a person is identified (a bad response, a provider error). */
export async function refuseSso(tenantId: string, connectionId: string, reason: SsoRefusal): Promise<SsoSignInError> {
  await recordRefusal(tenantId, connectionId, reason, null);
  return new SsoSignInError(reason);
}

/**
 * Turns a checked identity into a one-time ticket for a Kalendr session, or refuses. The connection decides the business: a
 * provider can only ever sign someone into the business that owns its verified domain, and only for an address on that domain.
 * A person who was removed stays removed; a stranger is let in only when the owner turned auto-join on for the domain.
 */
export async function signInThroughCompany(connection: ConnectionRecord, tenantId: string, identity: { email: string; name: string | null }, binding: string): Promise<string> {
  const email = identity.email.trim().toLowerCase();
  if (emailDomainOf(email) !== connection.domain) throw await refuseSso(tenantId, connection.id, "wrong_domain");
  const database = getDatabase();
  if (!database) throw new SsoSignInError("provider_error");
  const [existing] = await database.select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.email, email)).limit(1);
  const outcome = await withTenant(tenantId, async (transaction) => {
    if (existing) {
      const [membership] = await transaction.select({ id: memberships.id, isActive: memberships.isActive }).from(memberships)
        .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, existing.id))).limit(1);
      if (membership) return membership.isActive ? { kind: "ok" as const, userId: existing.id } : { kind: "refused" as const, reason: "access_removed" as const, userId: existing.id };
    }
    if (!connection.autoJoinEnabled) return { kind: "refused" as const, reason: "not_invited" as const, userId: existing?.id ?? null };
    const userId = existing?.id ?? crypto.randomUUID();
    if (!existing) {
      await insertCredentialUser(transaction, {
        id: userId, name: (identity.name ?? email.split("@")[0] ?? "Staff").slice(0, 160), email, password: randomBytes(24).toString("base64url"),
        emailVerified: true, passwordChosen: false,
      });
    }
    const inserted = await transaction.insert(memberships).values({ tenantId, userId, role: connection.autoJoinRole, invitedAt: new Date() })
      .onConflictDoNothing().returning({ id: memberships.id });
    if (inserted[0]) {
      await transaction.insert(auditEvents).values({
        tenantId, actorUserId: userId, actorType: "staff", action: "staff.member.created", outcome: "success",
        metadata: { membershipId: inserted[0].id, role: connection.autoJoinRole, via: "company_domain" },
      });
    }
    return { kind: "ok" as const, userId };
  });
  if (outcome.kind === "refused") {
    await recordRefusal(tenantId, connection.id, outcome.reason, outcome.userId);
    throw new SsoSignInError(outcome.reason);
  }
  return issueSsoTicket({ userId: outcome.userId, tenantId, connectionId: connection.id, binding });
}
