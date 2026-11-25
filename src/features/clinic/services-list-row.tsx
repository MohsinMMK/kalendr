"use client";

import Link from "next/link";
import { Copy, CopyPlus, EllipsisVertical, Eye, EyeOff, ExternalLink, GripVertical, Link2, Trash2 } from "lucide-react";

import { SortableItem, SortableItemHandle } from "@/components/reui/sortable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Switch } from "@/components/ui/switch";
import { serviceMeta } from "@/features/booking/booking-options";
import { useTerms } from "@/features/terms/business-profile-context";
import type { Service } from "@/lib/domain";

export interface ServiceRowActions {
  onToggle: (service: Service, active: boolean) => void;
  onCopyLink: (service: Service) => void;
  onDuplicate: (service: Service) => void;
  onVisibility: (service: Service, visibility: "listed" | "hidden") => void;
  onDelete: (service: Service) => void;
}

/** One service: the name opens its editor, the switch turns it on or off, everything else is in the one row of buttons. */
export function ServiceRow({ service, previewHref, handle, canManage, busy, actions }: {
  service: Service;
  previewHref: string | null;
  handle: boolean;
  canManage: boolean;
  busy: boolean;
  actions: ServiceRowActions;
}) {
  const t = useTerms();
  const active = service.isActive !== false;
  return (
    <SortableItem value={service.id} role="group" tabIndex={-1} className="bg-card">
      <div className="flex min-h-14 items-center gap-1.5 px-2 py-1.5 sm:gap-2 sm:px-3">
        {handle ? (
          <SortableItemHandle render={<Button variant="ghost" size="icon" aria-label={`Move ${service.name}. Drag it, or press space and use the arrow keys.`} />}>
            <GripVertical aria-hidden="true" />
          </SortableItemHandle>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <Link href={`/services/${service.id}`} className={`min-w-0 truncate rounded-sm text-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring ${active ? "" : "text-muted-foreground"}`}>
              {service.name}
            </Link>
            {service.visibility === "hidden" ? <Badge variant="outline" size="sm" className="shrink-0">Hidden</Badge> : null}
          </div>
          <p className="truncate text-xs text-muted-foreground">{serviceMeta(service)}</p>
        </div>
        {canManage ? (
          <Switch checked={active} disabled={busy} onCheckedChange={(next) => actions.onToggle(service, next)} aria-label={`${service.name} is ${active ? "on" : "off"}`} />
        ) : null}
        {previewHref ? (
          <Button variant="ghost" size="icon" className="hidden sm:inline-flex" aria-label={`Preview ${service.name}`} render={<a href={previewHref} target="_blank" rel="noreferrer" />}>
            <ExternalLink aria-hidden="true" />
          </Button>
        ) : null}
        <Button variant="ghost" size="icon" className="hidden sm:inline-flex" aria-label={`Copy link to ${service.name}`} onClick={() => actions.onCopyLink(service)}>
          <Link2 aria-hidden="true" />
        </Button>
        <Menu>
          <MenuTrigger render={<Button variant="ghost" size="icon" aria-label={`More for ${service.name}`} />}>
            <EllipsisVertical aria-hidden="true" />
          </MenuTrigger>
          <MenuPopup align="end">
            {previewHref ? (
              <MenuItem className="sm:hidden" render={<a href={previewHref} target="_blank" rel="noreferrer" />}>
                <ExternalLink aria-hidden="true" />
                Preview
              </MenuItem>
            ) : null}
            <MenuItem className="sm:hidden" onClick={() => actions.onCopyLink(service)}>
              <Copy aria-hidden="true" />
              Copy link
            </MenuItem>
            {canManage ? (
              <>
                <MenuItem onClick={() => actions.onDuplicate(service)}>
                  <CopyPlus aria-hidden="true" />
                  Duplicate
                </MenuItem>
                {service.visibility === "hidden" ? (
                  <MenuItem disabled={busy} onClick={() => actions.onVisibility(service, "listed")}>
                    <Eye aria-hidden="true" />
                    Show on booking page
                  </MenuItem>
                ) : (
                  <MenuItem disabled={busy} onClick={() => actions.onVisibility(service, "hidden")}>
                    <EyeOff aria-hidden="true" />
                    Hide from booking page
                  </MenuItem>
                )}
                <MenuSeparator />
                <MenuItem variant="destructive" onClick={() => actions.onDelete(service)}>
                  <Trash2 aria-hidden="true" />
                  Delete {t.service}
                </MenuItem>
              </>
            ) : null}
          </MenuPopup>
        </Menu>
      </div>
    </SortableItem>
  );
}
