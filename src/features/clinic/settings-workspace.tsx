"use client";

import { WorkspacePage } from "@/components/workspace-page";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, CalendarDays, CircleCheck, LockKeyhole } from "lucide-react";

import { SelectField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useMediaQuery } from "@/hooks/use-media-query";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Frame, FrameDescription, FrameFooter, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { BillingSettings } from "@/features/billing/billing-settings";
import { useTerms } from "@/features/terms/business-profile-context";
import type { TermWords } from "@/lib/terminology";
import { AssistantSettings } from "./assistant/assistant-settings";
import { OrganisationSettings } from "./organisation/organisation-settings";
import { useCatalogLookups } from "./clinic-catalog";
import { usePreviewAppointments } from "./preview-appointments";
import { AvailabilitySettings } from "./availability-settings";
import { BrandSettingsPanel } from "./brand-settings";
import { DomainSettingsPanel } from "./domain-settings";
import { DiscoverySettings } from "./discovery-settings";
import { BookingFormsSettings } from "./booking-forms-settings";
import { BookingGuideSettings } from "./booking-guide-settings";
import { CancelPresetsPanel } from "./cancel-presets-panel";
import { BusinessProfileSettings } from "./business-profile-settings";
import { SidebarEditor } from "./customize-sidebar";
import { ChannelSettingsPanel } from "./channel-settings";
import { PaymentSettings } from "./payment-settings";
import { PatientPageSettings } from "./patient-page-settings";
import { PrivacySettings } from "./privacy-settings";
import { DataProtectionSettings } from "./data-protection-settings";
import { DevelopersSettings } from "./developers-settings";
import { AppsSettings } from "./apps-settings";
import { ImportSettingsEntry } from "./import-settings-entry";
import { ReplyToSettings } from "./reply-to-settings";
import { TemplatesSettings } from "./templates-settings";
import { TeamLimitsSettings } from "./team-limits-settings";
import { pickSettingsSection, settingsHref, useSettingsSections, type SettingsItem, type SettingsSection } from "./settings-sections";
import { previewSettingsKey } from "./website-connection";
import { WorkflowSettings } from "./workflow-settings";
import { WebsiteInstallGuide } from "./website-install-guide";
import { WebsiteConnectionWorkspace } from "./website-connection-workspace";

export type { SettingsSection } from "./settings-sections";
export { useSettingsSections } from "./settings-sections";

const channelDetails = (t: TermWords) => ({
  sms: { label: "SMS", detail: `A text message to the ${t.customer}’s mobile number` },
  email: { label: "Email", detail: `Sent when the ${t.customer} gave an email address` },
  whatsapp: { label: "WhatsApp", detail: `A message on the ${t.customer}’s WhatsApp number` },
});

const leadTimeOptions = [
  { value: "48", label: "48 hours before" },
  { value: "24", label: "24 hours before" },
  { value: "2", label: "2 hours before" },
];

/** The open settings section. It lives in the address (`/settings?section=hours`), so a link, a reload or Back reopens it. */
export function useSettingsSection(): { current: SettingsItem | undefined; open: (next: SettingsSection) => void } {
  const router = useRouter();
  const asked = useSearchParams().get("section");
  const { all } = useSettingsSections();
  return {
    current: pickSettingsSection(asked, all),
    open: (next) => router.replace(settingsHref(next), { scroll: false }),
  };
}

