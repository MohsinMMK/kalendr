"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Power, Repeat, Tag, Ticket, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { ActionBar, type ActionMenuEntry } from "@/components/action-bar";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toastManager } from "@/components/ui/toast";
import { WorkspaceFrame, WorkspacePage } from "@/components/workspace-page";
import { useTerms } from "@/features/terms/business-profile-context";
import { formatMoney } from "@/lib/money";
import type { CouponInput, CouponView, MembershipPlanInput, MembershipPlanView, PackageInput, PackageView } from "@/lib/offers-contracts";
import { describeCoupon } from "@/lib/offers";

import { useCatalogLookups } from "./clinic-catalog";
import { CouponSheet, PackageSheet, PlanSheet } from "./offers-forms";
import { offerDay } from "./offers-parts";
import { staffMutation } from "./queries/http";
import { offerKeys, useOffers } from "./queries/offers";
import { useStaffAccess } from "./staff-access";

function ListSkeleton() {
  return <div role="status" aria-label="Loading offers" className="flex flex-col gap-2 p-4"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>;
}

/** One row: what it is, a status in words, one main action and a ⋯ menu for the rest. */
function OfferRow({ title, detail, extra, badge, label, canEdit, onEdit, menu }: {
  title: string;
  detail: string;
  extra?: string;
  badge?: React.ReactNode;
  label: string;
  canEdit: boolean;
  onEdit: () => void;
  menu: ActionMenuEntry[];
}) {
  return (
    <li className="flex min-h-16 items-center gap-3 px-3 py-2">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 flex-wrap items-center gap-2"><span className="truncate font-medium text-sm">{title}</span>{badge}</span>
        <span className="truncate text-muted-foreground text-xs">{detail}</span>
        {extra ? <span className="truncate text-muted-foreground text-xs">{extra}</span> : null}
      </span>
      {canEdit ? (
        <ActionBar className="flex-none" overflowLabel={`More for ${label}`} actions={[{ id: "edit", label: "Edit", icon: <Pencil aria-hidden="true" />, pinned: true, onSelect: onEdit }]} menu={menu} />
      ) : null}
    </li>
  );
}

type CreateProps = { canEdit: boolean; creating: boolean; onCreate: () => void; onCreated: () => void };

function ErrorState({ title, message, onRetry }: { title: string; message: string; onRetry: () => void }) {
  return (
    <Alert variant="error" className="m-4 w-auto">
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{message}</p>
        <Button size="sm" variant="outline" className="mt-2 min-h-11 sm:min-h-8" onClick={onRetry}>Try again</Button>
      </AlertDescription>
    </Alert>
  );
}

function EmptyTab({ icon, title, text, canEdit, action, onAction }: { icon: React.ReactNode; title: string; text: string; canEdit: boolean; action: string; onAction: () => void }) {
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{text}</EmptyDescription>
      </EmptyHeader>
      {canEdit ? <EmptyContent><Button className="min-h-11 sm:min-h-8" onClick={onAction}><Plus aria-hidden="true" />{action}</Button></EmptyContent> : null}
    </Empty>
  );
}

function servicesText(ids: string[], names: (id: string) => string, all = "Every service"): string {
  if (!ids.length) return all;
  return ids.length <= 2 ? ids.map(names).join(", ") : `${ids.length} services`;
}

function useToggleActive() {
  const queryClient = useQueryClient();
  return async (path: string, body: object, name: string, next: boolean) => {
    try {
      await staffMutation(path, "PUT", body);
      void queryClient.invalidateQueries({ queryKey: offerKeys.all() });
      toastManager.add({ title: next ? "Switched on" : "Switched off", description: name, type: "success" });
    } catch (cause: unknown) {
      toastManager.add({ title: cause instanceof Error ? cause.message : "That could not be saved. Try again.", type: "error" });
    }
  };
}

function toggleEntry(isActive: boolean, onSelect: () => void): ActionMenuEntry {
  return { id: "toggle", label: isActive ? "Switch off" : "Switch on", icon: <Power aria-hidden="true" />, hint: isActive ? "Stops new sales" : "Allows sales again", onSelect };
}

function packageBody(pack: PackageView, isActive: boolean): PackageInput {
  return { name: pack.name, ...(pack.description ? { description: pack.description } : {}), priceMinor: pack.priceMinor, credits: pack.credits, validDays: pack.validDays, serviceIds: pack.serviceIds, isActive, version: pack.version };
}
function planBody(plan: MembershipPlanView, isActive: boolean): MembershipPlanInput {
  return { name: plan.name, ...(plan.description ? { description: plan.description } : {}), priceMinor: plan.priceMinor, creditsPerPeriod: plan.creditsPerPeriod, memberDiscountPercent: plan.memberDiscountPercent, serviceIds: plan.serviceIds, isActive, version: plan.version };
}
function couponBody(coupon: CouponView, isActive: boolean): CouponInput {
  return { code: coupon.code, kind: coupon.kind, value: coupon.value, maxUses: coupon.maxUses, perCustomerLimit: coupon.perCustomerLimit, validFrom: coupon.validFrom, validTo: coupon.validTo, serviceIds: coupon.serviceIds, firstVisitOnly: coupon.firstVisitOnly, stackable: coupon.stackable, isActive, version: coupon.version };
}

