"use client";

import { Lock } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { useTerms } from "@/features/terms/business-profile-context";

import { useCatalogLookups } from "../clinic-catalog";
import { useStaffAccess } from "../staff-access";
import { AttributesTab } from "./attributes-tab";
import { DefaultsTab } from "./defaults-tab";
import { ProvisioningTab } from "./provisioning-tab";
import { RolesTab } from "./roles-tab";
import { SignInTab } from "./sign-in-tab";
import { TeamsTab } from "./teams-tab";
import { ScrollArea } from "@/components/ui/scroll-area";

/**
 * Settings > Organisation: what large groups need on top of one business: departments with their own pages, roles shaped to the
 * organisation, company sign-in, directory sync, attributes and defaults. The server checks the permission and the plan on every call.
 */
export function OrganisationSettings() {
  const catalog = useCatalogLookups();
  const access = useStaffAccess();
  const t = useTerms();

  if (!catalog.database) {
    return <Alert role="note"><AlertDescription>Teams, roles and company sign-in are saved on the {t.business} database, so they aren&apos;t available in the preview.</AlertDescription></Alert>;
  }
  const mayManage = access.can("org.manage");
  return (
    <Tabs defaultValue="teams" className="gap-4">
      <ScrollArea clampContentMinWidth={false} className="max-w-full">
      <TabsList variant="underline" aria-label="Organisation">
        <TabsTab value="teams">Teams</TabsTab>
        <TabsTab value="roles">Roles</TabsTab>
        <TabsTab value="sign-in">Sign-in</TabsTab>
        <TabsTab value="provisioning">Provisioning</TabsTab>
        <TabsTab value="attributes">Attributes</TabsTab>
        <TabsTab value="defaults">Defaults</TabsTab>
      </TabsList>
      </ScrollArea>
      {!mayManage ? <Alert role="note"><Lock aria-hidden="true" /><AlertDescription>You can look, but changing the organisation needs the &ldquo;Manage the organisation&rdquo; permission.</AlertDescription></Alert> : null}
      <TabsPanel value="teams"><TeamsTab /></TabsPanel>
      <TabsPanel value="roles"><RolesTab /></TabsPanel>
      <TabsPanel value="sign-in"><SignInTab /></TabsPanel>
      <TabsPanel value="provisioning"><ProvisioningTab /></TabsPanel>
      <TabsPanel value="attributes"><AttributesTab /></TabsPanel>
      <TabsPanel value="defaults"><DefaultsTab /></TabsPanel>
    </Tabs>
  );
}
