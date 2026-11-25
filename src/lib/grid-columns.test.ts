import { describe, expect, it } from "vitest";

import {
  columnsChanged, hideColumn, MAX_COLUMN_NAME, moveColumn, moveColumnTo, renameColumn, resetColumns, resizeColumn, resolveColumns, showColumn,
  visibleColumns, type GridColumnSpec,
} from "./grid-columns";
import { parseWorkspaceLayout, type ListLayout } from "./workspace-layout";

const specs: GridColumnSpec[] = [
  { id: "name", label: "Patient", system: true },
  { id: "phone", label: "Phone", system: true },
  { id: "email", label: "Email", system: true },
  { id: "next", label: "Next booking" },
  { id: "cf-tier", label: "Tier", custom: true },
];
const ids = (layout: ListLayout | undefined, from = specs) => resolveColumns(from, layout).map((column) => column.id);
const shown = (layout: ListLayout | undefined, from = specs) => visibleColumns(resolveColumns(from, layout)).map((column) => column.id);

describe("resolveColumns", () => {
  it("is the defaults when nothing was changed", () => {
    expect(ids(undefined)).toEqual(["name", "phone", "email", "next", "cf-tier"]);
    expect(resolveColumns(specs, undefined).every((column) => !column.hidden && !column.renamed)).toBe(true);
  });

  it("uses the business's own words for a renamed column", () => {
    const [name] = resolveColumns(specs, { labels: { name: "Client" } });
    expect(name).toMatchObject({ title: "Client", label: "Patient", renamed: true });
  });

  it("ignores a rename of a custom field, whose name lives on the field", () => {
    const column = resolveColumns(specs, { labels: { "cf-tier": "Hacked" } }).find((item) => item.id === "cf-tier");
    expect(column?.title).toBe("Tier");
  });

  it("drops ids the table no longer has and keeps new columns beside the one they followed", () => {
    expect(ids({ order: ["gone", "email", "name"] })).toEqual(["email", "next", "cf-tier", "name", "phone"]);
    expect(shown({ hidden: ["gone", "phone"] })).toEqual(["name", "email", "next", "cf-tier"]);
  });

  it("hides what is hidden by default until the business shows it", () => {
    const withExtra = [...specs, { id: "source", label: "Booked via", defaultHidden: true }];
    expect(shown(undefined, withExtra)).not.toContain("source");
    const next = showColumn(withExtra, undefined, "source");
    expect(shown(next, withExtra)).toContain("source");
    expect(shown(hideColumn(withExtra, next, "source"), withExtra)).not.toContain("source");
  });
});

describe("changing columns", () => {
  it("renames, and takes the override away for an empty or default name", () => {
    const renamed = renameColumn(specs, undefined, "phone", "  Mobile   number ");
    expect(renamed).toEqual({ labels: { phone: "Mobile number" } });
    expect(renameColumn(specs, renamed, "phone", "")).toBeUndefined();
    expect(renameColumn(specs, renamed, "phone", "Phone")).toBeUndefined();
    expect(renameColumn(specs, undefined, "cf-tier", "Nope")).toBeUndefined();
    expect(renameColumn(specs, undefined, "nothing", "Nope")).toBeUndefined();
  });

  it("limits a name to its length", () => {
    const long = renameColumn(specs, undefined, "name", "x".repeat(200));
    expect(long?.labels?.name).toHaveLength(MAX_COLUMN_NAME);
  });

  it("hides and shows, but never the last visible column", () => {
    const hidden = hideColumn(specs, undefined, "phone");
    expect(shown(hidden)).toEqual(["name", "email", "next", "cf-tier"]);
    expect(shown(showColumn(specs, hidden, "phone"))).toEqual(["name", "phone", "email", "next", "cf-tier"]);
    let layout: ListLayout | undefined;
    for (const id of ["name", "phone", "email", "next"]) layout = hideColumn(specs, layout, id);
    expect(shown(layout)).toEqual(["cf-tier"]);
    expect(shown(hideColumn(specs, layout, "cf-tier"))).toEqual(["cf-tier"]);
  });

  it("moves a column past the visible one beside it, leaving hidden ones where they are", () => {
    expect(ids(moveColumn(specs, undefined, "email", -1))).toEqual(["name", "email", "phone", "next", "cf-tier"]);
    const hiddenPhone = hideColumn(specs, undefined, "phone");
    // email moves before name, the visible column beside it; the hidden phone stays where it was.
    expect(shown(moveColumn(specs, hiddenPhone, "email", -1))).toEqual(["email", "name", "next", "cf-tier"]);
    expect(shown(moveColumn(specs, hiddenPhone, "email", 1))).toEqual(["name", "next", "email", "cf-tier"]);
    expect(moveColumn(specs, undefined, "name", -1)).toBeUndefined();
    expect(moveColumn(specs, undefined, "cf-tier", 1)).toBeUndefined();
  });

  it("drops a dragged column where the other one is", () => {
    expect(ids(moveColumnTo(specs, undefined, "name", "email"))).toEqual(["phone", "email", "name", "next", "cf-tier"]);
    expect(ids(moveColumnTo(specs, undefined, "next", "phone"))).toEqual(["name", "next", "phone", "email", "cf-tier"]);
    expect(moveColumnTo(specs, undefined, "name", "name")).toBeUndefined();
    expect(moveColumnTo(specs, undefined, "name", "unknown")).toBeUndefined();
  });

  it("keeps a dragged width within bounds and ignores unknown columns", () => {
    expect(resolveColumns(specs, resizeColumn(specs, undefined, "phone", 300.4))[1]?.width).toBe(300);
    expect(resolveColumns(specs, resizeColumn(specs, undefined, "phone", 5))[1]?.width).toBe(64);
    expect(resolveColumns(specs, resizeColumn(specs, undefined, "phone", 99999))[1]?.width).toBe(640);
    expect(resizeColumn(specs, undefined, "unknown", 200)).toBeUndefined();
  });

  it("stores nothing when a change brings the defaults back", () => {
    const moved = moveColumn(specs, undefined, "email", -1);
    expect(moveColumn(specs, moved, "email", 1)).toBeUndefined();
    const hidden = hideColumn(specs, undefined, "next");
    expect(showColumn(specs, hidden, "next")).toBeUndefined();
  });

  it("drops stored entries for columns that are gone when anything changes", () => {
    const stale: ListLayout = { order: ["email", "gone"], hidden: ["gone"], labels: { gone: "Old" }, widths: { gone: 200 } };
    const next = hideColumn(specs, stale, "next");
    expect(JSON.stringify(next)).not.toContain("gone");
    expect(shown(next)).toEqual(["name", "phone", "email", "cf-tier"]);
  });

  it("resets everything to the defaults", () => {
    const changed = renameColumn(specs, hideColumn(specs, undefined, "next"), "name", "Client");
    expect(columnsChanged(changed)).toBe(true);
    expect(resetColumns()).toBeUndefined();
    expect(columnsChanged(resetColumns())).toBe(false);
  });
});

describe("the stored layout", () => {
  it("keeps names and widths through the workspace layout schema, dropping a bad one by itself", () => {
    const layout = parseWorkspaceLayout({ pages: { patients: { lists: { columns: { order: ["email"], labels: { name: "Client" }, widths: { phone: 5000 } } } } } });
    const stored = layout.pages.patients?.lists?.columns;
    expect(stored?.labels).toEqual({ name: "Client" });
    expect(stored?.widths).toBeUndefined();
    expect(stored?.order).toEqual(["email"]);
  });
});
