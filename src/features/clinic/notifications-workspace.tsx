"use client";

import { CircleAlert } from "lucide-react";
import { useRouter } from "next/navigation";

import { WorkspacePage } from "@/components/workspace-page";
import { Alert, AlertDescription } from "@/components/ui/alert";

import { NotificationSettings } from "./notification-settings";

/** The Notifications page, opened from the profile menu. */
export function NotificationsWorkspace({ preview }: { preview: boolean }) {
  const router = useRouter();
  return (
    <WorkspacePage title="Notifications" description="What you hear about, how you hear it, and when." back={{ label: "Back to my profile", onClick: () => router.push("/profile") }}>
      {preview ? (
        <Alert variant="info">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>This preview has no accounts. Notification choices are saved once a database is connected.</AlertDescription>
        </Alert>
      ) : <NotificationSettings />}
    </WorkspacePage>
  );
}
