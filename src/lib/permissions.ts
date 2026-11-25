/**
 * What each person may do in a clinic. A role gives a starting set (its preset);
 * the owner or an admin can then switch single permissions on or off for one person.
 * The server resolves this on every request, so a change applies at once.
 */
import { isClinicalBusinessType } from "@/lib/business-types";
import { defaultBusinessProfile, profileWords, type BusinessProfile } from "@/lib/terminology";

export type StaffRole = "owner" | "admin" | "receptionist" | "practitioner" | "billing" | "read_only";

export const permissionKeys = [
  "appointments.book",
  "series.manage",
  "classes.manage",
  "waitlist.manage",
  "appointments.status",
  "records.view",
  "records.accessLog",
  "profile.own",
  "hours.own",
  "hours.edit",
  "schedule.read",
  "settings.manage",
  "brand.manage",
  "team.manage",
  "audit.view",
  "messages.retry",
  "inbox.reply",
  "payments.collect",
  "payments.refund",
  "payments.close_day",
  "payments.settings",
  "invoices.issue",
  "calendars.own",
  "calendars.manage",
  "privacy.manage",
  "billing.manage",
  "api.manage",
  "apps.manage",
  "spam.manage",
  "services.manage",
  "customers.manage",
  "customers.merge",
  "campaigns.manage",
  "org.manage",
  "routing.manage",
  "routing.report",
  "reports.view",
  "reports.revenue",
  "reports.export",
] as const;

export type Permission = (typeof permissionKeys)[number];
export type PermissionOverrides = Partial<Record<Permission, boolean>>;

export interface PermissionInfo {
  key: Permission;
  label: string;
  description: string;
}

/**
 * The permission list in one business's words. Healthcare and dental read exactly as they always have;
 * the records group is left out when records are turned off. Use `permissionGroups` when no business is known.
 */
