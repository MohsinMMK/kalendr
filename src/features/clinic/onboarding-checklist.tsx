"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CheckCircle2, ChevronRight, Circle, ListChecks, MinusCircle, MoreHorizontal, PlayCircle, Sparkles, Trash2 } from "lucide-react";

import { ActionMenuButton, type ActionMenuEntry } from "@/components/action-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Meter, MeterIndicator, MeterTrack } from "@/components/ui/meter";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import { stepWords, type StepTarget } from "@/lib/onboarding-steps";

import { ConfirmDialog } from "./calendar-confirm";
import { useCatalogLookups } from "./clinic-catalog";
import { requestProductTour } from "./product-tour";
import { useAddSampleData, useOnboarding, useRemoveTestData, useStepAction, useTourAction, type OnboardingState } from "./queries/onboarding";
import { requestSettingsSection } from "./settings-navigation";
import { ShareLinkDialog } from "./share-link-dialog";
import { useStaffAccess } from "./staff-access";
import { useOptionalStaffSnapshot } from "./staff-snapshot-provider";
import { TestBookingPanel } from "./test-booking-panel";

type Step = OnboardingState["steps"][number];

const statusIcon = {
  done: <CheckCircle2 className="size-4 text-success" aria-hidden="true" />,
  todo: <Circle className="size-4 text-muted-foreground" aria-hidden="true" />,
  skipped: <MinusCircle className="size-4 text-muted-foreground" aria-hidden="true" />,
} as const;
const statusWord = { done: "Done", todo: "To do", skipped: "Skipped" } as const;

/**
 * "Getting started" (feature 11): a slim card on the dashboard with how far the owner has got, the next step as one button,
 * and the whole list of eight in a dialog. Each step shows done, to do or skipped and sits one click from where it is done.
 * Progress is saved on the server, so leaving halfway and coming back shows the same next step. Hidden once every step
 * is done or skipped, and for businesses set up before this existed.
 */
export function OnboardingChecklist() {
  const database = useCatalogLookups().database;
  const canManage = useStaffAccess().can("settings.manage");
  // Only a real business's owner or admin reads the checklist; the preview and other roles never reach the data hooks.
  return database && canManage ? <ChecklistBody /> : null;
}

