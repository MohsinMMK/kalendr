"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Field, FieldDescription, FieldError } from "@/components/ui/field";
import { challengeErrorCodes, turnstileTokenHeader } from "@/lib/bot-check";

/**
 * Cloudflare Turnstile, shown only after the server asks for it (a risky second attempt with
 * no signed-in session). Most people never see it. The token goes in a request header and
 * works once, so the widget resets after every send.
 */

interface TurnstileRenderOptions {
  sitekey: string;
  action?: string;
  theme?: "auto" | "light" | "dark";
  size?: "normal" | "flexible" | "compact";
  callback?: (token: string) => void;
  "expired-callback"?: () => void;
  "error-callback"?: () => void;
}

interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileRenderOptions): string;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const scriptUrl = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let scriptLoading: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  scriptLoading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = scriptUrl;
    script.async = true;
    // The page's CSP trusts scripts added by its own nonced scripts ('strict-dynamic');
    // the nonce is copied as well for browsers that only check nonces.
    const nonce = document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce;
    if (nonce) script.nonce = nonce;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile did not start")));
    script.onerror = () => {
      scriptLoading = null;
      script.remove();
      reject(new Error("Turnstile could not load"));
    };
    document.head.append(script);
  });
  return scriptLoading;
}

export interface TurnstileFieldProps {
  siteKey: string;
  /** Called with a fresh token, or null when it expires or the widget fails. */
  onToken: (token: string | null) => void;
  error?: string;
  /** Shown in Cloudflare's analytics, such as "booking" or "sign_up". */
  action?: string;
}

export function TurnstileField({ siteKey, onToken, error, action }: TurnstileFieldProps) {
  const container = useRef<HTMLDivElement>(null);
  const tokenHandler = useRef(onToken);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    tokenHandler.current = onToken;
  }, [onToken]);

  useEffect(() => {
    let widgetId: string | undefined;
    let cancelled = false;
    loadTurnstile()
      .then((turnstile) => {
        if (cancelled || !container.current) return;
        widgetId = turnstile.render(container.current, {
          sitekey: siteKey,
          action,
          theme: "auto",
          size: "flexible",
          callback: (token) => tokenHandler.current(token),
          "expired-callback": () => tokenHandler.current(null),
          "error-callback": () => tokenHandler.current(null),
        });
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
      if (widgetId) window.turnstile?.remove(widgetId);
    };
  }, [siteKey, action]);

  return (
    <Field invalid={Boolean(error) || loadFailed} className="w-full" data-testid="turnstile-field">
      <span className="font-medium text-base/4.5 text-foreground sm:text-sm/4">Quick check</span>
      <FieldDescription>Confirm you are a person to continue.</FieldDescription>
      <div ref={container} className="min-h-16.25 w-full" />
      {loadFailed ? (
        <FieldError match>The check could not load. Check your connection, then reload the page.</FieldError>
      ) : error ? (
        <FieldError match>{error}</FieldError>
      ) : null}
    </Field>
  );
}

/**
 * State for one form's bot check. Send `headers()` with the request, then pass the response's
 * error code to `afterResponse`: it shows the check when the server asked for it and resets
 * a used token.
 */
export function useBotCheck() {
  const [shown, setShown] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [round, setRound] = useState(0);

  const onToken = useCallback((next: string | null) => {
    setToken(next);
    if (next) setError("");
  }, []);

  const headers = useCallback((): Record<string, string> => (token ? { [turnstileTokenHeader]: token } : {}), [token]);

  /** Returns true when the server wants the check (so the form shows its field error, not a page error). */
  const afterResponse = useCallback((code: string | undefined, message?: string): boolean => {
    if (token) {
      setToken(null);
      setRound((value) => value + 1);
    }
    if (code && challengeErrorCodes.includes(code)) {
      setShown(true);
      setError(message || "Complete the check to continue.");
      return true;
    }
    setError("");
    return false;
  }, [token]);

  return { shown, token, error, round, onToken, headers, afterResponse };
}
