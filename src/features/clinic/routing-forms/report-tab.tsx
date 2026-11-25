"use client";

import { ChartColumn, FileDown, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { OptionSelect } from "@/components/form-fields";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Meter, MeterIndicator, MeterTrack } from "@/components/ui/meter";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useTerms } from "@/features/terms/business-profile-context";
import { cn } from "@/lib/utils";
import type { RoutingFormSummary, RoutingReport } from "@/lib/routing-forms";

import { reportQuery, useRoutingReport } from "./queries";

const rangeChoices = [{ value: "7", label: "Last 7 days" }, { value: "30", label: "Last 30 days" }, { value: "90", label: "Last 90 days" }];

function Funnel({ report }: { report: RoutingReport }) {
  const steps = [
    { label: "Opened the form", value: report.opened },
    { label: "Answered the questions", value: report.answered },
    { label: "Were shown times", value: report.slotShown },
    { label: "Booked", value: report.booked },
  ];
  const top = Math.max(report.opened, 1);
  return (
    <ol aria-label="From opening to booking" className="flex flex-col gap-3">
      {steps.map((step) => (
        <li key={step.label} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-3 text-sm"><span>{step.label}</span><span className="font-medium tabular-nums">{step.value} <span className="font-normal text-muted-foreground text-xs">({Math.round((step.value / top) * 100)}%)</span></span></div>
          <Meter value={step.value} max={top} aria-label={`${step.label}: ${step.value}`}><MeterTrack className="rounded-full"><MeterIndicator className="rounded-full" /></MeterTrack></Meter>
        </li>
      ))}
    </ol>
  );
}

function Loaded({ report }: { report: RoutingReport }) {
  const t = useTerms();
  if (report.opened === 0) {
    return (
      <Empty className="p-6">
        <EmptyHeader>
          <EmptyMedia variant="icon"><ChartColumn aria-hidden="true" /></EmptyMedia>
          <EmptyTitle className="text-base">No responses in this period</EmptyTitle>
          <EmptyDescription>Once a live form is opened, you will see where {t.customers} drop off here.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardPanel className="flex flex-col gap-1">
          <p className="text-muted-foreground text-sm">Answered but did not book last week</p>
          <p className="font-heading font-semibold text-4xl tabular-nums" aria-label={`${report.answeredNotBookedLastWeek} ${t.customers} answered but did not book last week`}>{report.answeredNotBookedLastWeek}</p>
          <p className="text-muted-foreground text-xs">{t.Customers} who answered, were sent to book, and had not booked {report.abandonedAfterHours} hours later. A quick call or message can win them back.</p>
        </CardPanel>
      </Card>
      <Card>
        <CardHeader><CardTitle>From opening to booking</CardTitle><CardDescription>How far {t.customers} got.</CardDescription></CardHeader>
        <CardPanel><Funnel report={report} /></CardPanel>
      </Card>
      <Card>
        <CardHeader><CardTitle>By route</CardTitle><CardDescription>Where each route sent {t.customers}, and how many booked.</CardDescription></CardHeader>
        <CardPanel className="p-0">
          <Table>
            <TableHeader><TableRow><TableHead>Route</TableHead><TableHead className="text-end">Responses</TableHead><TableHead className="text-end">Booked</TableHead><TableHead className="text-end">Did not book</TableHead></TableRow></TableHeader>
            <TableBody>
              {report.perRoute.length === 0 ? <TableRow><TableCell colSpan={4} className="text-muted-foreground">No routes were used in this period.</TableCell></TableRow> : report.perRoute.map((route) => (
                <TableRow key={route.routeId}><TableCell className="font-medium">{route.name}</TableCell><TableCell className="text-end tabular-nums">{route.responses}</TableCell><TableCell className="text-end tabular-nums">{route.booked}</TableCell><TableCell className="text-end tabular-nums">{route.notBooked}</TableCell></TableRow>
              ))}
            </TableBody>
          </Table>
        </CardPanel>
      </Card>
    </div>
  );
}

export function ReportTab({ forms }: { forms: readonly RoutingFormSummary[] }) {
  const [formId, setFormId] = useState("");
  const [period, setPeriod] = useState(() => ({ days: "30", now: Date.now() }));
  const range = { from: new Date(period.now - Number(period.days) * 86_400_000).toISOString(), to: new Date(period.now).toISOString() };
  const query = useRoutingReport(formId, range.from, range.to);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-40 flex-1 flex-col gap-1.5">
          <Label htmlFor="routing-report-form">Form</Label>
          <OptionSelect id="routing-report-form" value={formId} onValueChange={setFormId} options={[{ value: "", label: "All forms" }, ...forms.map((form) => ({ value: form.id, label: form.name }))]} />
        </div>
        <div className="flex min-w-40 flex-1 flex-col gap-1.5">
          <Label htmlFor="routing-report-range">Period</Label>
          <OptionSelect id="routing-report-range" value={period.days} onValueChange={(days) => setPeriod({ days, now: Date.now() })} options={rangeChoices} />
        </div>
        <a href={`/api/staff/routing-forms/report/export?${reportQuery(formId, range.from, range.to)}`} className={cn(buttonVariants({ variant: "outline", size: "lg" }), "min-h-11 sm:min-h-9")}><FileDown aria-hidden="true" /> Export CSV</a>
      </div>
      {query.isPending ? <div role="status" aria-label="Loading the report" className="flex flex-col gap-3"><Skeleton className="h-24 w-full" /><Skeleton className="h-40 w-full" /></div>
        : query.isError ? (
          <Alert variant="error"><TriangleAlert aria-hidden="true" /><AlertTitle>The report could not be loaded</AlertTitle>
            <AlertDescription><p>{query.error instanceof Error ? query.error.message : "Something went wrong."}</p><Button size="sm" variant="outline" className="mt-2 min-h-11 sm:min-h-8" onClick={() => void query.refetch()}>Try again</Button></AlertDescription></Alert>
        ) : <Loaded report={query.data} />}
    </div>
  );
}
