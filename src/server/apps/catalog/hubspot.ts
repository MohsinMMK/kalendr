import { z } from "zod";

import { verdictForStatus, type AppDefinition, type AppRequest } from "../types";

/**
 * HubSpot (feature 55): creates or updates one contact when a customer books. Only the fields the owner turns on are
 * sent, each under the property name the owner chose, and only for customers who agreed to marketing messages.
 */

const propertyName = z.string().trim().regex(/^[a-z][a-z0-9_]{0,60}$/, "Use a HubSpot property name: lowercase letters, numbers and underscores.");
const mappedField = z.object({ enabled: z.boolean(), target: propertyName }).strict();

const settingsSchema = z.object({
  events: z.array(z.enum(["appointment.created", "appointment.completed"])).min(1, "Choose at least one thing that updates a contact.").max(2),
  fields: z.object({ email: z.object({ enabled: z.literal(true), target: z.literal("email") }).strict(), firstName: mappedField, lastName: mappedField, phone: mappedField }).strict(),
}).strict();
type HubspotSettings = z.infer<typeof settingsSchema>;

const credentialSchema = z.object({
  accessToken: z.string().trim().regex(/^[A-Za-z0-9._-]{20,200}$/, "That does not look like a HubSpot private app token."),
}).strict();

const API = "https://api.hubapi.com";

const headers = (token: string): Record<string, string> => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` });

export const hubspotApp: AppDefinition<HubspotSettings> = {
  key: "hubspot",
  name: "HubSpot",
  tagline: "Keep customers in HubSpot up to date.",
  description: "When someone books, Kalendr adds or updates them as a contact in HubSpot, matched on email, so your sales and follow-up lists stay current.",
  category: "crm",
  dataSent: [
    "The customer's email address, always, to match or create the contact.",
    "Only the other fields you turn on below: first name, last name, phone.",
    "Only for customers who agreed to marketing messages. Everyone else is skipped.",
  ],
  allowedHosts: ["api.hubapi.com"],
  credentialFields: [{
    key: "accessToken", label: "HubSpot private app token", placeholder: "pat-…",
    help: "In HubSpot, make a private app with the crm.objects.contacts.write scope and copy its access token.",
  }],
  credentialSchema,
  settingFields: [
    { kind: "choices", key: "events", label: "Update the contact when", options: [
      { value: "appointment.created", label: "A booking is made" },
      { value: "appointment.completed", label: "A visit finishes" },
    ] },
    { kind: "mapping", key: "fields", label: "Fields to send", help: "Each one goes to the HubSpot property you name. Leave a field off to keep it out of HubSpot.", rows: [
      { key: "email", label: "Email", locked: true, defaultTarget: "email" },
      { key: "firstName", label: "First name", defaultTarget: "firstname" },
      { key: "lastName", label: "Last name", defaultTarget: "lastname" },
      { key: "phone", label: "Phone", defaultTarget: "phone" },
    ] },
  ],
  settingsSchema,
  defaultSettings: {
    events: ["appointment.created"],
    fields: { email: { enabled: true, target: "email" }, firstName: { enabled: true, target: "firstname" }, lastName: { enabled: false, target: "lastname" }, phone: { enabled: false, target: "phone" } },
  },
  events: ["appointment.created", "appointment.completed"],
  uninstallNote: "HubSpot does not let Kalendr revoke the token from here. Delete the private app, or its token, in HubSpot to finish.",
  listensTo: (settings) => settings.events,
  needsCustomer: () => true,
  build({ event, settings, credentials, facts }) {
    if (!settings.events.some((type) => type === event.type)) return { skip: "not_subscribed" };
    const customer = facts.customer;
    if (!customer) return { skip: "not_subscribed" };
    if (!customer.marketingConsent) return { skip: "no_consent" };
    if (!customer.email) return { skip: "no_email" };
    const properties: Record<string, string> = { [settings.fields.email.target]: customer.email };
    if (settings.fields.firstName.enabled) properties[settings.fields.firstName.target] = customer.firstName;
    if (settings.fields.lastName.enabled) properties[settings.fields.lastName.target] = customer.lastName;
    if (settings.fields.phone.enabled && customer.phone) properties[settings.fields.phone.target] = customer.phone;
    // One batch call that creates the contact or updates the one with this email, so a repeat is harmless.
    const request: AppRequest = {
      url: `${API}/crm/v3/objects/contacts/batch/upsert`, method: "POST", headers: headers(credentials.accessToken ?? ""),
      body: JSON.stringify({ inputs: [{ idProperty: "email", id: customer.email, properties }] }),
    };
    return { request };
  },
  buildCheck: ({ credentials }) => ({ url: `${API}/crm/v3/objects/contacts?limit=1`, method: "GET", headers: headers(credentials.accessToken ?? "") }),
  interpret: ({ statusCode }) => verdictForStatus(statusCode),
};
