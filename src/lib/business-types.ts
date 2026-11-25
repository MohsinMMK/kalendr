import type { BookingMode } from "@/lib/domain";

/**
 * The kinds of business Kalendr is set up for. The owner picks one at setup; it presets the words the
 * product uses, the starter services and which features are on. Every word and feature can then be
 * changed per business in Settings (see `resolveBusinessProfile` in `terminology.ts`).
 */
export const businessTypeIds = [
  "healthcare",
  "dental",
  "wellness",
  "real_estate",
  "professional_services",
  "retail",
  "education",
  "other",
] as const;

export type BusinessTypeId = (typeof businessTypeIds)[number];

export const defaultBusinessType: BusinessTypeId = "healthcare";

export const termKeys = [
  "customer",
  "provider",
  "business",
  "appointment",
  "service",
  "resource",
  "location",
] as const;

export type TermKey = (typeof termKeys)[number];

export interface Term {
  singular: string;
  plural: string;
}

export type Terms = Record<TermKey, Term>;

/**
 * Second words some types use alongside a term: healthcare says "visit" and "appointment", "practitioner" and
 * "doctor", "practice" and "clinic". Each alias falls back to its base term, so other types read one word.
 */
export const aliasBases = { visit: "appointment", practitioner: "provider", practice: "business" } as const satisfies Record<string, TermKey>;
export type AliasKey = keyof typeof aliasBases;
export type Aliases = Record<AliasKey, Term>;

export const featureKeys = [
  "records",
  "recalls",
  "dependents",
  "dateOfBirth",
  "providerCredentials",
  "customerTypes",
  "notifyOnMove",
] as const;

export type FeatureKey = (typeof featureKeys)[number];
export type Features = Record<FeatureKey, boolean>;

export const resourceKinds = [
  "operatory",
  "room",
  "chair",
  "equipment",
  "space",
  "station",
  "vehicle",
  "other",
] as const;

export type ResourceKind = (typeof resourceKinds)[number];

export const resourceKindLabels: Record<ResourceKind, string> = {
  operatory: "Operatory",
  room: "Room",
  chair: "Chair",
  equipment: "Equipment",
  space: "Space",
  station: "Station",
  vehicle: "Vehicle",
  other: "Other",
};

/** Labels for the provider profile fields that are stored in fixed columns. */
export interface ProviderFieldLabels {
  /** Short title shown before or after the name, such as "Dr." or "Senior stylist". */
  title: string;
  titlePlaceholder: string;
  /** Stored in `practitioners.specialty`. */
  specialty: string;
  specialtyPlaceholder: string;
  qualifications: string;
  registrationNumber: string;
  bio: string;
}

export interface StarterService {
  name: string;
  description: string;
  durationMinutes: number;
  bookingMode: BookingMode;
  requiredResourceKind?: ResourceKind;
}

export interface BusinessTypePreset {
  id: BusinessTypeId;
  label: string;
  /** One line shown on the setup card. */
  description: string;
  /** Example businesses, shown under the label. */
  examples: string;
  terms: Terms;
  /** Only types whose existing copy uses a second word set these. */
  aliases?: Partial<Aliases>;
  features: Features;
  starterServices: StarterService[];
  resourceKinds: ResourceKind[];
  providerFields: ProviderFieldLabels;
}

const term = (singular: string, plural: string): Term => ({ singular, plural });

const allFeaturesOff: Features = {
  records: false,
  recalls: false,
  dependents: false,
  dateOfBirth: false,
  providerCredentials: false,
  customerTypes: true,
  notifyOnMove: true,
};

const neutralProviderFields: ProviderFieldLabels = {
  title: "Role",
  titlePlaceholder: "Consultant",
  specialty: "Focus area",
  specialtyPlaceholder: "What they help with",
  qualifications: "Qualifications",
  registrationNumber: "Licence number",
  bio: "About",
};

