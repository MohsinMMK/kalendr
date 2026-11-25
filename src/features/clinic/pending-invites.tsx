"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MailPlus } from "lucide-react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { clearOfflineData } from "@/features/app-support/service-worker";
import type { StaffRole } from "@/lib/permissions";
import type { MyInvite } from "@/server/staff-login-invites";

import { clearStaffQueryCache } from "./queries/client";
import { staffMutation } from "./queries/http";

/** The inviting business has its own words for roles that are not readable from here, so they are named neutrally. */
const roleNames: Record<StaffRole, string> = {
  owner: "an owner",
  admin: "an admin",
  receptionist: "a receptionist",
  practitioner: "a practitioner",
  billing: "billing staff",
  read_only: "a read-only member",
};

function PendingInvite({ invite }: { invite: MyInvite }) {
  const router = useRouter();
  const [pending, setPending] = useState<"accept" | "decline" | null>(null);
  const [error, setError] = useState("");

  async function answer(choice: "accept" | "decline") {
    setPending(choice);
    setError("");
    try {
      await staffMutation(`/api/staff/invites/${encodeURIComponent(invite.id)}/${choice}`, "POST", {});
      if (choice === "decline") {
        setPending(null);
        router.refresh();
        return;
      }
      // Accepting opens the new business, so what the page holds for the current one is cleared the way a switch clears it.
      clearStaffQueryCache();
      await clearOfflineData();
      window.location.assign(new URL("/dashboard", window.location.origin));
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Could not answer the invite. Try again.");
      setPending(null);
    }
  }

  return (
    <Alert variant="info">
      <MailPlus aria-hidden="true" />
      <AlertTitle>{invite.businessName} invited you to join as {roleNames[invite.role]}</AlertTitle>
      <AlertDescription>
        {error ? <p className="text-destructive-foreground">{error}</p> : <p>Accept to add it to the businesses you can open with this login. If you decline, they are not told.</p>}
      </AlertDescription>
      <AlertAction>
        <Button size="sm" variant="ghost" disabled={pending !== null} onClick={() => void answer("decline")}>
          {pending === "decline" ? "Declining…" : "Decline"}
        </Button>
        <Button size="sm" disabled={pending !== null} onClick={() => void answer("accept")}>
          {pending === "accept" ? "Joining…" : "Accept"}
        </Button>
      </AlertAction>
    </Alert>
  );
}

/** Invites from other businesses that are waiting for this login's answer. Nothing shows when there are none. */
export function PendingInvites({ invites, className }: { invites: MyInvite[]; className?: string }) {
  if (invites.length === 0) return null;
  return (
    <div className={className ?? "flex w-full flex-col gap-2"} aria-label="Invites to other businesses" role="region">
      {invites.map((invite) => <PendingInvite key={invite.id} invite={invite} />)}
    </div>
  );
}
