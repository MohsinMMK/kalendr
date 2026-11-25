import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  allowedLocationIds, andLocation, assertLocationAllowed, assertLocationVisible, canUseLocation, filterAllowedLocations,
  isLimitedToLocations, locationCondition, locationOrNoneCondition, visibleCustomerCondition,
} from "./location-scope";
import { ApiError } from "./api-error";

const dialect = new PgDialect();
const render = (fragment: ReturnType<typeof sql>) => dialect.sqlToQuery(fragment);

const everyone = { locationIds: null };
const absent = {};
const limited = { locationIds: ["loc-a", "loc-b"] };

describe("location scope", () => {
  it("treats null, absent and empty as no limit", () => {
    for (const context of [everyone, absent, { locationIds: [] }]) {
      expect(allowedLocationIds(context)).toBeNull();
      expect(isLimitedToLocations(context)).toBe(false);
      expect(canUseLocation(context, "anywhere")).toBe(true);
      expect(locationCondition(context, sql`appointment.location_id`)).toBeNull();
    }
    expect(render(andLocation(everyone, sql`appointment.location_id`)).sql.trim()).toBe("");
  });

  it("allows only the listed locations, and a record with no location stays business-wide", () => {
    expect(canUseLocation(limited, "loc-a")).toBe(true);
    expect(canUseLocation(limited, "loc-z")).toBe(false);
    expect(canUseLocation(limited, null)).toBe(true);
  });

  it("binds the ids as parameters, never into the text", () => {
    const query = render(locationCondition(limited, sql`appointment.location_id`)!);
    expect(query.sql).toBe("appointment.location_id in ($1, $2)");
    expect(query.params).toEqual(["loc-a", "loc-b"]);
    const orNone = render(locationOrNoneCondition(limited, sql`block.location_id`)!);
    expect(orNone.sql).toContain("block.location_id is null or");
    expect(locationOrNoneCondition(everyone, sql`block.location_id`)).toBeNull();
  });

  it("reads another location's record as missing and refuses booking into it", () => {
    expect(() => assertLocationVisible(limited, "loc-z", () => new ApiError(404, "gone", "Not found."))).toThrowError(expect.objectContaining({ status: 404 }));
    expect(() => assertLocationVisible(limited, "loc-a", () => new ApiError(404, "gone", "Not found."))).not.toThrow();
    expect(() => assertLocationAllowed(limited, "loc-z")).toThrowError(expect.objectContaining({ status: 403, code: "location_not_allowed" }));
    expect(() => assertLocationAllowed(limited, "loc-b")).not.toThrow();
    expect(() => assertLocationAllowed(everyone, "loc-z")).not.toThrow();
  });

  it("offers a limited person their own locations only, without changing the original list", () => {
    const all = [{ id: "loc-a" }, { id: "loc-b" }, { id: "loc-c" }];
    expect(filterAllowedLocations({ locationIds: ["loc-b"] }, all)).toEqual([{ id: "loc-b" }]);
    expect(filterAllowedLocations(everyone, all)).toEqual(all);
    expect(all).toHaveLength(3);
  });

  it("limits customers to those seen at the locations, or not seen anywhere yet", () => {
    expect(visibleCustomerCondition({ ...everyone, tenantId: "t" }, sql`patients.id`)).toBeNull();
    const query = render(visibleCustomerCondition({ ...limited, tenantId: "t" }, sql`patients.id`)!);
    expect(query.sql).toContain("not exists");
    expect(query.params).toContain("loc-a");
  });
});
