"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarCheck, CircleAlert, Trash2 } from "lucide-react";

import { PhoneField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ResponsiveDrawer, ResponsiveDrawerPopup } from "@/components/responsive-drawer";
import { DrawerDescription, DrawerFooter, DrawerHeader, DrawerPanel, DrawerTitle } from "@/components/ui/drawer";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";

import { findTestBooking, useRemoveTestData, type OnboardingState, type TestBookingView } from "./queries/onboarding";
import { clinicDateKey } from "./schedule-availability";
import { useOptionalStaffSnapshot } from "./staff-snapshot-provider";

const channelWords: Record<string, string> = { sms: "a text message", whatsapp: "a WhatsApp message", email: "an email", phone: "a call" };

/** How the confirmation is going, in plain words. */
function confirmationLine(confirmation: TestBookingView["confirmation"]): { text: string; problem: boolean } {
  if (!confirmation) return { text: "Your confirmation is being prepared.", problem: false };
  const how = channelWords[confirmation.channel] ?? "a message";
  switch (confirmation.status) {
    case "delivered":
    case "read": return { text: `Your confirmation reached you as ${how}.`, problem: false };
    case "sent": return { text: `Your confirmation was sent as ${how}. It should be with you now.`, problem: false };
    // The provider has the message; the delivery report that moves it on to "sent" can take a while or never come.
    case "sending": return { text: `Your confirmation is on its way as ${how}.`, problem: false };
    case "cancelled": return { text: `Nothing was sent for this booking. Check your reminder settings.`, problem: true };
    case "failed": return { text: `Your confirmation could not be sent as ${how}. Check Messages to see why.`, problem: true };
    default: return { text: `Your confirmation is queued as ${how}.`, problem: false };
  }
}

/**
 * "Make a test booking" (feature 11, step 4): the business's own public page in a side panel, filled in with the owner's own
 * name, email and phone. The owner books, and the panel watches for that booking: when it lands it is flagged as a test (left
 * out of counts and reports), the panel says it is on the schedule and how the confirmation is going, and one click removes it.
 */