const healthcare: BusinessTypePreset = {
  id: "healthcare",
  label: "Healthcare",
  description: "Clinics, hospitals and therapists.",
  examples: "Clinic, hospital, physiotherapy, therapy",
  terms: {
    customer: term("patient", "patients"),
    provider: term("doctor", "doctors"),
    business: term("clinic", "clinics"),
    appointment: term("appointment", "appointments"),
    service: term("appointment type", "appointment types"),
    resource: term("room", "rooms"),
    location: term("location", "locations"),
  },
  aliases: {
    visit: term("visit", "visits"),
    practitioner: term("practitioner", "practitioners"),
    practice: term("practice", "practices"),
  },
  features: {
    records: true,
    recalls: true,
    dependents: true,
    dateOfBirth: true,
    providerCredentials: true,
    customerTypes: true,
    notifyOnMove: true,
  },
  starterServices: [
    { name: "Consultation", description: "Meet a doctor and plan next steps.", durationMinutes: 30, bookingMode: "instant" },
    { name: "Follow-up", description: "A scheduled review after a previous visit.", durationMinutes: 20, bookingMode: "instant" },
    { name: "Health check", description: "A longer preventive visit.", durationMinutes: 45, bookingMode: "instant" },
    { name: "Procedure", description: "A planned procedure. The clinic confirms a suitable time.", durationMinutes: 60, bookingMode: "request", requiredResourceKind: "room" },
  ],
  resourceKinds: ["room", "equipment", "other"],
  providerFields: {
    title: "Title",
    titlePlaceholder: "Dr.",
    specialty: "Specialty",
    specialtyPlaceholder: "General medicine",
    qualifications: "Qualifications",
    registrationNumber: "Registration number",
    bio: "About",
  },
};

const dental: BusinessTypePreset = {
  ...healthcare,
  id: "dental",
  label: "Dental",
  description: "Dental clinics and orthodontists.",
  examples: "Dental clinic, orthodontist, oral surgery",
  terms: { ...healthcare.terms, resource: term("chair", "chairs") },
  starterServices: [
    { name: "Consultation", description: "A first visit or review of a dental concern.", durationMinutes: 30, bookingMode: "instant" },
    { name: "Dental cleaning", description: "A routine cleaning and oral health check.", durationMinutes: 45, bookingMode: "instant", requiredResourceKind: "chair" },
    { name: "Filling", description: "Treat a cavity or replace an old filling.", durationMinutes: 45, bookingMode: "instant", requiredResourceKind: "chair" },
    { name: "Root canal", description: "Treat an infected tooth. The clinic confirms a suitable time.", durationMinutes: 60, bookingMode: "request", requiredResourceKind: "chair" },
    { name: "Extraction", description: "Remove a tooth. The clinic confirms a suitable time.", durationMinutes: 30, bookingMode: "request", requiredResourceKind: "chair" },
    { name: "Braces review", description: "A scheduled orthodontic check.", durationMinutes: 20, bookingMode: "instant" },
  ],
  resourceKinds: ["chair", "operatory", "room", "equipment"],
  providerFields: { ...healthcare.providerFields, specialtyPlaceholder: "General dentistry" },
};

const wellness: BusinessTypePreset = {
  id: "wellness",
  label: "Salon, spa and fitness",
  description: "Beauty, grooming, spa and fitness.",
  examples: "Salon, barber, spa, nail studio, gym, yoga",
  terms: {
    customer: term("client", "clients"),
    provider: term("stylist", "stylists"),
    business: term("salon", "salons"),
    appointment: term("appointment", "appointments"),
    service: term("service", "services"),
    resource: term("station", "stations"),
    location: term("location", "locations"),
  },
  features: { ...allFeaturesOff, recalls: true },
  starterServices: [
    { name: "General visit", description: "Not sure what you need? Book a general visit and talk it through.", durationMinutes: 30, bookingMode: "instant" },
    { name: "Haircut", description: "Wash, cut and finish.", durationMinutes: 45, bookingMode: "instant", requiredResourceKind: "station" },
    { name: "Hair colour", description: "Colour, toning and finish.", durationMinutes: 120, bookingMode: "instant", requiredResourceKind: "station" },
    { name: "Manicure", description: "Shape, cuticle care and polish.", durationMinutes: 40, bookingMode: "instant" },
    { name: "Massage", description: "A full-body relaxing massage.", durationMinutes: 60, bookingMode: "instant", requiredResourceKind: "room" },
    { name: "Consultation", description: "Talk through what you'd like before booking.", durationMinutes: 15, bookingMode: "instant" },
  ],
  resourceKinds: ["station", "chair", "room", "equipment", "other"],
  providerFields: {
    ...neutralProviderFields,
    titlePlaceholder: "Senior stylist",
    specialty: "Specialty",
    specialtyPlaceholder: "Colour and cuts",
    registrationNumber: "Licence number",
  },
};

