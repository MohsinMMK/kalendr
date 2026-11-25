"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowRight, Info, MessagesSquare, TriangleAlert } from "lucide-react";

import { ExpandingSearch } from "@/components/expanding-search";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { WorkspaceFrame, WorkspacePage } from "@/components/workspace-page";
import { useTerms } from "@/features/terms/business-profile-context";
import type { ContactChannel } from "@/lib/domain";
import type { StaffMessage } from "@/lib/staff-snapshot";

import { useCatalogLookups } from "./clinic-catalog";
import { useUnreadThreadCount } from "./inbox-api";
import { InboxPanel } from "./inbox-panel";
import { requestSettingsSection } from "./settings-navigation";
import { useStaffAccess } from "./staff-access";
import { UndeliveredMessages } from "./undelivered-messages";
import { messageReason } from "./message-reasons";
import { appointmentDateTime, channelLabel } from "./clinic-format";
import { usePreviewAppointments } from "./preview-appointments";
import { useVisitsNeedingPerson } from "./use-visits-needing-person";
import { patientName as fullName } from "./patient-directory";

const aboutLabels: Record<string, string> = {
  "appointment.created": "Booking made",
  "appointment.confirm": "Booking confirmed",
  "appointment.reschedule": "Moved to a new time",
  "appointment.suggest": "New time suggested",
  "appointment.cancel": "Booking cancelled",
  "appointment.reminder": "Reminder",
  "record.shared": "Document ready",
  "appointment.quick_message.your_turn": "It's your turn",
  "appointment.quick_message.running_late": "Running late",
  "appointment.quick_message.call_us": "Please call us",
};

const statusDisplay: Record<StaffMessage["status"], { label: string; tone: "neutral" | "info" | "success" | "danger" }> = {
  queued: { label: "Queued", tone: "info" },
  recorded: { label: "Recorded", tone: "neutral" },
  sent: { label: "Sent", tone: "info" },
  delivered: { label: "Delivered", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Not sent", tone: "neutral" },
};

type ChannelFilter = "all" | ContactChannel;

const channelFilters: { value: ChannelFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "sms", label: "SMS" },
  { value: "email", label: "Email" },
];

type MessagesTab = "activity" | "inbox";

/** Messages has two views: what was sent (Activity) and what customers wrote back (Inbox, for people who may reply). */
export function MessagesWorkspace({ emailConnected = false }: { emailConnected?: boolean }) {
  const t = useTerms();
  const access = useStaffAccess();
  const catalog = useCatalogLookups();
  const canInbox = access.can("inbox.reply");
  const initial = useSearchParams()?.get("tab") === "inbox" ? "inbox" : "activity";
  const [chosen, setChosen] = useState<MessagesTab>(initial);
  const tab: MessagesTab = canInbox ? chosen : "activity";
  const unread = useUnreadThreadCount(canInbox && catalog.database);

  function chooseTab(next: MessagesTab) {
    setChosen(next);
    // Keep the address shareable without a Next navigation; the page itself doesn't change.
    const url = new URL(window.location.href);
    if (next === "inbox") url.searchParams.set("tab", "inbox"); else url.searchParams.delete("tab");
    window.history.replaceState(window.history.state, "", url);
  }

  const [query, setQuery] = useState("");
  const [channel, setChannel] = useState<ChannelFilter>("all");
  const search = <ExpandingSearch placeholder={`Search by ${t.customer}`} label={`Search messages by ${t.customer}`} value={query} onValueChange={setQuery} />;
  const channels = (
    <ToggleGroup aria-label="Filter by channel" variant="outline" size="sm" value={[channel]} onValueChange={(next) => { if (next[0]) setChannel(next[0] as ChannelFilter); }}>
      {channelFilters.map((item) => <ToggleGroupItem key={item.value} value={item.value}>{item.label}</ToggleGroupItem>)}
    </ToggleGroup>
  );
  const activity = <ActivityView emailConnected={emailConnected} query={query} channel={channel} />;
  const inbox = tab === "inbox";

  return (
    <WorkspacePage nav="messages" fit={inbox ? "screen" : "flow"}>
      <Tabs value={tab} onValueChange={(next: string) => chooseTab(next === "inbox" ? "inbox" : "activity")} className="min-h-0 flex-1 gap-0">
        <WorkspaceFrame
          flush={inbox}
          panelClassName={inbox ? "overflow-hidden" : "gap-4"}
          start={canInbox ? (
            <TabsList variant="underline" aria-label="Messages views">
              <TabsTab value="activity">Activity</TabsTab>
              <TabsTab value="inbox">
                Inbox
                {unread ? <span className="ms-1.5 inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs text-primary-foreground" aria-label={`${unread} unread`}>{unread}</span> : null}
              </TabsTab>
            </TabsList>
          ) : null}
          end={inbox ? null : <>{search}{channels}</>}
        >
          {canInbox ? (
            <>
              <TabsPanel value="activity" className="flex flex-col gap-4">{activity}</TabsPanel>
              <TabsPanel value="inbox" className="flex min-h-0 flex-1 flex-col"><InboxPanel /></TabsPanel>
            </>
          ) : activity}
        </WorkspaceFrame>
      </Tabs>
    </WorkspacePage>
  );
}

