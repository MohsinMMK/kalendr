import {
  aliasBases,
  featureKeys,
  getBusinessType,
  resourceKindLabels,
  termKeys,
  type AliasKey,
  type Aliases,
  type BusinessTypeId,
  type FeatureKey,
  type Features,
  type ProviderFieldLabels,
  type ResourceKind,
  type Term,
  type TermKey,
  type Terms,
} from "@/lib/business-types";

export type TerminologyOverrides = Partial<Record<TermKey, Partial<Term>>>;
export type FeatureOverrides = Partial<Features>;

/** The staff roles a business can give its own names. The keys, and what each role may do, never change. */
export const roleNameKeys = ["owner", "admin", "receptionist", "practitioner", "billing", "read_only"] as const;
export type RoleNameKey = (typeof roleNameKeys)[number];
/** Only the roles a business renamed. A role left out keeps its standard name. */
export type RoleNameOverrides = Partial<Record<RoleNameKey, string>>;

/**
 * What `tenants.terminology` holds: the renamed words, plus the renamed roles under their own key. Roles live beside the
 * words so every place that already loads the business profile picks them up.
 */
export type StoredTerminology = TerminologyOverrides & { roles?: RoleNameOverrides };

/** What a business has chosen: its type plus any words or features it changed in Settings. */
export interface BusinessProfileSettings {
  businessType?: string | null;
  terminology?: unknown;
  features?: unknown;
}

/** The words and features every screen, email and API response uses for one business. */
export interface BusinessProfile {
  businessType: BusinessTypeId;
  businessTypeLabel: string;
  terms: Terms;
  /** Second words ("visit", "practitioner", "practice"); each equals its base term unless the type keeps its own. */
  aliases: Aliases;
  features: Features;
  providerFields: ProviderFieldLabels;
  resourceKinds: ResourceKind[];
  /** Only the words and features that differ from the type's preset, cleaned. */
  terminologyOverrides: TerminologyOverrides;
  featureOverrides: FeatureOverrides;
  /** The roles this business renamed, cleaned. `roleLabelsFor` applies them. */
  roleNameOverrides: RoleNameOverrides;
}

export const maxTermLength = 40;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanWord(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Control characters (a pasted NUL in particular, which Postgres refuses in jsonb) become spaces like any line break.
  const word = value.replace(/[\s\p{Cc}]+/gu, " ").trim();
  if (!word || word.length > maxTermLength) return null;
  return word;
}

/** Keeps only known terms with usable words. Words are stored lower case unless the owner typed capitals inside. */
export function cleanTerminologyOverrides(value: unknown): TerminologyOverrides {
  if (!isRecord(value)) return {};
  const cleaned: TerminologyOverrides = {};
  for (const key of termKeys) {
    const entry = value[key];
    if (!isRecord(entry)) continue;
    const singular = cleanWord(entry.singular);
    const plural = cleanWord(entry.plural);
    if (!singular && !plural) continue;
    cleaned[key] = { ...(singular ? { singular } : {}), ...(plural ? { plural } : {}) };
  }
  return cleaned;
}

/** Keeps only known roles with usable names. An empty or too long name is dropped, which puts the role's standard name back. */
export function cleanRoleNames(value: unknown): RoleNameOverrides {
  if (!isRecord(value)) return {};
  const cleaned: RoleNameOverrides = {};
  for (const key of roleNameKeys) {
    const name = cleanWord(value[key]);
    if (name) cleaned[key] = name;
  }
  return cleaned;
}

/** The renamed words and roles of a stored or submitted `terminology` value, cleaned, as the database and the preview cookie keep them. */
export function cleanStoredTerminology(value: unknown): StoredTerminology {
  const roles = cleanRoleNames(isRecord(value) ? value.roles : undefined);
  return { ...cleanTerminologyOverrides(value), ...(Object.keys(roles).length > 0 ? { roles } : {}) };
}

