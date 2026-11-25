import { describe, expect, it } from "vitest";

import {
  defaultSidebarSettings,
  isSidebarCustomised,
  maxSidebarNameLength,
  readSidebarSettings,
  renameEntry,
  renameHeading,
  reorderSection,
  resolveSidebar,
  setEntryHidden,
  sidebarEntryIds,
  writeSidebarSettings,
} from "./sidebar";
import { profileWords, resolveBusinessProfile } from "./terminology";

const t = profileWords(resolveBusinessProfile({ businessType: "wellness" }));
const ids = (section: ReturnType<typeof resolveSidebar>["sections"][number]) => section.entries.map((entry) => entry.id);

describe("sidebar defaults", () => {
  it("lists the front desk and business entries in their usual order, in the business's words", () => {
    const sidebar = resolveSidebar(t);
    expect(sidebar.sections.map((section) => section.label)).toEqual(["Front desk", "Salon"]);
    expect(ids(sidebar.sections[0]!)).toEqual(["dashboard", "schedule", "bookings", "patients", "follow-ups", "classes", "messages"]);
    expect(ids(sidebar.sections[1]!)).toEqual(["records", "billing", "campaigns", "routing-forms", "offers", "reports", "reviews", "spam", "activity", "services", "doctors", "settings", "your-page", "help"]);
    expect(sidebar.labels.patients).toBe("Clients");
    expect(sidebar.labels.doctors).toBe("Stylists");
    expect(sidebar.labels.profile).toBe("My profile");
  });

  it("names every entry", () => {
    const sidebar = resolveSidebar(t);
    for (const id of sidebarEntryIds) expect(sidebar.labels[id].length).toBeGreaterThan(0);
  });
});

describe("renaming", () => {
  it("shows the business's own name for an entry and for a heading", () => {
    const settings = renameHeading(renameEntry(defaultSidebarSettings, "schedule", "Diary"), "front-desk", "Reception");
    const sidebar = resolveSidebar(t, settings);
    expect(sidebar.labels.schedule).toBe("Diary");
    expect(sidebar.entries.schedule.renamed).toBe(true);
    expect(sidebar.sections[0]!.label).toBe("Reception");
  });

  it("cleans a name and puts the default back for an empty one", () => {
    const named = renameEntry(defaultSidebarSettings, "bookings", "  Appointment   book  ");
    expect(named.names.bookings).toBe("Appointment book");
    expect(renameEntry(named, "bookings", "   ").names.bookings).toBeUndefined();
    expect(renameEntry(named, "bookings", "x".repeat(maxSidebarNameLength + 1)).names.bookings).toBeUndefined();
  });

  it("stores nothing for a name that equals the default", () => {
    const page = writeSidebarSettings(renameEntry(defaultSidebarSettings, "patients", "Clients"), t);
    expect(page).toEqual({});
  });

  it("follows the business's words when an entry keeps its default name", () => {
    const salon = resolveSidebar(t, readSidebarSettings(writeSidebarSettings(defaultSidebarSettings, t)));
    expect(salon.labels.patients).toBe("Clients");
    const clinic = profileWords(resolveBusinessProfile({ businessType: "healthcare" }));
    expect(resolveSidebar(clinic).labels.patients).toBe("Patients");
  });
});

describe("hiding", () => {
  it("hides an entry but still names it", () => {
    const sidebar = resolveSidebar(t, setEntryHidden(defaultSidebarSettings, "offers", true));
    expect(sidebar.entries.offers.hidden).toBe(true);
    expect(sidebar.labels.offers).toBe("Offers");
    expect(sidebar.entries.schedule.hidden).toBe(false);
  });

  it("never hides Settings, Help or My profile", () => {
    let settings = defaultSidebarSettings;
    for (const id of ["settings", "help", "profile"] as const) settings = setEntryHidden(settings, id, true);
    expect(settings.hidden).toEqual([]);
    const stored = readSidebarSettings({ lists: { entries: { hidden: ["settings", "help", "profile", "offers"] } } });
    expect(stored.hidden).toEqual(["offers"]);
    const sidebar = resolveSidebar(t, { ...defaultSidebarSettings, hidden: ["settings"] });
    expect(sidebar.entries.settings.hidden).toBe(false);
    expect(sidebar.entries.settings.locked).toBe(true);
  });

  it("shows an entry again", () => {
    const hidden = setEntryHidden(defaultSidebarSettings, "offers", true);
    expect(setEntryHidden(hidden, "offers", false).hidden).toEqual([]);
  });
});

