"use client";

import { History, Search } from "lucide-react";
import Link from "next/link";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Frame, FramePanel } from "@/components/ui/frame";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AdminAuditRow } from "@/lib/admin-contracts";

import { useAuditEvents } from "./admin-api";
import { formatDateTime, humaniseAction, shortId } from "./admin-format";
import { EmptyPanel, ErrorPanel, LoadingRows, ScreenHeader } from "./screen-states";

function BusinessLink({ id }: { id: string | null }) {
  return id ? <Link className="font-mono text-xs underline-offset-4 hover:underline" href={`/admin/tenants/${encodeURIComponent(id)}`}>{shortId(id)}</Link> : <span className="text-muted-foreground">Platform</span>;
}

function AuditTable({ rows }: { rows: AdminAuditRow[] }) {
  return (
    <>
      <Table className="max-md:hidden" aria-label="Audit events">
        <TableHeader><TableRow><TableHead>When</TableHead><TableHead>What</TableHead><TableHead>Business</TableHead><TableHead>Reason</TableHead><TableHead>Operator</TableHead></TableRow></TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="whitespace-nowrap tabular-nums">{formatDateTime(row.occurredAt)}</TableCell>
              <TableCell className="font-medium">{humaniseAction(row.action)}</TableCell>
              <TableCell><BusinessLink id={row.tenantId} /></TableCell>
              <TableCell className="max-w-72 whitespace-normal text-muted-foreground">{row.reason ?? "None given"}</TableCell>
              <TableCell className="font-mono text-xs">{shortId(row.adminUserId)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <ul className="flex flex-col divide-y md:hidden" aria-label="Audit events">
        {rows.map((row) => (
          <li key={row.id} className="flex flex-col gap-1 py-3 text-sm">
            <p className="font-medium">{humaniseAction(row.action)}</p>
            <p className="text-xs text-muted-foreground"><time dateTime={row.occurredAt}>{formatDateTime(row.occurredAt)}</time> · operator <span className="font-mono">{shortId(row.adminUserId)}</span></p>
            {row.reason ? <p className="text-muted-foreground">{row.reason}</p> : null}
            <p className="text-xs"><BusinessLink id={row.tenantId} /></p>
          </li>
        ))}
      </ul>
    </>
  );
}

export function AuditScreen({ initialTenant = "" }: { initialTenant?: string }) {
  const [typed, setTyped] = useState(initialTenant);
  const [tenantId, setTenantId] = useState(initialTenant);
  const query = useAuditEvents(tenantId);

  function submit(event: FormEvent) {
    event.preventDefault();
    setTenantId(typed.trim());
  }

  return (
    <>
      <ScreenHeader title="Audit" description="Everything operators have done, newest first. Every change has a reason." />
      <form onSubmit={submit} role="search" className="flex gap-2">
        <InputGroup className="max-w-xl">
          <InputGroupAddon><Search aria-hidden="true" /></InputGroupAddon>
          <InputGroupInput aria-label="Business id" placeholder="Filter by business id" value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" spellCheck={false} />
        </InputGroup>
        <Button type="submit" size="lg" className="min-h-11" variant="outline">Filter</Button>
        {tenantId ? <Button type="button" size="lg" className="min-h-11" variant="ghost" onClick={() => { setTyped(""); setTenantId(""); }}>Clear</Button> : null}
      </form>
      <Frame>
        <FramePanel>
          {query.isPending ? <LoadingRows label="Loading audit events" rows={5} /> : null}
          {query.isError ? <ErrorPanel error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} /> : null}
          {query.data && query.data.length === 0 ? <EmptyPanel icon={<History aria-hidden="true" />} title="Nothing recorded" description={tenantId ? "No operator has acted on this business." : "Operator actions appear here."} /> : null}
          {query.data && query.data.length > 0 ? <AuditTable rows={query.data} /> : null}
        </FramePanel>
      </Frame>
    </>
  );
}
