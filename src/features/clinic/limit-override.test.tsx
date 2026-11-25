/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isLimitError, LimitOverridePrompt, useLimitOverride } from "./limit-override";
import { StaffApiError } from "./queries/http";

afterEach(cleanup);

function Harness({ send }: { send: (body: unknown) => Promise<void> }) {
  const [slot, setSlot] = useState("9:00");
  const override = useLimitOverride(slot);
  async function book() {
    try { await send({ slot, ...override.takeBody() }); override.clear(); } catch (cause) { if (override.capture(cause)) return; throw cause; }
  }
  return (
    <div>
      <button onClick={() => void book()}>Book</button>
      <button onClick={() => setSlot("10:00")}>Pick another time</button>
      <LimitOverridePrompt override={override} actionLabel="Book anyway" onConfirm={() => void book()} />
    </div>
  );
}

describe("limit override", () => {
  it("knows a full limit from any other refusal", () => {
    expect(isLimitError(new StaffApiError("Full.", 409, "limit_reached"))).toBe(true);
    expect(isLimitError(new StaffApiError("Full.", 409, "customer_cap_reached"))).toBe(true);
    expect(isLimitError(new StaffApiError("Taken.", 409, "slot_unavailable"))).toBe(false);
  });

  it("explains the limit and sends the chosen reason on the next try only", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new StaffApiError("Tuesday is full.", 409, "limit_reached"))
      .mockResolvedValue(undefined);
    render(<Harness send={send} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Book" }));
    expect(await screen.findByText("Tuesday is full.")).toBeInTheDocument();
    expect(send).toHaveBeenLastCalledWith({ slot: "9:00" });
    const anyway = screen.getByRole("button", { name: "Book anyway" });
    expect(anyway).toBeDisabled();
    await user.click(screen.getByRole("combobox", { name: "Why go past it?" }));
    await user.click(await screen.findByRole("option", { name: "It is urgent" }));
    await user.click(anyway);
    expect(send).toHaveBeenLastCalledWith({ slot: "9:00", limitOverrideReason: "emergency" });
    expect(screen.queryByText("Tuesday is full.")).not.toBeInTheDocument();
  });

  it("drops the question when another time is picked", async () => {
    const send = vi.fn().mockRejectedValueOnce(new StaffApiError("A customer is at the cap.", 409, "customer_cap_reached"));
    render(<Harness send={send} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Book" }));
    expect(await screen.findByText("A customer is at the cap.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Pick another time" }));
    expect(screen.queryByText("A customer is at the cap.")).not.toBeInTheDocument();
  });
});
