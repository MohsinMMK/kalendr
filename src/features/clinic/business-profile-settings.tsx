"use client";

import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";

import { SelectField } from "@/components/form-fields";
import { ImageUpload } from "@/components/image-upload";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Frame, FrameDescription, FrameFooter, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { toastManager } from "@/components/ui/toast";
import {
  businessTypeIds,
  businessTypes,
  featureKeys,
  featureLabels,
  getBusinessType,
  termKeys,
  termLabels,
  type BusinessTypeId,
  type FeatureKey,
  type TermKey,
} from "@/lib/business-types";
import { clockModes, type ClockMode } from "@/lib/booking-page";
import { savePreviewBusinessProfile } from "@/lib/preview-business-profile";
import { roleLabelsFor, roleDescriptionsFor } from "@/lib/permissions";
import { maxTermLength, resolveBusinessProfile, roleNameKeys, type FeatureOverrides, type RoleNameKey, type RoleNameOverrides, type TerminologyOverrides } from "@/lib/terminology";

import { useBusinessProfile } from "../terms/business-profile-context";
import { useCatalogLookups } from "./clinic-catalog";
import { usePreviewAppointments } from "./preview-appointments";
import { useStaffAccess } from "./staff-access";
import { staffMutation, staffQuery, useOptionalStaffSnapshot } from "./staff-snapshot-provider";

const clockOptions: Array<{ value: ClockMode; label: string }> = [
  { value: "auto", label: "Follow the customer's device" },
  { value: "12h", label: "12-hour" },
  { value: "24h", label: "24-hour" },
];
const weekStartOptions = [{ value: "1", label: "Monday" }, { value: "7", label: "Sunday" }];

const typeOptions = businessTypeIds.map((id) => ({ value: id, label: businessTypes[id].label }));

