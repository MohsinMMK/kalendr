"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import Link from "next/link";
import {
  Activity,
  ArrowLeft,
  Briefcase,
  Dumbbell,
  Flower2,
  GraduationCap,
  Scissors,
  Shapes,
  Smile,
  Sparkles,
  Stethoscope,
  type LucideIcon,
} from "lucide-react";

import { TurnstileField, useBotCheck } from "@/components/turnstile-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { OTPField, OTPFieldInput, OTPFieldSeparator } from "@/components/ui/otp-field";
import { RadioGroup } from "@/components/ui/radio-group";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { ScrollArea } from "@/components/ui/scroll-area";
import { authClient } from "@/lib/auth-client";
import { isClinicalBusinessType, type BusinessTypeId } from "@/lib/business-types";
import { parseClinicSlug, slugFromName } from "@/lib/clinic-slug";
import { clinicRegistrationSchema } from "@/lib/clinic-registration";
import { onboardingTemplateIds, onboardingTemplates, type OnboardingTemplateId } from "@/lib/onboarding-templates";
import { savePreviewBusinessProfile } from "@/lib/preview-business-profile";
import { profileWords, resolveBusinessProfile } from "@/lib/terminology";

import { ChoiceCard, SwitchRow, tapAdvanceDelayMs, TypeInField } from "./onboarding-choice";
import { StartShowcase } from "./start-showcase";

/**
 * Sign-up (/start). One question per screen and no step counter: the email (or Google / Microsoft), the code we
 * email, a password, the kind of business, then its name. The right half shows the owner's booking page filling in
 * as they go. The page itself never scrolls; only the middle of the left column does, and Continue stays pinned.
 */

type Method = "email" | "google" | "microsoft";
type Step = "account" | "code" | "password" | "kind" | "details" | "created";
type Providers = { google: boolean; microsoft: boolean };

const codeLength = 6;
const resendSeconds = 30;

const templateIcons: Record<OnboardingTemplateId, LucideIcon> = {
  general_practice: Stethoscope,
  dental: Smile,
  physiotherapy: Activity,
  salon: Scissors,
  spa: Flower2,
  barber: Sparkles,
  tutoring: GraduationCap,
  consulting: Briefcase,
  fitness: Dumbbell,
  other: Shapes,
};

/** What the Google / Microsoft leg sends back in `?error=`. */
const providerErrors: Record<string, string> = {
  provider_unavailable: "That sign-up option isn’t set up here yet. Use your email instead.",
  provider_unverified: "That account’s email isn’t verified. Use your email instead.",
  provider_failed: "We couldn’t finish with that account. Try again, or use your email.",
  email_taken: "This email already has an account. Sign in instead.",
  rate_limited: "Too many tries. Wait a few minutes, then try again.",
};

/** The browser's own time zone, so a business outside India does not start with India's. The server checks it again. */
function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Kolkata";
  } catch {
    return "Asia/Kolkata";
  }
}

/** A full-page visit (not client navigation): the route redirects to the provider. */
function startWithProvider(provider: "google" | "microsoft") {
  window.location.assign(new URL(`/api/public/sign-up/oauth/${provider}`, window.location.origin));
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1Z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" />
      <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15A10.96 10.96 0 0 0 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38Z" />
    </svg>
  );
}

function MicrosoftMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4">
      <path fill="#F25022" d="M2 2h9.5v9.5H2z" />
      <path fill="#7FBA00" d="M12.5 2H22v9.5h-9.5z" />
      <path fill="#00A4EF" d="M2 12.5h9.5V22H2z" />
      <path fill="#FFB900" d="M12.5 12.5H22V22h-9.5z" />
    </svg>
  );
}

