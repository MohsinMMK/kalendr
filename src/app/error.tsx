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

export default function ErrorPage({
  error,
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  useEffect(() => {
    reportClientError(error);
  }, [error]);

  const digest =
    error instanceof Error && "digest" in error && typeof error.digest === "string"
      ? error.digest
      : null;
  return (
    <main className="grid flex-1 place-items-center bg-background p-4">
      <Frame className="w-full max-w-lg">
        <FramePanel className="p-0">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <CircleAlert aria-hidden="true" />
              </EmptyMedia>
              <p className="mb-1 text-xs text-muted-foreground">Something went wrong</p>
              <EmptyTitle>
                <h1>This page could not be loaded.</h1>
              </EmptyTitle>
              <EmptyDescription className="mt-1">
                Your appointment information has not been changed. Try loading the page again; if the problem continues, contact the business directly.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={() => retry()}>
                <RotateCcw aria-hidden="true" />
                Try again
              </Button>
              {digest ? (
                <p className="text-xs text-muted-foreground">Reference: {digest}</p>
              ) : null}
            </EmptyContent>
          </Empty>
        </FramePanel>
      </Frame>
    </main>
  );
}