function PackagesTab({ packages, canEdit, creating, onCreate, onCreated }: { packages: PackageView[] } & CreateProps) {
  const catalog = useCatalogLookups();
  const toggle = useToggleActive();
  const [editing, setEditing] = useState<{ pack: PackageView | null } | null>(null);
  return (
    <div className="flex flex-1 flex-col">
      {packages.length ? (
        <ul aria-label="Packages" className="flex flex-col divide-y">
          {packages.map((pack) => (
            <OfferRow
              key={pack.id}
              title={pack.name}
              label={pack.name}
              badge={pack.isActive ? null : <Badge variant="secondary" size="lg">Switched off</Badge>}
              detail={`${formatMoney(pack.priceMinor, pack.currency)} · ${pack.credits} sessions · valid ${pack.validDays} days · ${servicesText(pack.serviceIds, catalog.serviceName)}`}
              extra={`${pack.sold} sold · ${pack.creditsOutstanding} sessions not yet used`}
              canEdit={canEdit}
              onEdit={() => setEditing({ pack })}
              menu={[toggleEntry(pack.isActive, () => void toggle(`/api/staff/packages/${pack.id}`, packageBody(pack, !pack.isActive), pack.name, !pack.isActive))]}
            />
          ))}
        </ul>
      ) : (
        <EmptyTab icon={<Ticket aria-hidden="true" />} title="No packages yet" text="A package sells several sessions at once, like 10 massages. Customers use one each visit." canEdit={canEdit} action="Create your first package" onAction={onCreate} />
      )}
      <PackageSheet open={creating || Boolean(editing)} pack={editing?.pack ?? null} onOpenChange={(open) => { if (!open) { setEditing(null); onCreated(); } }} />
    </div>
  );
}

function PlansTab({ plans, canEdit, creating, onCreate, onCreated }: { plans: MembershipPlanView[] } & CreateProps) {
  const catalog = useCatalogLookups();
  const toggle = useToggleActive();
  const [editing, setEditing] = useState<{ plan: MembershipPlanView | null } | null>(null);
  return (
    <div className="flex flex-1 flex-col">
      {plans.length ? (
        <ul aria-label="Membership plans" className="flex flex-col divide-y">
          {plans.map((plan) => {
            const perks = [plan.creditsPerPeriod ? `${plan.creditsPerPeriod} sessions each month` : "", plan.memberDiscountPercent ? `${plan.memberDiscountPercent}% off` : ""].filter(Boolean).join(" · ");
            return (
              <OfferRow
                key={plan.id}
                title={plan.name}
                label={plan.name}
                badge={plan.isActive ? null : <Badge variant="secondary" size="lg">Switched off</Badge>}
                detail={`${formatMoney(plan.priceMinor, plan.currency)} a month · ${perks} · ${servicesText(plan.serviceIds, catalog.serviceName)}`}
                extra={`${plan.activeMembers} ${plan.activeMembers === 1 ? "member" : "members"}`}
                canEdit={canEdit}
                onEdit={() => setEditing({ plan })}
                menu={[toggleEntry(plan.isActive, () => void toggle(`/api/staff/memberships/plans/${plan.id}`, planBody(plan, !plan.isActive), plan.name, !plan.isActive))]}
              />
            );
          })}
        </ul>
      ) : (
        <EmptyTab icon={<Repeat aria-hidden="true" />} title="No membership plans yet" text={`A plan gives regulars sessions each month or a lower price for a monthly fee.`} canEdit={canEdit} action="Create your first plan" onAction={onCreate} />
      )}
      <PlanSheet open={creating || Boolean(editing)} plan={editing?.plan ?? null} onOpenChange={(open) => { if (!open) { setEditing(null); onCreated(); } }} />
    </div>
  );
}

function couponStatus(coupon: CouponView, now: number): { tone: "success" | "attention" | "neutral" | "danger"; text: string } {
  if (!coupon.isActive) return { tone: "neutral", text: "Switched off" };
  if (coupon.validTo && now >= Date.parse(coupon.validTo)) return { tone: "danger", text: "Expired" };
  if (coupon.validFrom && now < Date.parse(coupon.validFrom)) return { tone: "attention", text: `Starts ${offerDay(coupon.validFrom)}` };
  if (coupon.maxUses !== null && coupon.used >= coupon.maxUses) return { tone: "danger", text: "Used up" };
  return { tone: "success", text: "Active" };
}

