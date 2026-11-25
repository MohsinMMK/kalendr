"use client";

import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";

/**
 * Back on the left, the main action on the right. Below 768px it stays fixed
 * at the bottom of the screen, clear of the phone's home bar; from 768px it
 * sits under the screen's content.
 */
export function BookingBottomBar({
  onBack,
  backDisabled = false,
  children,
}: {
  /** Hidden on the first screen. */
  onBack?: () => void;
  backDisabled?: boolean;
  /** The main action, usually Continue. */
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:z-20 max-md:border-t max-md:bg-background/95 max-md:px-4 max-md:pt-3 max-md:pb-[max(--spacing(3),env(safe-area-inset-bottom))] max-md:backdrop-blur md:border-t md:pt-5">
      {onBack ? (
        <Button size="lg" variant="ghost" onClick={onBack} disabled={backDisabled}>
          <ArrowLeft aria-hidden="true" />
          Back
        </Button>
      ) : (
        <span aria-hidden="true" />
      )}
      <div className="flex min-w-0 justify-end max-md:flex-1 max-md:[&>*]:flex-1 max-md:[&>*]:max-w-64">{children}</div>
    </div>
  );
}
