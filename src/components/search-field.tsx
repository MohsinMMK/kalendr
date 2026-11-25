"use client";

import type { ComponentProps } from "react";
import { Search } from "lucide-react";

import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";

/** Search input on the coss InputGroup. Name it with `aria-label`, or place it in a coss Field with a FieldLabel. */
export function SearchField({
  className,
  ...props
}: Omit<ComponentProps<typeof InputGroupInput>, "type" | "className"> & { className?: string }) {
  return (
    <InputGroup className={className}>
      <InputGroupInput type="search" {...props} />
      <InputGroupAddon>
        <Search aria-hidden="true" />
      </InputGroupAddon>
    </InputGroup>
  );
}
