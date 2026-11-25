"use client";

import { WorkspacePage } from "@/components/workspace-page";

import { ActivityLog } from "./activity-log";
import { ReviewsSettings } from "./reviews-settings";
import { SpamSettings } from "./spam-settings";

/**
 * Reviews, Spam and Activity used to sit in Settings. They are work that comes back every day rather than setup, so each
 * is now a sidebar page of its own, with the same panel it had in Settings.
 */
export function MovedSettingsPage({ page }: { page: "reviews" | "spam" | "activity" }) {
  return (
    <WorkspacePage nav={page}>
      <div className="flex w-full flex-col gap-4">
        {page === "reviews" ? <ReviewsSettings /> : page === "spam" ? <SpamSettings /> : <ActivityLog />}
      </div>
    </WorkspacePage>
  );
}
