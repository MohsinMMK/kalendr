"use client";

import Link from "next/link";
import { Menu as MenuIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Menu, MenuLinkItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { marketingPages } from "@/features/marketing/site-nav";

/** The page list behind one button below the lg breakpoint. */
export function MobileNav() {
  return (
    <Menu>
      <MenuTrigger render={<Button variant="ghost" size="icon" aria-label="Open menu" className="lg:hidden" />}>
        <MenuIcon aria-hidden="true" />
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-56">
        {marketingPages.map((page) => (
          <MenuLinkItem key={page.href} render={<Link href={page.href} />}>
            {page.label}
          </MenuLinkItem>
        ))}
        <MenuSeparator />
        <MenuLinkItem render={<Link href="/developers" />}>Developers</MenuLinkItem>
        <MenuLinkItem render={<Link href="/sign-in" />}>Sign in</MenuLinkItem>
      </MenuPopup>
    </Menu>
  );
}
