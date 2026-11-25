"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { EllipsisVertical } from "lucide-react";
import { useState, type FormEvent } from "react";

import { TextField } from "@/components/form-fields";
import { TurnstileField, useBotCheck } from "@/components/turnstile-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardDescription, CardFooter, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { OTPField, OTPFieldInput } from "@/components/ui/otp-field";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { Spinner } from "@/components/ui/spinner";
import { TogglePrimitive } from "@/components/ui/toggle";
import { ToggleGroupPrimitive } from "@/components/ui/toggle-group";
import type { PatientContactKind } from "@/lib/patient-contact";
import { previewPortalCode, previewPortalEmail, previewPortalPhone } from "@/lib/preview-records";

import { ApiRequestError, portalAuth } from "../records/records-client";
import { generalNoticeSlug, PrivacyNoticeLink } from "./privacy-notice";

const codeLength = 6;

/** Where to go after the code: a fixed list, never a free address from the link. */
const returnPaths: Record<string, string> = { privacy: "/portal/privacy" };

function returnPath(): string {
  const next = new URLSearchParams(window.location.search).get("next");
  return (next && returnPaths[next]) || "/portal";
}

export function PortalSignIn({ preview, turnstileSiteKey = null }: { preview: boolean; turnstileSiteKey?: string | null }) {
  const router = useRouter();
  const bot = useBotCheck();
  const [kind, setKind] = useState<PatientContactKind>("email");
  const [contact, setContact] = useState("");
  const [step, setStep] = useState<"contact" | "code">("contact");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [remember, setRemember] = useState(false);

  async function attempt(action: () => Promise<void> | void) {
    setPending(true);
    setError("");
    try {
      await action();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Something went wrong. Try again.");
    } finally {
      setPending(false);
    }
  }

  const sendCode = (via?: "text") => attempt(async () => {
    if (!preview) {
      try {
        await portalAuth.requestCode(kind, contact, bot.headers(), via);
        bot.afterResponse(undefined);
      } catch (cause: unknown) {
        // The server asks for the person check: show it on the contact step, under the field.
        if (bot.afterResponse(cause instanceof ApiRequestError ? cause.code : undefined, cause instanceof Error ? cause.message : undefined)) {
          setStep("contact");
          return;
        }
        throw cause;
      }
    }
    setCode("");
    setStep("code");
    setNotice(
      kind === "email"
        ? "If this email can sign in, a code is on its way. It works for 10 minutes."
        : `If this number can sign in, a code is on its way by ${via === "text" ? "text message" : "WhatsApp or text message"}. It works for 10 minutes.`,
    );
  });

  const verify = (value: string) => attempt(async () => {
    if (preview) portalAuth.previewSignIn(kind, contact, value);
    else await portalAuth.verifyCode(kind, contact, value, remember);
    router.replace(returnPath());
    router.refresh();
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (step === "contact") void sendCode();
    else if (code.length === codeLength) void verify(code);
  }

  return (
    <main className="flex min-h-screen flex-1 flex-col items-center justify-center gap-4 bg-muted/72 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="justify-items-center gap-2 text-center">
          <Image src="/kalendr-mark.svg" alt="" width={36} height={36} />
          <CardTitle render={<h1 />} className="text-xl">{step === "contact" ? "Your bookings and documents" : "Enter your code"}</CardTitle>
          <CardDescription>
            {step === "contact" ? "Use the email or phone number you gave when you booked." : `For ${contact.trim()}.`}
          </CardDescription>
        </CardHeader>
        <CardPanel>
          <form className="flex flex-col gap-4" onSubmit={submit}>
            {preview ? (
              <Alert variant="info">
                <AlertDescription>
                  {step === "contact"
                    ? <p>Preview, nothing is sent. Try <span className="font-medium text-foreground">{previewPortalEmail}</span> or {previewPortalPhone}.</p>
                    : <p>Preview code: <span className="font-mono font-medium text-foreground">{previewPortalCode}</span></p>}
                </AlertDescription>
              </Alert>
            ) : null}
            {error ? <Alert variant="error" role="alert"><AlertDescription>{error}</AlertDescription></Alert> : null}
            {step === "contact" ? (
              <>
                <SegmentedControl className="w-full" render={<ToggleGroupPrimitive aria-label="Sign in with" value={[kind]} onValueChange={(next: string[]) => { if (next[0]) { setKind(next[0] as PatientContactKind); setContact(""); setError(""); } }} />}>
                  <SegmentedControlItem className="flex-1" render={<TogglePrimitive value="email" />}>Email</SegmentedControlItem>
                  <SegmentedControlItem className="flex-1" render={<TogglePrimitive value="phone" />}>Phone</SegmentedControlItem>
                </SegmentedControl>
                <TextField
                  id="portal-contact"
                  label={kind === "email" ? "Email" : "Phone number"}
                  type={kind === "email" ? "email" : "tel"}
                  autoComplete={kind === "email" ? "email" : "tel"}
                  value={contact}
                  onChange={(event) => setContact(event.target.value)}
                  required
                />
                {bot.shown && turnstileSiteKey ? (
                  <TurnstileField key={bot.round} siteKey={turnstileSiteKey} action="code_request" onToken={bot.onToken} error={bot.error} />
                ) : null}
                <Button type="submit" disabled={pending || contact.trim().length < 5 || (bot.shown && Boolean(turnstileSiteKey) && !bot.token)}>
                  {pending ? <Spinner aria-hidden="true" /> : null}
                  Send code
                </Button>
              </>
            ) : (
              <>
                {notice && !error ? <p className="text-sm text-muted-foreground" role="status">{notice}</p> : null}
                <Field className="gap-2">
                  <FieldLabel id="portal-code-label">Six-digit code</FieldLabel>
                  <OTPField
                    size="lg"
                    length={codeLength}
                    autoFocus
                    aria-labelledby="portal-code-label"
                    value={code}
                    onValueChange={setCode}
                    onValueComplete={(value) => void verify(value)}
                    disabled={pending}
                  >
                    {Array.from({ length: codeLength }, (_, index) => <OTPFieldInput key={index} {...(index === 0 ? {} : { "aria-label": `Digit ${index + 1}` })} />)}
                  </OTPField>
                </Field>
                {preview ? null : (
                  <Label className="items-start gap-2 font-normal">
                    <Checkbox checked={remember} onCheckedChange={(checked) => setRemember(checked === true)} disabled={pending} />
                    <span>Remember this device for 30 days</span>
                  </Label>
                )}
                <Button type="submit" disabled={pending || code.length < codeLength}>
                  {pending ? <Spinner aria-hidden="true" /> : null}
                  Sign in
                </Button>
                <div className="flex items-center justify-between gap-1">
                  <Button type="button" variant="ghost" size="sm" className="min-w-0" onClick={() => { setStep("contact"); setError(""); }}>Change contact</Button>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => void sendCode()}>Send again</Button>
                    {kind === "phone" && !preview ? (
                      <Menu>
                        <MenuTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label="More ways to get a code" disabled={pending} />}>
                          <EllipsisVertical aria-hidden="true" />
                        </MenuTrigger>
                        <MenuPopup align="end">
                          <MenuItem onClick={() => void sendCode("text")}>Send it as a text message instead</MenuItem>
                        </MenuPopup>
                      </Menu>
                    ) : null}
                  </div>
                </div>
              </>
            )}
          </form>
        </CardPanel>
        <CardFooter className="flex-col justify-center gap-2 text-center text-xs text-muted-foreground">
          <PrivacyNoticeLink clinicSlug={generalNoticeSlug} />
          <p>Staff? <Link className="underline underline-offset-2" href="/sign-in">Sign in here</Link></p>
        </CardFooter>
      </Card>
    </main>
  );
}