/** What to store in `tenants.terminology` for a profile. */
export function storedTerminologyOf(profile: Pick<BusinessProfile, "terminologyOverrides" | "roleNameOverrides">): StoredTerminology {
  return cleanStoredTerminology({ ...profile.terminologyOverrides, roles: profile.roleNameOverrides });
}

export function cleanFeatureOverrides(value: unknown): FeatureOverrides {
  if (!isRecord(value)) return {};
  const cleaned: FeatureOverrides = {};
  for (const key of featureKeys) {
    if (typeof value[key] === "boolean") cleaned[key] = value[key];
  }
  return cleaned;
}

/** Merges a business type's preset with the owner's overrides. Pure; safe on the server and in the browser. */
export function resolveBusinessProfile(settings: BusinessProfileSettings): BusinessProfile {
  const preset = getBusinessType(settings.businessType);
  const terminologyOverrides = cleanTerminologyOverrides(settings.terminology);
  const featureOverrides = cleanFeatureOverrides(settings.features);
  const terms = Object.fromEntries(
    termKeys.map((key) => {
      const base = preset.terms[key];
      const override = terminologyOverrides[key];
      return [key, { singular: override?.singular ?? base.singular, plural: override?.plural ?? base.plural }];
    }),
  ) as Terms;
  // A renamed base term wins over the type's alias, so an owner who says "session" never sees "visit".
  const aliases = Object.fromEntries(
    (Object.keys(aliasBases) as AliasKey[]).map((alias) => {
      const base = aliasBases[alias];
      const own = preset.aliases?.[alias];
      return [alias, own && !terminologyOverrides[base] ? own : terms[base]];
    }),
  ) as Aliases;
  return {
    businessType: preset.id,
    businessTypeLabel: preset.label,
    terms,
    aliases,
    features: { ...preset.features, ...featureOverrides },
    providerFields: preset.providerFields,
    resourceKinds: preset.resourceKinds,
    terminologyOverrides,
    featureOverrides,
    roleNameOverrides: cleanRoleNames(isRecord(settings.terminology) ? settings.terminology.roles : undefined),
  };
}

export const defaultBusinessProfile: BusinessProfile = resolveBusinessProfile({ businessType: "healthcare" });

export function capitalize(word: string): string {
  return word ? word.charAt(0).toLocaleUpperCase("en") + word.slice(1) : word;
}

/** Title case for navigation and headings: "appointment type" becomes "Appointment Types" only when asked. */
export function titleCase(words: string): string {
  return words.split(" ").map(capitalize).join(" ");
}

/** "a client", "an agent", "an hour". Good enough for the words the presets and owners use. */
export function withArticle(word: string): string {
  return `${/^[aeiou]/i.test(word) ? "an" : "a"} ${word}`;
}

/**
 * Ready-made words for copy. Lower case for use inside sentences, capitalised for the start of a sentence
 * or a label: `t.customer` is "client", `t.Customers` is "Clients", `t.aCustomer` is "a client".
 */
export interface TermWords {
  customer: string;
  customers: string;
  Customer: string;
  Customers: string;
  aCustomer: string;
  provider: string;
  providers: string;
  Provider: string;
  Providers: string;
  aProvider: string;
  business: string;
  businesses: string;
  Business: string;
  Businesses: string;
  aBusiness: string;
  appointment: string;
  appointments: string;
  Appointment: string;
  Appointments: string;
  anAppointment: string;
  service: string;
  services: string;
  Service: string;
  Services: string;
  aService: string;
  resource: string;
  resources: string;
  Resource: string;
  Resources: string;
  aResource: string;
  location: string;
  locations: string;
  Location: string;
  Locations: string;
  aLocation: string;
  /** "visit" in healthcare and dental; the appointment word everywhere else. */
  visit: string;
  visits: string;
  Visit: string;
  Visits: string;
  aVisit: string;
  /** "practitioner" in healthcare and dental; the provider word everywhere else. */
  practitioner: string;
  practitioners: string;
  Practitioner: string;
  Practitioners: string;
  aPractitioner: string;
  /** "practice" in healthcare and dental; the business word everywhere else. */
  practice: string;
  practices: string;
  Practice: string;
  Practices: string;
  aPractice: string;
}

