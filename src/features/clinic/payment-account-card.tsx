"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { CreditCard, FlaskConical, MoreHorizontal, Unplug } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";

import { TextField } from "@/components/form-fields";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { toastManager } from "@/components/ui/toast";
import { paymentAccountInputSchema, type PaymentAccountView, type PaymentSettingsView } from "@/lib/payments";
import { secondFactorErrorCodes } from "@/lib/security-policy";

import { paymentKeys } from "./queries/payments";
import { StaffApiError, staffMutation } from "./queries/http";
import { CopyField, checkedAt, maskKeyId, stepUpDeclined } from "./payment-parts";
import { useStepUp } from "./step-up-dialog";

const razorpaySchema = paymentAccountInputSchema.options[0];
type RazorpayValues = z.input<typeof razorpaySchema>;

const providerNames = { razorpay: "Razorpay", stripe: "Stripe", fake: "Built-in test account" } as const;

function isStepUpDeclined(cause: unknown): boolean {
  return cause instanceof StaffApiError && (cause.code === secondFactorErrorCodes.stepUp || cause.code === secondFactorErrorCodes.pending);
}

/** Settings, Payments: connect, look at or disconnect the business's own payment account. Secrets are never shown again. */
export function PaymentAccountCard({ settings }: { settings: PaymentSettingsView }) {
  const account = settings.account;
  return (
    <Frame>
      <FrameHeader>
        <FrameTitle>Payment account</FrameTitle>
        <FrameDescription>Online payments go straight to your own account. Kalendr never holds the money.</FrameDescription>
      </FrameHeader>
      <FramePanel className="flex flex-col gap-4">
        {account ? <ConnectedAccount account={account} /> : <ConnectAccount providers={settings.providers} />}
      </FramePanel>
    </Frame>
  );
}

function ConnectAccount({ providers }: { providers: PaymentSettingsView["providers"] }) {
  const queryClient = useQueryClient();
  const { runWithStepUp } = useStepUp();
  const [message, setMessage] = useState("");
  const [testing, setTesting] = useState(false);
  const form = useForm<RazorpayValues>({
    resolver: zodResolver(razorpaySchema),
    defaultValues: { provider: "razorpay", keyId: "", keySecret: "", webhookSecret: "" },
  });
  const { register, handleSubmit, setError, reset, formState: { errors, isSubmitting } } = form;

  async function connected(account: PaymentAccountView) {
    queryClient.setQueryData<PaymentSettingsView>(paymentKeys.settings(), (current) => (current ? { ...current, account } : current));
    await queryClient.invalidateQueries({ queryKey: paymentKeys.settings() });
    toastManager.add({ title: `${providerNames[account.provider]} connected.`, type: "success" });
  }

  const submit = handleSubmit(async (values) => {
    setMessage("");
    try {
      const account = await runWithStepUp(() => staffMutation<PaymentAccountView>("/api/staff/payment-account", "PUT", values));
      // The secrets leave the form as soon as they are sent.
      reset({ provider: "razorpay", keyId: "", keySecret: "", webhookSecret: "" });
      await connected(account);
    } catch (cause: unknown) {
      if (isStepUpDeclined(cause)) { setMessage(stepUpDeclined); return; }
      if (cause instanceof StaffApiError) {
        const known = Object.entries(cause.fieldErrors).filter(([path]) => path === "keyId" || path === "keySecret" || path === "webhookSecret");
        for (const [path, messages] of known) setError(path as "keyId" | "keySecret" | "webhookSecret", { type: "server", message: messages[0] ?? "Check this." });
        if (!known.length) setMessage(cause.message);
        return;
      }
      setMessage(cause instanceof Error ? cause.message : "The account could not be connected. Try again.");
    }
  });

  async function connectTestAccount() {
    setTesting(true);
    setMessage("");
    try {
      const account = await runWithStepUp(() => staffMutation<PaymentAccountView>("/api/staff/payment-account", "PUT", { provider: "fake" }));
      await connected(account);
    } catch (cause: unknown) {
      setMessage(isStepUpDeclined(cause) ? stepUpDeclined : cause instanceof Error ? cause.message : "The test account could not be set up. Try again.");
    } finally {
      setTesting(false);
    }
  }

  return (
    <>
      <Alert variant="info">
        <CreditCard aria-hidden="true" />
        <AlertTitle>No payment account yet</AlertTitle>
        <AlertDescription>Connect one to take deposits or full payment when people book. Until then, bookings stay free.</AlertDescription>
      </Alert>
      {message ? <Alert variant="error"><AlertDescription>{message}</AlertDescription></Alert> : null}
      {providers.razorpay ? (
        <form noValidate className="flex flex-col gap-4" aria-label="Connect Razorpay" onSubmit={(event) => void submit(event)}>
          <h4 className="font-medium text-sm">Razorpay</h4>
          <TextField label="Key id" hint="Starts with rzp_test_ or rzp_live_. Find it in your Razorpay dashboard under API keys." autoComplete="off" spellCheck={false} error={errors.keyId?.message} {...register("keyId")} />
          <TextField label="Key secret" type="password" autoComplete="off" hint="Stored safely and never shown again." error={errors.keySecret?.message} {...register("keySecret")} />
          <TextField label="Webhook secret" type="password" autoComplete="off" hint="The secret you set for the webhook in the Razorpay dashboard." error={errors.webhookSecret?.message} {...register("webhookSecret")} />
          <div className="flex items-center justify-end gap-2">
            <Button type="submit" size="lg" className="min-h-11" loading={isSubmitting}>Connect Razorpay</Button>
          </div>
        </form>
      ) : null}
      {providers.stripe ? (
        <Button variant="outline" size="lg" className="min-h-11 self-start" render={<a href="/api/staff/payment-account/stripe/connect" />}>Connect with Stripe</Button>
      ) : null}
      {providers.fake ? (
        <div className="flex flex-col gap-2 rounded-lg border bg-muted/50 p-3">
          <p className="text-sm"><span className="font-medium">Just trying it out?</span> The built-in test account runs in practice mode. No real money moves.</p>
          <Button variant="outline" size="lg" className="min-h-11 self-start" loading={testing} onClick={() => void connectTestAccount()}><FlaskConical aria-hidden="true" />Use the built-in test account</Button>
        </div>
      ) : null}
      {!providers.razorpay && !providers.stripe && !providers.fake ? (
        <Alert variant="warning"><AlertDescription>No way of connecting an account is switched on here yet. Ask whoever set up Kalendr to turn one on.</AlertDescription></Alert>
      ) : null}
    </>
  );
}

