import { render as baseRender, type RenderOptions } from "@testing-library/react";
import { NuqsTestingAdapter, type OnUrlUpdateFunction } from "nuqs/adapters/testing";
import type { ReactElement } from "react";

/** Renders with the address-bar adapter the booking pages get from `BookingShell`. */
export function render(ui: ReactElement, options: RenderOptions & { searchParams?: string; onUrlUpdate?: OnUrlUpdateFunction } = {}) {
  const { searchParams, onUrlUpdate, ...rest } = options;
  return baseRender(ui, {
    ...rest,
    wrapper: ({ children }) => (
      <NuqsTestingAdapter searchParams={searchParams} onUrlUpdate={onUrlUpdate}>{children}</NuqsTestingAdapter>
    ),
  });
}
