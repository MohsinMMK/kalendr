import { type ReportKey, type ReportResult } from "../../lib/reports";
import { bookingsReport } from "./bookings";
import type { ReportContext } from "./common";
import { customersReport } from "./customers";
import { noShowsReport } from "./noshows";
import { overviewReport } from "./overview";
import { revenueReport } from "./revenue";
import { satisfactionReport } from "./satisfaction";
import { sourcesReport } from "./sources";
import { utilisationReport } from "./utilisation";

const builders: Record<ReportKey, (context: ReportContext) => Promise<ReportResult>> = {
  overview: overviewReport,
  bookings: bookingsReport,
  utilisation: utilisationReport,
  noshows: noShowsReport,
  revenue: revenueReport,
  customers: customersReport,
  sources: sourcesReport,
  satisfaction: satisfactionReport,
};

/** Works out one report. The same function builds the screen's numbers and the CSV, here or in the worker. */
export function buildReport(report: ReportKey, context: ReportContext): Promise<ReportResult> {
  return builders[report](context);
}
