import { PhoneIcon } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { brandStyle, type BrandSettings } from "@/lib/brand-theme";
import { cn } from "@/lib/utils";

/**
 * A small, non-interactive copy of the first booking screen in the owner's colours, shown beside the controls
 * (feature 13). It sets the same CSS variables as the real page (`brandStyle`), so what is shown is what customers get.
 */
export function BrandPreview({
  brand,
  businessName,
  logoUrl,
  coverUrl,
  device,
}: {
  brand: BrandSettings;
  businessName: string;
  logoUrl: string | null;
  coverUrl: string | null;
  device: "phone" | "desktop";
}) {
  const initials = businessName.split(/\s+/).slice(0, 2).map((part) => part.charAt(0).toUpperCase()).join("");
  return (
    <div
      aria-label={`Preview on ${device}`}
      role="img"
      // Nothing in the preview can be focused or pressed; `inert` also keeps screen readers on the one label above.
      inert
      style={brandStyle(brand)}
      className={cn(
        "pointer-events-none mx-auto flex select-none flex-col overflow-hidden rounded-xl border bg-background text-foreground shadow-sm/5",
        device === "phone" ? "w-64" : "w-full max-w-lg",
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Avatar className="size-7 rounded-lg" aria-hidden="true">
            {logoUrl ? <AvatarImage src={logoUrl} alt="" className="object-cover" /> : null}
            <AvatarFallback className="text-xs">{initials}</AvatarFallback>
          </Avatar>
          <p className="truncate font-heading font-semibold text-xs">{businessName}</p>
        </div>
        {device === "desktop" ? <span className="flex items-center gap-1 text-muted-foreground text-xs"><PhoneIcon className="size-3" aria-hidden="true" />Call us</span> : null}
      </div>
      <div className="relative aspect-video w-full bg-muted">
        {/* A plain img on purpose: the cover is a same-site address, and next/image would need its own sizing here. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {coverUrl ? <img src={coverUrl} alt="" className="size-full object-cover" /> : <div className="flex size-full items-center justify-center bg-primary/10 text-muted-foreground text-xs">Cover photo</div>}
      </div>
      <div className="flex flex-col gap-2 p-3">
        <p className="font-heading font-semibold text-sm">Book an appointment</p>
        <div className="flex flex-wrap gap-1">
          <Badge variant="outline">Consultation</Badge>
          <Badge>Popular</Badge>
        </div>
        <Button size="sm" tabIndex={-1}>Choose a time</Button>
      </div>
      {brand.hideBadge ? null : <p className="border-t px-3 py-1.5 text-muted-foreground text-[10px]">Scheduling by Kalendr.</p>}
    </div>
  );
}