function ChecklistBody() {
  const t = useTerms();
  const router = useRouter();
  const catalog = useCatalogLookups();
  const staff = useOptionalStaffSnapshot();
  const query = useOnboarding();
  const stepAction = useStepAction();
  const tourAction = useTourAction();
  const addSample = useAddSampleData();
  const removeTest = useRemoveTestData();
  const [listOpen, setListOpen] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const state = query.data;
  const refetch = query.refetch;

  // What the owner just fixed in Settings (a phone number, a logo) must show when they come back to the list or the link.
  useEffect(() => {
    if (listOpen || shareOpen) void refetch();
  }, [listOpen, shareOpen, refetch]);

  if (!state) return null;
  const { summary } = state;
  // Finished: nothing to show, unless test data is still in, which is worth a reminder in the menu only.
  const hidden = summary.finished;
  const nextStep = state.steps.find((step) => step.key === summary.next);

  function go(target: StepTarget) {
    setListOpen(false);
    if (target.kind === "settings") requestSettingsSection(target.section);
    else if (target.kind === "panel") (target.panel === "test_booking" ? setTestOpen : setShareOpen)(true);
    else router.push(target.href);
  }
  function mark(key: Step["key"], action: "done" | "skip" | "undo") {
    stepAction.mutate({ step: key, action }, {
      onError: (error) => toastManager.add({ title: "Could not save that", description: error.message, type: "error" }),
    });
  }
  async function removeTestData() {
    try {
      const result = await removeTest.mutateAsync();
      toastManager.add({ title: "Test data removed", description: `${result.appointmentsRemoved} ${result.appointmentsRemoved === 1 ? t.appointment : t.appointments} and ${result.customersRemoved} ${result.customersRemoved === 1 ? t.customer : t.customers} removed.${result.appointmentsRetired > 0 ? ` ${result.appointmentsRetired} with a payment or record on it ${result.appointmentsRetired === 1 ? "was" : "were"} marked as entered in error instead.` : ""}${result.customersKept > 0 ? ` ${result.customersKept} ${result.customersKept === 1 ? t.customer : t.customers} with a consent record ${result.customersKept === 1 ? "has" : "have"} to stay.` : ""}`, type: "success" });
      await staff?.refresh();
      setConfirmRemove(false);
    } catch (cause: unknown) {
      toastManager.add({ title: "Could not remove test data", description: cause instanceof Error ? cause.message : "Try again.", type: "error" });
    }
  }
  async function addSampleData() {
    try {
      const result = await addSample.mutateAsync();
      toastManager.add({ title: "Sample data added", description: `${result.added} sample ${result.added === 1 ? t.appointment : t.appointments} over the next week. Remove them any time from the ⋯ menu.`, type: "success" });
      await staff?.refresh();
    } catch (cause: unknown) {
      toastManager.add({ title: "Could not add sample data", description: cause instanceof Error ? cause.message : "Try again.", type: "error" });
    }
  }

  const menu: ActionMenuEntry[] = [
    { id: "all", label: "See all steps", icon: <ListChecks aria-hidden="true" />, onSelect: () => setListOpen(true) },
    { id: "tour", label: "Take the tour", hint: "Five short stops on your real screens", icon: <PlayCircle aria-hidden="true" />, onSelect: () => { tourAction.mutate("reopen"); requestProductTour(); } },
    { kind: "separator", id: "sep" },
    state.sampleData
      ? { id: "sample-off", label: "Remove sample data", icon: <Trash2 aria-hidden="true" />, onSelect: () => setConfirmRemove(true) }
      : { id: "sample-on", label: "Add sample data", hint: `A week of labelled sample ${t.appointments}`, icon: <Sparkles aria-hidden="true" />, onSelect: () => void addSampleData() },
    ...(state.testRows > 0 && !state.sampleData ? [{ id: "test-off", label: "Remove test data", icon: <Trash2 aria-hidden="true" />, onSelect: () => setConfirmRemove(true) }] : []),
  ];

  return (
    <>
      {hidden ? null : (
        <Card className="shrink-0 px-3 py-2.5 lg:py-2" aria-label="Getting started">
          <div className="flex flex-nowrap items-center gap-3">
            <ListChecks className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <p className="truncate font-medium text-sm">
                Getting started <span className="font-normal text-muted-foreground">· {summary.done} of {summary.total} done</span>
              </p>
              <Meter value={summary.done + summary.skipped} max={summary.total} aria-label="Setup progress" className="max-w-xs max-sm:hidden">
                <MeterTrack className="h-1.5"><MeterIndicator /></MeterTrack>
              </Meter>
            </div>
            {nextStep ? (
              <Button size="sm" className="shrink-0" onClick={() => go(nextStep.target)}>
                <span className="max-sm:hidden">{stepWords(nextStep.key, t).title}</span>
                <span className="sm:hidden">{nextStep.actionLabel}</span>
                <ChevronRight aria-hidden="true" />
              </Button>
            ) : null}
            <ActionMenuButton iconOnly label="More about getting started" icon={<MoreHorizontal aria-hidden="true" />} variant="ghost" items={menu} />
          </div>
        </Card>
      )}

      <Dialog open={listOpen} onOpenChange={setListOpen}>
        <DialogPopup className="sm:max-w-lg" bottomStickOnMobile>
          <DialogHeader>
            <DialogTitle>Getting started</DialogTitle>
            <DialogDescription>{summary.done} of {summary.total} done. Each step takes about a minute, and your progress is saved.</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <ol className="flex flex-col divide-y rounded-lg border">
              {state.steps.map((step) => {
                const words = stepWords(step.key, t);
                return (
                  <li key={step.key} className="flex flex-nowrap items-start gap-3 p-3">
                    <span className="mt-0.5" role="img" aria-label={statusWord[step.status]}>{statusIcon[step.status]}</span>
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <p className="flex items-center gap-2 font-medium text-sm">{words.title}{step.status === "skipped" ? <Badge variant="outline">Skipped</Badge> : null}</p>
                      <p className="text-muted-foreground text-xs">{words.detail}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {step.status === "done" ? null : <Button size="xs" variant={step.key === summary.next ? "default" : "outline"} onClick={() => go(step.target)}>{step.actionLabel}</Button>}
                      <ActionMenuButton
                        iconOnly
                        label={`More for ${words.title}`}
                        icon={<MoreHorizontal aria-hidden="true" />}
                        variant="ghost"
                        items={[
                          ...(step.status === "todo" && ["services", "hours", "share_link"].includes(step.key) ? [{ id: "done", label: "Mark as done", onSelect: () => mark(step.key, "done") }] : []),
                          ...(step.status === "todo" ? [{ id: "skip", label: "Skip this step", onSelect: () => mark(step.key, "skip") }] : []),
                          ...(step.status === "skipped" ? [{ id: "undo", label: "Put it back on the list", onSelect: () => mark(step.key, "undo") }] : []),
                          ...(step.status === "done" ? [{ id: "open", label: "Open again", onSelect: () => go(step.target) }] : []),
                        ]}
                      />
                    </div>
                  </li>
                );
              })}
            </ol>
          </DialogPanel>
        </DialogPopup>
      </Dialog>

      <TestBookingPanel open={testOpen} onOpenChange={setTestOpen} owner={state.owner} slug={catalog.clinic.slug} />
      <ShareLinkDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        state={state}
        onFix={(target) => { setShareOpen(false); go(target); }}
        onShared={() => mark("share_link", "done")}
      />
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove test and sample data?"
        description={`This removes your test booking, every sample ${t.appointment} and the sample ${t.customers}. Real ${t.appointments} and ${t.customers} are not touched.`}
        confirmLabel="Remove them"
        destructive
        busy={removeTest.isPending}
        onConfirm={() => void removeTestData()}
      />
    </>
  );
}
