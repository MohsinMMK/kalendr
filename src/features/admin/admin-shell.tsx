"use client";

import { Activity, Building2, History, MessagesSquare, ShieldAlert, SlidersHorizontal, UserCog } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { ScrollAreaPrimitive, ScrollBar } from "@/components/ui/scroll-area";
import { StaffQueryProvider } from "@/features/clinic/queries/client";
import { StepUpProvider } from "@/features/clinic/step-up-dialog";
import type { PlatformRole } from "@/lib/admin-contracts";
import { cn } from "@/lib/utils";

import { adminCan, roleLabels } from "./admin-format";
import { AdminRoleProvider } from "./admin-role";

const sections = [
  { href: "/admin", label: "Businesses", icon: Building2, match: (path: string) => path === "/admin" || path.startsWith("/admin/tenants") },
  { href: "/admin/messages", label: "Messages", icon: MessagesSquare, needs: "findMessages" },
  { href: "/admin/worker", label: "Worker", icon: Activity },
  { href: "/admin/abuse", label: "Abuse", icon: ShieldAlert },
  { href: "/admin/features", label: "Features", icon: SlidersHorizontal },
  { href: "/admin/audit", label: "Audit", icon: History },
  { href: "/admin/operators", label: "Operators", icon: UserCog, needs: "manageOperators" },
] as const;

type Section = (typeof sections)[number];

function isActive(section: Section, path: string): boolean {
  return "match" in section ? section.match(path) : path === section.href || path.startsWith(`${section.href}/`);
}

/** The operator's own frame: a left rail on wide screens, a scrolling bar of the same links on phones. */
export function AdminShell({ role, children }: { role: PlatformRole; children: ReactNode }) {
  const path = usePathname();
  const allowed = adminCan(role);
  const visible = sections.filter((section) => !("needs" in section) || allowed[section.needs]);
  return (
    <StaffQueryProvider scope="admin">
      <AdminRoleProvider role={role}>
        <StepUpProvider>
          <div className="flex min-h-svh flex-col bg-background md:flex-row">
            <a className="skip-link" href="#admin-main">Skip to content</a>
            <aside className="border-b bg-sidebar md:sticky md:top-0 md:h-svh md:w-60 md:shrink-0 md:border-r md:border-b-0">
              <div className="flex items-center justify-between gap-2 px-4 py-3 md:flex-col md:items-start md:gap-1 md:py-5">
                <p className="font-heading text-base font-semibold">Kalendr operators</p>
                <Badge variant="outline" size="lg">{roleLabels[role]}</Badge>
              </div>
              <ScrollAreaPrimitive.Root className="px-2 pb-2 md:pb-4">
                <ScrollAreaPrimitive.Viewport data-slot="scroll-area-viewport" className="rounded-[inherit] outline-none">
                  <ScrollAreaPrimitive.Content>
                  <nav aria-label="Operator sections" className="flex gap-1 md:flex-col">
                    {visible.map((section) => {
                      const active = isActive(section, path);
                      return (
                        <Link
                          key={section.href}
                          href={section.href}
                          aria-current={active ? "page" : undefined}
                          className={cn(
                            "inline-flex min-h-11 shrink-0 items-center gap-2 rounded-lg px-3 text-sm font-medium text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                            active && "bg-accent text-foreground",
                          )}
                        >
                          <section.icon aria-hidden="true" className="size-4" />
                          {section.label}
                        </Link>
                      );
                    })}
                  </nav>
                  </ScrollAreaPrimitive.Content>
                </ScrollAreaPrimitive.Viewport>
                <ScrollBar orientation="horizontal" />
              </ScrollAreaPrimitive.Root>
            </aside>
            <main id="admin-main" className="min-w-0 flex-1 p-4 md:p-6">
              <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">{children}</div>
            </main>
          </div>
        </StepUpProvider>
      </AdminRoleProvider>
    </StaffQueryProvider>
  );
}
