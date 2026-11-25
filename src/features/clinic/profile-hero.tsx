"use client";

import Image from "next/image";
import { Camera, ExternalLink, ImagePlus, SlidersHorizontal, Trash2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { usePictureUpload } from "@/components/image-upload";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { Spinner } from "@/components/ui/spinner";
import { useBusinessProfile } from "@/features/terms/business-profile-context";
import { practitionerInitials } from "@/lib/clinic-slug";
import { roleLabelsFor } from "@/lib/permissions";
import { cn } from "@/lib/utils";

import { useCatalogLookups } from "./clinic-catalog";
import { identityKeys } from "./queries/identity";
import { useStaffAccess } from "./staff-access";
import { useOptionalStaffSnapshot } from "./staff-snapshot-provider";

// The cover keeps one wide picture and shows more or less of its height as the space grows: taller on phones, a slim
// band on a wide desktop. Container sizes, not the window, so the sidebar being open or closed is taken into account.
const coverShape = "aspect-[2/1] @lg:aspect-[5/2] @2xl:aspect-[3/1] @4xl:aspect-[4/1]";
const logoShape = "size-20 rounded-2xl @lg:size-24 @4xl:size-28";
const logoLift = "-mt-10 @lg:-mt-12 @4xl:-mt-14";
// The picture controls sit on photos of any colour, so they bring their own dark, frosted backing and get darker on
// hover and press: white icons stay readable on a white logo or a bright cover just as on a dark one.
const onPicture = "border-white/25 bg-black/55 text-white shadow-md backdrop-blur-md hover:bg-black/75 data-pressed:bg-black/80 dark:hover:bg-black/75";

/**
 * The top of My profile, laid out like a profile everywhere else (LinkedIn, Notion): a wide cover photo, the logo resting
 * on its bottom edge, then the name. Owners and admins see the business's cover and logo and change them right here; the
 * same pictures lead the public business page. Everyone else sees their own photo on the business cover, and changes the
 * cover and logo only when given "Change the logo and cover" under Team.
 */
export function ProfileHero({ name, photoUrl }: { name: string; photoUrl?: string | null }) {
  const { clinic, database } = useCatalogLookups();
  const access = useStaffAccess();
  const profile = useBusinessProfile();
  const canEdit = access.can("brand.manage");
  const role = roleLabelsFor(profile)[access.role];
  const staff = useOptionalStaffSnapshot();
  const queryClient = useQueryClient();

  async function refresh() {
    await Promise.all([staff?.refresh(), queryClient.invalidateQueries({ queryKey: identityKeys.brand() })]);
  }

  const cover = usePictureUpload({ kind: "business_cover", url: clinic.coverUrl ?? null, saves: database, disabled: !canEdit, onChanged: refresh });
  const logo = usePictureUpload({ kind: "business_logo", url: clinic.logoUrl ?? null, saves: database, disabled: !canEdit, onChanged: refresh });
  const problem = cover.problem || logo.problem;

  // Whoever looks after the logo and cover sees the business here, so the logo's camera sits on the logo itself.
  const showsBusiness = canEdit;
  const title = showsBusiness ? clinic.name : name;
  const subtitle = showsBusiness ? `${name} · ${role}` : `${role} · ${clinic.name}`;
  const picture = showsBusiness ? logo.shown : photoUrl ?? null;

  return (
    <section aria-labelledby="profile-name" className="@container overflow-hidden rounded-2xl border bg-card shadow-xs/5">
      <div className={cn("relative bg-linear-135 from-muted via-muted to-primary/15", coverShape)}>
        {cover.shown ? (
          <Image
            src={cover.shown}
            alt=""
            fill
            unoptimized
            priority
            sizes="(min-width: 1024px) 896px, 100vw"
            className="object-cover motion-safe:fade-in-0 motion-safe:animate-in motion-safe:duration-700"
          />
        ) : canEdit ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center">
            <Button type="button" variant="outline" size="sm" className="bg-background/90" disabled={cover.locked} onClick={cover.pick}>
              {cover.busy === "upload" ? <Spinner aria-hidden="true" /> : <ImagePlus aria-hidden="true" />}
              Add cover photo
            </Button>
            <p className="max-w-xs text-xs text-muted-foreground @max-lg:hidden">A wide photo of your place, your team or your work. It leads your booking page too.</p>
          </div>
        ) : null}

        {cover.busy || cover.checking ? (
          <div className="absolute inset-0 flex items-center justify-center gap-1.5 bg-background/60 text-xs font-medium">
            <Spinner aria-hidden="true" className="size-4" />
            {cover.checking ? "Checking picture…" : null}
          </div>
        ) : null}

        {canEdit && cover.shown ? (
          <div className="absolute end-3 top-3">
            <Menu>
              <MenuTrigger render={<Button type="button" variant="ghost" size="sm" className={onPicture} disabled={cover.locked} />}>
                <Camera aria-hidden="true" />
                <span className="@max-sm:sr-only">Edit cover</span>
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={cover.pick}><ImagePlus aria-hidden="true" /> Upload a new cover</MenuItem>
                <MenuItem onClick={() => void cover.adjust()}><SlidersHorizontal aria-hidden="true" /> Adjust cover</MenuItem>
                <MenuItem variant="destructive" onClick={() => void cover.remove()}><Trash2 aria-hidden="true" /> Remove cover</MenuItem>
              </MenuPopup>
            </Menu>
          </div>
        ) : null}
        {canEdit ? cover.input : null}
        {canEdit ? cover.editor : null}
      </div>

      <div className="flex flex-col gap-3 px-4 pb-4 @lg:flex-row @lg:items-end @lg:gap-4 @lg:px-6 @lg:pb-5">
        <div className={cn("relative z-10 w-fit shrink-0", logoLift)}>
          <Avatar className={cn("bg-card text-xl shadow-md ring-4 ring-card", logoShape)} aria-hidden="true">
            {picture ? <AvatarImage src={picture} alt="" className="object-cover" /> : null}
            <AvatarFallback className="rounded-2xl">{practitionerInitials(title).slice(0, 2)}</AvatarFallback>
          </Avatar>
          {logo.busy || logo.checking ? (
            <span className="absolute inset-0 flex items-center justify-center rounded-2xl bg-background/60"><Spinner aria-hidden="true" /></span>
          ) : null}
          {canEdit ? (
            <>
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className={cn("absolute end-0 bottom-0 size-8 translate-x-1/4 translate-y-1/4 rounded-full ring-2 ring-card sm:size-8", onPicture)}
                      aria-label={logo.shown ? "Edit logo" : "Add logo"}
                      disabled={logo.locked}
                    />
                  }
                >
                  <Camera aria-hidden="true" />
                </MenuTrigger>
                <MenuPopup side="bottom" align="center">
                  <MenuItem onClick={logo.pick}><ImagePlus aria-hidden="true" /> {logo.shown ? "Upload a new logo" : "Upload a logo"}</MenuItem>
                  {logo.shown ? <MenuItem onClick={() => void logo.adjust()}><SlidersHorizontal aria-hidden="true" /> Adjust logo</MenuItem> : null}
                  {logo.shown ? <MenuItem variant="destructive" onClick={() => void logo.remove()}><Trash2 aria-hidden="true" /> Remove logo</MenuItem> : null}
                </MenuPopup>
              </Menu>
              {logo.input}
              {logo.editor}
            </>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-0.5 @lg:pb-1">
          <h1 id="profile-name" className="text-balance font-heading text-xl font-semibold leading-tight @2xl:text-2xl">{title}</h1>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        </div>

        {database ? (
          <Button variant="outline" size="sm" className="w-fit @lg:mb-1" render={<a href={`/b/${clinic.slug}`} target="_blank" rel="noreferrer" />}>
            View booking page
            <ExternalLink aria-hidden="true" />
          </Button>
        ) : null}
      </div>

      {problem ? <p role="alert" className="border-t px-4 py-2 text-sm text-destructive-foreground @lg:px-6">{problem}</p> : null}
      <span className="sr-only" aria-live="polite">
        {cover.busy === "upload" || logo.busy === "upload" ? "Uploading picture" : cover.busy === "remove" || logo.busy === "remove" ? "Removing picture" : cover.checking || logo.checking ? "Checking picture" : ""}
      </span>
    </section>
  );
}