function ConnectedAccount({ account }: { account: PaymentAccountView }) {
  const queryClient = useQueryClient();
  const { runWithStepUp } = useStepUp();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const test = account.mode === "test";

  async function disconnect() {
    setBusy(true);
    setMessage("");
    try {
      await runWithStepUp(() => staffMutation<unknown>("/api/staff/payment-account", "DELETE", {}));
      setConfirming(false);
      queryClient.setQueryData<PaymentSettingsView>(paymentKeys.settings(), (current) => (current ? { ...current, account: null } : current));
      await queryClient.invalidateQueries({ queryKey: paymentKeys.settings() });
      toastManager.add({ title: "Payment account disconnected.", type: "success" });
    } catch (cause: unknown) {
      setConfirming(false);
      setMessage(isStepUpDeclined(cause) ? stepUpDeclined : cause instanceof Error ? cause.message : "The account could not be disconnected. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <p className="font-medium">{providerNames[account.provider]}</p>
          <Badge variant={test ? "warning" : "success"} size="lg">{test ? "Test" : "Live"}</Badge>
          {account.status === "disabled" ? <Badge variant="error" size="lg">Paused</Badge> : null}
        </div>
        <Menu>
          <MenuTrigger render={<Button variant="outline" size="icon-lg" className="min-h-11 min-w-11 shrink-0" aria-label="More payment account actions" />}><MoreHorizontal aria-hidden="true" /></MenuTrigger>
          <MenuPopup align="end">
            <MenuItem variant="destructive" onClick={() => setConfirming(true)}><Unplug aria-hidden="true" />Disconnect…</MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      <p className="text-muted-foreground text-sm">
        {test ? "No real money moves. Payments in test mode are practice only." : "Real money moves. Customers are charged when they pay."}
      </p>
      {message ? <Alert variant="error"><AlertDescription>{message}</AlertDescription></Alert> : null}
      {account.status === "disabled" ? <Alert variant="warning"><AlertDescription>This account is paused, so bookings are not asking for payment. Check the keys in the provider dashboard, then connect again.</AlertDescription></Alert> : null}
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <div><dt className="text-muted-foreground">{account.provider === "stripe" ? "Account" : "Key"}</dt><dd className="font-medium tabular-nums">{maskKeyId(account.keyId)}</dd></div>
        <div><dt className="text-muted-foreground">Last checked</dt><dd className="font-medium">{checkedAt(account.lastCheckedAt)}</dd></div>
      </dl>
      {account.provider === "razorpay" ? (
        <CopyField label="Webhook address" value={account.webhookUrl} hint="Paste this into the webhook settings of your Razorpay dashboard, and turn on the payment and refund events." />
      ) : null}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect this account?</AlertDialogTitle>
            <AlertDialogDescription>New bookings stop asking for payment. Payments already taken stay in your records, and refunds for them can no longer be sent online.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Keep it connected</AlertDialogClose>
            <Button variant="destructive" loading={busy} onClick={() => void disconnect()}>Disconnect</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
