"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

import { approvalReturnPath } from "@/lib/oauth";
import { useRouter } from "next/navigation";
import { ArrowLeft, Building2, CircleAlert, Eye, EyeOff, Fingerprint, LogOut, MailCheck, Mail } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { authClient } from "@/lib/auth-client";
import { useTerms } from "@/features/terms/business-profile-context";

import { SecondFactorForm } from "./second-factor-parts";

/** Set by the reset and invite pages so sign-in opens with the email filled in, without putting it in the URL. */
export const signInEmailKey = "kalendr:sign-in-email";

const inviteNeeded = "Ask your manager to invite you.";

/** Turns the `?error=` code the sign-in page gets back from a provider or a failed link into words. */
export function signInErrorText(code: string | null | undefined): string {
  if (!code) return "";
  const known = new Set(["signup_disabled", "sign_up_disabled", "no_active_membership", "unable_to_link_account", "account_not_linked"]);
  const company = ssoErrorText[code.toLowerCase()];
  if (company) return company;
  return known.has(code.toLowerCase()) ? inviteNeeded : "Could not sign in. Try again.";
}

/** What the sign-in page says when company sign-in did not finish (feature 53). Each is one plain sentence. */
const ssoErrorText: Record<string, string> = {
  sso_invalid_response: "The company sign-in could not be checked. Try again from the start.",
  sso_no_email: "Your company sign-in did not share an email address. Ask your IT team to include it.",
  sso_wrong_domain: "That email address does not belong to this company sign-in.",
  sso_not_invited: inviteNeeded,
  sso_access_removed: "Your access to this workspace was removed. Ask your manager.",
  sso_connection_off: "Company sign-in is switched off for this business.",
  sso_provider_error: "Your company sign-in did not finish. Try again.",
  sso_required: "Your company needs you to sign in with company sign-in.",
};

/** The way this browser last signed in, so the sign-in page can mark it "Last used". Only the method is kept, never the email. */
const lastMethodKey = "kalendr:last-sign-in-method";
type SignInMethod = "password" | "google" | "microsoft" | "link" | "passkey" | "company";
const signInMethods: readonly SignInMethod[] = ["password", "google", "microsoft", "link", "passkey", "company"];

function rememberMethod(method: SignInMethod) {
  try {
    window.localStorage.setItem(lastMethodKey, method);
  } catch {
    // Storage can be blocked; the badge is only a convenience.
  }
}

function readLastMethod(): SignInMethod | null {
  try {
    const value = window.localStorage.getItem(lastMethodKey);
    return signInMethods.includes(value as SignInMethod) ? (value as SignInMethod) : null;
  } catch {
    return null;
  }
}

/** The small "Last used" tag that sits on the corner of the method this browser used last. */
function LastUsed({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <Badge variant="outline" size="sm" className="pointer-events-none absolute -top-2 -right-1.5 z-10 shadow-xs animate-in fade-in zoom-in-95">
      Last used
    </Badge>
  );
}

const linkSentText = "If that email has access, we've sent a link. It works once and expires in 10 minutes.";

type Providers = { google: boolean; microsoft: boolean };

function GoogleMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4">
      <path fill="#4285F4" d="M23 12.3c0-.8-.1-1.5-.2-2.2H12v4.2h6.2a5.3 5.3 0 0 1-2.3 3.5v2.9h3.7c2.2-2 3.4-5 3.4-8.4Z" />
      <path fill="#34A853" d="M12 24c3.1 0 5.7-1 7.6-2.8l-3.7-2.9c-1 .7-2.3 1.1-3.9 1.1-3 0-5.5-2-6.4-4.7H1.8v3A12 12 0 0 0 12 24Z" />
      <path fill="#FBBC05" d="M5.6 14.7a7.2 7.2 0 0 1 0-4.6v-3H1.8a12 12 0 0 0 0 10.6l3.8-3Z" />
      <path fill="#EA4335" d="M12 4.8c1.7 0 3.2.6 4.4 1.700l3.300-3.300A12 12 0 0 0 1.800 7.100l3.800 3C6.500 6.800 9 4.800 12 4.800Z" />
    </svg>
  );
}

function MicrosoftMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4">
      <path fill="#F25022" d="M2 2h9.500v9.500H2z" />
      <path fill="#7FBA00" d="M12.500 2H22v9.500h-9.500z" />
      <path fill="#00A4EF" d="M2 12.500h9.500V22H2z" />
      <path fill="#FFB900" d="M12.500 12.500H22V22h-9.500z" />
    </svg>
  );
}

function destinationFromUrl(): string {
  const next = new URLSearchParams(window.location.search).get("next");
  // An app that sent the person here to approve it gets them back to its approval page.
  return next === "/setup" ? "/setup" : approvalReturnPath(next) ?? "/dashboard";
}