export function permissionGroupsFor(profile: BusinessProfile): { title: string; items: PermissionInfo[] }[] {
  const t = profileWords(profile);
  const clinical = isClinicalBusinessType(profile.businessType);
  const followUps = profile.features.recalls ? ` and ${clinical ? "recalls" : "follow-ups"}` : "";
  const groups: { title: string; items: PermissionInfo[] }[] = [
    {
      title: "Appointments",
      items: [
        { key: "appointments.book", label: `Book and change ${t.visits}`, description: `Book, move and cancel ${t.visits}, add ${t.customers}, run the waitlist${followUps}.` },
        { key: "series.manage", label: `Book and change repeating ${t.visits}`, description: `Book a ${t.visit} that repeats, and change or cancel a whole repeating series. Changing one ${t.visit} in a series needs only the permission to book and change ${t.visits}.` },
        { key: "waitlist.manage", label: "Run the waitlist offers", description: `Offer a time to someone waiting by hand, let a held time go, choose who is asked first and switch automatic offers on or off per ${t.service}.` },
        { key: "appointments.status", label: `Move ${t.visits} along`, description: "Check in, start, complete, mark no-show and mark forms received." },
      ],
    },
    {
      title: `${t.Customer} records`,
      items: [
        {
          key: "records.view",
          label: `Open ${t.customer} records`,
          description: clinical
            ? `Read and write notes, reports and prescriptions. ${t.Providers} see only their own ${t.customers}.`
            : `Read and write notes and files. ${t.Providers} see only their own ${t.customers}.`,
        },
        { key: "records.accessLog", label: "See who opened a record", description: "View the access history on each record." },
      ],
    },
    {
      title: `${t.Customers} and marketing`,
      items: [
        { key: "customers.manage", label: `Manage ${t.customer} profiles`, description: `Add notes and tags, fill in extra fields, block a ${t.customer} from booking online and save segments. Notes are not clinical records.` },
        { key: "customers.merge", label: `Merge duplicate ${t.customers}`, description: `Combine two profiles of the same person. Asks for a second-factor code and can be undone for 30 days. Owners and admins by default.` },
        { key: "campaigns.manage", label: "Run campaigns", description: `Set up recall, birthday and win-back messages and one-off offers to ${t.customers} who agreed to marketing. Turn them on, pause them and read the results.` },
      ],
    },
    {
      title: "Payments",
      items: [
        { key: "payments.collect", label: "Take payments", description: `Record cash, UPI, card or bank payments for ${t.visits} at the desk.` },
        { key: "payments.refund", label: "Give refunds", description: "Give money back against a payment, with a reason. Payments themselves are never edited." },
        { key: "invoices.issue", label: "Issue invoices and credit notes", description: `Issue a numbered invoice or receipt for a ${t.visit}, correct one with a credit note, set up GST and export invoices for the accountant.` },
        { key: "payments.settings", label: "Set up online payments", description: "Connect the business's payment account, set prices and deposits, and write the cancellation and refund policy." },
        { key: "payments.close_day", label: "Close the day", description: "See the day-end summary, count the cash drawer and close the day. A closed day can't be changed." },
      ],
    },
    {
      title: "Reports",
      items: [
        { key: "reports.view", label: "See reports", description: `Open bookings, utilisation, no-show and ${t.customer} reports. ${t.Providers} see only their own numbers.` },
        { key: "reports.revenue", label: "See revenue reports", description: `See money figures: what came in, refunds and what is still owed. ${t.Providers} see only their own.` },
        { key: "reports.export", label: "Export reports", description: "Download any report as a CSV file. Every export is written to the activity log." },
      ],
    },
    {
      title: "Own profile",
      items: [
        { key: "profile.own", label: "Edit own profile", description: `Change their name and, for ${t.providers}, the public profile ${t.customers} see.` },
        { key: "hours.own", label: "Change own working hours", description: `${t.Providers} set the days and times they can be booked.` },
        { key: "calendars.own", label: "Connect own calendars", description: "Link Google, Outlook or Apple calendars so busy time blocks bookings and bookings appear there." },
      ],
    },
    {
      title: t.Business,
      items: [
        { key: "schedule.read", label: "See why a time is missing", description: `Pick a ${t.provider}, ${t.service} and day and see which rule closed each time. Changes nothing.` },
        { key: "hours.edit", label: "Manage everyone's hours", description: `Change any ${t.provider}'s hours and add or remove blocked time.` },
        { key: "settings.manage", label: `Manage ${t.business} settings`, description: `${t.Business} details, services, ${clinical ? "rooms" : t.resources}, booking page and website connection.` },
        { key: "brand.manage", label: "Change the logo and cover", description: `Change or remove the ${t.business}'s logo and cover photo, on My profile and in settings. They lead the booking page and the sidebar.` },
        { key: "team.manage", label: "Manage the team", description: "Add people, send invites, change roles and permissions, deactivate accounts." },
        { key: "audit.view", label: "See the activity log", description: "Who changed what, and every refused attempt." },
        { key: "calendars.manage", label: "Manage calendar sync", description: "See who has connected a calendar and choose how much of an appointment is written into calendars." },
        { key: "inbox.reply", label: `Read and answer ${t.customer} replies`, description: `Open the Inbox, read what ${t.customers} wrote back on WhatsApp and reply.` },
        { key: "messages.retry", label: "Resend failed messages", description: `See messages that could not be sent to ${t.customers} and try them again.` },
        { key: "billing.manage", label: "Manage plan and billing", description: "Choose or change the plan, update billing details, cancel the subscription and download Kalendr's invoices. Owners only by default." },
        { key: "api.manage", label: "Manage API keys and webhooks", description: `Create API keys and webhook addresses so other software can read and book ${t.visits}. Only the owner can create a key.` },
        { key: "apps.manage", label: "Install and remove apps", description: `Connect apps such as Slack or a CRM from the Apps page, choose what they receive, and remove them. An app only sees ${t.visits} and ${t.customers} data it was set up to receive.` },
        { key: "services.manage", label: `Manage ${t.service} templates and special links`, description: `Define a ${t.service} once and push it to every branch, lock the fields branches may not change, and make one-off or limited booking links.` },
        { key: "spam.manage", label: "Review spam reports and the blocklist", description: `Decide on bookings staff reported as spam, and add or remove blocked emails, phone numbers and domains.` },
        { key: "classes.manage", label: `Run classes`, description: `Add classes, set up their timetable, change seats, cancel a session and tell everyone.` },
        { key: "org.manage", label: "Manage the organisation", description: "Teams and departments, custom roles, company sign-in, directory sync, attributes and organisation defaults." },
        { key: "routing.manage", label: "Build routing forms", description: `Questions that send ${t.customers} to the right ${t.service} and ${t.provider}, plus the report and the wrong-assignment list.` },
        { key: "routing.report", label: `Flag a booking sent to the wrong ${t.provider}`, description: `Tell the owner a routed booking should have gone to someone else, so the form can be fixed.` },
        { key: "privacy.manage", label: "Handle privacy requests", description: `Approve or refuse ${t.customer} requests to download, correct or erase their data, and set how long data is kept.` },
      ],
    },
  ];
  return profile.features.records ? groups : groups.filter((group) => !group.items.some((item) => item.key === "records.view"));
}

