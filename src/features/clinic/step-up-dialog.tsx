"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";

import { SecondFactorForm } from "./second-factor-parts";
import { staffQuery } from "./staff-snapshot-provider";

type RunWithStepUp = <T>(action: () => Promise<T>) => Promise<T>;

const StepUpContext = createContext<{ runWithStepUp: RunWithStepUp } | null>(null);

/** Runs the action as it is when no provider is mounted (a test, a preview), so screens never depend on it. */
const passThrough: RunWithStepUp = (action) => action();

export function useStepUp(): { runWithStepUp: RunWithStepUp } {
  return useContext(StepUpContext) ?? { runWithStepUp: passThrough };
}

function errorCode(cause: unknown): string | null {
  if (typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string") return cause.code;
  return null;
}

interface Pending {
  kind: "step_up" | "required";
  hasAuthenticator: boolean;
  hasPasskey: boolean;
  /** Called with true once a code was accepted, or false when the person gave up. */
  settle: (verified: boolean) => void;
}

/**
 * Sensitive actions need a second-factor check from the last 10 minutes. A screen wraps its request in
 * `runWithStepUp`; if the server answers `step_up_required`, this asks for a code and then tries the request once more.
 */
export function StepUpProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const ask = useCallback(async (kind: Pending["kind"]): Promise<boolean> => {
    let hasAuthenticator = true;
    let hasPasskey = false;
    if (kind === "step_up") {
      try {
        const summary = await staffQuery<{ twoFactorEnabled: boolean; passkeyCount: number }>("/api/staff/security");
        hasAuthenticator = summary.twoFactorEnabled;
        hasPasskey = summary.passkeyCount > 0;
      } catch {
        // Fall back to asking for an authenticator code.
      }
    }
    return new Promise<boolean>((resolve) => {
      setPending({ kind, hasAuthenticator, hasPasskey, settle: resolve });
    });
  }, []);

  const runWithStepUp = useCallback<RunWithStepUp>((action) => {
    // One prompt at a time: a second action waits until the first one is answered.
    const run = queue.current.catch(() => undefined).then(async () => {
      try {
        return await action();
      } catch (cause: unknown) {
        const code = errorCode(cause);
        if (code !== "step_up_required" && code !== "second_factor_required") throw cause;
        const verified = await ask(code === "second_factor_required" ? "required" : "step_up");
        if (!verified || code === "second_factor_required") throw cause;
        return await action();
      }
    });
    queue.current = run;
    return run;
  }, [ask]);

  const value = useMemo(() => ({ runWithStepUp }), [runWithStepUp]);

  function close(verified: boolean) {
    const current = pending;
    setPending(null);
    current?.settle(verified);
  }

  return (
    <StepUpContext.Provider value={value}>
      {children}
      <Dialog open={pending !== null} onOpenChange={(open) => { if (!open) close(false); }}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{pending?.kind === "required" ? "Set up a second factor" : "Confirm it's you"}</DialogTitle>
            <DialogDescription>
              {pending?.kind === "required"
                ? "Your role needs a second factor before you can do this."
                : "This change needs a fresh code. Enter one to go on."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="pb-6">
            {pending?.kind === "required" ? (
              <Button size="lg" className="w-full" render={<Link href="/security/second-factor" />}>Set up a second factor</Button>
            ) : pending ? (
              <SecondFactorForm hasAuthenticator={pending.hasAuthenticator} hasPasskey={pending.hasPasskey} onVerified={() => close(true)} />
            ) : null}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </StepUpContext.Provider>
  );
}