const realEstate: BusinessTypePreset = {
  id: "real_estate",
  label: "Real estate",
  description: "Agencies, brokers and property managers.",
  examples: "Estate agent, broker, property manager, builder",
  terms: {
    customer: term("client", "clients"),
    provider: term("agent", "agents"),
    business: term("agency", "agencies"),
    appointment: term("viewing", "viewings"),
    service: term("appointment type", "appointment types"),
    resource: term("property", "properties"),
    location: term("office", "offices"),
  },
  features: { ...allFeaturesOff },
  starterServices: [
    { name: "Buyer consultation", description: "Talk through what you're looking for.", durationMinutes: 30, bookingMode: "instant" },
    { name: "Property viewing", description: "Visit a property with an agent.", durationMinutes: 30, bookingMode: "request" },
    { name: "Valuation", description: "An agent visits to value your property.", durationMinutes: 45, bookingMode: "request" },
    { name: "Lease signing", description: "Review and sign your agreement.", durationMinutes: 30, bookingMode: "request", requiredResourceKind: "room" },
  ],
  resourceKinds: ["space", "room", "vehicle", "other"],
  providerFields: {
    ...neutralProviderFields,
    titlePlaceholder: "Sales agent",
    specialty: "Area",
    specialtyPlaceholder: "Residential sales, Indiranagar",
    registrationNumber: "RERA number",
  },
};

const professionalServices: BusinessTypePreset = {
  id: "professional_services",
  label: "Professional services",
  description: "Agencies, consultants, legal and finance.",
  examples: "Agency, consultant, lawyer, accountant",
  terms: {
    customer: term("client", "clients"),
    provider: term("consultant", "consultants"),
    business: term("firm", "firms"),
    appointment: term("meeting", "meetings"),
    service: term("meeting type", "meeting types"),
    resource: term("room", "rooms"),
    location: term("office", "offices"),
  },
  features: { ...allFeaturesOff },
  starterServices: [
    { name: "General meeting", description: "Not sure what you need? Book a general visit and talk it through.", durationMinutes: 30, bookingMode: "instant" },
    { name: "Introductory call", description: "A short call to see how we can help.", durationMinutes: 20, bookingMode: "instant" },
    { name: "Consultation", description: "A working session on your question.", durationMinutes: 60, bookingMode: "instant" },
    { name: "Project review", description: "Review progress and next steps.", durationMinutes: 45, bookingMode: "instant" },
    { name: "Workshop", description: "A longer planned session. We confirm a suitable time.", durationMinutes: 120, bookingMode: "request", requiredResourceKind: "room" },
  ],
  resourceKinds: ["room", "equipment", "other"],
  providerFields: { ...neutralProviderFields, titlePlaceholder: "Senior consultant", specialtyPlaceholder: "Tax and compliance" },
};

const retail: BusinessTypePreset = {
  id: "retail",
  label: "Retail and shops",
  description: "Shops, showrooms, fittings and pickups.",
  examples: "Boutique, showroom, tailor, opticals, e-commerce",
  terms: {
    customer: term("customer", "customers"),
    provider: term("specialist", "specialists"),
    business: term("store", "stores"),
    appointment: term("appointment", "appointments"),
    service: term("service", "services"),
    resource: term("fitting room", "fitting rooms"),
    location: term("store", "stores"),
  },
  features: { ...allFeaturesOff },
  starterServices: [
    { name: "General visit", description: "Not sure what you need? Book a general visit and talk it through.", durationMinutes: 30, bookingMode: "instant" },
    { name: "Personal shopping", description: "One-to-one help choosing what suits you.", durationMinutes: 45, bookingMode: "instant" },
    { name: "Fitting", description: "Try on and adjust your order.", durationMinutes: 30, bookingMode: "instant", requiredResourceKind: "room" },
    { name: "Order pickup", description: "Collect an order at a time that suits you.", durationMinutes: 10, bookingMode: "instant" },
    { name: "Product demo", description: "See a product in action before you buy.", durationMinutes: 30, bookingMode: "instant" },
  ],
  resourceKinds: ["room", "station", "equipment", "other"],
  providerFields: { ...neutralProviderFields, titlePlaceholder: "Store specialist", specialtyPlaceholder: "Bridal wear" },
};

