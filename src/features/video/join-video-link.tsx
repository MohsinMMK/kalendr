"use client";

import { Video } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import type { VisitStatusView } from "@/lib/video-contracts";

/**
 * A "Join video visit" link for a booking that turns out to be a video visit. It asks the visit
 * page's endpoint once and shows nothing if the answer is no, late, or an error.
 */
export function JoinVideoLink({ manageToken, className }: { manageToken: string; className?: string }) {
  const [isVideo, setIsVideo] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/public/visit/${encodeURIComponent(manageToken)}`, {
          headers: { Accept: "application/json" },
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) return;
        const body: unknown = await response.json().catch(() => null);
        const data = typeof body === "object" && body !== null && "data" in body ? (body as { data?: Partial<VisitStatusView> }).data : undefined;
        const state = data?.state;
        if (state && state !== "not_video" && state !== "cancelled" && state !== "ended") setIsVideo(true);
      } catch {
        // Nothing to show. The booking page works without it.
      }
    })();
    return () => controller.abort();
  }, [manageToken]);

  if (!isVideo) return null;
  return (
    <Button variant="outline" size="lg" className={className} render={<Link href={`/visit/${encodeURIComponent(manageToken)}`} />}>
      <Video aria-hidden="true" />
      Join video visit
    </Button>
  );
}