export function StaffSignIn({ providers = { google: false, microsoft: false }, errorCode = null }: { providers?: Providers; errorCode?: string | null }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = window.sessionStorage.getItem(signInEmailKey);
      window.sessionStorage.removeItem(signInEmailKey);
    } catch {
      // Storage can be blocked; the person just types their email.
    }
    if (!saved) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time read of browser storage after mount
    setEmail(saved);
    passwordRef.current?.focus();
  }, []);
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(() => signInErrorText(errorCode));
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<"google" | "microsoft" | "link" | "passkey" | "company" | null>(null);
  const [needsCode, setNeedsCode] = useState(false);
  const [lastMethod, setLastMethod] = useState<SignInMethod | null>(null);
  const t = useTerms();

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time read of browser storage after mount
    setLastMethod(readLastMethod());
  }, []);

  async function finish() {
    router.replace(destinationFromUrl());
    router.refresh();
  }

  async function social(provider: "google" | "microsoft") {
    setBusy(provider);
    setError("");
    setNotice("");
    try {
      const result = await authClient.signIn.social({ provider, callbackURL: destinationFromUrl(), errorCallbackURL: "/sign-in" });
      if (result?.error) setError("Could not sign in. Try again.");
      else rememberMethod(provider);
    } catch {
      setError("Sign-in is unavailable right now. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  }

  async function sendLink() {
    setError("");
    setNotice("");
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
      setError("Enter your work email first, then ask for a link.");
      return;
    }
    setBusy("link");
    try {
      const result = await authClient.signIn.magicLink({ email: email.trim(), callbackURL: destinationFromUrl() });
      if (result?.error?.status === 429) {
        setError("Too many sign-in attempts. Wait a few minutes and try again.");
        return;
      }
      // The same words whether or not the email has access, so nobody can use this to find out who works here.
      setNotice(linkSentText);
      rememberMethod("link");
    } catch {
      setError("Sign-in is unavailable right now. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  }

  /** Company sign-in (feature 53): finds the identity provider for the email's domain, then goes there. */
  async function companySignIn() {
    setError("");
    setNotice("");
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
      setError("Enter your work email first, then continue with your company account.");
      return;
    }
    setBusy("company");
    try {
      const response = await fetch("/api/sso/lookup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: email.trim() }) });
      if (response.status === 429) {
        setError("Too many sign-in attempts. Wait a few minutes and try again.");
        return;
      }
      const body = await response.json().catch(() => null) as { data?: { sso?: boolean; startUrl?: string } } | null;
      if (!response.ok || !body?.data) {
        setError("Sign-in is unavailable right now. Check your connection and try again.");
        return;
      }
      if (!body.data.sso || !body.data.startUrl) {
        setError("That address has no company sign-in. Use your password or ask for a sign-in link.");
        return;
      }
      rememberMethod("company");
      window.location.assign(body.data.startUrl);
    } catch {
      setError("Sign-in is unavailable right now. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  }

  async function passkey() {
    setBusy("passkey");
    setError("");
    setNotice("");
    try {
      const result = await authClient.signIn.passkey();
      if (result?.error) {
        setError("The passkey was not confirmed. Try again, or use another way to sign in.");
        return;
      }
      rememberMethod("passkey");
      await finish();
    } catch {
      setError("The passkey was not confirmed. Try again, or use another way to sign in.");
    } finally {
      setBusy(null);
    }
  }

  async function signIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    setNotice("");
    let leaving = false;
    try {
      // Better Auth loads the destination as a full page once the password is accepted, so the server decides
      // in one step where the person lands (the page, or second-factor setup first). A code step returns instead.
      const result = await authClient.signIn.email({ email: email.trim(), password, callbackURL: destinationFromUrl() });
      if (result.error) {
        if (result.error.status === 429) {
          setError("Too many sign-in attempts. Wait a few minutes and try again.");
          return;
        }
        if (result.error.code === "SSO_REQUIRED") {
          setError("Your company needs you to sign in with your company account. Use the button below.");
          return;
        }
        setError(result.error.code === "EMAIL_NOT_VERIFIED" ? `Check your inbox for an email verification link, then sign in again. Check spam too. If it does not arrive, contact your ${t.business} administrator.` : `Could not sign in. Check your email and password, or ask your ${t.business} administrator for access.`);
        return;
      }
      rememberMethod("password");
      if ((result.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect === true) {
        setNeedsCode(true);
        return;
      }
      // The page is loading; keep the button busy so it cannot be pressed twice.
      leaving = true;
    } catch (cause: unknown) {
      console.error("Staff sign-in request failed", cause);
      setError("Sign-in is unavailable right now. Check your connection and try again.");
    } finally {
      if (!leaving) setPending(false);
    }
  }

  if (needsCode) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1 text-center">
          <h2 className="text-base font-semibold">Enter your code</h2>
          <p className="text-sm text-muted-foreground">Your account asks for a second step.</p>
        </div>
        <SecondFactorForm onVerified={finish} submitLabel="Verify" />
        <Button type="button" variant="ghost" size="sm" className="self-center" onClick={() => { setNeedsCode(false); setPassword(""); }}>
          <ArrowLeft aria-hidden="true" /> Back to sign in
        </Button>
      </div>
    );
  }

  const anyProvider = providers.google || providers.microsoft;

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <Alert variant="error">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <Alert variant="success" role="status">
          <MailCheck aria-hidden="true" />
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}
      {anyProvider ? (
        <>
          <div className="flex flex-col gap-2">
            {providers.google ? (
              <div className="relative">
                <Button type="button" variant="outline" size="lg" className="w-full" loading={busy === "google"} disabled={busy !== null && busy !== "google"} onClick={() => void social("google")}>
                  <GoogleMark /> Continue with Google
                </Button>
                <LastUsed show={lastMethod === "google"} />
              </div>
            ) : null}
            {providers.microsoft ? (
              <div className="relative">
                <Button type="button" variant="outline" size="lg" className="w-full" loading={busy === "microsoft"} disabled={busy !== null && busy !== "microsoft"} onClick={() => void social("microsoft")}>
                  <MicrosoftMark /> Continue with Microsoft
                </Button>
                <LastUsed show={lastMethod === "microsoft"} />
              </div>
            ) : null}
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground" aria-hidden="true">
            <Separator className="flex-1" /> or <Separator className="flex-1" />
          </div>
        </>
      ) : null}
      <Form onSubmit={(event) => void signIn(event)} className="flex flex-col gap-4" aria-label="Staff sign in">
        <Field name="email" className="w-full">
          <FieldLabel>Work email</FieldLabel>
          <Input
            id="staff-email"
            size="lg"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            autoComplete="username webauthn"
            placeholder={`you@${t.business.replace(/\s+/g, "")}.com`}
          />
          <FieldError match="valueMissing">Enter your work email.</FieldError>
          <FieldError match="typeMismatch">Enter a valid email address.</FieldError>
        </Field>
        <Field name="password" className="w-full">
          <div className="flex w-full items-center justify-between gap-2">
            <FieldLabel>Password</FieldLabel>
            <Button variant="link" size="xs" className="h-auto px-0 text-muted-foreground" render={<Link href="/forgot-password" />}>
              Forgot password?
            </Button>
          </div>
          <InputGroup>
            <InputGroupInput
              id="staff-password"
              size="lg"
              type={passwordVisible ? "text" : "password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              autoComplete="current-password"
              ref={passwordRef}
              placeholder="Enter your password"
            />
            <InputGroupAddon align="inline-end">
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={passwordVisible ? "Hide password" : "Show password"}
                aria-controls="staff-password"
                onClick={() => setPasswordVisible((visible) => !visible)}
              >
                {passwordVisible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
              </Button>
            </InputGroupAddon>
          </InputGroup>
          <FieldError match="valueMissing">Enter your password.</FieldError>
        </Field>
        <div className="relative mt-1">
          <Button size="lg" type="submit" loading={pending} aria-busy={pending} className="w-full">
            Sign in
          </Button>
          <LastUsed show={lastMethod === "password"} />
        </div>
      </Form>
      <div className="flex items-center gap-3 text-xs text-muted-foreground" aria-hidden="true">
        <Separator className="flex-1" /> or <Separator className="flex-1" />
      </div>
      <div className="flex flex-col gap-2">
        <div className="relative">
          <Button type="button" variant="outline" size="lg" className="w-full" loading={busy === "link"} disabled={busy !== null && busy !== "link"} onClick={() => void sendLink()}>
            <Mail aria-hidden="true" /> Email me a sign-in link
          </Button>
          <LastUsed show={lastMethod === "link"} />
        </div>
        <div className="relative">
          <Button type="button" variant="outline" size="lg" className="w-full" loading={busy === "passkey"} disabled={busy !== null && busy !== "passkey"} onClick={() => void passkey()}>
            <Fingerprint aria-hidden="true" /> Sign in with a passkey
          </Button>
          <LastUsed show={lastMethod === "passkey"} />
        </div>
        <div className="relative">
          <Button type="button" variant="outline" size="lg" className="w-full" loading={busy === "company"} disabled={busy !== null && busy !== "company"} onClick={() => void companySignIn()}>
            <Building2 aria-hidden="true" /> Continue with your company account
          </Button>
          <LastUsed show={lastMethod === "company"} />
        </div>
      </div>
    </div>
  );
}

export function StaffSignOut() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function signOut() {
    setPending(true);
    setError("");
    try {
      const result = await authClient.signOut();
      if (result.error) {
        setError("Could not sign out. Try again.");
        return;
      }
      router.replace("/sign-in");
      router.refresh();
    } catch (cause: unknown) {
      console.error("Staff sign-out request failed", cause);
      setError("Could not sign out. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex w-full flex-col items-center gap-3">
      <Button variant="outline" onClick={() => void signOut()} loading={pending}>
        <LogOut aria-hidden="true" />
        Sign out
      </Button>
      {error ? (
        <Alert variant="error" className="text-start">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
