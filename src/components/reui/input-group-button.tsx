"use client";

import type * as React from "react";

import { Button } from "@/components/ui/button";

/**
 * coss has no InputGroupButton; ReUI's time picker expects one. A ghost coss
 * Button sized for an InputGroupAddon (icon-xs already adapts inside input groups).
 */
function InputGroupButton({ variant = "ghost", size = "xs", ...props }: React.ComponentProps<typeof Button>) {
  return <Button data-slot="input-group-button" variant={variant} size={size} {...props} />;
}

export { InputGroupButton };
