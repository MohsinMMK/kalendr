"use client";

import { Check, Copy, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { toastManager } from "@/components/ui/toast";
import { useStaffAccess } from "@/features/clinic/staff-access";
import { useTerms } from "@/features/terms/business-profile-context";

/** The path of a business's public booking page. Shared with the command palette's "Copy booking link". */
export function bookingPathFor(slug: string): string {
  return `/book/${slug}`;
}

/**
 * The public booking link, pinned at the bottom of the sidebar with Copy and Open. It is for people who book for customers
 * (everyone with the permission to add a booking); billing and read-only roles do not see it. Folded to icons, the sidebar
 * has no room for it, so it hides.
 */
export function BookingLinkPin({ slug, preview }: { slug: string; preview: boolean }) {
  const t = useTerms();
  const allowed = useStaffAccess().can("appointments.book");
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // After mount, so the first paint matches the server's.
    queueMicrotask(() => setOrigin(window.location.origin));
  }, []);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!allowed || preview || !slug) return null;
  const path = bookingPathFor(slug);
  const address = `${origin}${path}`;

  const copy = () => {
    void navigator.clipboard.writeText(address).then(
      () => { setCopied(true); toastManager.add({ title: "Booking link copied", type: "success" }); },
      () => toastManager.add({ title: "Could not copy the booking link", type: "error" }),
    );
  };

  return (
    <div data-testid="booking-link-pin" className="flex flex-col gap-1.5 rounded-lg border p-2 group-data-[collapsible=icon]:hidden">
      <p className="px-1 text-xs font-medium text-foreground">Your booking link</p>
      <p className="truncate px-1 text-xs text-muted-foreground" title={address}>{origin ? address.replace(/^https?:\/\//, "") : path}</p>
      <div className="grid grid-cols-2 gap-1.5">
        <Button type="button" variant="outline" size="sm" className="min-h-9" onClick={copy}>
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? "Copied" : "Copy"}<span className="sr-only"> the {t.customer} booking link</span>
        </Button>
        <Button type="button" variant="outline" size="sm" className="min-h-9" render={<a href={path} target="_blank" rel="noopener" />}>
          <ExternalLink aria-hidden="true" />
          Open<span className="sr-only"> the {t.customer} booking page in a new tab</span>
        </Button>
      </div>
    </div>
  );
}
