"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Search } from "lucide-react";
import { useEffect } from "react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import { TextareaField, TextField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Frame, FrameDescription, FrameFooter, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import type { ListingView } from "@/lib/listing";
import { seoSettingsSchema } from "@/lib/seo";

import { StaffApiError } from "./queries/http";
import { useSaveListing } from "./queries/listing";

const listingFormSchema = z.object({
  listed: z.boolean(),
  title: seoSettingsSchema.shape.title,
  description: seoSettingsSchema.shape.description,
});
type ListingForm = z.infer<typeof listingFormSchema>;

/** How the page will look in a search result, from the words below or the page's own. */
function ResultPreview({ view, title, description }: { view: ListingView; title: string; description: string }) {
  const address = view.pageUrl.replace(/^https?:\/\//, "");
  return (
    <figure aria-label="How your page looks in a search result" className="flex flex-col gap-0.5 rounded-lg border bg-muted/40 p-3">
      <p className="truncate text-muted-foreground text-xs">{address}</p>
      <p className="line-clamp-2 font-medium text-primary text-base">{title || view.defaultTitle}</p>
      <p className="line-clamp-2 text-muted-foreground text-sm">{description || view.defaultDescription}</p>
    </figure>
  );
}

/**
 * "Let customers find us": the switch that puts a business on Google and in the directory, and the title and description
 * its page shows in search results and link previews. Off until the owner turns it on.
 */
export function ListingSettings({ view }: { view: ListingView }) {
  const t = useTerms();
  const save = useSaveListing();
  const form = useForm<ListingForm>({
    resolver: zodResolver(listingFormSchema),
    defaultValues: { listed: view.listed, title: view.seo.title ?? "", description: view.seo.description ?? "" },
  });
  const listed = useWatch({ control: form.control, name: "listed" }) ?? false;
  const title = useWatch({ control: form.control, name: "title" }) ?? "";
  const description = useWatch({ control: form.control, name: "description" }) ?? "";

  // A save (or another tab's change) brings a new saved state; start the form from it.
  useEffect(() => {
    form.reset({ listed: view.listed, title: view.seo.title ?? "", description: view.seo.description ?? "" });
  }, [form, view.listed, view.seo.title, view.seo.description]);

  const dirty = form.formState.isDirty;

  async function onSubmit(values: ListingForm) {
    try {
      await save.mutateAsync({ listed: values.listed, seo: { title: values.title || undefined, description: values.description || undefined }, expected: { listed: view.listed, seo: view.seo } });
      toastManager.add({ title: values.listed ? "Your page can now be found" : "Your page is hidden from search", type: "success" });
    } catch (cause: unknown) {
      const fields = cause instanceof StaffApiError ? cause.fieldErrors : {};
      for (const [path, messages] of Object.entries(fields)) {
        const name = path.endsWith("description") ? "description" : path.endsWith("title") ? "title" : null;
        if (name && messages[0]) form.setError(name, { message: messages[0] });
      }
      toastManager.add({ title: "Not saved", description: cause instanceof Error ? cause.message : "Try again in a moment.", type: "error" });
    }
  }

  return (
    <Frame>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
        <FrameHeader>
          <FrameTitle className="flex items-center gap-2"><Search aria-hidden="true" className="size-4" />Be found on Google</FrameTitle>
          <FrameDescription>Turn this on and search engines and the Kalendr directory can show your page. It is off until you choose.</FrameDescription>
        </FrameHeader>
        <FramePanel className="flex flex-col gap-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-1">
              <Label htmlFor="listing-switch" className="font-medium">Let {t.customers} find us</Label>
              <p className="text-muted-foreground text-xs">Your page, {t.services} and team get their own addresses in search results.</p>
            </div>
            <Switch id="listing-switch" checked={listed} onCheckedChange={(next) => form.setValue("listed", next, { shouldDirty: true })} aria-label={`Let ${t.customers} find us on Google`} />
          </div>
          <p className="flex items-center gap-2 text-sm">
            Right now:
            {view.indexable ? <Badge variant="success">Visible to search engines</Badge> : <Badge variant="outline">Hidden from search engines</Badge>}
          </p>
          {view.listed && view.blockers.length > 0 ? (
            <Alert variant="warning"><AlertDescription><ul className="flex list-disc flex-col gap-1 pl-4">{view.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></AlertDescription></Alert>
          ) : null}
          <TextField
            label="Page title"
            optional
            maxLength={70}
            placeholder={view.defaultTitle}
            hint="Shown as the headline in search results. About 60 characters works best."
            error={form.formState.errors.title?.message}
            {...form.register("title")}
          />
          <TextareaField
            label="Page description"
            optional
            rows={3}
            maxLength={160}
            placeholder={view.defaultDescription}
            hint="One or two sentences that make someone choose you. Up to 160 characters."
            error={form.formState.errors.description?.message}
            {...form.register("description")}
          />
          <ResultPreview view={view} title={title} description={description} />
        </FramePanel>
        <FrameFooter className="flex-row flex-nowrap justify-end gap-2">
          <Button type="button" variant="outline" disabled={!dirty || save.isPending} onClick={() => form.reset()}>Undo changes</Button>
          <Button type="submit" disabled={!dirty || save.isPending}>{save.isPending ? <Spinner /> : null}Save</Button>
        </FrameFooter>
      </form>
    </Frame>
  );
}
