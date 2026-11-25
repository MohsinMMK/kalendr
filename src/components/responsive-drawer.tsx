"use client";

import type React from "react";

import { Drawer, DrawerPopup } from "@/components/ui/drawer";
import { useMediaQuery } from "@/hooks/use-media-query";

const phoneQuery = "(max-width: 767px)";

/** A side panel on wider screens and a bottom sheet on phones: the coss Drawer in place of the old Sheet. */
export function ResponsiveDrawer(props: Omit<React.ComponentProps<typeof Drawer>, "position">): React.ReactElement {
  const isPhone = useMediaQuery(phoneQuery);
  return <Drawer position={isPhone ? "bottom" : "right"} {...props} />;
}

/** The popup for a ResponsiveDrawer: a drag bar on phones, a close button everywhere (as the old Sheet had). */
export function ResponsiveDrawerPopup(props: Omit<React.ComponentProps<typeof DrawerPopup>, "position">): React.ReactElement {
  const isPhone = useMediaQuery(phoneQuery);
  return <DrawerPopup showBar={isPhone} showCloseButton {...props} />;
}
