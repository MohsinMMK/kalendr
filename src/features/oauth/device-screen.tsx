"use client";

import { Check, Lock, TriangleAlert } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import type { ConsentView } from "@/lib/oauth";

import { StaffApiError, staffMutation } from "@/features/clinic/queries/http";

type Step = { name: "enter" } | { name: "review"; consent: ConsentView } | { name: "done"; approved: boolean };

/**
 * Where a person types the code the browser extension shows (feature 57). It looks the code up, shows what the extension
 * would be allowed to do, and only a press of Allow connects it.
 */
export function DeviceScreen({ businessName, personName }: { businessName: string; personName: string }) {
  const [code, setCode] = useState(useSearchParams().get("code") ?? "");
  const [step, setStep] = useState<Step>({ name: "enter" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function send(body: { code: string; approve?: boolean }) {
    setPending(true);
    setError("");
    try {
      return await staffMutation<{ consent: ConsentView } | { approved: boolean }>("/api/staff/oauth/device", "POST", body);
    } catch (cause: unknown) {
      setError(cause instanceof StaffApiError && cause.message ? cause.message : "Something went wrong. Try again.");
      return null;
    } finally {
      setPending(false);
    }
  }

  async function lookUp(event: { preventDefault(): void }) {
    event.preventDefault();
    const result = await send({ code });
    if (result && "consent" in result) setStep({ name: "review", consent: result.consent });
  }

  async function decide(approve: boolean) {
    const result = await send({ code, approve });
    if (result && "approved" in result) setStep({ name: "done", approved: result.approved });
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-4 px-4 py-8">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2" render={<h1 />}><Lock aria-hidden="true" className="size-4" /> Connect the browser extension</CardTitle>
          <CardDescription>You are signed in as {personName} at {businessName}.</CardDescription>
        </CardHeader>
        {step.name === "enter" ? (
          <form onSubmit={(event) => void lookUp(event)} noValidate>
            <CardPanel className="flex flex-col gap-4">
              <Field invalid={Boolean(error)}>
                <FieldLabel>Code from the extension</FieldLabel>
                <Input size="lg" autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="ABCD-EFGH" className="font-mono uppercase tracking-widest"
                  value={code} onChange={(event) => setCode(event.target.value)} />
                {error ? <FieldError match>{error}</FieldError> : <FieldDescription>Open the extension in your browser and choose Connect. It shows eight letters.</FieldDescription>}
              </Field>
            </CardPanel>
            <CardFooter className="justify-end"><Button type="submit" size="lg" disabled={pending || code.trim() === ""}>{pending ? <Spinner aria-hidden="true" /> : null}Continue</Button></CardFooter>
          </form>
        ) : null}
        {step.name === "review" ? (
          <>
            <CardPanel className="flex flex-col gap-4">
              <p className="text-sm"><strong>{step.consent.clientName}</strong> wants to use your Kalendr account. {step.consent.clientDescription}</p>
              <section aria-labelledby="may-title" className="flex flex-col gap-2">
                <h2 id="may-title" className="font-medium text-sm">It will be able to</h2>
                <ul className="flex flex-col divide-y rounded-lg border">
                  {step.consent.scopes.map((scope) => (
                    <li key={scope.scope} className="flex items-start gap-3 px-3 py-2.5">
                      <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                      <span className="flex flex-col gap-0.5"><span className="font-medium text-sm">{scope.label}</span><span className="text-muted-foreground text-xs">{scope.description}</span></span>
                    </li>
                  ))}
                </ul>
              </section>
              <Alert variant="warning"><TriangleAlert aria-hidden="true" /><AlertTitle>Only continue if you started this</AlertTitle><AlertDescription>The code <span className="font-mono">{code.toUpperCase()}</span> must be the one in your own extension. You can disconnect it any time under Settings, Apps, Signed in.</AlertDescription></Alert>
              {error ? <Alert variant="error" role="alert"><AlertDescription>{error}</AlertDescription></Alert> : null}
            </CardPanel>
            <CardFooter className="justify-end gap-2">
              <Button type="button" variant="ghost" size="lg" disabled={pending} onClick={() => void decide(false)}>Cancel</Button>
              <Button type="button" size="lg" disabled={pending} onClick={() => void decide(true)}>{pending ? <Spinner aria-hidden="true" /> : null}Allow</Button>
            </CardFooter>
          </>
        ) : null}
        {step.name === "done" ? (
          <CardPanel role="status" className="flex flex-col gap-2">
            <p className="font-medium">{step.approved ? "Connected" : "Not connected"}</p>
            <p className="text-muted-foreground text-sm">{step.approved ? "Go back to the extension. It finishes by itself in a few seconds. You can close this page." : "Nothing was shared. You can close this page."}</p>
          </CardPanel>
        ) : null}
      </Card>
    </main>
  );
}
