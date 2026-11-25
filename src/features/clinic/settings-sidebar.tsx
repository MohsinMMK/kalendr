"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { HookSidebar } from "@/components/ui/hook-sidebar";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";

import { pickSettingsSection, settingsHref, useSettingsSections, type SettingsSection } from "./settings-sections";
import { useNavLabel } from "./sidebar-nav";

/**
 * The sidebar on the Settings page, in place of the app's own: a way back to the app on top, then the settings sections in
 * their four groups. Choosing a section changes the address, so the page and this list always agree.
 */
export function SettingsSidebar({ backHref, clinicName }: { backHref: string; clinicName: string }) {
  const router = useRouter();
  const asked = useSearchParams().get("section");
  const { groups, all } = useSettingsSections();
  const current = pickSettingsSection(asked, all)?.id;
  const { setOpenMobile, state, isMobile } = useSidebar();
  const railed = isMobile || state === "expanded";
  const settingsLabel = useNavLabel("settings");

  function open(section: SettingsSection) {
    setOpenMobile(false);
    router.replace(settingsHref(section), { scroll: false });
  }

  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              tooltip="Back to app"
              onClick={() => setOpenMobile(false)}
              render={<Link href={backHref} />}
            >
              <span className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-accent text-sidebar-accent-foreground">
                <ArrowLeft aria-hidden="true" />
              </span>
              <span className="grid min-w-0 flex-1 text-start text-sm leading-tight">
                <span className="truncate font-medium">{settingsLabel}</span>
                <span className="truncate text-xs text-muted-foreground">Back to {clinicName}</span>
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label="Settings sections" className="contents">
          {groups.map((group) => (
            <SidebarGroup key={group.id}>
              <SidebarGroupLabel>{group.title}</SidebarGroupLabel>
              <SidebarGroupContent>
                {railed ? (
                  <HookSidebar
                    aria-label={group.title}
                    className="pt-1"
                    items={group.items.map((item) => ({ id: `settings-${item.id}`, label: item.title, icon: item.icon }))}
                    value={group.items.findIndex((item) => item.id === current)}
                    onChange={(index) => { const item = group.items[index]; if (item) open(item.id); }}
                  />
                ) : (
                  <SidebarMenu>
                    {group.items.map((item) => (
                      <SidebarMenuItem key={item.id}>
                        <SidebarMenuButton tooltip={item.title} isActive={item.id === current} aria-current={item.id === current ? "page" : undefined} onClick={() => open(item.id)}>
                          <item.icon aria-hidden="true" />
                          <span>{item.title}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                )}
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </nav>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
