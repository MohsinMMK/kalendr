import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { MemberLocationsField } from "./member-locations-field";

const places = [
  { id: "a", name: "Tolichowki", address: "1 Main Road", city: "Hyderabad" },
  { id: "b", name: "Banjara Hills", address: "2 Hill Road", city: "Hyderabad" },
];

function Harness({ initial = [], allowAll = true }: { initial?: string[]; allowAll?: boolean }) {
  const [value, setValue] = useState<string[]>(initial);
  return (
    <>
      <MemberLocationsField id="locations" locations={places} value={value} onChange={setValue} allowAll={allowAll} />
      <output data-testid="value">{JSON.stringify(value)}</output>
    </>
  );
}

afterEach(cleanup);

describe("MemberLocationsField", () => {
  it("starts on all locations, which is an empty list", () => {
    render(<Harness />);
    expect(screen.getByRole("combobox", { name: "Locations" }).textContent).toContain("All locations");
    expect(screen.getByTestId("value").textContent).toBe("[]");
  });

  it("limits to one place when it is picked, then back to all when 'All locations' is picked", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("combobox", { name: "Locations" }));
    await user.click(await screen.findByRole("option", { name: /Tolichowki/ }));
    expect(screen.getByTestId("value").textContent).toBe('["a"]');
    await user.click(await screen.findByRole("option", { name: /All locations/ }));
    expect(screen.getByTestId("value").textContent).toBe("[]");
  });

  it("shows the street under each name, and leaves 'All locations' out for someone who is limited themselves", async () => {
    const user = userEvent.setup();
    render(<Harness initial={["a"]} allowAll={false} />);
    await user.click(screen.getByRole("combobox", { name: "Locations" }));
    expect(await screen.findByText("2 Hill Road, Hyderabad")).toBeTruthy();
    expect(screen.queryByRole("option", { name: /All locations/ })).toBeNull();
  });
});
