"use client";

import { ExternalLink, Code2 } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { useTerms } from "@/features/terms/business-profile-context";

import { useCatalogLookups } from "./clinic-catalog";
import { KeysTab } from "./developers/keys-tab";
import { WebhooksTab } from "./developers/webhooks-tab";
import { useStaffAccess } from "./staff-access";

/** Settings > Developers: API keys and webhooks, with a link to the reference. */
export function DevelopersSettings() {
  const catalog = useCatalogLookups();
  const access = useStaffAccess();
  const t = useTerms();

  if (!catalog.database) {
    return <Alert role="note"><AlertDescription>API keys and webhooks are saved on the {t.business} database, so they aren&apos;t available in the preview.</AlertDescription></Alert>;
  }

  return (
    <Tabs defaultValue="keys" className="gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <TabsList variant="underline" aria-label="Developer tools">
          <TabsTab value="keys">API keys</TabsTab>
          <TabsTab value="webhooks">Webhooks</TabsTab>
        </TabsList>
        <Button variant="ghost" size="sm" render={<a href="/developers" target="_blank" rel="noopener noreferrer" />}>
          <Code2 aria-hidden="true" /> API reference <ExternalLink aria-hidden="true" /><span className="sr-only"> (opens in a new tab)</span>
        </Button>
      </div>
      <TabsPanel value="keys"><KeysTab isOwner={access.role === "owner"} /></TabsPanel>
      <TabsPanel value="webhooks"><WebhooksTab /></TabsPanel>
    </Tabs>
  );
}