export function TestBookingPanel({ open, onOpenChange, owner, slug }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  owner: OnboardingState["owner"];
  slug: string;
}) {
  const staff = useOptionalStaffSnapshot();
  const remove = useRemoveTestData();
  const [phone, setPhone] = useState(owner.phone);
  const [started, setStarted] = useState<string | null>(null);
  const [view, setView] = useState<TestBookingView>({ found: false });
  const [problem, setProblem] = useState("");
  const refresh = useRef(staff?.refresh);
  useEffect(() => { refresh.current = staff?.refresh; }, [staff?.refresh]);

  // Reset each time the panel opens.
  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => {
      setStarted(null);
      setView({ found: false });
      setProblem("");
      setPhone(owner.phone);
    });
  }, [open, owner.phone]);

  // While the owner books, look for the booking every few seconds. Stop once it is found.
  useEffect(() => {
    if (!open || !started || view.found) return;
    let cancelled = false;
    async function look() {
      try {
        const found = await findTestBooking(started!);
        if (cancelled) return;
        setView(found);
        if (found.found) void refresh.current?.();
      } catch (cause: unknown) {
        if (!cancelled) setProblem(cause instanceof Error ? cause.message : "We could not check for your booking.");
      }
    }
    const timer = window.setInterval(() => void look(), 3_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [open, started, view.found]);

  // Keep asking after it is found, so the confirmation line updates from queued to sent.
  useEffect(() => {
    if (!open || !started || !view.found) return;
    if (view.confirmation && ["sending", "sent", "delivered", "read", "failed", "cancelled"].includes(view.confirmation.status)) return;
    const timer = window.setInterval(() => {
      findTestBooking(started).then(setView).catch(() => undefined);
    }, 4_000);
    return () => window.clearInterval(timer);
  }, [open, started, view]);

  const src = useMemo(() => {
    if (!started) return "";
    const query = new URLSearchParams({ embed: "1", name: owner.name, email: owner.email });
    if (phone) query.set("phone", phone);
    return `/book/${encodeURIComponent(slug)}?${query.toString()}`;
  }, [started, owner.name, owner.email, phone, slug]);

  const confirmation = view.found ? confirmationLine(view.confirmation) : null;
  const phoneOk = phone === "" || /^\+\d{8,15}$/.test(phone);

  async function removeIt() {
    try {
      await remove.mutateAsync();
      toastManager.add({ title: "Test booking removed", description: "It is gone from your schedule and reports.", type: "success" });
      await staff?.refresh();
      onOpenChange(false);
    } catch (cause: unknown) {
      toastManager.add({ title: "Could not remove it", description: cause instanceof Error ? cause.message : "Try again.", type: "error" });
    }
  }

  return (
    <ResponsiveDrawer open={open} onOpenChange={onOpenChange}>
      <ResponsiveDrawerPopup className="sm:max-w-xl">
        <DrawerHeader>
          <DrawerTitle>Make a test booking</DrawerTitle>
          <DrawerDescription>Book yourself on your own page, the way a customer would. It is marked as a test, so it stays out of your reports.</DrawerDescription>
        </DrawerHeader>
        <DrawerPanel className="flex min-h-0 flex-col gap-3">
          {view.found ? (
            <div className="flex flex-col gap-3">
              <Alert variant="success" role="status">
                <CalendarCheck aria-hidden="true" />
                <AlertDescription>
                  It is on your schedule: {view.serviceName}{view.startsAt ? `, ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(view.startsAt))}` : ""}.
                </AlertDescription>
              </Alert>
              {confirmation ? (
                <Alert variant={confirmation.problem ? "warning" : "info"} role="status">
                  {confirmation.problem ? <CircleAlert aria-hidden="true" /> : <Spinner className={view.confirmation && ["sending", "sent", "delivered", "read"].includes(view.confirmation.status) ? "hidden" : undefined} />}
                  <AlertDescription>{confirmation.text}</AlertDescription>
                </Alert>
              ) : null}
              <p className="text-muted-foreground text-sm">Remove it when you are done. The slot opens up again and nothing about it is kept in your reports.</p>
            </div>
          ) : started ? (
            <>
              <div className="flex items-center gap-2 text-muted-foreground text-sm" role="status"><Spinner />Waiting for your booking…</div>
              {problem ? <Alert variant="warning"><AlertDescription>{problem}</AlertDescription></Alert> : null}
              <iframe title="Your booking page" src={src} className="min-h-[28rem] w-full flex-1 rounded-lg border bg-background" />
            </>
          ) : (
            <div className="flex flex-col gap-4">
              <dl className="grid gap-1 rounded-lg border p-3 text-sm">
                <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Name</dt><dd className="font-medium">{owner.name}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Email</dt><dd className="min-w-0 truncate font-medium">{owner.email}</dd></div>
              </dl>
              <PhoneField
                label="Your mobile number"
                hint="The confirmation is sent here. It is used for this test only."
                value={phone}
                onChange={setPhone}
                autoComplete="tel"
                error={phoneOk ? undefined : "Enter your number with the country code."}
              />
            </div>
          )}
        </DrawerPanel>
        <DrawerFooter className="flex-row flex-nowrap justify-end gap-2">
          {view.found ? (
            <>
              <Button variant="outline" loading={remove.isPending} onClick={() => void removeIt()}><Trash2 aria-hidden="true" />Remove test booking</Button>
              {/* Open the booking's own day: a phone shows one day at a time, and the first open time is often not today. */}
              <Button render={<Link href={view.startsAt ? `/schedule?date=${clinicDateKey(view.startsAt)}` : "/schedule"} />} onClick={() => onOpenChange(false)}>See it on the schedule</Button>
            </>
          ) : started ? (
            <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button disabled={!phoneOk} onClick={() => setStarted(new Date().toISOString())}>Start the test booking</Button>
            </>
          )}
        </DrawerFooter>
      </ResponsiveDrawerPopup>
    </ResponsiveDrawer>
  );
}
