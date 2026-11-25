"use client";

import { useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { useTerms } from "@/features/terms/business-profile-context";

import { AppDrawer } from "./apps/app-drawer";
import { Catalogue } from "./apps/catalogue";
import { ClientsPanel, GrantsPanel } from "./apps/connections";
import { useCatalogLookups } from "./clinic-catalog";
import { useStaffAccess } from "./staff-access";

/** Settings > Apps: find, connect, set up and remove every app in one place. */
export function AppsSettings() {
  const catalog = useCatalogLookups();
  const access = useStaffAccess();
  const t = useTerms();
  const [open, setOpen] = useState<string | null>(null);

  if (!catalog.database) {
    return <Alert role="note"><AlertDescription>Apps are saved on the {t.business} database, so they aren&apos;t available in the preview.</AlertDescription></Alert>;
  }
  return (
    <Tabs defaultValue="apps" className="gap-4">
      <TabsList variant="underline" aria-label="Apps">
        <TabsTab value="apps">Apps</TabsTab>
        <TabsTab value="signed-in">Signed in</TabsTab>
        {access.can("api.manage") ? <TabsTab value="yours">Your own apps</TabsTab> : null}
      </TabsList>
      <TabsPanel value="apps"><Catalogue onOpen={setOpen} /></TabsPanel>
      <TabsPanel value="signed-in"><GrantsPanel /></TabsPanel>
      {access.can("api.manage") ? <TabsPanel value="yours"><ClientsPanel isOwner={access.role === "owner"} /></TabsPanel> : null}
      <AppDrawer appKey={open} onClose={() => setOpen(null)} />
    </Tabs>
  );
}
