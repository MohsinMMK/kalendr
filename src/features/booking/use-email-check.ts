"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { EMAIL_CODE_MINUTES } from "@/lib/booking-intake";

/** How long the customer waits before asking for another code. */
export const RESEND_SECONDS = 30;

type Phase = "idle" | "sending" | "sent" | "verifying" | "verified" | "not_required";

export interface EmailCheckMessage {
  tone: "info" | "error";
  text: string;
}

interface State {
  phase: Phase;
  /** The address (trimmed, lower case) the code went to. Anything typed after that is a different address. */
  email: string;
  proof?: string;
  expiresAt?: number;
  resendAt?: number;
  locked: boolean;
  message?: EmailCheckMessage;
}

const idle: State = { phase: "idle", email: "", locked: false };
const normalise = (email: string) => email.trim().toLowerCase();

interface ApiError {
  code: string;
  message: string;
}

async function call(body: Record<string, unknown>): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: ApiError | null; network: boolean }> {
  try {
    const response = await fetch("/api/public/email-check", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload: unknown = await response.json().catch(() => undefined);
    if (response.ok) {
      const data = payload && typeof payload === "object" ? (payload as { data?: unknown }).data : undefined;
      return { ok: true, data: data && typeof data === "object" ? (data as Record<string, unknown>) : {} };
    }
    const error = payload && typeof payload === "object" ? (payload as { error?: Partial<ApiError> }).error : undefined;
    return { ok: false, network: false, error: error && typeof error.code === "string" ? { code: error.code, message: typeof error.message === "string" ? error.message : "" } : null };
  } catch {
    return { ok: false, error: null, network: true };
  }
}

/**
 * The email check on the details screen: send a 6-digit code, take it back, and hold the one-use proof that goes with
 * the booking. The proof counts only for the address the code went to, so changing the email undoes it.
 */
export function useEmailCheck({ clinicSlug, serviceId, email }: { clinicSlug: string; serviceId: string; email: string }) {
  const [state, setState] = useState<State>(idle);
  const [now, setNow] = useState(() => Date.now());
  const current = normalise(email);
  const busy = useRef(false);

  // A different address starts over.
  if (state !== idle && state.email !== current) setState(idle);

  // The resend countdown ticks only while there is something to count.
  const counting = state.resendAt !== undefined && state.resendAt > now;
  useEffect(() => {
    if (!counting) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [counting]);

  const sameAddress = state.email === current;
  const send = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    const target = current;
    setState({ phase: "sending", email: target, locked: false });
    const result = await call({ action: "send", clinicSlug, serviceId, email: target });
    busy.current = false;
    if (result.ok) {
      const minutes = typeof result.data.expiresInMinutes === "number" ? result.data.expiresInMinutes : EMAIL_CODE_MINUTES;
      const at = Date.now();
      setNow(at);
      setState({
        phase: "sent",
        email: target,
        locked: false,
        expiresAt: at + minutes * 60_000,
        resendAt: at + RESEND_SECONDS * 1000,
        message: { tone: "info", text: `We sent a 6-digit code to ${target}. It works for ${minutes} minutes.` },
      });
      return;
    }
    const code = result.error?.code;
    if (code === "email_check_not_required") {
      setState({ phase: "not_required", email: target, locked: false });
      return;
    }
    const text = result.network
      ? "We could not reach the server. Check your connection and try again."
      : code === "too_many_codes"
        ? "Too many codes were sent to this address. Wait an hour, then ask for a new one."
        : code === "rate_limited"
          ? "Too many tries. Wait a minute, then ask for a new code."
          : result.error?.message || "We could not send the code. Please try again.";
    setState({ phase: "idle", email: target, locked: false, message: { tone: "error", text } });
  }, [clinicSlug, current, serviceId]);

  const verify = useCallback(async (code: string): Promise<boolean> => {
    if (busy.current || !/^\d{6}$/.test(code)) return false;
    busy.current = true;
    const target = current;
    const sentState = state;
    setState((previous) => ({ ...previous, phase: "verifying", message: undefined }));
    const result = await call({ action: "verify", clinicSlug, email: target, code });
    busy.current = false;
    if (result.ok && typeof result.data.proof === "string") {
      setState({ phase: "verified", email: target, locked: false, proof: result.data.proof });
      return true;
    }
    const failure = result.ok ? "invalid_code" : result.error?.code;
    const expired = sentState.expiresAt !== undefined && Date.now() > sentState.expiresAt;
    setState((previous) => {
      if (previous.email !== target) return previous;
      if (failure === "too_many_attempts") {
        return { ...previous, phase: "sent", locked: true, message: { tone: "error", text: "Too many wrong codes. Ask for a new code." } };
      }
      const text = result.ok || failure === "invalid_code"
        ? expired
          ? "That code has expired. Ask for a new code."
          : "That code is not right. Check the email and try again."
        : result.ok === false && result.network
          ? "We could not reach the server. Check your connection and try again."
          : failure === "rate_limited"
            ? "Too many tries. Wait a minute, then try again."
            : result.ok === false && result.error?.message
              ? result.error.message
              : "We could not check the code. Please try again.";
      return { ...previous, phase: "sent", message: { tone: "error", text } };
    });
    return false;
  }, [clinicSlug, current, state]);

  /** Starts over, for example when the booking says the proof no longer counts. */
  const reset = useCallback((message?: string) => {
    setState(message ? { ...idle, email: current, message: { tone: "error", text: message } } : idle);
  }, [current]);

  const verified = state.phase === "verified" && sameAddress;
  return {
    phase: sameAddress ? state.phase : "idle",
    /** The one-use proof for the booking, only while it matches the address in the form. */
    proof: verified ? state.proof : undefined,
    verified,
    notRequired: state.phase === "not_required" && sameAddress,
    locked: sameAddress && state.locked,
    message: sameAddress ? state.message : undefined,
    secondsToResend: sameAddress && !state.locked && state.resendAt ? Math.max(0, Math.ceil((state.resendAt - now) / 1000)) : 0,
    send,
    verify,
    reset,
  };
}

export type EmailCheck = ReturnType<typeof useEmailCheck>;
