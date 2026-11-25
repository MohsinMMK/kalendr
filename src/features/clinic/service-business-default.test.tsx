/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { useForm, type UseFormReturn } from "react-hook-form";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Schedule } from "@/lib/availability-setup";
import { serviceSetupUpdateSchema } from "@/lib/service-setup";
import { defaultCancelPolicy } from "@/lib/cancel-policy";
import { useTerms } from "@/features/terms/business-profile-context";

import { ServiceCancelPolicyTab } from "./service-cancel-policy-tab";
import { updateFrom, type ServiceFormValues } from "./service-editor-model";
import { ServiceHoursTab } from "./service-hours-tab";

const schedules: Schedule[] = [
  { id: "sch-a", practitionerId: "p1", name: "Home visits", timezone: "Asia/Kolkata", isDefault: false, version: 1, weekly: [], overrides: [] } as unknown as Schedule,
  { id: "sch-b", practitionerId: "p1", name: "Tuesday afternoons", timezone: "Asia/Kolkata", isDefault: false, version: 1, weekly: [], overrides: [] } as unknown as Schedule,
];

vi.mock("./availability-api", () => ({ listSchedules: vi.fn(async () => schedules) }));

afterEach(cleanup);

const captured: { form: UseFormReturn<ServiceFormValues> | null } = { form: null };

function Harness({ scheduleId }: { scheduleId: string | null }) {
  const form = useForm<ServiceFormValues>({
    defaultValues: { basics: { scheduleId, restrictionScheduleId: null } } as unknown as ServiceFormValues,
  });
  useEffect(() => { captured.form = form; });
  return <ServiceHoursTab practitioners={[{ id: "p1" } as never]} form={form} saves />;
}

describe("Hours: business default versus this service", () => {
  it("shows that the usual hours are used while no schedule is chosen", async () => {
    render(<Harness scheduleId={null} />);
    expect(await screen.findByText("Uses business default")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /Use this schedule/ })).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Customize" })).toBeEnabled();
  });

  it("Customize starts from the first schedule on offer", async () => {
    render(<Harness scheduleId={null} />);
    await userEvent.click(await screen.findByRole("button", { name: "Customize" }));
    expect(captured.form?.getValues("basics.scheduleId")).toBe("sch-a");
    expect(await screen.findByRole("combobox", { name: /Use this schedule/ })).toBeInTheDocument();
    expect(screen.getByText("Set for this one")).toBeInTheDocument();
  });

  it("Reset writes null, which the server stores as the usual hours", async () => {
    render(<Harness scheduleId="sch-b" />);
    await userEvent.click(await screen.findByRole("button", { name: "Reset to default" }));
    expect(captured.form?.getValues("basics.scheduleId")).toBeNull();
    expect(screen.getByText("Uses business default")).toBeInTheDocument();

    // The same value goes to the server unchanged, and its schema accepts it.
    const body = updateFrom(captured.form!.getValues(), 3);
    expect(body.basics?.scheduleId).toBeNull();
    expect(serviceSetupUpdateSchema.safeParse({ expectedVersion: 3, basics: { scheduleId: null } }).success).toBe(true);
  });
});

describe("Settings with no business-wide value", () => {
  it("does not offer Customize or Reset on the cancel policy, because each service stores its own values", () => {
    function CancelHarness() {
      const terms = useTerms();
      const form = useForm<ServiceFormValues>({ defaultValues: { cancelPolicy: defaultCancelPolicy } as unknown as ServiceFormValues });
      return <ServiceCancelPolicyTab form={form} terms={terms} />;
    }
    render(<CancelHarness />);
    expect(screen.queryByText("Uses business default")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Customize" })).not.toBeInTheDocument();
  });
});