function CodesTab({ coupons, canEdit, creating, onCreate, onCreated }: { coupons: CouponView[] } & CreateProps) {
  const catalog = useCatalogLookups();
  const toggle = useToggleActive();
  const [now] = useState(() => Date.now());
  const [editing, setEditing] = useState<{ coupon: CouponView | null } | null>(null);
  return (
    <div className="flex flex-1 flex-col">
      {coupons.length ? (
        <ul aria-label="Codes" className="flex flex-col divide-y">
          {coupons.map((coupon) => {
            const status = couponStatus(coupon, now);
            return (
              <OfferRow
                key={coupon.id}
                title={coupon.code}
                label={coupon.code}
                badge={<StatusBadge tone={status.tone}>{status.text}</StatusBadge>}
                detail={`${describeCoupon(coupon.kind, coupon.value, (minor) => formatMoney(minor))} · ${servicesText(coupon.serviceIds, catalog.serviceName, "Every service")}${coupon.firstVisitOnly ? " · First visit only" : ""}`}
                extra={`Used ${coupon.used}${coupon.maxUses !== null ? ` of ${coupon.maxUses}` : ""} ${coupon.used === 1 && coupon.maxUses === null ? "time" : "times"}${coupon.validTo ? ` · Ends ${offerDay(new Date(Date.parse(coupon.validTo) - 1).toISOString())}` : ""}`}
                canEdit={canEdit}
                onEdit={() => setEditing({ coupon })}
                menu={[toggleEntry(coupon.isActive, () => void toggle(`/api/staff/coupons/${coupon.id}`, couponBody(coupon, !coupon.isActive), coupon.code, !coupon.isActive))]}
              />
            );
          })}
        </ul>
      ) : (
        <EmptyTab icon={<Tag aria-hidden="true" />} title="No codes yet" text="A code takes a percentage or an amount off. Give it out in a message or on a flyer." canEdit={canEdit} action="Create your first code" onAction={onCreate} />
      )}
      <CouponSheet open={creating || Boolean(editing)} coupon={editing?.coupon ?? null} onOpenChange={(open) => { if (!open) { setEditing(null); onCreated(); } }} />
    </div>
  );
}

/** Offers: packages, membership plans and discount codes. Needs the database; the preview keeps none. */
export function OffersWorkspace() {
  const t = useTerms();
  const access = useStaffAccess();
  const live = useCatalogLookups().database;
  const [tab, setTab] = useState("packages");
  const query = useOffers(live);
  const canEdit = access.can("payments.settings");
  const [creating, setCreating] = useState(false);

  if (!live) {
    return (
      <WorkspacePage nav="offers">
      <WorkspaceFrame>
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon"><Ticket aria-hidden="true" /></EmptyMedia>
          <EmptyTitle>Offers are not available in the preview</EmptyTitle>
          <EmptyDescription>Packages, memberships and codes need the {t.business} database. Nothing here is stored in the preview.</EmptyDescription>
        </EmptyHeader>
      </Empty>
      </WorkspaceFrame>
      </WorkspacePage>
    );
  }

  const data = query.data;
  const create = { canEdit, creating, onCreate: () => setCreating(true), onCreated: () => setCreating(false) };
  const newLabel = tab === "packages" ? "New package" : tab === "memberships" ? "New plan" : "New code";
  const hasItems = data ? (tab === "packages" ? data.packages : tab === "memberships" ? data.plans : data.coupons).length > 0 : false;
  return (
    <WorkspacePage
      nav="offers"
      bar={canEdit && hasItems ? [{ id: "new", label: newLabel, icon: <Plus aria-hidden="true" />, variant: "default", pinned: true, onSelect: () => setCreating(true) }] : []}
    >
      <Tabs value={tab} onValueChange={(next) => { setTab(String(next)); setCreating(false); }} className="gap-0">
        <WorkspaceFrame
          flush
          start={
            <TabsList variant="underline" aria-label="Offers">
              <TabsTrigger value="packages" className="pointer-coarse:min-h-11">Packages</TabsTrigger>
              <TabsTrigger value="memberships" className="pointer-coarse:min-h-11">Memberships</TabsTrigger>
              <TabsTrigger value="codes" className="pointer-coarse:min-h-11">Codes</TabsTrigger>
            </TabsList>
          }
        >
          {query.isPending ? <ListSkeleton /> : query.isError || !data ? (
            <ErrorState title="Offers could not be loaded" message={query.error instanceof Error ? query.error.message : "Something went wrong."} onRetry={() => void query.refetch()} />
          ) : (
            <>
              <TabsContent value="packages" className="flex flex-1 flex-col"><PackagesTab packages={data.packages} {...create} /></TabsContent>
              <TabsContent value="memberships" className="flex flex-1 flex-col"><PlansTab plans={data.plans} {...create} /></TabsContent>
              <TabsContent value="codes" className="flex flex-1 flex-col"><CodesTab coupons={data.coupons} {...create} /></TabsContent>
            </>
          )}
        </WorkspaceFrame>
      </Tabs>
    </WorkspacePage>
  );
}

