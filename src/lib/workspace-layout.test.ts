import { describe, expect, it } from "vitest";

import { orderServices, parseWorkspaceLayout } from "./workspace-layout";

const services = ["cleaning", "filling", "root-canal", "whitening"].map((id) => ({ id }));
const layoutWith = (order: string[]) => parseWorkspaceLayout({ pages: { profile: { lists: { services: { order } } } } });

describe("orderServices", () => {
  it("keeps the given order when the business has not arranged anything", () => {
    expect(orderServices(services, undefined).map((item) => item.id)).toEqual(["cleaning", "filling", "root-canal", "whitening"]);
    expect(orderServices(services, parseWorkspaceLayout({})).map((item) => item.id)).toEqual(["cleaning", "filling", "root-canal", "whitening"]);
  });

  it("lists services in the saved order", () => {
    const ordered = orderServices(services, layoutWith(["whitening", "cleaning", "root-canal", "filling"]));
    expect(ordered.map((item) => item.id)).toEqual(["whitening", "cleaning", "root-canal", "filling"]);
  });

  it("ignores ids that no longer exist and puts a new service after the one it followed", () => {
    const ordered = orderServices(services, layoutWith(["gone", "root-canal", "cleaning"]));
    expect(ordered.map((item) => item.id)).toEqual(["root-canal", "whitening", "cleaning", "filling"]);
  });

  it("ignores another page's order", () => {
    const layout = parseWorkspaceLayout({ pages: { today: { lists: { services: { order: ["whitening"] } } } } });
    expect(orderServices(services, layout).map((item) => item.id)).toEqual(["cleaning", "filling", "root-canal", "whitening"]);
  });
});
