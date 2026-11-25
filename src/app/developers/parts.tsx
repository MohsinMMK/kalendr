import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { ScrollAreaPrimitive, ScrollBar } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { OperationDoc, Row } from "@/app/developers/reference";
import { curlFor } from "@/app/developers/samples";

/** Small building blocks for the reference page. Plain HTML: it must read without a script and fit 360px. */

export function Heading({ id, children }: { id: string; children: ReactNode }): ReactNode {
  return <h2 id={id} className="scroll-mt-20 border-b pb-2 font-heading text-xl font-semibold tracking-tight text-foreground">{children}</h2>;
}

export function Prose({ children }: { children: ReactNode }): ReactNode {
  return <div className="space-y-3 text-base leading-relaxed text-foreground [&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.875em]">{children}</div>;
}

/** A code sample. The scrolling region is focusable so keyboard users can scroll a long line sideways. */
export function Code({ label, children }: { label: string; children: string }): ReactNode {
  return (
    <ScrollAreaPrimitive.Root className="max-w-full rounded-lg border bg-muted">
      <ScrollAreaPrimitive.Viewport data-slot="scroll-area-viewport" role="region" aria-label={label} className="rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ScrollAreaPrimitive.Content>
          <pre className="p-3 font-mono text-sm leading-relaxed text-foreground">
            <code>{children}</code>
          </pre>
        </ScrollAreaPrimitive.Content>
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar orientation="horizontal" />
    </ScrollAreaPrimitive.Root>
  );
}

export function Json({ label, value }: { label: string; value: unknown }): ReactNode {
  return <Code label={label}>{JSON.stringify(value, null, 2)}</Code>;
}

const cell = "whitespace-normal align-top leading-snug";

/** A table of fields, or of anything with a name, a kind and a note. */
export function FieldTable({ label, rows, showRequired = true }: { label: string; rows: Row[]; showRequired?: boolean }): ReactNode {
  return (
    <Table render={<div role="region" aria-label={label} tabIndex={0} />}>
      <TableHeader>
        <TableRow>
          <TableHead>Field</TableHead>
          <TableHead>Type</TableHead>
          {showRequired ? <TableHead>Required</TableHead> : null}
          <TableHead>Notes</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.name}>
            <TableCell className={`${cell} font-mono text-[0.8125rem]`}>{row.name}</TableCell>
            <TableCell className={`${cell} min-w-32 text-muted-foreground`}>{row.type}</TableCell>
            {showRequired ? <TableCell className={cell}>{row.required ? "Yes" : "No"}</TableCell> : null}
            <TableCell className={`${cell} min-w-48 text-muted-foreground`}>{row.description}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function SimpleTable({ label, head, rows }: { label: string; head: string[]; rows: ReactNode[][] }): ReactNode {
  return (
    <Table render={<div role="region" aria-label={label} tabIndex={0} />}>
      <TableHeader>
        <TableRow>{head.map((title) => <TableHead key={title}>{title}</TableHead>)}</TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => (
          <TableRow key={index}>
            {row.map((value, column) => <TableCell key={column} className={`${cell} ${column === 0 ? "font-mono text-[0.8125rem]" : "text-muted-foreground"}`}>{value}</TableCell>)}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function Operation({ operation, baseUrl }: { operation: OperationDoc; baseUrl: string }): ReactNode {
  const headingId = `${operation.anchor}-title`;
  const success = operation.responses.find((response) => response.status.startsWith("2"));
  const errors = operation.responses.filter((response) => !response.status.startsWith("2"));
  const sub = "mt-4 text-sm font-semibold uppercase tracking-wide text-muted-foreground";
  return (
    <section id={operation.anchor} aria-labelledby={headingId} className="scroll-mt-20 space-y-3 rounded-xl border bg-card p-4 text-card-foreground sm:p-5">
      <h3 id={headingId} className="flex flex-wrap items-center gap-2 font-heading text-lg font-semibold">
        <Badge variant={operation.method === "GET" ? "info" : "success"} size="lg">{operation.method}</Badge>
        <span className="break-all font-mono text-base">{operation.path}</span>
      </h3>
      <p className="text-sm text-muted-foreground">
        {operation.summary}. Scope: <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[0.875em] text-foreground">{operation.scope}</code>
      </p>
      <p className="whitespace-pre-line text-base leading-relaxed">{operation.description.replace(/\n\nRequires the .* scope\.$/, "")}</p>
      {operation.parameters.length > 0 ? (
        <>
          <h4 className={sub}>Parameters</h4>
          <SimpleTable
            label={`${operation.summary} parameters`}
            head={["Name", "In", "Type", "Required", "Notes"]}
            rows={operation.parameters.map((parameter) => [parameter.name, parameter.location, parameter.type, parameter.required ? "Yes" : "No", parameter.description])}
          />
        </>
      ) : null}
      {operation.body ? (
        <>
          <h4 className={sub}>Request body {operation.body.required ? "" : "(optional)"}</h4>
          <FieldTable label={`${operation.summary} request fields`} rows={operation.body.rows} />
          {operation.body.example ? <Json label={`${operation.summary} request example`} value={operation.body.example} /> : null}
        </>
      ) : null}
      {success ? (
        <>
          <h4 className={sub}>Response {success.status}</h4>
          <p className="text-sm text-muted-foreground">{success.description}</p>
          {success.rows.length > 0 ? <FieldTable label={`${operation.summary} response fields`} rows={success.rows} showRequired={false} /> : null}
          {success.example ? <Json label={`${operation.summary} response example`} value={success.example} /> : null}
        </>
      ) : null}
      <h4 className={sub}>Errors</h4>
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        {errors.map((response) => <li key={response.status}><span className="font-mono text-foreground">{response.status}</span> {response.description}</li>)}
      </ul>
      <h4 className={sub}>Example</h4>
      <Code label={`${operation.summary} curl example`}>{curlFor(operation.id, baseUrl)}</Code>
    </section>
  );
}