/** The Settings page's content: the open section. The staff frame's settings sidebar lists the sections from 768px. */
export function SettingsWorkspace() {
  const { database } = usePreviewAppointments();
  const catalog = useCatalogLookups();
  const t = useTerms();
  const channels = channelDetails(t);
  const sections = useSettingsSections().all;
  const wide = useMediaQuery("(min-width: 768px)");
  const { current, open: openAddress } = useSettingsSection();
  const section = current?.id;
  const [reminderStage, setReminderStage] = useState<"edit" | "review" | "result">("edit");
  const [reminderChannels, setReminderChannels] = useState({ sms: true, email: true, whatsapp: false });
  const [leadTime, setLeadTime] = useState("24");
  const [message, setMessage] = useState("");
  // A section change from the sidebar clears what the last one left behind.
  const [shownSection, setShownSection] = useState(section);
  if (shownSection !== section) {
    setShownSection(section);
    setMessage("");
    setReminderStage("edit");
  }

  useEffect(() => { document.getElementById("settings-title")?.focus({ preventScroll: true }); }, [section, reminderStage]);

  useEffect(() => {
    queueMicrotask(() => {
    try {
      const saved = window.sessionStorage.getItem(previewSettingsKey);
      if (!saved) return;
      const parsed: unknown = JSON.parse(saved);
      if (typeof parsed !== "object" || parsed === null) return;
      const state = parsed as Record<string, unknown>;
      if (typeof state.reminderChannels === "object" && state.reminderChannels !== null) setReminderChannels(state.reminderChannels as typeof reminderChannels);
      if (typeof state.leadTime === "string") setLeadTime(state.leadTime);
    } catch (error: unknown) {
      console.error("Could not load preview settings", error);
    }
    });
  }, []);

  function savePreviewSettings() {
    if (database) {
      setMessage(`This settings section is not stored on the ${t.business} database yet.`);
      return;
    }
    try {
      const stored = window.sessionStorage.getItem(previewSettingsKey);
      const parsed: unknown = stored ? JSON.parse(stored) : {};
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Stored preview settings are invalid");
      window.sessionStorage.setItem(previewSettingsKey, JSON.stringify({ ...parsed, reminderChannels, leadTime }));
      setReminderStage("result");
    } catch (error: unknown) {
      console.error("Could not save preview settings", error);
      setMessage("Could not save in this browser. Check storage access and try again.");
    }
  }

  const openSection = openAddress;

  if (!current) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><LockKeyhole aria-hidden="true" /></EmptyMedia>
            <EmptyTitle id="settings-title">No {t.business} settings for your account</EmptyTitle>
            <EmptyDescription>Your name, password and working hours are on your profile. Ask the {t.business} owner if you need more access.</EmptyDescription>
          </EmptyHeader>
          <Button variant="outline" render={<a href="/profile" />}>Open my profile</Button>
        </Empty>
      </div>
    );
  }

  return (
    <WorkspacePage title={current.title} description={current.description} headingId="settings-title">
      {/* Phones have no room for the settings sidebar, so the sections sit in one row that scrolls sideways. */}
      {!wide ? (
        <nav aria-label="Settings sections" className="-mx-4 flex shrink-0 gap-1 overflow-x-auto px-4 [scrollbar-width:none]">
          {sections.map((item) => <SettingsNavButton key={item.id} item={item} selected={section === item.id} onSelect={() => openSection(item.id)} />)}
        </nav>
      ) : null}
          <div className="flex min-w-0 flex-col gap-4">
            {section === "business" ? <BusinessProfileSettings /> : null}
            {section === "sidebar" ? <SidebarEditor /> : null}
            {section === "brand" ? <BrandSettingsPanel /> : null}
            {section === "domain" ? <DomainSettingsPanel /> : null}
            {section === "discovery" ? <DiscoverySettings /> : null}
            {section === "forms" ? <BookingFormsSettings /> : null}
            {section === "workflows" ? <WorkflowSettings /> : null}
            {section === "guide" ? <BookingGuideSettings /> : null}
            {section === "patient" ? <PatientPageSettings /> : null}
            {section === "hours" ? (database ? <AvailabilitySettings /> : (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon"><CalendarDays aria-hidden="true" /></EmptyMedia>
                  <EmptyTitle>Hours are not editable in the preview</EmptyTitle>
                  <EmptyDescription>Working hours are saved on the {t.business} database. Start the local database to edit them here.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )) : null}
            {section === "cancelreasons" ? <CancelPresetsPanel /> : null}
            {section === "payments" ? <PaymentSettings /> : null}
            {section === "templates" ? <TemplatesSettings /> : null}
            {section === "limits" ? <TeamLimitsSettings /> : null}
            {section === "assistant" ? <AssistantSettings /> : null}
            {section === "messaging" ? <><ChannelSettingsPanel /><ReplyToSettings /></> : null}
            {section === "organisation" ? <OrganisationSettings /> : null}
            {section === "security" ? <DataProtectionSettings /> : null}
            {section === "privacy" ? <PrivacySettings /> : null}
            {section === "billing" ? <BillingSettings /> : null}
            {section === "import" ? <ImportSettingsEntry /> : null}
            {section === "developers" ? <DevelopersSettings /> : null}
            {section === "apps" ? <AppsSettings /> : null}
            {section === "website" ? (database ? <WebsiteInstallGuide clinic={catalog.clinic} /> : <WebsiteConnectionWorkspace onBack={() => openSection("patient")} />) : null}
            {section === "reminders" ? (
              reminderStage === "edit" ? (
                <Frame>
                  <FrameHeader>
                    <FrameTitle>Reminder channels</FrameTitle>
                    <FrameDescription>Choose how {t.customers} hear about an upcoming {t.visit}.</FrameDescription>
                  </FrameHeader>
                  <FramePanel className="flex flex-col divide-y py-1">
                    {(["sms", "email", "whatsapp"] as const).map((channel) => (
                      <div key={channel} className="flex items-center justify-between gap-4 py-3">
                        <div className="min-w-0">
                          <Label htmlFor={`reminder-${channel}`} className="font-medium">{channels[channel].label} reminders</Label>
                          <p className="text-xs text-muted-foreground">{channels[channel].detail}</p>
                        </div>
                        <Switch id={`reminder-${channel}`} checked={reminderChannels[channel]} onCheckedChange={(checked) => setReminderChannels((current) => ({ ...current, [channel]: checked }))} />
                      </div>
                    ))}
                  </FramePanel>
                  <FramePanel className="flex flex-col gap-4">
                    <SelectField label="Primary reminder timing" fieldClassName="max-w-sm" value={leadTime} onValueChange={setLeadTime} options={leadTimeOptions} />
                    <Alert role="note">
                      <AlertDescription>{t.Customer} preview: You have a routine scheduling reminder. Open your secure booking link or contact the {t.business}. No message is sent from this demo.</AlertDescription>
                    </Alert>
                  </FramePanel>
                  <FrameFooter className="flex justify-end">
                    <Button onClick={() => setReminderStage("review")}>Review changes <ArrowRight aria-hidden="true" /></Button>
                  </FrameFooter>
                </Frame>
              ) : reminderStage === "review" ? (
                <Frame>
                  <FrameHeader>
                    <FrameTitle>Review reminder settings</FrameTitle>
                    <FrameDescription>{database ? `This section cannot be saved to the ${t.business} database yet.` : "Saving records this choice in the current preview only. It does not update a provider or public booking configuration."}</FrameDescription>
                  </FrameHeader>
                  <FramePanel className="flex flex-col gap-3">
                    {message ? (
                      <Alert variant="warning">
                        <AlertDescription>{message}</AlertDescription>
                      </Alert>
                    ) : null}
                    <dl className="flex flex-col divide-y text-sm">
                      <div className="flex flex-wrap justify-between gap-x-4 gap-y-0.5 pb-2.5">
                        <dt className="text-muted-foreground">Channels</dt>
                        <dd className="font-medium">{Object.entries(reminderChannels).filter(([, enabled]) => enabled).map(([name]) => name.toUpperCase()).join(", ") || "None"}</dd>
                      </div>
                      <div className="flex flex-wrap justify-between gap-x-4 gap-y-0.5 pt-2.5">
                        <dt className="text-muted-foreground">Primary timing</dt>
                        <dd className="font-medium">{leadTime} hours before</dd>
                      </div>
                    </dl>
                  </FramePanel>
                  <FrameFooter className="flex flex-wrap justify-between gap-3">
                    <Button variant="ghost" onClick={() => setReminderStage("edit")}>Back</Button>
                    <Button onClick={savePreviewSettings} disabled={Boolean(database)}>{database ? "Cannot save yet" : "Save preview settings"}</Button>
                  </FrameFooter>
                </Frame>
              ) : (
                <Frame role="status">
                  <FramePanel className="flex items-start gap-3">
                    <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success-foreground" />
                    <div className="flex min-w-0 flex-col items-start gap-1">
                      <h3 className="font-heading text-base font-semibold">Reminders choice recorded</h3>
                      <p className="text-sm text-muted-foreground">This setting remains in the current browser preview. No provider or external website was changed.</p>
                      <Button variant="outline" className="mt-3" onClick={() => setReminderStage("edit")}>Back to reminders</Button>
                    </div>
                  </FramePanel>
                </Frame>
              )
            ) : null}
          </div>
    </WorkspacePage>
  );
}

function SettingsNavButton({
  item,
  selected,
  onSelect,
}: {
  item: SettingsItem;
  selected: boolean;
  onSelect: () => void;
}) {
  const Icon = item.icon;
  return (
    <Button
      variant={selected ? "secondary" : "ghost"}
      onClick={onSelect}
      aria-current={selected ? "page" : undefined}
      className="shrink-0 justify-start md:w-full"
    >
      <Icon aria-hidden="true" />
      <span className="min-w-0 truncate">{item.title}</span>
    </Button>
  );
}
