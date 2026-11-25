import { googleAnalyticsApp } from "./catalog/google-analytics";
import { hubspotApp } from "./catalog/hubspot";
import { slackApp } from "./catalog/slack";
import type { AppDefinition, RegisteredApp } from "./types";

/**
 * Every app that installs from the Apps page, in the order they are shown. The list is code, not a table: an app is
 * reviewed and shipped like any other change, and a business only ever records that it turned one on.
 *
 * To add an app, write one module under ./catalog that satisfies AppDefinition and list it here. Install, the
 * settings form, delivery, retries, the activity log and removal all come from the framework.
 */

export function defineApp<Settings extends Record<string, unknown>>(app: AppDefinition<Settings>): RegisteredApp {
  const parse = (value: unknown): Settings | null => {
    const result = app.settingsSchema.safeParse(value);
    return result.success ? result.data : null;
  };
  return {
    key: app.key, name: app.name, tagline: app.tagline, description: app.description, category: app.category, dataSent: app.dataSent,
    allowedHosts: app.allowedHosts, credentialFields: app.credentialFields, credentialSchema: app.credentialSchema, settingFields: app.settingFields,
    defaultSettings: app.defaultSettings, events: app.events, uninstallNote: app.uninstallNote ?? null, hasRevoke: Boolean(app.buildRevoke),
    parseSettings(value) {
      const result = app.settingsSchema.safeParse(value);
      if (result.success) return { ok: true, settings: result.data };
      const fieldErrors = Object.fromEntries(Object.entries(result.error.flatten().fieldErrors).flatMap(([key, messages]) => (Array.isArray(messages) && messages.length > 0 ? [[key, messages.map(String)]] : [])));
      return { ok: false, fieldErrors };
    },
    listensTo: (settings) => { const parsed = parse(settings); return parsed ? app.listensTo(parsed) : []; },
    needsCustomer: (settings) => { const parsed = parse(settings); return parsed && app.needsCustomer ? app.needsCustomer(parsed) : false; },
    build(input) {
      const settings = parse(input.settings);
      return settings ? app.build({ ...input, settings }) : { skip: "nothing_to_send" };
    },
    buildCheck(input) {
      const settings = parse(input.settings);
      return settings ? app.buildCheck({ ...input, settings }) : null;
    },
    interpret: (response) => app.interpret(response),
    buildRevoke: (credentials) => (app.buildRevoke ? app.buildRevoke(credentials) : null),
  };
}

export const apps: readonly RegisteredApp[] = [defineApp(slackApp), defineApp(hubspotApp), defineApp(googleAnalyticsApp)];

export function getApp(key: string): RegisteredApp | null {
  return apps.find((app) => app.key === key) ?? null;
}
