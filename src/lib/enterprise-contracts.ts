/**
 * Request and response shapes for enterprise and teams (feature 53). Shared by the routes, the server and the screens.
 */
import { z } from "zod";

import { assignableRoles, isPermission, type Permission } from "@/lib/permissions";

const id = z.string().trim().min(1).max(64);
const name = (max: number) => z.string().trim().min(2, "Enter at least 2 characters.").max(max);

/* ---------------------------------------------------------------- teams */

export const teamSlugPattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export const teamInputSchema = z.object({
  name: name(120),
  slug: z.string().trim().toLowerCase().min(2).max(80).regex(teamSlugPattern, "Use letters, numbers and dashes.").optional(),
  description: z.string().trim().max(600).nullable().optional(),
  parentTeamId: id.nullable().optional(),
  locationId: id.nullable().optional(),
  isPrivate: z.boolean().optional(),
  isActive: z.boolean().optional(),
  membershipIds: z.array(id).max(500).optional(),
}).strict();
export type TeamInput = z.infer<typeof teamInputSchema>;

export const teamUpdateSchema = teamInputSchema.partial().extend({ version: z.number().int().min(1) }).strict();
export type TeamUpdateInput = z.infer<typeof teamUpdateSchema>;

export interface TeamView {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  parentTeamId: string | null;
  locationId: string | null;
  isPrivate: boolean;
  isActive: boolean;
  version: number;
  memberCount: number;
  membershipIds: string[];
}

/** What the public team page shows. A private team lists no people. */
export interface PublicTeam {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  isPrivate: boolean;
  parent: { name: string; slug: string } | null;
  children: { name: string; slug: string }[];
  /** Empty for a private team, whoever is in it. */
  practitionerIds: string[];
  /** Everyone in the team and its sub-teams: the pool the services are taken from. Never sent for a private team. */
  serviceFromPractitionerIds: string[];
}

/* ---------------------------------------------------------------- custom roles */

export const customRoleInputSchema = z.object({
  name: name(80),
  description: z.string().trim().max(240).nullable().optional(),
  baseRole: z.enum(assignableRoles),
  permissions: z.array(z.string().refine(isPermission, "Unknown permission.")).max(100),
}).strict();
export type CustomRoleInput = z.infer<typeof customRoleInputSchema>;

export const customRoleUpdateSchema = customRoleInputSchema.partial().extend({ version: z.number().int().min(1) }).strict();
export type CustomRoleUpdateInput = z.infer<typeof customRoleUpdateSchema>;

export interface CustomRoleView {
  id: string;
  name: string;
  description: string | null;
  baseRole: (typeof assignableRoles)[number];
  permissions: Permission[];
  version: number;
  memberCount: number;
}

/* ---------------------------------------------------------------- attributes */

export const attributeKinds = ["text", "single", "multiple", "number"] as const;
export type AttributeKind = (typeof attributeKinds)[number];

export const attributeKindLabels: Record<AttributeKind, string> = {
  text: "Free text",
  single: "One choice",
  multiple: "Several choices",
  number: "A number",
};

export const attributeDefinitionSchema = z.object({
  name: name(60),
  kind: z.enum(attributeKinds),
  options: z.array(z.string().trim().min(1).max(60)).max(50).default([]),
}).strict().superRefine((value, context) => {
  const isChoice = value.kind === "single" || value.kind === "multiple";
  if (isChoice && value.options.length < 2) context.addIssue({ code: "custom", path: ["options"], message: "Add at least two choices." });
  if (!isChoice && value.options.length > 0) context.addIssue({ code: "custom", path: ["options"], message: "Choices only apply to choice attributes." });
  if (new Set(value.options.map((option) => option.toLowerCase())).size !== value.options.length) {
    context.addIssue({ code: "custom", path: ["options"], message: "Each choice must be different." });
  }
});
export type AttributeDefinitionInput = z.infer<typeof attributeDefinitionSchema>;

export const attributeUpdateSchema = z.object({
  name: name(60).optional(),
  options: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
  version: z.number().int().min(1),
}).strict();

export interface AttributeView {
  id: string;
  name: string;
  kind: AttributeKind;
  options: string[];
  position: number;
  version: number;
}

export const attributeValueSchema = z.union([z.string().trim().max(300), z.number().finite(), z.array(z.string().trim().min(1).max(60)).max(50), z.null()]);

/** Set values for one person: attribute id to value, null to clear. */
export const personAttributesSchema = z.object({ values: z.record(id, attributeValueSchema) }).strict();
export type PersonAttributesInput = z.infer<typeof personAttributesSchema>;

export interface PersonAttributesView {
  practitionerId: string;
  name: string;
  values: Record<string, string | number | string[]>;
}

/* ---------------------------------------------------------------- organisation defaults */

export const clockOptions = ["12h", "24h"] as const;
export const weekStartOptions = ["monday", "sunday", "saturday"] as const;

export const orgDefaultsSchema = z.object({
  timezone: z.string().trim().min(1).max(64).nullable().optional(),
  clock: z.enum(clockOptions).nullable().optional(),
  weekStart: z.enum(weekStartOptions).nullable().optional(),
  /** Starting wording for what a customer is told, copied onto new services. Plain text, no links. */
  confirmationMessage: z.string().trim().max(600).nullable().optional(),
  reminderMessage: z.string().trim().max(600).nullable().optional(),
  version: z.number().int().min(0).optional(),
}).strict();
export type OrgDefaultsInput = z.infer<typeof orgDefaultsSchema>;