/** Every permission in healthcare words. Screens that know the business use `permissionGroupsFor`. */
export const permissionGroups = permissionGroupsFor(defaultBusinessProfile);

export const permissionLabels: Record<Permission, string> = Object.fromEntries(
  permissionGroups.flatMap((group) => group.items.map((item) => [item.key, item.label])),
) as Record<Permission, string>;

export const rolePresets: Record<StaffRole, readonly Permission[]> = {
  owner: permissionKeys,
  // Spending money on the subscription stays with the owner unless they hand it over, so the admin preset leaves it out.
  admin: permissionKeys.filter((key) => key !== "billing.manage"),
  receptionist: ["appointments.book", "series.manage", "classes.manage", "waitlist.manage", "appointments.status", "schedule.read", "inbox.reply", "payments.collect", "payments.close_day", "invoices.issue", "customers.manage", "routing.report", "reports.view", "profile.own", "calendars.own"],
  practitioner: ["appointments.status", "schedule.read", "records.view", "routing.report", "reports.view", "profile.own", "calendars.own"],
  billing: ["payments.collect", "payments.refund", "payments.close_day", "invoices.issue", "reports.view", "reports.revenue", "reports.export", "profile.own", "billing.manage"],
  read_only: ["profile.own"],
};

export function isStaffRole(value: string): value is StaffRole {
  return Object.hasOwn(rolePresets, value);
}

/**
 * Role names in one business's words: the practitioner role is called by the provider word. A name the business gave a
 * role in Settings wins. Only the name changes; the role's key and its permissions do not.
 */
export function roleLabelsFor(profile: BusinessProfile): Record<StaffRole, string> {
  const t = profileWords(profile);
  const own = profile.roleNameOverrides;
  return {
    owner: own.owner ?? "Owner",
    admin: own.admin ?? "Admin",
    receptionist: own.receptionist ?? "Receptionist",
    practitioner: own.practitioner ?? t.Provider,
    billing: own.billing ?? "Billing",
    read_only: own.read_only ?? "Read only",
  };
}

export function roleDescriptionsFor(profile: BusinessProfile): Record<StaffRole, string> {
  const t = profileWords(profile);
  return {
    owner: `Everything, including the ${t.business}'s billing and closing the account.`,
    admin: "Everything except changing the owner.",
    receptionist: `Front desk: books ${t.visits}, checks ${t.customers} in, runs the waitlist.`,
    practitioner: profile.features.records
      ? `Sees their own schedule and ${t.customers}, writes records.`
      : `Sees their own schedule and ${t.customers}.`,
    billing: `Sees the schedule and ${t.customers}, takes payments and gives refunds.`,
    read_only: `Sees the schedule and ${t.customers}. Changes nothing.`,
  };
}

export const roleLabels: Record<StaffRole, string> = roleLabelsFor(defaultBusinessProfile);

export const roleDescriptions: Record<StaffRole, string> = roleDescriptionsFor(defaultBusinessProfile);

/** Roles someone can be given after they join. Owner is fixed; doctor needs a practitioner profile. */
export const assignableRoles = ["admin", "receptionist", "practitioner", "billing", "read_only"] as const;
export type AssignableRole = (typeof assignableRoles)[number];

export function isPermission(value: string): value is Permission {
  return (permissionKeys as readonly string[]).includes(value);
}

/**
 * Keeps only overrides that differ from the starting set: the role's preset, or the custom role's permissions when the
 * person has one. The owner never has overrides.
 */
export function cleanOverrides(role: StaffRole, overrides: unknown, customPermissions?: readonly string[] | null): PermissionOverrides {
  if (role === "owner" || !overrides || typeof overrides !== "object") return {};
  const preset = new Set<string>(customPermissions ?? rolePresets[role]);
  const clean: PermissionOverrides = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (!isPermission(key) || typeof value !== "boolean") continue;
    if (preset.has(key) !== value) clean[key] = value;
  }
  return clean;
}

/**
 * What a person may do. A custom role (feature 53) replaces the role's preset with its own list of permission keys; the
 * built-in `role` stays as its base for the second-factor and owner rules. The owner is never narrowed by a custom role.
 */
export function resolvePermissions(role: StaffRole, overrides: unknown, customPermissions?: readonly string[] | null): Permission[] {
  const custom = role === "owner" ? null : customPermissions ?? null;
  const clean = cleanOverrides(role, overrides, custom);
  const preset = new Set<string>(custom ?? rolePresets[role]);
  return permissionKeys.filter((key) => clean[key] ?? preset.has(key));
}

export function hasPermission(permissions: readonly Permission[] | undefined, permission: Permission): boolean {
  return Boolean(permissions?.includes(permission));
}
