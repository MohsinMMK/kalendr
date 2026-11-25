"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Fingerprint, Smartphone } from "lucide-react";

import { Button } from "@/components/ui/button";

import { AuthenticatorEnrol, BackupCodesView, PasskeyAddButton } from "./second-factor-parts";
import { StaffSignOut } from "./staff-auth-controls";

type Step = { name: "choose" } | { name: "authenticator" } | { name: "codes"; codes: string[] };

/** Forced enrolment: choose a way, set it up, and keep the backup codes. */
export function EnrolSecondFactor({ passwordChosen }: { passwordChosen: boolean }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>({ name: "choose" });
  const number = step.name === "choose" ? 1 : step.name === "authenticator" ? 2 : 3;

  function done() {
    router.replace("/dashboard");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-center text-xs font-medium text-muted-foreground" aria-live="polite">
        Step {number} of 3
      </p>
      {step.name === "choose" ? (
        <div className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">How do you want to confirm it&apos;s you?</h2>
          <Button type="button" variant="outline" size="lg" aria-label="Authenticator app" className="h-auto min-h-16 w-full justify-start gap-3 py-3 text-start" onClick={() => setStep({ name: "authenticator" })}>
            <Smartphone aria-hidden="true" className="size-5" />
            <span className="flex flex-col">
              <span className="font-medium">Authenticator app</span>
              <span className="text-xs font-normal text-muted-foreground">A 6-digit code from an app on your phone.</span>
            </span>
          </Button>
          <div className="flex flex-col gap-1">
            <div className="flex items-start gap-3 rounded-lg border p-3">
              <Fingerprint aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
              <div className="flex flex-1 flex-col gap-2">
                <span className="flex flex-col">
                  <span className="text-sm font-medium">Passkey</span>
                  <span className="text-xs text-muted-foreground">Your fingerprint, face or screen lock.</span>
                </span>
                <PasskeyAddButton variant="outline" label="Add a passkey" onAdded={done} />
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {step.name === "authenticator" ? (
        <>
          <h2 className="text-base font-semibold">Set up your authenticator app</h2>
          <AuthenticatorEnrol passwordChosen={passwordChosen} onEnrolled={(codes) => setStep({ name: "codes", codes })} />
          <Button type="button" variant="ghost" size="sm" className="self-center" onClick={() => setStep({ name: "choose" })}>Choose another way</Button>
        </>
      ) : null}
      {step.name === "codes" ? (
        <>
          <h2 className="text-base font-semibold">Save your backup codes</h2>
          <BackupCodesView codes={step.codes} onContinue={done} />
        </>
      ) : null}
      <StaffSignOut />
    </div>
  );
}