function ActivityView({ emailConnected, query, channel }: { emailConnected: boolean; query: string; channel: ChannelFilter }) {
  const catalog = useCatalogLookups();
  const t = useTerms();
  const { appointments, patients, operations } = usePreviewAppointments();
  const needingPerson = useVisitsNeedingPerson();
  const access = useStaffAccess();
  const canRetry = Boolean(catalog.database) && access.can("messages.retry");
  const canEditReminders = Boolean(catalog.database) && access.can("settings.manage");
  const messages = catalog.snapshot?.messages ?? operations.messages;

  const patientName = (id: string | null) => {
    const patient = patients.find((item) => item.id === id);
    return patient ? fullName(patient) : t.Customer;
  };
  const search = query.trim().toLowerCase();
  const shown = useMemo(() => messages.filter((message) => {
    if (channel !== "all" && message.channel !== channel) return false;
    if (!search) return true;
    const patient = patients.find((item) => item.id === message.patientId);
    return patient ? fullName(patient).toLowerCase().includes(search) : false;
  }), [channel, messages, patients, search]);

  return (
    <>
      {needingPerson.length ? (
        <Card>
          <CardHeader>
            <h2 className="flex items-center gap-2 text-sm font-semibold"><TriangleAlert aria-hidden="true" className="size-4 text-warning-foreground" /> Needs a person ({needingPerson.length})</h2>
            <CardDescription className="text-xs">Kalendr found no opening with the same {t.practitioner}, so these bookings stayed where they were.</CardDescription>
          </CardHeader>
          <CardPanel className="p-0">
            <Table>
              <TableBody>
                {needingPerson.map(({ appointment, reason }) => (
                  <TableRow key={appointment.id}>
                    <TableCell className="whitespace-normal">
                      <p className="font-medium">{patientName(appointment.patientId)}</p>
                      <p className="text-xs text-muted-foreground">{appointmentDateTime(appointment.startsAt)} · {catalog.practitionerName(appointment.practitionerId)}</p>
                    </TableCell>
                    <TableCell className="text-muted-foreground max-sm:hidden">{reason}</TableCell>
                    <TableCell className="text-end">
                      <Button variant="outline" size="sm" render={<Link href={`/appointments/${appointment.id}?action=reschedule`} />}>
                        Reschedule <ArrowRight aria-hidden="true" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardPanel>
        </Card>
      ) : null}

      {emailConnected ? (
        <Alert variant="info">
          <Info aria-hidden="true" />
          <AlertTitle>Emails are sent in your business&apos;s name</AlertTitle>
          <AlertDescription>Booking emails carry a calendar file and the {t.customer}&apos;s private booking link, and replies come to your business email. WhatsApp and SMS aren&apos;t connected yet, so those updates are recorded here only.</AlertDescription>
        </Alert>
      ) : (
        <Alert variant="info">
          <Info aria-hidden="true" />
          <AlertTitle>{t.Customers} aren&apos;t being contacted yet</AlertTitle>
          <AlertDescription>No WhatsApp, SMS or email provider is connected, so updates are recorded here and not delivered. Website bookings still show the change on the {t.customer}&apos;s private booking page.</AlertDescription>
        </Alert>
      )}

      {canRetry ? <UndeliveredMessages patientName={patientName} /> : null}

      <Card>
        <CardHeader>
          <CardTitle render={<h2 />} className="text-base">Sent messages</CardTitle>
        </CardHeader>
        <CardPanel className="p-0">
          {shown.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.Customer}</TableHead>
                  <TableHead className="max-sm:hidden">About</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((message) => {
                  const appointment = appointments.find((item) => item.id === message.appointmentId);
                  const about = aboutLabels[message.templateKey] ?? "Booking update";
                  const status = statusDisplay[message.status];
                  const reason = message.status === "failed" || message.status === "cancelled" ? messageReason(message.failureCode) : null;
                  return (
                    <TableRow key={message.id}>
                      <TableCell className="whitespace-normal">
                        <p className="font-medium">{patientName(message.patientId)}</p>
                        <p className="text-xs text-muted-foreground sm:hidden">{about}</p>
                      </TableCell>
                      <TableCell className="whitespace-normal max-sm:hidden">
                        <p>{about}</p>
                        {appointment ? <p className="text-xs text-muted-foreground">{appointmentDateTime(appointment.startsAt)}</p> : null}
                      </TableCell>
                      <TableCell><Badge variant="outline">{channelLabel(message.channel)}</Badge></TableCell>
                      <TableCell className="whitespace-normal">
                        <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                        {reason ? <p className="mt-1 max-w-56 text-xs text-muted-foreground">{reason}</p> : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon"><MessagesSquare aria-hidden="true" /></EmptyMedia>
                <EmptyTitle>{messages.length ? "No matching messages" : "No messages yet"}</EmptyTitle>
                <EmptyDescription>{messages.length ? `Try another ${t.customer} or channel.` : "Booking changes and reminders appear here."}</EmptyDescription>
              </EmptyHeader>
              {messages.length || !canEditReminders ? null : <EmptyContent><Button size="sm" onClick={() => requestSettingsSection("workflows")}>Review your reminders</Button></EmptyContent>}
            </Empty>
          )}
        </CardPanel>
      </Card>
    </>
  );
}