export function StartClinicForm({
  preview = false,
  turnstileSiteKey = null,
  providers = { google: false, microsoft: false },
  initialError = null,
}: {
  preview?: boolean;
  turnstileSiteKey?: string | null;
  providers?: Providers;
  /** `?error=` from the Google / Microsoft leg. */
  initialError?: string | null;
}) {
  const bot = useBotCheck();
  const botCheckWaiting = bot.shown && Boolean(turnstileSiteKey) && !bot.token;
  // The rehearsal has no account to make, so it starts at the business.
  const [step, setStep] = useState<Step>(preview ? "kind" : "account");
  const [method, setMethod] = useState<Method>("email");
  const [verified, setVerified] = useState(false);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [resendIn, setResendIn] = useState(0);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [template, setTemplate] = useState<OnboardingTemplateId | "">("");
  const [ownerName, setOwnerName] = useState("");
  const [clinicName, setClinicName] = useState("");
  // The owner takes bookings themselves unless they say otherwise, so there is someone to book with straight away.
  const [ownerPractices, setOwnerPractices] = useState(true);
  const [slugEdited, setSlugEdited] = useState(false);
  const [slug, setSlug] = useState("");
  const [showSlug, setShowSlug] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(initialError ? (providerErrors[initialError] ?? providerErrors.provider_failed!) : "");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const businessType: BusinessTypeId | "" = template ? onboardingTemplates[template].businessType : "";
  const t = profileWords(resolveBusinessProfile({ businessType: businessType || "other", terminology: template ? onboardingTemplates[template].words : {} }));
  const clinical = businessType ? isClinicalBusinessType(businessType) : false;
  const suggestedSlug = useMemo(() => slugFromName(clinicName), [clinicName]);
  const bookingSlug = slugEdited ? slug : suggestedSlug;

  const headingRef = useRef<HTMLHeadingElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const stepRef = useRef(step);
  const firstStep = useRef(true);
  const advanceTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    stepRef.current = step;
    // Move focus to each new question, but not on first load (the page's own first field takes it).
    if (firstStep.current) firstStep.current = false;
    // A screen whose first field took focus keeps it; otherwise the question itself takes it, for screen readers.
    else if (!bodyRef.current?.contains(document.activeElement)) headingRef.current?.focus();
  }, [step]);
  // The code boxes are disabled while the code is being sent, so autoFocus misses them; put the cursor in the first
  // box once they are ready, so the owner can type or paste the code straight away.
  useEffect(() => {
    if (step !== "code" || pending) return;
    const body = bodyRef.current;
    if (body?.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement) return;
    body?.querySelector<HTMLInputElement>("input:not([type=hidden])")?.focus();
  }, [step, pending]);
  useEffect(() => () => window.clearTimeout(advanceTimer.current), []);
  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = window.setTimeout(() => setResendIn((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [resendIn]);

  // Coming back from Google or Microsoft, or a refresh: pick up the proved email and carry on from there.
  useEffect(() => {
    if (preview) return;
    if (new URLSearchParams(window.location.search).has("error")) window.history.replaceState(null, "", window.location.pathname);
    let cancelled = false;
    void fetch("/api/public/sign-up", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { data?: { email: string; method: Method; name: string | null } | null } | null) => {
        const proof = body?.data;
        if (cancelled || !proof) return;
        setEmail(proof.email);
        setMethod(proof.method);
        setVerified(true);
        if (proof.name) setOwnerName((current) => current || proof.name!);
        // An email owner's password is never kept in the browser, so after a refresh they choose it again.
        setStep(proof.method === "email" ? "password" : "kind");
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [preview]);

  function go(next: Step, message = "") {
    window.clearTimeout(advanceTimer.current);
    setError(message);
    setStep(next);
  }

  async function post(body: Record<string, string>): Promise<{ ok: true } | { ok: false; message: string; code?: string; fields: Record<string, string> }> {
    const response = await fetch("/api/public/sign-up", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...bot.headers() },
      body: JSON.stringify(body),
    });
    if (response.ok) return { ok: true };
    return { ok: false, ...readError(await response.json().catch(() => null)) };
  }

  async function sendCode(): Promise<boolean> {
    const address = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      setFieldErrors({ email: "Enter a valid email." });
      return false;
    }
    setPending(true);
    setError("");
    setFieldErrors({});
    try {
      const result = await post({ action: "send", email: address });
      if (!result.ok) {
        if (bot.afterResponse(result.code, result.fields.turnstileToken)) return false;
        setFieldErrors(result.fields);
        if (!result.fields.email) setError(result.message);
        return false;
      }
      bot.afterResponse(undefined);
      setEmail(address);
      setMethod("email");
      setCode("");
      setResendIn(resendSeconds);
      return true;
    } catch {
      setError("Couldn’t send the code. Check your connection and try again.");
      return false;
    } finally {
      setPending(false);
    }
  }

  async function verifyCode(value: string) {
    if (pending || value.length !== codeLength) return;
    setPending(true);
    setError("");
    try {
      const result = await post({ action: "verify", email, code: value });
      if (!result.ok) {
        setCode("");
        setError(result.message);
        return;
      }
      setVerified(true);
      go("password");
    } catch {
      setError("Couldn’t check the code. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  function useAnotherEmail() {
    void fetch("/api/public/sign-up", { method: "DELETE" }).catch(() => undefined);
    setVerified(false);
    setMethod("email");
    setCode("");
    setPassword("");
    go("account");
  }

  function onPickKind(event: MouseEvent<HTMLElement>) {
    // A pointer tap moves on; keyboard and screen-reader choices report `detail` 0 and stay.
    if (event.detail === 0) return;
    window.clearTimeout(advanceTimer.current);
    advanceTimer.current = window.setTimeout(() => {
      if (stepRef.current === "kind") go("details");
    }, tapAdvanceDelayMs);
  }

  function registrationDetails() {
    const chosen = template || "other";
    return {
      template: chosen,
      businessType: onboardingTemplates[chosen].businessType,
      clinicName: clinicName.trim(),
      slug: bookingSlug,
      ownerName: ownerName.trim(),
      email: email.trim().toLowerCase(),
      ...(method === "email" ? { password } : {}),
      timezone: browserTimezone(),
      ownerPractices,
      ...(ownerPractices ? { practice: { name: ownerName.trim(), ...onboardingTemplates[chosen].owner } } : {}),
    };
  }

  function checkDetails(): boolean {
    const errors: Record<string, string> = {};
    if (clinicName.trim().length < 2) errors.clinicName = `Enter the name your ${t.customers} know.`;
    if (ownerName.trim().length < 2) errors.ownerName = "Enter your full name.";
    const slugCheck = parseClinicSlug(bookingSlug);
    if (!slugCheck.ok) {
      errors.slug = slugCheck.message;
      setShowSlug(true);
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function createBusiness() {
    if (pending || !checkDetails()) return;
    if (preview) {
      savePreviewBusinessProfile({ businessType: businessType || "other", terminology: template ? onboardingTemplates[template].words : {}, features: {} });
      go("created");
      return;
    }
    const parsed = clinicRegistrationSchema.safeParse(registrationDetails());
    if (!parsed.success) {
      const fields = Object.fromEntries(parsed.error.issues.map((issue) => [String(issue.path[0]), issue.message]));
      setFieldErrors(fields);
      if (fields.password) go("password", fields.password);
      else if (fields.email) go("account", fields.email);
      return;
    }
    setPending(true);
    setError("");
    let created = false;
    let leaving = false;
    try {
      const response = await fetch("/api/public/clinics", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...bot.headers() },
        body: JSON.stringify(parsed.data),
      });
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const apiError = readError(result);
        if (bot.afterResponse(apiError.code, apiError.fields.turnstileToken)) return;
        setFieldErrors(apiError.fields);
        // Each problem goes back to the screen that asks for it; everything typed so far stays.
        if (apiError.code === "email_not_verified" || apiError.fields.email) {
          setVerified(false);
          go("account", apiError.code === "email_not_verified" ? "Your email check timed out. Confirm your email again; the rest is kept." : apiError.message);
        } else if (apiError.fields.password) go("password", apiError.message);
        else if (apiError.fields.businessType || apiError.fields.template) go("kind", apiError.message);
        else {
          if (apiError.fields.slug) setShowSlug(true);
          setError(apiError.message);
        }
        return;
      }
      bot.afterResponse(undefined);
      created = true;
      if (method !== "email") {
        // Google or Microsoft now signs the owner in to the account just made.
        await authClient.signIn.social({ provider: method, callbackURL: "/dashboard", errorCallbackURL: "/sign-in" });
        return;
      }
      // Better Auth loads the dashboard as a full page, so the server decides in one step where the owner lands.
      const signedIn = await authClient.signIn.email({ email: parsed.data.email, password, callbackURL: "/dashboard" });
      setPassword("");
      if (signedIn.error) {
        go("created", `Your ${t.business} is saved. Sign in with your email and password to finish setup.`);
        return;
      }
      leaving = true;
    } catch (cause: unknown) {
      console.error(created ? "Sign-in after sign-up failed" : "Sign-up request failed", cause instanceof Error ? cause.name : "Unknown error");
      if (created) go("created", `Your ${t.business} is saved. Sign in to finish setup.`);
      else setError("Couldn’t reach Kalendr. Check your connection. If you already pressed Create, try signing in first.");
    } finally {
      if (!leaving) setPending(false);
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (step === "account") {
      if (verified && method === "email" && email) return go("password");
      if (await sendCode()) go("code");
    } else if (step === "code") {
      if (code.length < codeLength) setError("Enter the 6-digit code from your email.");
      else await verifyCode(code);
    } else if (step === "password") {
      if (password.length < 12) setFieldErrors({ password: "Use at least 12 characters." });
      else {
        setFieldErrors({});
        go("kind");
      }
    } else if (step === "kind") {
      if (!template) setError("Choose what kind of business you run.");
      else go("details");
    } else if (step === "details") {
      await createBusiness();
    }
  }

  const backTo: Step | null =
    step === "code"
      ? "account"
      : step === "password"
        ? method === "email"
          ? verified
            ? "account"
            : "code"
          : null
        : step === "kind"
          ? preview
            ? null
            : method === "email"
              ? "password"
              : "account"
          : step === "details"
            ? "kind"
            : null;

  const screens: Record<Step, { title: string; detail?: ReactNode; continueLabel: string; body: ReactNode }> = {
    account: {
      title: "Create your account",
      continueLabel: verified && method === "email" ? "Continue" : "Continue with email",
      body: (
        <>
          {providers.google || providers.microsoft ? (
            <>
              <div className="flex flex-col gap-2">
                {providers.google ? (
                  <Button variant="outline" size="lg" type="button" onClick={() => startWithProvider("google")}>
                    <GoogleMark /> Continue with Google
                  </Button>
                ) : null}
                {providers.microsoft ? (
                  <Button variant="outline" size="lg" type="button" onClick={() => startWithProvider("microsoft")}>
                    <MicrosoftMark /> Continue with Microsoft
                  </Button>
                ) : null}
              </div>
              <div className="flex items-center gap-3 text-xs text-muted-foreground" aria-hidden="true">
                <Separator className="flex-1" /> or <Separator className="flex-1" />
              </div>
            </>
          ) : null}
          <TypeInField
            id="owner-email"
            label="Work email"
            type="email"
            value={email}
            onChange={(value) => {
              setEmail(value);
              if (verified) setVerified(false);
            }}
            autoComplete="email"
            error={fieldErrors.email}
            required
            maxLength={254}
            autoFocus
          />
          {bot.shown && turnstileSiteKey ? (
            <TurnstileField key={bot.round} siteKey={turnstileSiteKey} action="sign_up" onToken={bot.onToken} error={bot.error} />
          ) : null}
        </>
      ),
    },
    code: {
      title: "Check your email",
      detail: (
        <>
          We sent a 6-digit code to <span className="font-medium text-foreground [overflow-wrap:anywhere]">{email}</span>.
        </>
      ),
      continueLabel: "Verify",
      body: (
        <>
          <Field className="gap-2">
            <FieldLabel id="sign-up-code-label" className="sr-only">
              Six-digit code
            </FieldLabel>
            <OTPField
              size="lg"
              length={codeLength}
              autoFocus
              aria-labelledby="sign-up-code-label"
              value={code}
              onValueChange={(value) => {
                setCode(value);
                if (error) setError("");
              }}
              onValueComplete={(value) => void verifyCode(value)}
              disabled={pending}
            >
              {Array.from({ length: codeLength }, (_, index) => (
                <span key={index} className="contents">
                  {index === 3 ? <OTPFieldSeparator /> : null}
                  <OTPFieldInput {...(index === 0 ? {} : { "aria-label": `Digit ${index + 1}` })} />
                </span>
              ))}
            </OTPField>
          </Field>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto px-0"
              disabled={pending || resendIn > 0}
              onClick={() => void sendCode()}
            >
              {resendIn > 0 ? `Resend code in ${resendIn}s` : "Resend code"}
            </Button>
            <Button type="button" variant="link" size="sm" className="h-auto px-0 text-muted-foreground" onClick={useAnotherEmail}>
              Use a different email
            </Button>
          </div>
          {bot.shown && turnstileSiteKey ? (
            <TurnstileField key={bot.round} siteKey={turnstileSiteKey} action="sign_up" onToken={bot.onToken} error={bot.error} />
          ) : null}
        </>
      ),
    },
    password: {
      title: "Choose a password",
      detail: (
        <>
          For <span className="font-medium text-foreground [overflow-wrap:anywhere]">{email}</span>
        </>
      ),
      continueLabel: "Continue",
      body: (
        <>
          <TypeInField
            id="owner-password"
            label="Password"
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
            hint="At least 12 characters"
            error={fieldErrors.password}
            required
            maxLength={128}
            autoFocus
          />
          <Label className="flex min-h-10 items-center gap-2 text-sm font-normal text-muted-foreground">
            <Checkbox checked={showPassword} onCheckedChange={(checked) => setShowPassword(checked)} />
            Show password
          </Label>
          {/* The username field lets password managers save the pair. */}
          <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />
        </>
      ),
    },
    kind: {
      title: "What kind of business?",
      continueLabel: "Continue",
      body: (
        <RadioGroup
          aria-label="Type of business"
          value={template}
          onValueChange={(value) => {
            setTemplate(value as OnboardingTemplateId);
            setError("");
          }}
          className="grid grid-cols-1 gap-2 min-[400px]:grid-cols-2"
        >
          {onboardingTemplateIds.map((id) => {
            const Icon = templateIcons[id];
            return <ChoiceCard key={id} value={id} icon={<Icon />} title={onboardingTemplates[id].label} onPick={onPickKind} />;
          })}
        </RadioGroup>
      ),
    },
    details: {
      title: `Name your ${t.business}`,
      continueLabel: preview ? "Finish preview" : `Create ${t.business}`,
      body: (
        <>
          <TypeInField
            id="clinic-name"
            label={`${t.Business} name`}
            value={clinicName}
            onChange={setClinicName}
            autoComplete="organization"
            placeholder={clinical ? "Lotus Dental" : undefined}
            error={fieldErrors.clinicName}
            required
            maxLength={160}
            autoFocus
          />
          <TypeInField
            id="owner-name"
            label="Your full name"
            value={ownerName}
            onChange={setOwnerName}
            autoComplete="name"
            error={fieldErrors.ownerName}
            required
            maxLength={160}
          />
          <SwitchRow
            id="owner-practices"
            label={`I take ${t.appointments} myself`}
            checked={ownerPractices}
            onCheckedChange={setOwnerPractices}
          />
          {showSlug ? (
            <TypeInField
              id="clinic-slug"
              label="Booking link"
              value={bookingSlug}
              onChange={(value) => {
                setSlugEdited(true);
                setSlug(value);
              }}
              hint={`/book/${bookingSlug || "your-business"}`}
              error={fieldErrors.slug}
            />
          ) : (
            <Button
              variant="link"
              type="button"
              onClick={() => setShowSlug(true)}
              size="sm"
              className="h-auto min-w-0 justify-start justify-self-start whitespace-normal px-0 text-start font-normal text-muted-foreground [overflow-wrap:anywhere] hover:text-foreground"
            >
              /book/{bookingSlug || "your-business"} · change
            </Button>
          )}
          {!preview && bot.shown && turnstileSiteKey ? (
            <TurnstileField key={bot.round} siteKey={turnstileSiteKey} action="sign_up" onToken={bot.onToken} error={bot.error} />
          ) : null}
        </>
      ),
    },
    created: {
      title: preview ? `You’ve seen how ${t.aBusiness} begins.` : `Your ${t.business} is ready.`,
      detail: preview ? "Nothing you typed was saved." : error || "Sign in to finish setup.",
      continueLabel: "",
      body: (
        <div className="flex flex-col gap-2">
          <Button size="lg" render={<Link href={preview ? "/dashboard" : "/sign-in?next=%2Fdashboard"} />}>
            {preview ? "Explore sample workspace" : "Sign in"}
          </Button>
          {preview ? (
            <Button size="lg" variant="outline" render={<Link href="/setup" />}>
              Try {t.service} and availability setup
            </Button>
          ) : null}
        </div>
      ),
    },
  };
  const screen = screens[step];
  const done = step === "created";
  const blocked = (step === "account" || step === "code" || step === "details") && botCheckWaiting;

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <div className="flex min-w-0 flex-1 flex-col lg:max-w-[50%]">
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 px-4 sm:px-8">
          <Link href="/" className="font-heading text-lg font-semibold text-foreground no-underline">
            kalendr
          </Link>
          {preview ? (
            <span className="text-xs text-muted-foreground">Preview: nothing is saved</span>
          ) : (
            <div className="flex items-center gap-2">
              <span className="hidden text-sm text-muted-foreground sm:inline">Have an account?</span>
              <Button variant="outline" size="sm" render={<Link href="/sign-in" />}>
                Sign in
              </Button>
            </div>
          )}
        </header>

        <form noValidate onSubmit={(event) => void onSubmit(event)} className="flex min-h-0 flex-1 flex-col">
          <ScrollArea className="min-h-0 flex-1" fill overscrollContain>
            <div ref={bodyRef} className="h-full">
              <div
                key={step}
                className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center gap-6 px-4 py-6 animate-in fade-in slide-in-from-bottom-1 duration-300 sm:px-0"
              >
                <div className="flex flex-col gap-1.5">
                  <h1 ref={headingRef} tabIndex={-1} className="font-heading text-2xl font-semibold tracking-tight outline-none">
                    {screen.title}
                  </h1>
                  {screen.detail ? <p className="text-sm text-muted-foreground">{screen.detail}</p> : null}
                </div>
                <div className="flex flex-col gap-4">{screen.body}</div>
                {error && !done ? (
                  <Alert variant="error" role="alert">
                    <AlertDescription>
                      {error}{" "}
                      {error === providerErrors.email_taken ? (
                        <Link href="/sign-in" className="font-medium underline underline-offset-4">
                          Sign in
                        </Link>
                      ) : null}
                    </AlertDescription>
                  </Alert>
                ) : null}
              </div>
            </div>
          </ScrollArea>

          {done ? null : (
            <footer className="shrink-0 border-t bg-background/95 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
              <div className="mx-auto flex w-full max-w-md items-center gap-2">
                {backTo ? (
                  <Button type="button" variant="ghost" size="lg" onClick={() => go(backTo)} disabled={pending} aria-label="Back">
                    <ArrowLeft aria-hidden="true" />
                    <span className="max-sm:sr-only">Back</span>
                  </Button>
                ) : null}
                <Button type="submit" size="lg" className="ms-auto flex-1 sm:flex-none sm:min-w-40" disabled={pending || blocked}>
                  {pending ? <Spinner aria-hidden="true" /> : null}
                  {screen.continueLabel}
                </Button>
              </div>
            </footer>
          )}
        </form>
      </div>

      <aside aria-label="Your booking page, as you fill it in" className="hidden flex-1 p-3 lg:block">
        <StartShowcase
          template={template}
          businessName={clinicName}
          ownerName={ownerName}
          ownerPractices={ownerPractices}
          slug={bookingSlug}
        />
      </aside>
    </div>
  );
}

function readError(value: unknown): { message: string; code?: string; fields: Record<string, string> } {
  const fallback = { message: "Something went wrong. Please try again.", fields: {} };
  if (typeof value !== "object" || value === null || !("error" in value)) return fallback;
  const error = value.error;
  if (typeof error !== "object" || error === null) return fallback;
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  const message = "message" in error && typeof error.message === "string" ? error.message : fallback.message;
  const fields: Record<string, string> = {};
  if ("fieldErrors" in error && typeof error.fieldErrors === "object" && error.fieldErrors !== null) {
    for (const [key, messages] of Object.entries(error.fieldErrors)) {
      if (Array.isArray(messages) && typeof messages[0] === "string") fields[key] = messages[0];
    }
  }
  return { message, code, fields };
}
