"use client";

import { CloudOff } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";

import { formatOfflineTime, useOfflineAt } from "./offline-status";

/** Shown when the schedule on screen is the saved copy, not live. Nothing can be changed until the connection is back. */
export function OfflineBanner() {
  const at = useOfflineAt();
  if (!at) return null;
  return (
    <Alert variant="warning" role="status" className="rounded-none border-x-0 border-t-0">
      <CloudOff aria-hidden="true" />
      <AlertDescription>
        Offline: showing {formatOfflineTime(at)}. You can look but not change anything until you are back online; nothing you try now is saved for later.
      </AlertDescription>
    </Alert>
  );
}
