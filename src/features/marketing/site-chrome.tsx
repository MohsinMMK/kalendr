import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Brand } from "@/features/marketing/brand";
import { MobileNav } from "@/features/marketing/mobile-nav";
import { container } from "@/features/marketing/page-parts";
import { marketingPages } from "@/features/marketing/site-nav";
import { cn } from "@/lib/utils";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b bg-background">
      <div className={cn(container, "flex h-14 items-center justify-between gap-4")}>
        <div className="flex items-center gap-6">
          <Brand />
          <nav className="hidden items-center gap-0.5 lg:flex" aria-label="Main navigation">
            {marketingPages.map((page) => (
              <Button key={page.href} variant="ghost" size="sm" render={<Link href={page.href} />}>
                {page.label}
              </Button>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" className="max-sm:hidden" render={<Link href="/sign-in" />}>
            Sign in
          </Button>
          <Button render={<Link href="/start" />}>
            Get started <ArrowRight aria-hidden="true" />
          </Button>
          <MobileNav />
        </div>
      </div>
    </header>
  );
}

const footerLink = "text-sm text-muted-foreground no-underline hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export function SiteFooter() {
  return (
    <footer className="border-t">
      <div className={cn(container, "grid gap-8 py-10 sm:grid-cols-[minmax(0,2fr)_repeat(2,minmax(0,1fr))]")}>
        <div className="flex flex-col items-start gap-2">
          <Brand size={20} className="text-base" />
          <p className="text-sm text-muted-foreground">Online booking and scheduling for businesses that run on appointments.</p>
          <p className="text-xs text-muted-foreground">Kalendr by Khanect</p>
        </div>
        <nav aria-label="Product">
          <h2 className="mb-3 text-sm font-medium">Product</h2>
          <ul className="space-y-2">
            {marketingPages.map((page) => (
              <li key={page.href}>
                <Link className={footerLink} href={page.href}>{page.label}</Link>
              </li>
            ))}
          </ul>
        </nav>
        <nav aria-label="Get going">
          <h2 className="mb-3 text-sm font-medium">Get going</h2>
          <ul className="space-y-2">
            <li><Link className={footerLink} href="/start">Set up your business</Link></li>
            <li><Link className={footerLink} href="/explore">Find a business</Link></li>
            <li><Link className={footerLink} href="/developers">Developers</Link></li>
            <li><Link className={footerLink} href="/sign-in">Team sign in</Link></li>
          </ul>
        </nav>
      </div>
    </footer>
  );
}