/** Business type, the words every screen uses, and which features are on. Owners and admins only. */
export function BusinessProfileSettings() {
  const current = useBusinessProfile();
  const access = useStaffAccess();
  const staff = useOptionalStaffSnapshot();
  // The saved business, or the preview's sample with its drawings.
  const { clinic } = useCatalogLookups();
  const { database } = usePreviewAppointments();
  const [businessType, setBusinessType] = useState<BusinessTypeId>(current.businessType);
  const [terminology, setTerminology] = useState<TerminologyOverrides>(current.terminologyOverrides);
  const [features, setFeatures] = useState<FeatureOverrides>(current.featureOverrides);
  const [roleNames, setRoleNames] = useState<RoleNameOverrides>(current.roleNameOverrides);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  // The booking page's clock and week start live on the business row, so they load on their own.
  const [clock, setClock] = useState<ClockMode>("auto");
  const [weekStart, setWeekStart] = useState<1 | 7>(1);
  const [pageDefaults, setPageDefaults] = useState<"loading" | "ready" | "failed">(database ? "loading" : "ready");
  const canChange = access.role === "owner" || access.role === "admin";
  // The logo and cover have their own switch under Team, so the owner can hand them to one person.
  const canChangePictures = access.can("brand.manage");

  useEffect(() => {
    if (!database) return;
    const controller = new AbortController();
    staffQuery<{ defaultClock?: string; weekStart?: number }>("/api/staff/business-profile", controller.signal).then((data) => {
      if (controller.signal.aborted) return;
      setClock(clockModes.find((mode) => mode === data.defaultClock) ?? "auto");
      setWeekStart(data.weekStart === 7 ? 7 : 1);
      setPageDefaults("ready");
    }).catch(() => {
      if (!controller.signal.aborted) setPageDefaults("failed");
    });
    return () => controller.abort();
  }, [database]);

  const preset = getBusinessType(businessType);
  const draft = resolveBusinessProfile({ businessType, terminology: { ...terminology, roles: roleNames }, features });
  // What each role is called until the business names it: the standard names, in the words being chosen.
  const standardRoles = roleLabelsFor(resolveBusinessProfile({ businessType, terminology, features }));
  const roleDescriptions = roleDescriptionsFor(draft);
  const typeChanged = businessType !== current.businessType;

  function chooseType(next: string) {
    const id = getBusinessType(next).id;
    setBusinessType(id);
    // A new type brings its own words and features, so earlier renames and switches start over.
    setTerminology({});
    setFeatures({});
  }

  function setWord(key: TermKey, form: "singular" | "plural", value: string) {
    setTerminology((before) => {
      const entry = { ...before[key], [form]: value };
      const next = { ...before, [key]: entry };
      if (!entry.singular?.trim() && !entry.plural?.trim()) delete next[key];
      return next;
    });
  }

  function resetWord(key: TermKey) {
    setTerminology((before) => {
      const next = { ...before };
      delete next[key];
      return next;
    });
  }

  function setRoleName(key: RoleNameKey, value: string) {
    setRoleNames((before) => {
      const next = { ...before, [key]: value };
      if (!value.trim()) delete next[key];
      return next;
    });
  }

  function setFeature(key: FeatureKey, on: boolean) {
    setFeatures((before) => {
      const next = { ...before };
      if (on === preset.features[key]) delete next[key];
      else next[key] = on;
      return next;
    });
  }

  async function save() {
    setPending(true);
    setMessage("");
    const body = {
      businessType, terminology: draft.terminologyOverrides, features: draft.featureOverrides, roleNames: draft.roleNameOverrides,
      // Only sent once the saved values have loaded, so a failed load never overwrites them with the defaults.
      ...(database && pageDefaults === "ready" ? { defaultClock: clock, weekStart } : {}),
    };
    try {
      if (database) {
        await staffMutation("/api/staff/business-profile", "PATCH", body);
        await staff?.refresh();
      } else {
        savePreviewBusinessProfile({ businessType, terminology: { ...body.terminology, roles: body.roleNames }, features: body.features });
      }
      toastManager.add({ title: "Every screen now uses these words.", type: "success" });
    } catch (cause: unknown) {
      setMessage(cause instanceof Error ? cause.message : "Could not save the business profile.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      {!canChange ? (
        <Alert role="note">
          <AlertDescription>Only the owner or an admin can change these settings.</AlertDescription>
        </Alert>
      ) : null}
      <Frame>
        <FrameHeader>
          <FrameTitle>Logo and cover</FrameTitle>
          <FrameDescription>
            Shown at the top of your booking page. Pictures are cropped to fit and save as soon as you add them.
          </FrameDescription>
        </FrameHeader>
        <FramePanel className="grid gap-6 md:grid-cols-[auto_minmax(0,1fr)]">
          <ImageUpload
            kind="business_logo"
            label="Logo"
            description="Square. Shown beside your name."
            url={clinic.logoUrl}
            saves={database}
            disabled={!canChangePictures}
            onChanged={() => staff?.refresh()}
          />
          <ImageUpload
            kind="business_cover"
            label="Cover photo"
            description="A wide photo of your place, your team or your work. It runs across the top of your page, with your logo on it, and on the first booking screen. 16:9 works best."
            url={clinic.coverUrl}
            saves={database}
            disabled={!canChangePictures}
            onChanged={() => staff?.refresh()}
          />
        </FramePanel>
      </Frame>

      <Frame>
        <FrameHeader>
          <FrameTitle>Booking page times</FrameTitle>
          <FrameDescription>How times and weeks are written on your booking page. A service can choose its own first day of the week.</FrameDescription>
        </FrameHeader>
        <FramePanel className="flex flex-col gap-3">
          {pageDefaults === "failed" ? <Alert variant="error"><AlertDescription>These settings could not be loaded, so they are left as they are. Reload the page to change them.</AlertDescription></Alert> : null}
          {!database ? <Alert variant="info"><AlertDescription>This is a preview. These choices are not saved.</AlertDescription></Alert> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField
              label="Clock on the booking page"
              value={clock}
              onValueChange={(next) => setClock(clockModes.find((mode) => mode === next) ?? "auto")}
              options={clockOptions}
              disabled={!canChange || pageDefaults !== "ready"}
            />
            <SelectField
              label="Week starts on"
              value={String(weekStart)}
              onValueChange={(next) => setWeekStart(next === "7" ? 7 : 1)}
              options={weekStartOptions}
              disabled={!canChange || pageDefaults !== "ready"}
            />
          </div>
        </FramePanel>
      </Frame>

      <Frame>
        <FrameHeader>
          <FrameTitle>Business type</FrameTitle>
          <FrameDescription>Sets the starting words and features. You can change any of them below.</FrameDescription>
        </FrameHeader>
        <FramePanel className="flex flex-col gap-3">
          <SelectField
            label="Type of business"
            hint={preset.examples}
            fieldClassName="max-w-sm"
            value={businessType}
            onValueChange={chooseType}
            options={typeOptions}
            disabled={!canChange}
          />
          {typeChanged ? (
            <Alert variant="warning">
              <AlertDescription>
                Changing the type resets the words and features below to the {preset.label.toLowerCase()} starting set.
                Your existing bookings, {current.terms.customer.plural} and services stay as they are.
              </AlertDescription>
            </Alert>
          ) : null}
        </FramePanel>
      </Frame>

      <Frame>
        <FrameHeader>
          <FrameTitle>Words</FrameTitle>
          <FrameDescription>The words your team and customers see on every screen, email and message.</FrameDescription>
        </FrameHeader>
        <FramePanel className="flex flex-col divide-y py-1">
          {termKeys.map((key) => {
            const base = preset.terms[key];
            const own = terminology[key];
            return (
              <div key={key} className="grid gap-2 py-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
                <div className="min-w-0 sm:self-center">
                  <p className="text-sm font-medium">{termLabels[key].label}</p>
                  <p className="text-xs text-muted-foreground">{termLabels[key].hint}</p>
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor={`term-${key}-one`} className="text-xs text-muted-foreground">One</Label>
                  <Input id={`term-${key}-one`} value={own?.singular ?? ""} placeholder={base.singular} maxLength={40}
                    onChange={(event) => setWord(key, "singular", event.target.value)} disabled={!canChange} />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor={`term-${key}-many`} className="text-xs text-muted-foreground">More than one</Label>
                  <Input id={`term-${key}-many`} value={own?.plural ?? ""} placeholder={base.plural} maxLength={40}
                    onChange={(event) => setWord(key, "plural", event.target.value)} disabled={!canChange} />
                </div>
                <Button type="button" variant="ghost" size="icon" aria-label={`Use the default words for ${termLabels[key].label.toLowerCase()}`}
                  onClick={() => resetWord(key)} disabled={!canChange || !own}>
                  <RotateCcw aria-hidden="true" />
                </Button>
              </div>
            );
          })}
        </FramePanel>
      </Frame>

      <Frame>
        <FrameHeader>
          <FrameTitle>Role names</FrameTitle>
          <FrameDescription>What each role is called on the Team page, in invites and in the account menu. Only the name changes: what each role can do stays the same.</FrameDescription>
        </FrameHeader>
        <FramePanel className="flex flex-col divide-y py-1">
          {roleNameKeys.map((key) => (
            <div key={key} className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,16rem)_auto] sm:items-center">
              <div className="min-w-0">
                <Label htmlFor={`role-${key}`} className="font-medium">{standardRoles[key]}</Label>
                <p className="text-xs text-muted-foreground">{roleDescriptions[key]}</p>
              </div>
              <Input id={`role-${key}`} value={roleNames[key] ?? ""} placeholder={standardRoles[key]} maxLength={maxTermLength}
                onChange={(event) => setRoleName(key, event.target.value)} disabled={!canChange} />
              <Button type="button" variant="ghost" size="icon" aria-label={`Use the standard name for ${standardRoles[key].toLowerCase()}`}
                onClick={() => setRoleName(key, "")} disabled={!canChange || !roleNames[key]}>
                <RotateCcw aria-hidden="true" />
              </Button>
            </div>
          ))}
        </FramePanel>
      </Frame>

      <Frame>
        <FrameHeader>
          <FrameTitle>Features</FrameTitle>
          <FrameDescription>Turn off what your business does not use. Turned-off features disappear from every screen.</FrameDescription>
        </FrameHeader>
        <FramePanel className="flex flex-col divide-y py-1">
          {featureKeys.filter((key) => key !== "customerTypes").map((key) => (
            <div key={key} className="flex items-center justify-between gap-4 py-3">
              <div className="min-w-0">
                <Label htmlFor={`feature-${key}`} className="font-medium">{featureLabels[key].label}</Label>
                <p className="text-xs text-muted-foreground">{featureLabels[key].hint}</p>
              </div>
              <Switch id={`feature-${key}`} checked={draft.features[key]} onCheckedChange={(on) => setFeature(key, on)} disabled={!canChange} />
            </div>
          ))}
        </FramePanel>
        <FrameFooter className="flex flex-wrap items-center justify-between gap-3">
          {message ? <p role="alert" className="text-sm text-destructive-foreground">{message}</p> : <span />}
          <Button type="submit" disabled={!canChange || pending}>
            {pending ? <Spinner aria-hidden="true" /> : null}
            Save business profile
          </Button>
        </FrameFooter>
      </Frame>
    </form>
  );
}