export function termWords(terms: Terms, aliases?: Aliases): TermWords {
  // Keep owner-typed capitals such as "GP" or "RM"; only fold a leading capital.
  const fold = (word: string) => (/^[A-Z][a-z]/.test(word) ? word.charAt(0).toLowerCase() + word.slice(1) : word);
  const words = (key: TermKey) => ({ one: fold(terms[key].singular), many: fold(terms[key].plural) });
  const alias = (key: AliasKey) => {
    const chosen = aliases?.[key] ?? terms[aliasBases[key]];
    return { one: fold(chosen.singular), many: fold(chosen.plural) };
  };
  const v = alias("visit");
  const pr = alias("practitioner");
  const pc = alias("practice");
  const c = words("customer");
  const p = words("provider");
  const b = words("business");
  const a = words("appointment");
  const s = words("service");
  const r = words("resource");
  const l = words("location");
  return {
    customer: c.one, customers: c.many, Customer: capitalize(c.one), Customers: capitalize(c.many), aCustomer: withArticle(c.one),
    provider: p.one, providers: p.many, Provider: capitalize(p.one), Providers: capitalize(p.many), aProvider: withArticle(p.one),
    business: b.one, businesses: b.many, Business: capitalize(b.one), Businesses: capitalize(b.many), aBusiness: withArticle(b.one),
    appointment: a.one, appointments: a.many, Appointment: capitalize(a.one), Appointments: capitalize(a.many), anAppointment: withArticle(a.one),
    service: s.one, services: s.many, Service: capitalize(s.one), Services: capitalize(s.many), aService: withArticle(s.one),
    resource: r.one, resources: r.many, Resource: capitalize(r.one), Resources: capitalize(r.many), aResource: withArticle(r.one),
    location: l.one, locations: l.many, Location: capitalize(l.one), Locations: capitalize(l.many), aLocation: withArticle(l.one),
    visit: v.one, visits: v.many, Visit: capitalize(v.one), Visits: capitalize(v.many), aVisit: withArticle(v.one),
    practitioner: pr.one, practitioners: pr.many, Practitioner: capitalize(pr.one), Practitioners: capitalize(pr.many), aPractitioner: withArticle(pr.one),
    practice: pc.one, practices: pc.many, Practice: capitalize(pc.one), Practices: capitalize(pc.many), aPractice: withArticle(pc.one),
  };
}

/** All the words for one business, including its second words. Use this rather than `termWords` when you have a profile. */
export function profileWords(profile: BusinessProfile): TermWords {
  return termWords(profile.terms, profile.aliases);
}

export function resourceKindLabel(kind: ResourceKind): string {
  return resourceKindLabels[kind];
}

export function hasFeature(profile: BusinessProfile, feature: FeatureKey): boolean {
  return profile.features[feature];
}

/**
 * One set of words for a screen that spans several businesses, such as the customer portal. One business, or
 * several with the same words, keep theirs; a mix falls back to the plain "other" words.
 */
export function sharedBusinessProfile(profiles: BusinessProfile[]): BusinessProfile {
  const [first, ...rest] = profiles;
  if (!first) return defaultBusinessProfile;
  const key = (profile: BusinessProfile) => JSON.stringify([profile.terms, profile.features]);
  if (rest.every((profile) => key(profile) === key(first))) return first;
  const neutral = resolveBusinessProfile({ businessType: "other" });
  // Keep a feature on when every business has it, so a shared screen never hides something all of them use.
  const features = Object.fromEntries(
    featureKeys.map((feature) => [feature, profiles.every((profile) => profile.features[feature])]),
  ) as Features;
  return { ...neutral, features };
}
