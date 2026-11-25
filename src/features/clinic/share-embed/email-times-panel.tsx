"use client";

import { Copy } from "lucide-react";
import { useState } from "react";

import { SelectField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { EmbedContextView } from "@/server/email-times";

import { copyHtml, copyText } from "./copy";
import { useEmailTimes } from "./queries";

/** The next six open times for a service as a snippet for an email. A snapshot: the booking page checks each time again. */
export function EmailTimesPanel({ context, serviceSlug }: { context: EmbedContextView; serviceSlug: string | null }) {
  const [chosen, setChosen] = useState<string | null>(null);
  const preselected = context.services.find((service) => service.slug === serviceSlug)?.id ?? null;
  const serviceId = chosen ?? preselected ?? context.services[0]?.id ?? null;
  const times = useEmailTimes(serviceId);

  if (context.services.length === 0) {
    return <Alert><AlertDescription>Add a service first, then you can send its open times in an email.</AlertDescription></Alert>;
  }
  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-sm">Paste the next open times into an email. Each time links to your booking page with that time already chosen.</p>
      <SelectField label="Service" value={serviceId ?? ""} options={context.services.map((service) => ({ value: service.id, label: service.name }))} onValueChange={setChosen} />
      {times.isPending ? (
        <div className="flex flex-col gap-2" role="status" aria-label="Finding open times"><Skeleton className="h-6 w-2/3" /><Skeleton className="h-6 w-1/2" /><Skeleton className="h-6 w-3/5" /></div>
      ) : times.isError ? (
        <Alert variant="error"><AlertDescription>
          <p>{times.error.message}</p>
          <Button size="sm" variant="outline" className="mt-2" onClick={() => void times.refetch()}>Try again</Button>
        </AlertDescription></Alert>
      ) : times.data.times.length === 0 ? (
        <Alert variant="warning"><AlertDescription>There are no open times in the next two weeks, so there is nothing to paste yet.</AlertDescription></Alert>
      ) : (
        <>
          <div className="rounded-lg border p-3 text-sm [&_a]:text-info-foreground [&_a]:underline" dangerouslySetInnerHTML={{ __html: times.data.html }} aria-label="Email preview" role="group" />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void copyHtml(times.data.html, times.data.times.map((time) => `${time.label}: ${time.href}`).join("\n"), "Times")}><Copy aria-hidden="true" /> Copy for email</Button>
            <Button size="sm" variant="outline" onClick={() => void copyText(times.data.html, "HTML")}>Copy as HTML</Button>
          </div>
        </>
      )}
    </div>
  );
}
