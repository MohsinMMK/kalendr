"use client";

import { FileUp } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { useTerms } from "@/features/terms/business-profile-context";

/** The Settings entry for data import. The wizard needs the whole page, so this points to it. */
export function ImportSettingsEntry() {
  const t = useTerms();
  return (
    <Frame>
      <FrameHeader>
        <FrameTitle>Import data</FrameTitle>
        <FrameDescription>Bring your {t.customers}, {t.services} or future {t.appointments} in from a CSV or Excel file.</FrameDescription>
      </FrameHeader>
      <FramePanel className="flex flex-col items-start gap-3">
        <ul className="list-disc ps-5 text-sm text-muted-foreground">
          <li>You check every row before anything is saved.</li>
          <li>Nothing is sent to your {t.customers} by importing.</li>
          <li>You can undo an import for 7 days.</li>
        </ul>
        <Button render={<a href="/settings/import" />}><FileUp aria-hidden="true" /> Open the import wizard</Button>
      </FramePanel>
    </Frame>
  );
}
