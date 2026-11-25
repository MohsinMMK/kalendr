"use client";

import { Check, Lock, ShieldAlert, TriangleAlert } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardFooter, CardHeader, CardPanel, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import type { ConsentView } from "@/lib/oauth";

import { StaffApiError, staffMutation, staffQuery } from "@/features/clinic/queries/http";

/**
 * The approval screen for OAuth (feature 55). It shows who is asking, exactly what they would be able to do, and the
 * address the person is sent to afterwards. Nothing is granted until the person presses Allow.
 */
export function ConsentScreen({ businessName, personName }: { businessName: string; personName: string }) {
  const params = useSearchParams();
  const search = params.toString();
  // This page has no staff frame around it, so it talks to the API directly instead of through the shared query client.
  const [state, setState] = useState<{ phase: "loading" } | { phase: "error"; message: string } | { phase: "ready"; consent: ConsentView }>({ phase: "loading" });
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    staffQuery<{ consent: ConsentView }>(`/api/staff/oauth/authorize?${search}`, controller.signal).then(
      (data) => setState({ phase: "ready", consent: data.consent }),
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        setState({ phase: "error", message: cause instanceof StaffApiError && cause.message ? cause.message : "Go back to the app and start again." });
      },
    );
    return () => controller.abort();
  }, [search]);

  async function decide(approve: boolean) {
    setPending(true);
    setFailure("");
    try {
      const { redirectTo } = await staffMutation<{ redirectTo: string }>("/api/staff/oauth/authorize", "POST", { query: Object.fromEntries(params.entries()), approve });
      setDone(true);
      window.location.assign(redirectTo);
    } catch (cause: unknown) {
      setFailure(cause instanceof StaffApiError && cause.message ? cause.message : "Something went wrong. Try again.");
      setPending(false);
    }
  }

  const consent = state.phase === "ready" ? state.consent : null;
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-4 px-4 py-8">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2" render={<h1 />}><Lock aria-hidden="true" className="size-4" /> Connect an app</CardTitle>
          <CardDescription>You are signed in as {personName} at {businessName}.</CardDescription>
        </CardHeader>
        <CardPanel className="flex flex-col gap-4">
          {state.phase === "loading" ? <div role="status" aria-label="Loading request" className="flex flex-col gap-2"><Skeleton className="h-6 w-2/3" /><Skeleton className="h-20 w-full" /></div> : null}
          {state.phase === "error" ? (
            <Alert variant="error">
              <ShieldAlert aria-hidden="true" />
              <AlertTitle>This request can&apos;t be approved</AlertTitle>
              <AlertDescription>{state.message}</AlertDescription>
            </Alert>
          ) : null}
          {consent ? (
            <>
              <p className="text-sm"><strong>{consent.clientName}</strong> wants to use your Kalendr account{consent.clientDescription ? `. ${consent.clientDescription}` : "."}</p>
              <section aria-labelledby="may-title" className="flex flex-col gap-2">
                <h2 id="may-title" className="font-medium text-sm">It will be able to</h2>
                <ul className="flex flex-col divide-y rounded-lg border">
                  {consent.scopes.map((scope) => (
                    <li key={scope.scope} className="flex items-start gap-3 px-3 py-2.5">
                      <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                      <span className="flex flex-col gap-0.5"><span className="font-medium text-sm">{scope.label}</span><span className="text-muted-foreground text-xs">{scope.description}</span></span>
                    </li>
                  ))}
                </ul>
              </section>
              <p className="text-muted-foreground text-xs">After you choose, you go back to <strong>{consent.redirectHost}</strong>. You can disconnect it any time under Settings, Apps, Signed in.</p>
              {consent.scopes.some((scope) => scope.writes) ? (
                <Alert variant="warning"><TriangleAlert aria-hidden="true" /><AlertDescription>This app can make changes, not only read.</AlertDescription></Alert>
              ) : null}
              {failure ? <Alert variant="error" role="alert"><AlertDescription>{failure}</AlertDescription></Alert> : null}
            </>
          ) : null}
        </CardPanel>
        {consent ? (
          <CardFooter className="flex-row justify-end gap-2">
            <Button type="button" variant="ghost" size="lg" disabled={pending || done} onClick={() => void decide(false)}>Cancel</Button>
            <Button type="button" size="lg" disabled={pending || done} onClick={() => void decide(true)}>{pending || done ? <Spinner aria-hidden="true" /> : null}Allow</Button>
          </CardFooter>
        ) : null}
      </Card>
    </main>
  );
}
