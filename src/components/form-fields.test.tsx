import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { DatePicker } from "@/components/date-picker";
import { SelectField, TextField } from "@/components/form-fields";
import { chooseDate, chooseOption } from "@/test/choose-option";

function Harness() {
  const [value, setValue] = useState("");
  const [date, setDate] = useState("2026-09-22");
  return <>
    <SelectField label="Owner" value={value} onValueChange={setValue} placeholder="Pick" options={[{ value: "", label: "Whole clinic" }, { value: "a", label: "Asha" }]} />
    <TextField id="name" label="Name" error="Enter a name" />
    <DatePicker aria-label="Visit date" value={date} onValueChange={setDate} />
    <output>{date}</output>
  </>;
}

describe("coss form compositions", () => {
  it("selects by label, links labels and errors, and picks calendar dates", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("combobox", { name: "Owner" });
    await chooseOption(user, trigger, "Asha");
    expect(trigger).toHaveTextContent("Asha");
    await chooseOption(user, trigger, "Whole clinic");
    expect(trigger).toHaveTextContent("Whole clinic");
    const name = screen.getByLabelText("Name");
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAccessibleDescription("Enter a name");
    await chooseDate(user, screen.getByRole("button", { name: /Visit date/ }), /September 23.*2026/);
    expect(screen.getByRole("status")).toHaveTextContent("2026-09-23");
  });
});
