import { ArrowLeft, CalendarSearch } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Frame, FramePanel } from "@/components/ui/frame";

export default function NotFound() {
  return (
    <main className="grid flex-1 place-items-center bg-background p-4">
      <Frame className="w-full max-w-lg">
        <FramePanel className="p-0">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <CalendarSearch aria-hidden="true" />
              </EmptyMedia>
              <p className="mb-1 text-xs text-muted-foreground">Page not found</p>
              <EmptyTitle>
                <h1>This appointment page is unavailable.</h1>
              </EmptyTitle>
              <EmptyDescription className="mt-1">
                The link may be incomplete or no longer active. Return to Kalendr or ask the business for its current booking link.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button render={<Link href="/" />}>
                <ArrowLeft aria-hidden="true" />
                Return home
              </Button>
            </EmptyContent>
          </Empty>
        </FramePanel>
      </Frame>
    </main>
  );
}
