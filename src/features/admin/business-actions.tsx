"use client";

import { Eye, History, MailCheck, PauseCircle, PlayCircle } from "lucide-react";
import { useState } from "react";

import { ActionBar, type BarAction } from "@/components/action-bar";
import { toastManager } from "@/components/ui/toast";
import type { AdminTenantHealth } from "@/lib/admin-contracts";

import { adminActions, useAdminAction } from "./admin-api";
import { useAdminCan } from "./admin-role";
import { ImpersonateDialog } from "./impersonate-dialog";
import { ReasonDialog } from "./reason-dialog";

type Open = "pause" | "resend" | "view" | null;

/** One row that never wraps; what does not fit goes into the ⋯ menu. Actions this role cannot do are not offered. */
export function BusinessActions({ health, onViewStarted }: { health: AdminTenantHealth; onViewStarted: () => void }) {
  const can = useAdminCan();
  const [open, setOpen] = useState<Open>(null);
  const paused = Boolean(health.pausedAt) || !health.isActive;
  const pause = useAdminAction((input: { reason: string }) => adminActions.pause(health.tenantId, { paused: !paused, reason: input.reason }));
  const resend = useAdminAction((input: { reason: string }) => adminActions.resend(health.tenantId, input));

  const actions: BarAction[] = [
    ...(can.viewAs ? [{ id: "view", label: "View as this business", icon: <Eye />, variant: "default" as const, priority: 3, onSelect: () => setOpen("view") }] : []),
    ...(can.pause ? [{ id: "pause", label: paused ? "Resume business" : "Pause business", icon: paused ? <PlayCircle /> : <PauseCircle />, priority: 2, onSelect: () => setOpen("pause") }] : []),
    ...(can.resend ? [{ id: "resend", label: "Resend verification email", icon: <MailCheck />, priority: 1, onSelect: () => setOpen("resend") }] : []),
    { id: "audit", label: "Audit trail", icon: <History />, href: `/admin/audit?tenant=${encodeURIComponent(health.tenantId)}` },
  ];

  return (
    <>
      <ActionBar actions={actions} />
      <ImpersonateDialog tenantId={health.tenantId} businessName={health.name} open={open === "view"} onOpenChange={(next) => setOpen(next ? "view" : null)} onStarted={onViewStarted} />
      <ReasonDialog
        open={open === "pause"}
        onOpenChange={(next) => setOpen(next ? "pause" : null)}
        title={paused ? `Resume ${health.name}?` : `Pause ${health.name}?`}
        description={paused ? "Its public pages and bookings work again straight away." : "Its public pages show a neutral notice and no new bookings come in. Staff can still sign in."}
        confirmLabel={paused ? "Resume business" : "Pause business"}
        destructive={!paused}
        onConfirm={async (reason) => {
          await pause.mutateAsync({ reason });
          toastManager.add({ title: paused ? "Business resumed" : "Business paused", type: "success" });
        }}
      />
      <ReasonDialog
        open={open === "resend"}
        onOpenChange={(next) => setOpen(next ? "resend" : null)}
        title="Resend the verification email?"
        description="The owner gets a fresh link at the email they signed up with. You will not see the address."
        confirmLabel="Resend email"
        onConfirm={async (reason) => {
          await resend.mutateAsync({ reason });
          toastManager.add({ title: "Verification email queued", type: "success" });
        }}
      />
    </>
  );
}
