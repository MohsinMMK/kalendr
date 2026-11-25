"use client";

import { CircleAlert, RotateCcw } from "lucide-react";
import { useEffect } from "react";

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
import { reportClientError } from "@/lib/browser-monitoring";

import "./globals.css";

/** Replaces the root layout when it fails, so it brings its own document and styles. */
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    reportClientError(error);
  }, [error]);

  const digest =
    error instanceof Error && "digest" in error && typeof error.digest === "string" ? error.digest : null;

  return (
    <html lang="en" className="light h-full antialiased">
      <body>
        <title>Something went wrong · Kalendr</title>
        <main className="grid min-h-svh place-items-center bg-background p-4">
          <Frame className="w-full max-w-lg">
            <FramePanel className="p-0">
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <CircleAlert aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle>
                    <h1>Kalendr could not load.</h1>
                  </EmptyTitle>
                  <EmptyDescription className="mt-1">
                    Your appointments have not been changed. Try again in a moment; if it keeps happening, contact the
                    business directly.
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button onClick={() => retry()}>
                    <RotateCcw aria-hidden="true" />
                    Try again
                  </Button>
                  {digest ? <p className="text-xs text-muted-foreground">Reference: {digest}</p> : null}
                </EmptyContent>
              </Empty>
            </FramePanel>
          </Frame>
        </main>
      </body>
    </html>
  );
}
