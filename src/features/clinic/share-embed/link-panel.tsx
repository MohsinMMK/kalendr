"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Copy, ExternalLink, Link2, Trash2 } from "lucide-react";
import { useMemo } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";

import { TextField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { bookingLinkInputSchema, shortLinkUrl, type BookingLinkInput } from "@/lib/booking-links";
import { qrCodePath } from "@/lib/check-in";
import { bookingPageUrl } from "@/lib/embed/builder";
import type { EmbedContextView } from "@/server/email-times";

import { StaffApiError } from "../queries/http";
import { copyText } from "./copy";
import { useCreateShortLink, useDeleteShortLink, useShortLinks } from "./queries";

/** The booking link, its QR code and the printed short links with their click counts. */
export function LinkPanel({ context, serviceSlug }: { context: EmbedContextView; serviceSlug: string | null }) {
  const url = bookingPageUrl(context.origin, context.clinicSlug, serviceSlug);
  const qr = useMemo(() => qrCodePath(url), [url]);
  const qrFile = useMemo(
    () => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${qr.size} ${qr.size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${qr.path}" fill="#000"/></svg>`)}`,
    [qr],
  );
  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="share-link-title" className="flex flex-col gap-3">
        <h3 id="share-link-title" className="font-medium text-sm">Booking link</h3>
        <div className="flex gap-2">
          <Input readOnly size="lg" value={url} aria-label="Booking link" className="font-mono text-xs" onFocus={(event) => event.currentTarget.select()} />
          <Button variant="outline" size="icon-lg" aria-label="Copy booking link" onClick={() => void copyText(url, "Link")}><Copy aria-hidden="true" /></Button>
          <Button variant="outline" size="icon-lg" aria-label="Open booking page" render={<a href={url} target="_blank" rel="noopener noreferrer" />}><ExternalLink aria-hidden="true" /></Button>
        </div>
        <div className="flex items-center gap-4">
          <div className="rounded-xl border bg-white p-2">
            <svg role="img" aria-label="QR code for the booking link" viewBox={`0 0 ${qr.size} ${qr.size}`} shapeRendering="crispEdges" className="size-36">
              <path d={qr.path} fill="#000" />
            </svg>
          </div>
          <div className="flex flex-col items-start gap-2 text-muted-foreground text-xs">
            <p>Print it on a card or a window sticker. It opens {serviceSlug ? "this service" : "your booking page"}.</p>
            <Button size="sm" variant="outline" render={<a href={qrFile} download={`booking-${serviceSlug ?? context.clinicSlug}-qr.svg`} />}>Download QR code</Button>
          </div>
        </div>
      </section>
      <ShortLinks context={context} serviceSlug={serviceSlug} />
    </div>
  );
}

function ShortLinks({ context, serviceSlug }: { context: EmbedContextView; serviceSlug: string | null }) {
  const links = useShortLinks(true);
  const create = useCreateShortLink();
  const remove = useDeleteShortLink();
  const form = useForm<z.input<typeof bookingLinkInputSchema>, unknown, BookingLinkInput>({
    resolver: zodResolver(bookingLinkInputSchema),
    defaultValues: { label: "", serviceSlug: null, prefill: {} },
  });
  const { errors } = form.formState;

  async function submit(values: BookingLinkInput): Promise<void> {
    try {
      const created = await create.mutateAsync({ ...values, serviceSlug });
      form.reset({ label: "", serviceSlug: null, prefill: {} });
      toastManager.add({ title: "Short link made", description: shortLinkUrl(context.origin, created.code), type: "success" });
    } catch (error: unknown) {
      if (error instanceof StaffApiError) {
        for (const [path, messages] of Object.entries(error.fieldErrors)) form.setError(path as never, { type: "server", message: messages[0] ?? "Check this." });
        if (Object.keys(error.fieldErrors).length === 0) toastManager.add({ title: error.message, type: "error" });
      }
    }
  }

  return (
    <section aria-labelledby="short-links-title" className="flex flex-col gap-3">
      <div>
        <h3 id="short-links-title" className="font-medium text-sm">Short links for print and bios</h3>
        <p className="text-muted-foreground text-xs">A short link such as {shortLinkUrl(context.origin, "abc2345")} opens {serviceSlug ? "this service" : "your booking page"}. Add a campaign tag to see which card or post brought people in.</p>
      </div>
      <form noValidate onSubmit={(event) => { void form.handleSubmit(submit)(event); }} className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3">
        <TextField label="Name for this link" placeholder="Reception card" maxLength={80} error={errors.label?.message} {...form.register("label")} />
        <Collapsible>
          <CollapsibleTrigger className="min-h-11 text-start text-muted-foreground text-xs underline underline-offset-2">Add a campaign tag</CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="grid gap-3 pt-2 sm:grid-cols-3">
              <TextField label="Source" placeholder="instagram" error={errors.utmSource?.message} {...form.register("utmSource", { setValueAs: (value: string) => value || undefined })} />
              <TextField label="Medium" placeholder="bio" error={errors.utmMedium?.message} {...form.register("utmMedium", { setValueAs: (value: string) => value || undefined })} />
              <TextField label="Campaign" placeholder="diwali-offer" error={errors.utmCampaign?.message} {...form.register("utmCampaign", { setValueAs: (value: string) => value || undefined })} />
            </div>
          </CollapsiblePanel>
        </Collapsible>
        <Button type="submit" size="lg" className="self-start" disabled={create.isPending}>
          {create.isPending ? <Spinner aria-hidden="true" /> : <Link2 aria-hidden="true" />}
          Make short link
        </Button>
      </form>
      {links.isPending ? (
        <div className="flex flex-col gap-2" role="status" aria-label="Loading short links"><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div>
      ) : links.isError ? (
        <Alert variant="error"><AlertDescription>
          <p>{links.error.message}</p>
          <Button size="sm" variant="outline" className="mt-2" onClick={() => void links.refetch()}>Try again</Button>
        </AlertDescription></Alert>
      ) : links.data.length === 0 ? (
        <Empty className="rounded-lg border border-dashed py-6">
          <EmptyHeader>
            <EmptyMedia variant="icon"><Link2 aria-hidden="true" /></EmptyMedia>
            <EmptyTitle>No short links yet</EmptyTitle>
            <EmptyDescription>Make one above and print it, or put it in your Instagram bio.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border">
          {links.data.map((link) => {
            const short = shortLinkUrl(context.origin, link.code);
            return (
              <li key={link.id} className="flex items-center gap-2 p-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-sm">{link.label}</p>
                  <p className="truncate font-mono text-muted-foreground text-xs">{short}</p>
                </div>
                <Badge variant="outline">{link.clicks} {link.clicks === 1 ? "visit" : "visits"}</Badge>
                <Button variant="ghost" size="icon" aria-label={`Copy ${link.label} link`} onClick={() => void copyText(short, "Link")}><Copy aria-hidden="true" /></Button>
                <Button variant="ghost" size="icon" aria-label={`Delete ${link.label}`} disabled={remove.isPending} onClick={() => remove.mutate(link.id, { onError: (error) => toastManager.add({ title: error.message, type: "error" }) })}>
                  <Trash2 aria-hidden="true" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
