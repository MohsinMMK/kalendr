/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReportChart, ReportMetric } from "@/lib/reports";

import { ChartCard, MetricCard, TableCard } from "./reports-parts";

afterEach(cleanup);

// Recharts measures its box; jsdom has none, so the chart view is not drawn here. The table view is what a screen reader reads.
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });

const metric: ReportMetric = { key: "no_show_rate", label: "No-show rate", value: 25, previous: 20, format: "percent", formula: "No-show rate: no-shows ÷ visits that were due.", href: "/bookings?tab=past" };

describe("report parts", () => {
  it("shows a figure with how it moved, how it is worked out and a link to the rows", () => {
    render(<MetricCard metric={metric} currency="INR" />);
    expect(screen.getByTestId("metric-no_show_rate")).toHaveTextContent("25%");
    expect(screen.getByText("Up 25% on the period before")).toBeInTheDocument();
    expect(screen.getByText("No-show rate: no-shows ÷ visits that were due.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /See the rows/ })).toHaveAttribute("href", "/bookings?tab=past");
  });

  it("says so when there is nothing to compare or divide by", () => {
    render(<MetricCard metric={{ ...metric, value: null, previous: null }} currency="INR" />);
    expect(screen.getByTestId("metric-no_show_rate")).toHaveTextContent("—");
    expect(screen.getByText("No earlier figure to compare")).toBeInTheDocument();
  });

  it("gives every chart a table view", async () => {
    const chart: ReportChart = { key: "by_day", title: "Bookings by day", kind: "bar", xKey: "day", series: [{ key: "bookings", label: "Bookings" }], rows: [{ day: "2026-09-01", bookings: 3 }, { day: "2026-09-02", bookings: 5 }] };
    render(<ChartCard chart={chart} currency="INR" />);
    await userEvent.setup().click(screen.getByRole("tab", { name: "Table" }));
    expect(screen.getByRole("columnheader", { name: "Bookings" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "5" })).toBeInTheDocument();
  });

  it("links a table row to the bookings behind it, and says when it is empty", () => {
    const { rerender } = render(<TableCard currency="INR" table={{ key: "t", title: "By source", hrefKey: "href", columns: [{ key: "name", label: "Source" }, { key: "total", label: "Bookings", format: "count" }], rows: [{ name: "Booking page", total: 4, href: "/bookings?sources=online" }] }} />);
    expect(screen.getByRole("link", { name: "See the rows for Booking page" })).toHaveAttribute("href", "/bookings?sources=online");
    rerender(<TableCard currency="INR" table={{ key: "t", title: "By source", columns: [{ key: "name", label: "Source" }], rows: [] }} />);
    expect(screen.getByText("Nothing in this period.")).toBeInTheDocument();
  });
});
