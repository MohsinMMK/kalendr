"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CircleAlert, Eye, EyeOff, MailCheck } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import { authClient } from "@/lib/auth-client";

import { signInEmailKey } from "./staff-auth-controls";

/** Matches `emailAndPassword.minPasswordLength` in src/lib/auth.ts. */
const minimumLength = 12;

function PasswordInput({ id, label, value, onChange, autoComplete, description }: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: "new-password" | "current-password";
  description?: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <Field name={id} className="w-full">
      <FieldLabel>{label}</FieldLabel>
      <InputGroup>
        <InputGroupInput
          id={id}
          size="lg"
          type={visible ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          required
          minLength={autoComplete === "new-password" ? minimumLength : undefined}
          autoComplete={autoComplete}
        />
        <InputGroupAddon align="inline-end">
          <Button variant="ghost" size="icon-xs" aria-label={visible ? "Hide password" : "Show password"} aria-controls={id} onClick={() => setVisible((current) => !current)}>
            {visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          </Button>
        </InputGroupAddon>
      </InputGroup>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      <FieldError match="valueMissing">Enter a password.</FieldError>
      <FieldError match="tooShort">Use at least {minimumLength} characters.</FieldError>
    </Field>
  );
}

function ErrorAlert({ message }: { message: string }) {
  return (
    <Alert variant="error">
      <CircleAlert aria-hidden="true" />
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

/** Finishes both an invite (first password) and a reset. Better Auth checks the token again. */
export function ResetPasswordForm({ token, email, invite }: { token: string; email: string; invite: boolean }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const t = useTerms();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  return (
    <Form
      className="flex flex-col gap-4"
      aria-label={invite ? "Choose your password" : "Choose a new password"}
      onSubmit={async (event) => {
        event.preventDefault();
        setError("");
        if (password !== confirm) {
          setError("The two passwords don't match.");
          return;
        }
        setPending(true);
        try {
          const result = await authClient.resetPassword({ newPassword: password, token });
          if (result.error) {
            setError(result.error.code === "INVALID_TOKEN" ? `This link has already been used or has expired. Ask your ${t.business} for a new one.` : result.error.message ?? "The password could not be saved.");
            return;
          }
          toastManager.add({ title: invite ? "Your account is ready" : "Password changed", description: "Sign in with your new password.", type: "success" });
          try {
            window.sessionStorage.setItem(signInEmailKey, email);
          } catch {
            // Storage blocked: they type their email on the sign-in page.
          }
          router.replace("/sign-in");
        } catch {
          setError("The password could not be saved. Check your connection and try again.");
        } finally {
          setPending(false);
        }
      }}
    >
      {error ? <ErrorAlert message={error} /> : null}
      {/* Lets password managers save the new password against the right account. */}
      <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />
      <PasswordInput id="new-password" label={invite ? "Choose a password" : "New password"} value={password} onChange={setPassword} autoComplete="new-password" description={`At least ${minimumLength} characters. A short sentence is easy to remember.`} />
      <PasswordInput id="confirm-password" label="Type it again" value={confirm} onChange={setConfirm} autoComplete="new-password" />
      <Button size="lg" type="submit" loading={pending} className="mt-1 w-full">
        {invite ? "Create my account" : "Save new password"}
      </Button>
    </Form>
  );
}

/** Always answers the same way, so it can't be used to find out who works at a business. */
export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const t = useTerms();

  if (sent) {
    return (
      <Alert variant="success" role="status">
        <MailCheck aria-hidden="true" />
        <AlertTitle>Check your email</AlertTitle>
        <AlertDescription>
          <p>If {email.trim()} has {t.aBusiness} account, a link to choose a new password is on its way. It works for one hour.</p>
          <p>No email? Check spam, or ask your {t.business} owner to send you a reset link from the Team page.</p>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Form
      className="flex flex-col gap-4"
      aria-label="Reset your password"
      onSubmit={async (event) => {
        event.preventDefault();
        setPending(true);
        setError("");
        try {
          const result = await authClient.requestPasswordReset({ email: email.trim(), redirectTo: "/reset-password" });
          if (result.error && result.error.status && result.error.status >= 500) {
            setError("Password resets are unavailable right now. Try again in a few minutes.");
            return;
          }
          setSent(true);
        } catch {
          setError("Password resets are unavailable right now. Check your connection and try again.");
        } finally {
          setPending(false);
        }
      }}
    >
      {error ? <ErrorAlert message={error} /> : null}
      <Field name="email" className="w-full">
        <FieldLabel>Work email</FieldLabel>
        <Input id="reset-email" size="lg" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="username" placeholder={`you@${t.business.replace(/\s+/g, "")}.com`} />
        <FieldError match="valueMissing">Enter your work email.</FieldError>
        <FieldError match="typeMismatch">Enter a valid email address.</FieldError>
      </Field>
      <Button size="lg" type="submit" loading={pending} className="mt-1 w-full">Send reset link</Button>
      <Button variant="link" size="sm" className="self-center" render={<Link href="/sign-in" />}>Back to sign in</Button>
    </Form>
  );
}

/** On My profile. Signs the person out of their other devices once it's changed. */
export function ChangePasswordForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  return (
    <Form
      className="flex flex-col gap-4"
      aria-label="Change password"
      onSubmit={async (event) => {
        event.preventDefault();
        setPending(true);
        setError("");
        try {
          const result = await authClient.changePassword({ currentPassword: current, newPassword: next, revokeOtherSessions: true });
          if (result.error) {
            setError(result.error.code === "INVALID_PASSWORD" ? "Your current password isn't right." : result.error.message ?? "The password could not be changed.");
            return;
          }
          setCurrent("");
          setNext("");
          toastManager.add({ title: "Password changed", description: "You were signed out of your other devices.", type: "success" });
        } catch {
          setError("The password could not be changed. Check your connection and try again.");
        } finally {
          setPending(false);
        }
      }}
    >
      {error ? <ErrorAlert message={error} /> : null}
      <PasswordInput id="current-password" label="Current password" value={current} onChange={setCurrent} autoComplete="current-password" />
      <PasswordInput id="changed-password" label="New password" value={next} onChange={setNext} autoComplete="new-password" description={`At least ${minimumLength} characters. Other devices are signed out.`} />
      <Button type="submit" loading={pending} className="self-start">Change password</Button>
    </Form>
  );
}