describe("order", () => {
  it("reorders one section and leaves the other alone", () => {
    const settings = reorderSection(defaultSidebarSettings, "front-desk", ["messages", "dashboard", "schedule", "bookings", "patients", "follow-ups", "classes"]);
    const sidebar = resolveSidebar(t, settings);
    expect(ids(sidebar.sections[0]!)[0]).toBe("messages");
    expect(ids(sidebar.sections[1]!)).toEqual(ids(resolveSidebar(t).sections[1]!));
  });

  it("places entries the stored order does not know after the entry that precedes them by default", () => {
    const sidebar = resolveSidebar(t, { ...defaultSidebarSettings, order: ["patients", "schedule"] });
    expect(ids(sidebar.sections[0]!)).toEqual(["dashboard", "patients", "follow-ups", "classes", "messages", "schedule", "bookings"]);
  });

  it("ignores an id from another section when reordering", () => {
    const settings = reorderSection(defaultSidebarSettings, "front-desk", ["offers", "schedule"]);
    expect(ids(resolveSidebar(t, settings).sections[0]!).sort()).toEqual(ids(resolveSidebar(t).sections[0]!).sort());
  });
});

describe("storage", () => {
  it("round trips what differs from the defaults", () => {
    let settings = renameEntry(defaultSidebarSettings, "schedule", "Diary");
    settings = renameHeading(settings, "business", "Running the place");
    settings = setEntryHidden(settings, "offers", true);
    settings = reorderSection(settings, "front-desk", ["messages", "dashboard", "schedule", "bookings", "patients", "follow-ups", "classes"]);
    const page = writeSidebarSettings(settings, t);
    expect(page.options).toEqual({ "name-schedule": "Diary", "heading-business": "Running the place" });
    expect(page.lists?.entries?.hidden).toEqual(["offers"]);
    const read = readSidebarSettings(page);
    expect(resolveSidebar(t, read).labels.schedule).toBe("Diary");
    expect(ids(resolveSidebar(t, read).sections[0]!)[0]).toBe("messages");
    expect(read.hidden).toEqual(["offers"]);
  });

  it("stores nothing at all for the defaults, which is how reset works", () => {
    expect(writeSidebarSettings(defaultSidebarSettings, t)).toEqual({});
    const customised = setEntryHidden(defaultSidebarSettings, "offers", true);
    expect(isSidebarCustomised(customised)).toBe(true);
    expect(isSidebarCustomised(defaultSidebarSettings)).toBe(false);
    expect(isSidebarCustomised(readSidebarSettings({}))).toBe(false);
  });

  it("drops unknown ids, repeated ids and bad names from a stored page", () => {
    const read = readSidebarSettings({
      lists: { entries: { order: ["schedule", "ghost", "schedule", "patients"], hidden: ["ghost", "offers", "offers"] } },
      options: { "name-schedule": 12, "name-ghost": "Boo", "name-patients": "x".repeat(maxSidebarNameLength + 1), "heading-front-desk": " Reception ", "heading-ghost": "Nope" },
    });
    expect(read.order).toEqual(["schedule", "patients"]);
    expect(read.hidden).toEqual(["offers"]);
    expect(read.names).toEqual({});
    expect(read.headings).toEqual({ "front-desk": "Reception" });
  });

  it("survives an empty or missing page", () => {
    expect(readSidebarSettings(undefined)).toEqual(defaultSidebarSettings);
    expect(readSidebarSettings({})).toEqual(defaultSidebarSettings);
  });
});
