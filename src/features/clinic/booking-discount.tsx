"use client";

import { useEffect, useId, useState } from "react";

import { Input } from "@/components/ui/input";
import { useTerms } from "@/features/terms/business-profile-context";

import { ChoiceField, type Choice } from "./choice-field";
import { creditsLeftText, offerDay } from "./offers-parts";
import { StaffApiError } from "./queries/http";
import { useCustomerOffers } from "./queries/offers";

type Mode = "none" | "package" | "code";

/** What the server says about a code or package it refused; shown beside the Discount field, not above the form. */
const discountCodes = new Set(["coupon_invalid", "coupon_not_combinable", "one_discount", "package_expired", "no_credits", "package_wrong_service", "package_not_found", "package_inactive", "nothing_to_discount"]);

export interface BookingDiscount {
  mode: Mode;
  packageId: string;
  code: string;
  error: string;
  chooseNone: () => void;
  choosePackage: (id: string) => void;
  chooseCode: () => void;
  setCode: (code: string) => void;
  /** The part of the booking request this choice adds: `couponCode` or `customerPackageId`, never both. */
  body: () => { couponCode?: string; customerPackageId?: string };
  /** Takes a refusal about the discount; false means it was about something else. */
  capture: (cause: unknown) => boolean;
}

/** The discount choice for one booking: state only, so a screen without a query cache can hold it. */
export function useBookingDiscount(): BookingDiscount {
  const [mode, setMode] = useState<Mode>("none");
  const [packageId, setPackageId] = useState("");
  const [code, setCodeText] = useState("");
  const [error, setError] = useState("");
  return {
    mode, packageId, code, error,
    chooseNone: () => { setMode("none"); setPackageId(""); setError(""); },
    choosePackage: (id) => { setMode("package"); setPackageId(id); setError(""); },
    chooseCode: () => { setMode("code"); setPackageId(""); setError(""); },
    setCode: (next) => { setCodeText(next); setError(""); },
    body: () => (mode === "package" && packageId ? { customerPackageId: packageId } : mode === "code" && code.trim() ? { couponCode: code.trim() } : {}),
    capture: (cause) => {
      if (!(cause instanceof StaffApiError) || !discountCodes.has(cause.code)) return false;
      setError(cause.message);
      return true;
    },
  };
}

/**
 * "Discount": no discount, use one of the customer's packages for this service, or type a code. One choice,
 * so one discount per booking, the same rule the server keeps. Shows nothing in the preview.
 */
export function BookingDiscountControl({ discount, patientId, serviceId, live }: { discount: BookingDiscount; patientId: string | undefined; serviceId: string | undefined; live: boolean }) {
  return live ? <DiscountRow discount={discount} patientId={patientId} serviceId={serviceId} /> : null;
}

function DiscountRow({ discount, patientId, serviceId }: { discount: BookingDiscount; patientId: string | undefined; serviceId: string | undefined }) {
  const t = useTerms();
  const errorId = useId();
  const offers = useCustomerOffers(patientId ?? null);
  const usable = (offers.data?.packages ?? []).filter((pack) => pack.status === "active" && pack.remaining > 0 && Boolean(serviceId) && pack.serviceIds.includes(serviceId!));
  const { mode, packageId, chooseNone } = discount;
  const stale = mode === "package" && Boolean(offers.data) && !usable.some((pack) => pack.id === packageId);
  useEffect(() => { if (stale) chooseNone(); }, [stale, chooseNone]);

  const chosenPackage = usable.find((pack) => pack.id === packageId);
  const choices: Choice[] = [
    { id: "none", label: "No discount" },
    ...usable.map((pack): Choice => ({ id: `pkg:${pack.id}`, label: `Use ${pack.name}`, detail: `${creditsLeftText(pack.remaining, pack.creditsTotal)} · to ${offerDay(pack.expiresAt)}` })),
    { id: "code", label: "Use a code…" },
  ];
  const value: Choice = mode === "package" && chosenPackage
    ? { id: `pkg:${chosenPackage.id}`, label: `Use ${chosenPackage.name}`, detail: creditsLeftText(chosenPackage.remaining, chosenPackage.creditsTotal) }
    : mode === "code" ? { id: "code", label: "Use a code…" } : { id: "none", label: "No discount" };

  function pick(id: string) {
    if (id === "none") discount.chooseNone();
    else if (id === "code") discount.chooseCode();
    else discount.choosePackage(id.slice(4));
  }

  return (
    <section aria-label="Discount" className="flex flex-col gap-1">
      <dl className="grid grid-cols-[minmax(6.5rem,8.5rem)_minmax(0,1fr)] items-start gap-x-3 gap-y-0.5">
        <dt className="flex min-h-7 items-center text-muted-foreground text-sm">Discount</dt>
        <dd className="flex min-h-7 min-w-0 flex-col justify-center gap-1 text-sm">
          <ChoiceField
            label="Discount"
            placeholder="No discount"
            empty="Nothing matches"
            loading={Boolean(patientId) && offers.isPending}
            value={value}
            choices={choices}
            onPick={pick}
          />
          {mode === "code" ? (
            <Input
              size="sm"
              aria-label="Discount code"
              aria-invalid={discount.error ? true : undefined}
              aria-describedby={discount.error ? errorId : undefined}
              placeholder="Type the code"
              autoComplete="off"
              autoCapitalize="characters"
              maxLength={40}
              value={discount.code}
              onChange={(event) => discount.setCode(event.target.value)}
            />
          ) : null}
          {discount.error ? <p id={errorId} role="alert" className="text-destructive-foreground text-xs">{discount.error}</p> : null}
        </dd>
      </dl>
      {patientId && offers.isError ? <p className="text-muted-foreground text-xs">This {t.customer}’s packages could not be loaded. You can still use a code.</p> : null}
    </section>
  );
}