const education: BusinessTypePreset = {
  id: "education",
  label: "Education and tutoring",
  description: "Tutors, coaching centres and classes.",
  examples: "Tutor, coaching centre, music or language classes",
  terms: {
    customer: term("student", "students"),
    provider: term("tutor", "tutors"),
    business: term("centre", "centres"),
    appointment: term("session", "sessions"),
    service: term("class", "classes"),
    resource: term("room", "rooms"),
    location: term("location", "locations"),
  },
  features: { ...allFeaturesOff, recalls: true, dependents: true },
  starterServices: [
    { name: "General session", description: "Not sure what you need? Book a general visit and talk it through.", durationMinutes: 30, bookingMode: "instant" },
    { name: "Trial class", description: "A first session to meet the tutor.", durationMinutes: 30, bookingMode: "instant" },
    { name: "One-to-one session", description: "A focused session on one subject.", durationMinutes: 60, bookingMode: "instant" },
    { name: "Exam preparation", description: "Practice and review before an exam.", durationMinutes: 90, bookingMode: "instant", requiredResourceKind: "room" },
    { name: "Parent meeting", description: "Talk through progress and plans.", durationMinutes: 20, bookingMode: "request" },
  ],
  resourceKinds: ["room", "equipment", "other"],
  providerFields: { ...neutralProviderFields, titlePlaceholder: "Maths tutor", specialty: "Subjects", specialtyPlaceholder: "Maths and physics" },
};

const other: BusinessTypePreset = {
  id: "other",
  label: "Something else",
  description: "Any business that runs on appointments.",
  examples: "Repairs, photography, pet care, events",
  terms: {
    customer: term("customer", "customers"),
    provider: term("team member", "team members"),
    business: term("business", "businesses"),
    appointment: term("appointment", "appointments"),
    service: term("service", "services"),
    resource: term("resource", "resources"),
    location: term("location", "locations"),
  },
  features: { ...allFeaturesOff },
  starterServices: [
    { name: "General visit", description: "Not sure what you need? Book a general visit and talk it through.", durationMinutes: 30, bookingMode: "instant" },
    { name: "Standard appointment", description: "Our usual appointment.", durationMinutes: 60, bookingMode: "instant" },
  ],
  resourceKinds: ["room", "space", "equipment", "vehicle", "other"],
  providerFields: neutralProviderFields,
};

export const businessTypes: Record<BusinessTypeId, BusinessTypePreset> = {
  healthcare,
  dental,
  wellness,
  real_estate: realEstate,
  professional_services: professionalServices,
  retail,
  education,
  other,
};

export function isBusinessTypeId(value: unknown): value is BusinessTypeId {
  return typeof value === "string" && (businessTypeIds as readonly string[]).includes(value);
}

export function getBusinessType(value: unknown): BusinessTypePreset {
  return businessTypes[isBusinessTypeId(value) ? value : defaultBusinessType];
}

/** Healthcare and dental keep clinical wording and features; every other type must not show any. */
export function isClinicalBusinessType(value: BusinessTypeId): boolean {
  return value === "healthcare" || value === "dental";
}

/** What each term means, for the Settings screen where owners rename them. */
export const termLabels: Record<TermKey, { label: string; hint: string }> = {
  customer: { label: "People who book", hint: "The people who make appointments with you." },
  provider: { label: "People who serve them", hint: "The staff members customers book with." },
  business: { label: "Your business", hint: "How customers refer to your place." },
  appointment: { label: "A booking", hint: "One booked time slot." },
  service: { label: "What can be booked", hint: "The things a customer chooses from." },
  resource: { label: "Rooms or equipment", hint: "Things a booking needs besides a person." },
  location: { label: "Places", hint: "Where appointments happen." },
};

/** Plain names and one-line explanations for the switches on the Settings screen. */
export const featureLabels: Record<FeatureKey, { label: string; hint: string }> = {
  records: { label: "Records", hint: "Keep notes and files for each customer after a booking." },
  recalls: { label: "Follow-ups", hint: "Remind customers to book again after a set time." },
  dependents: { label: "Booking for someone else", hint: "Let a customer book for a child or another family member." },
  dateOfBirth: { label: "Date of birth", hint: "Ask for a date of birth when someone books." },
  providerCredentials: { label: "Qualifications", hint: "Show qualifications and registration numbers for staff." },
  customerTypes: { label: "New or returning", hint: "No longer asked when someone books." },
  notifyOnMove: { label: "Tell customers when you move them", hint: "When staff drag an appointment to a new time, the box to tell the customer starts ticked. Staff can change it each time." },
};
