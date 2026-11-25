// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mutate = vi.fn();
const state = { data: { optimizedSlots: false, rebookFromOldLink: true } as { optimizedSlots: boolean; rebookFromOldLink: boolean } | undefined, isPending: false, isError: false };

vi.mock("./queries/service-booking-options", () => ({
  useServiceBookingOptions: () => state,
  useSaveServiceBookingOptions: () => ({ mutate, isPending: false }),
}));

import { ServiceOptimizedSlotsField } from "./service-optimized-slots-field";
import { ServiceRebookLinkField } from "./service-rebook-link-field";

describe("the service booking option fields", () => {
  beforeEach(() => { mutate.mockClear(); state.isPending = false; state.isError = false; });

  it("saves optimized slots as soon as the switch is turned on", async () => {
    render(<ServiceOptimizedSlotsField serviceId="s1" />);
    await userEvent.click(screen.getByRole("switch", { name: /next to existing bookings/i }));
    expect(mutate).toHaveBeenCalledWith({ optimizedSlots: true }, expect.anything());
  });

  it("shows Book again as on by default and saves turning it off", async () => {
    render(<ServiceRebookLinkField serviceId="s1" />);
    const toggle = screen.getByRole("switch", { name: /book again/i });
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    expect(mutate).toHaveBeenCalledWith({ rebookFromOldLink: false }, expect.anything());
  });

  it("says nothing is saved in the preview", () => {
    render(<ServiceOptimizedSlotsField serviceId="s1" saves={false} />);
    expect(screen.getByText(/not saved in the preview/i)).toBeInTheDocument();
  });
});
