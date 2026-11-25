"use client";

import { useMemo, useState, type FormEvent } from "react";
import { Check, CircleAlert, Copy, Download, Fingerprint, KeyRound } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { toastManager } from "@/components/ui/toast";
import { authClient } from "@/lib/auth-client";
import { qrCodePath } from "@/lib/check-in";
import { deviceLabel } from "@/lib/device-label";
import { Eye, EyeOff } from "lucide-react";

/** What better-auth hands back when a call fails. Only the message, status and code are read, never a secret. */
interface AuthFailure {
  message?: string;
  status?: number;
  code?: string;
}

export function authFailureText(error: AuthFailure | null | undefined, fallback: string): string {
  if (!error) return fallback;
  if (error.status === 429) return "Too many tries. Wait a few minutes and try again.";
  return error.message?.trim() ? error.message : fallback;
}

/** Keeps digits only, so "123 456" pasted from an app still works. */
function cleanCode(value: string, backup: boolean): string {
  return backup ? value.trim() : value.replace(/\D/g, "").slice(0, 6);
}

/**
 * Asks for an authenticator code, a backup code or a passkey. Used on sign-in, on the confirm page and in the step-up
 * dialog. It never stores or logs what was typed.
 */
export function SecondFactorForm({
  hasAuthenticator = true,
  hasPasskey = false,
  onVerified,
  submitLabel = "Confirm",
}: {
  hasAuthenticator?: boolean;
  hasPasskey?: boolean;
  onVerified: () => void | Promise<void>;
  submitLabel?: string;
}) {
  const [backup, setBackup] = useState(false);
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [passkeyPending, setPasskeyPending] = useState(false);
  const [error, setError] = useState("");
  const label = backup ? "Backup code" : "Authenticator code";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = cleanCode(code, backup);
    if (!value) return;
    setPending(true);
    setError("");
    try {
      const result = backup
        ? await authClient.twoFactor.verifyBackupCode({ code: value })
        : await authClient.twoFactor.verifyTotp({ code: value });
      if (result.error) {
        setError(result.error.status === 429 ? authFailureText(result.error, "") : backup ? "That backup code did not work. Each code works once." : "That code did not work. Check the code in your app and try again.");
        return;
      }
      await onVerified();
    } catch {
      setError("This is unavailable right now. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  async function signInWithPasskey() {
    setPasskeyPending(true);
    setError("");
    try {
      const result = await authClient.signIn.passkey();
      if (result?.error) {
        setError("The passkey was not confirmed. Try again, or use a code.");
        return;
      }
      await onVerified();
    } catch {
      setError("The passkey was not confirmed. Try again, or use a code.");
    } finally {
      setPasskeyPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <Alert variant="error">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {hasAuthenticator ? (
        <Form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" aria-label="Second step code">
          <Field name="code" className="w-full">
            <FieldLabel>{label}</FieldLabel>
            <Input
              key={label}
              size="lg"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              required
              autoFocus
              inputMode={backup ? "text" : "numeric"}
              autoComplete="one-time-code"
              spellCheck={false}
              placeholder={backup ? "Enter a backup code" : "6-digit code"}
            />
            <FieldDescription>{backup ? "Each backup code works once." : "Open your authenticator app and enter the current code."}</FieldDescription>
            <FieldError match="valueMissing">{backup ? "Enter a backup code." : "Enter the 6-digit code."}</FieldError>
          </Field>
          <Button size="lg" type="submit" loading={pending} aria-busy={pending} className="w-full">
            {submitLabel}
          </Button>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="self-center"
            onClick={() => {
              setBackup((value) => !value);
              setCode("");
              setError("");
            }}
          >
            {backup ? "Use my authenticator app" : "Use a backup code"}
          </Button>
        </Form>
      ) : null}
      {hasPasskey ? (
        <Button type="button" variant="outline" size="lg" className="w-full" loading={passkeyPending} onClick={() => void signInWithPasskey()}>
          <Fingerprint aria-hidden="true" /> Use a passkey
        </Button>
      ) : null}
    </div>
  );
}

function secretFromUri(uri: string): string {
  try {
    return new URL(uri).searchParams.get("secret") ?? "";
  } catch {
    return "";
  }
}

/**
 * Turns on an authenticator app: (optional) password, then the QR code and a first code to prove it works.
 * Hands the backup codes to `onEnrolled` once the first code is right.
 */
export function AuthenticatorEnrol({
  passwordChosen,
  onEnrolled,
}: {
  passwordChosen: boolean;
  onEnrolled: (backupCodes: string[]) => void;
}) {
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [setup, setSetup] = useState<{ uri: string; codes: string[] } | null>(null);
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const qr = useMemo(() => (setup ? qrCodePath(setup.uri) : null), [setup]);
  const secret = setup ? secretFromUri(setup.uri) : "";

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const result = await authClient.twoFactor.enable(passwordChosen ? { password } : {});
      if (result.error || !result.data) {
        setError(result.error?.code === "INVALID_PASSWORD" ? "That password is not right. Try again." : authFailureText(result.error, "Could not start the setup. Try again."));
        return;
      }
      const data = result.data;
      if (!("totpURI" in data)) {
        setError("Could not start the setup. Try again.");
        return;
      }
      setSetup({ uri: data.totpURI, codes: data.backupCodes ?? [] });
    } catch {
      setError("This is unavailable right now. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!setup) return;
    setPending(true);
    setError("");
    try {
      const result = await authClient.twoFactor.verifyTotp({ code: cleanCode(code, false) });
      if (result.error) {
        setError("That code did not work. Check the code in your app and try again.");
        return;
      }
      onEnrolled(setup.codes);
    } catch {
      setError("This is unavailable right now. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  const errorAlert = error ? (
    <Alert variant="error">
      <CircleAlert aria-hidden="true" />
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  ) : null;

  if (!setup) {
    return (
      <Form onSubmit={(event) => void start(event)} className="flex flex-col gap-4" aria-label="Set up an authenticator app">
        {errorAlert}
        {passwordChosen ? (
          <Field name="password" className="w-full">
            <FieldLabel>Current password</FieldLabel>
            <InputGroup>
              <InputGroupInput
                size="lg"
                type={passwordVisible ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                autoComplete="current-password"
              />
              <InputGroupAddon align="inline-end">
                <Button variant="ghost" size="icon-xs" aria-label={passwordVisible ? "Hide password" : "Show password"} onClick={() => setPasswordVisible((visible) => !visible)}>
                  {passwordVisible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                </Button>
              </InputGroupAddon>
            </InputGroup>
            <FieldDescription>We ask for your password before we change how you sign in.</FieldDescription>
            <FieldError match="valueMissing">Enter your password.</FieldError>
          </Field>
        ) : (
          <p className="text-sm text-muted-foreground">You will need an authenticator app, such as Google Authenticator, Microsoft Authenticator or 1Password.</p>
        )}
        <Button size="lg" type="submit" loading={pending} aria-busy={pending} className="w-full">
          Continue
        </Button>
      </Form>
    );
  }

  return (
    <Form onSubmit={(event) => void verify(event)} className="flex flex-col gap-4" aria-label="Check your authenticator app">
      {errorAlert}
      <ol className="flex list-decimal flex-col gap-1 ps-5 text-sm text-muted-foreground">
        <li>Open your authenticator app and add an account.</li>
        <li>Scan this code, or type the key below.</li>
        <li>Enter the 6-digit code the app shows.</li>
      </ol>
      {qr ? (
        <div className="mx-auto rounded-xl border bg-white p-2">
          <svg role="img" aria-label="QR code for your authenticator app" viewBox={`0 0 ${qr.size} ${qr.size}`} shapeRendering="crispEdges" className="size-44">
            <path d={qr.path} fill="#000" />
          </svg>
        </div>
      ) : null}
      {secret ? (
        <p className="text-center text-xs text-muted-foreground">
          Can&apos;t scan? Type this key: <code data-testid="totp-secret" className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground break-all select-all">{secret}</code>
        </p>
      ) : null}
      <Field name="code" className="w-full">
        <FieldLabel>Authenticator code</FieldLabel>
        <Input
          size="lg"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          required
          inputMode="numeric"
          autoComplete="one-time-code"
          spellCheck={false}
          placeholder="6-digit code"
        />
        <FieldError match="valueMissing">Enter the 6-digit code.</FieldError>
      </Field>
      <Button size="lg" type="submit" loading={pending} aria-busy={pending} className="w-full">
        Verify
      </Button>
    </Form>
  );
}

/** Shows the backup codes once. Continue stays off until the person says they saved them. */
export function BackupCodesView({
  codes,
  onContinue,
  continueLabel = "Continue",
}: {
  codes: string[];
  onContinue: () => void;
  continueLabel?: string;
}) {
  const [saved, setSaved] = useState(false);
  const text = codes.join("\n");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      toastManager.add({ title: "Codes copied", type: "success" });
    } catch {
      toastManager.add({ title: "Could not copy", description: "Select the codes and copy them.", type: "error" });
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([`Kalendr backup codes\nEach code works once.\n\n${text}\n`], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "kalendr-backup-codes.txt";
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        If you lose your phone, each of these codes lets you in once. We show them only now, so keep them somewhere safe.
      </p>
      <ul aria-label="Backup codes" className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/40 p-3 font-mono text-sm">
        {codes.map((value) => (
          <li key={value} className="select-all text-center">{value}</li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button type="button" variant="outline" className="flex-1" onClick={() => void copy()}>
          <Copy aria-hidden="true" /> Copy
        </Button>
        <Button type="button" variant="outline" className="flex-1" onClick={download}>
          <Download aria-hidden="true" /> Download
        </Button>
      </div>
      <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
        <Checkbox checked={saved} onCheckedChange={(value) => setSaved(value === true)} aria-label="I saved these codes" />
        <span aria-hidden="true">I saved these codes</span>
      </label>
      <Button size="lg" className="w-full" disabled={!saved} onClick={onContinue}>
        <Check aria-hidden="true" /> {continueLabel}
      </Button>
    </div>
  );
}

/** Adds a passkey to this account. The browser asks the person to confirm with their fingerprint, face or screen lock. */
export function PasskeyAddButton({
  onAdded,
  size = "default",
  variant = "default",
  label = "Add a passkey",
  className,
}: {
  onAdded: () => void | Promise<void>;
  size?: "default" | "lg" | "sm";
  variant?: "default" | "outline";
  label?: string;
  className?: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function add() {
    setPending(true);
    setError("");
    try {
      const result = await authClient.passkey.addPasskey({ name: deviceLabel(navigator.userAgent) });
      if (result?.error) {
        setError("The passkey was not added. Try again.");
        return;
      }
      await onAdded();
    } catch {
      setError("The passkey was not added. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button type="button" size={size} variant={variant} className={className} loading={pending} onClick={() => void add()}>
        <KeyRound aria-hidden="true" /> {label}
      </Button>
      {error ? <p role="alert" className="text-sm text-destructive-foreground">{error}</p> : null}
    </div>
  );
}