export interface OrgDefaults {
  timezone: string | null;
  clock: (typeof clockOptions)[number] | null;
  weekStart: (typeof weekStartOptions)[number] | null;
  confirmationMessage: string | null;
  reminderMessage: string | null;
  version: number;
}

/* ---------------------------------------------------------------- domains, sign-in and directory sync */

export const domainPattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export const domainInputSchema = z.object({
  domain: z.string().trim().toLowerCase().max(253).regex(domainPattern, "Enter a domain such as yourcompany.com."),
}).strict();

export const domainUpdateSchema = z.object({
  autoJoinEnabled: z.boolean().optional(),
  autoJoinRole: z.enum(["receptionist", "practitioner", "billing", "read_only"]).optional(),
  requireSso: z.boolean().optional(),
  version: z.number().int().min(1),
}).strict();
export type DomainUpdateInput = z.infer<typeof domainUpdateSchema>;

export interface DomainView {
  id: string;
  domain: string;
  verified: boolean;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  lastCheckNote: string | null;
  autoJoinEnabled: boolean;
  autoJoinRole: "receptionist" | "practitioner" | "billing" | "read_only";
  requireSso: boolean;
  version: number;
  connection: SsoConnectionView | null;
  /** The owner who may still sign in with a password while company sign-in is required, if one was chosen. */
  breakGlassName?: string | null;
  /** The record to publish. Present only in the response that created or regenerated it. */
  dnsRecord?: { host: string; value: string };
}

export const ssoConnectionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("saml"),
    idpEntityId: z.string().trim().min(3).max(500),
    idpSsoUrl: z.string().trim().url().max(1000).refine((value) => value.startsWith("https://"), "The sign-in address must start with https://."),
    idpCertificate: z.string().trim().min(100).max(8000).refine((value) => value.includes("BEGIN CERTIFICATE") || /^[A-Za-z0-9+/=\s]+$/.test(value), "Paste the provider's signing certificate."),
  }).strict(),
  z.object({
    kind: z.literal("oidc"),
    oidcIssuer: z.string().trim().url().max(500).refine((value) => value.startsWith("https://"), "The issuer address must start with https://."),
    oidcClientId: z.string().trim().min(1).max(300),
    oidcClientSecret: z.string().trim().min(1).max(500).optional(),
  }).strict(),
]);
export type SsoConnectionInput = z.infer<typeof ssoConnectionSchema>;

export const ssoStatusSchema = z.object({ status: z.enum(["active", "disabled"]) }).strict();

export interface SsoConnectionView {
  id: string;
  kind: "saml" | "oidc";
  status: "draft" | "active" | "disabled";
  idpEntityId: string | null;
  idpSsoUrl: string | null;
  oidcIssuer: string | null;
  oidcClientId: string | null;
  hasClientSecret: boolean;
  version: number;
  /** What the owner pastes into the identity provider. */
  serviceProvider: { entityId: string; acsUrl: string; metadataUrl: string; redirectUri: string };
}

export const scimTokenInputSchema = z.object({
  name: name(80),
  defaultRole: z.enum(["receptionist", "practitioner", "billing", "read_only"]).default("read_only"),
}).strict();

export interface ScimTokenView {
  id: string;
  name: string;
  prefix: string;
  defaultRole: "receptionist" | "practitioner" | "billing" | "read_only";
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  /** The token itself, only in the response that creates it. */
  token?: string;
}

/* ---------------------------------------------------------------- audit viewer */

export const auditOutcomes = ["success", "denied", "failed"] as const;

export const auditQuerySchema = z.object({
  category: z.enum(["all", "team", "settings", "visits", "records", "refused"]).default("all"),
  actor: id.optional(),
  action: z.string().trim().max(80).regex(/^[a-z0-9_.]+$/).optional(),
  outcome: z.enum(auditOutcomes).optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  cursor: z.string().max(200).nullable().optional(),
}).strict();
export type AuditQuery = z.infer<typeof auditQuerySchema>;

/** The kinds of event the viewer can filter to, in plain words. Each maps to audit action names. */
export const auditActionGroups = {
  sign_in: { label: "Sign-ins", actions: ["staff.sign_in", "staff.sso.sign_in"] },
  failed_sign_in: { label: "Failed sign-ins", actions: ["staff.sign_in.failed", "staff.sso.sign_in.failed", "staff.sign_in.refused", "staff.second_factor.failed"] },
  role_change: { label: "Role and permission changes", actions: ["staff.member.role_changed", "staff.member.permissions_changed", "enterprise.role.created", "enterprise.role.updated", "enterprise.role.deleted"] },
  api_key: { label: "API keys", actions: ["api_key.created", "api_key.revoked"] },
  booking_change: { label: "Booking changes", actions: ["appointment.created", "appointment.cancel", "appointment.reschedule", "appointment.confirm"] },
  export: { label: "Exports", actions: ["audit.exported", "invoices.exported", "privacy.export.downloaded"] },
} as const;
export type AuditActionGroup = keyof typeof auditActionGroups;
