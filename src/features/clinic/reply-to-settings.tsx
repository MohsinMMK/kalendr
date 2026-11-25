"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, Mail, TriangleAlert } from "lucide-react";
import { type FormEvent, useState } from "react";

import { TextField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { Skeleton } from "@/components/ui/skeleton";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import type { ReplyToView } from "@/lib/reply-to";

import { useCatalogLookups } from "./clinic-catalog";
import { staffMutation, staffQuery } from "./queries/http";

const key = ["staff", "reply-to"] as const;

/**
 * Where a customer's reply to a confirmation email goes (feature 50). A new address is only used after a one-time code
 * sent to it is entered, so replies can never reach an address nobody owns.
 */
export function ReplyToSettings() {
  const t = useTerms();
  const database = useCatalogLookups().database;
  const client = useQueryClient();
  const current = useQuery({ queryKey: key, queryFn: ({ signal }) => staffQuery<ReplyToView>("/api/staff/reply-to", signal), enabled: database });
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState("");
  const send = useMutation({
    mutationFn: () => staffMutation<{ sent: true }>("/api/staff/reply-to", "POST", { action: "send", email: email.trim() }),
    onSuccess: () => { setError(""); setSentTo(email.trim()); setCode(""); toastManager.add({ title: "Code sent. It works for 10 minutes.", type: "success" }); },
    onError: (cause: unknown) => setError(cause instanceof Error ? cause.message : "The code could not be sent. Try again."),
  });
  const verify = useMutation({
    mutationFn: () => staffMutation<ReplyToView>("/api/staff/reply-to", "POST", { action: "verify", email: (sentTo ?? email).trim(), code: code.trim() }),
    onSuccess: async () => { setError(""); setSentTo(null); setEmail(""); setCode(""); toastManager.add({ title: "Done. Replies now reach this address.", type: "success" }); await client.invalidateQueries({ queryKey: key }); },
    onError: (cause: unknown) => setError(cause instanceof Error ? cause.message : "That code could not be checked."),
  });
  const remove = useMutation({
    mutationFn: () => staffMutation<ReplyToView>("/api/staff/reply-to", "DELETE", {}),
    onSuccess: async () => { toastManager.add({ title: "Removed. Replies go to your business email.", type: "success" }); await client.invalidateQueries({ queryKey: key }); },
    onError: (cause: unknown) => setError(cause instanceof Error ? cause.message : "It could not be removed."),
  });
  if (!database) return null;

  function submitEmail(event: FormEvent) { event.preventDefault(); setError(""); if (!/^\S+@\S+\.\S+$/.test(email.trim())) { setError("Enter a full email address."); return; } send.mutate(); }
  function submitCode(event: FormEvent) { event.preventDefault(); setError(""); if (!/^\d{6}$/.test(code.trim())) { setError("Enter the 6-digit code."); return; } verify.mutate(); }

  return (
    <Frame>
      <FrameHeader>
        <FrameTitle>Reply-to address</FrameTitle>
        <FrameDescription>When a {t.customer} replies to a confirmation or reminder email, the reply reaches this address.</FrameDescription>
      </FrameHeader>
      <FramePanel className="flex flex-col gap-4">
        {error ? <Alert variant="error"><TriangleAlert aria-hidden="true" /><AlertDescription>{error}</AlertDescription></Alert> : null}
        {current.isPending ? <Skeleton role="status" aria-label="Loading the reply-to address" className="h-10 w-full" /> : null}
        {current.isError ? <Alert variant="error"><TriangleAlert aria-hidden="true" /><AlertDescription className="flex flex-wrap items-center gap-2">It could not be loaded.<Button size="sm" variant="outline" onClick={() => void current.refetch()}>Try again</Button></AlertDescription></Alert> : null}
        {current.data ? (
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <Mail aria-hidden="true" className="size-4 text-muted-foreground" />
            {current.data.email ? <><span className="font-medium">{current.data.email}</span><Badge variant="success"><CircleCheck aria-hidden="true" /> Verified</Badge><Button size="sm" variant="ghost" loading={remove.isPending} onClick={() => remove.mutate()}>Remove</Button></> : <span className="text-muted-foreground">Not set. Replies go to your business email.</span>}
          </p>
        ) : null}
        {sentTo ? (
          <form onSubmit={submitCode} noValidate className="flex flex-col gap-3" aria-label="Confirm the address">
            <p className="text-sm">We sent a 6-digit code to <span className="font-medium">{sentTo}</span>. Enter it to start using this address.</p>
            <TextField label="Code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} fieldClassName="sm:w-40" />
            <div className="flex gap-2">
              <Button type="submit" loading={verify.isPending}>Confirm</Button>
              <Button type="button" variant="ghost" onClick={() => { setSentTo(null); setCode(""); setError(""); }}>Use a different address</Button>
            </div>
          </form>
        ) : (
          <form onSubmit={submitEmail} noValidate className="flex flex-col gap-3 sm:flex-row sm:items-end" aria-label="Set the reply-to address">
            <TextField label={current.data?.email ? "Change to" : "Email address"} type="email" autoComplete="off" placeholder="hello@yourbusiness.com" value={email} onChange={(event) => setEmail(event.target.value)} fieldClassName="sm:flex-1" />
            <Button type="submit" loading={send.isPending} className="sm:mb-px">Send a code</Button>
          </form>
        )}
      </FramePanel>
    </Frame>
  );
}
