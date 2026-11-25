"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, EllipsisVertical, Fingerprint, KeyRound, Laptop, Lock, ShieldCheck, Smartphone } from "lucide-react";

import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { RichMenu, RichMenuContent, RichMenuItem, RichMenuTrigger } from "@/components/rich-menu";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { toastManager } from "@/components/ui/toast";
import { authClient } from "@/lib/auth-client";
import { deviceLabel, maskedAddress } from "@/lib/device-label";
import { useTerms } from "@/features/terms/business-profile-context";

import { AuthenticatorEnrol, authFailureText, BackupCodesView, PasskeyAddButton } from "./second-factor-parts";
import { useStaffAccess } from "./staff-access";
import { staffMutation, staffQuery } from "./staff-snapshot-provider";
import { useStepUp } from "./step-up-dialog";

interface SecuritySummary {
  twoFactorEnabled: boolean;
  passkeyCount: number;
  passwordChosen: boolean;
  secondFactorRequired: boolean;
  policy: { requireSecondFactorForAll: boolean };
  recentlyVerified: boolean;
}

interface PasskeyRow {
  id: string;
  name: string;
  createdAt: string;
  deviceType: string;
}

interface DeviceRow {
  id: string;
  token: string;
  label: string;
  place: string | null;
  lastUsed: string;
  current: boolean;
}

const summaryKey = ["staff", "security", "summary"] as const;
const passkeysKey = ["staff", "security", "passkeys"] as const;
const devicesKey = ["staff", "security", "devices"] as const;

function useSummary() {
  return useQuery({ queryKey: summaryKey, queryFn: ({ signal }) => staffQuery<SecuritySummary>("/api/staff/security", signal) });
}

function dateText(value: string, withTime = false): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-IN", withTime ? { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" } : { day: "numeric", month: "short", year: "numeric" });
}

/** "Just now", "5 minutes ago", or the date once it is more than a day old. */
function lastUsedText(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return dateText(value);
}

/** Loading, error-with-retry and the content, so each card behaves the same way. */
function CardState({ loading, error, retry, children }: { loading: boolean; error: boolean; retry: () => void; children: ReactNode }) {
  if (loading) {
    return (
      <div className="flex flex-col gap-2" role="status" aria-label="Loading">
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="h-5 w-2/3" />
      </div>
    );
  }
  if (error) {
    return (
      <Alert variant="error">
        <CircleAlert aria-hidden="true" />
        <AlertDescription>
          <p>This could not be loaded.</p>
          <Button variant="outline" size="sm" className="self-start" onClick={retry}>Try again</Button>
        </AlertDescription>
      </Alert>
    );
  }
  return <>{children}</>;
}

function InlineError({ message }: { message: string }) {
  return message ? (
    <Alert variant="error">
      <CircleAlert aria-hidden="true" />
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  ) : null;
}

/** Asks for the current password (only when this person chose one), then runs the change. */
function PasswordDialog({
  open,
  onOpenChange,
  passwordChosen,
  title,
  description,
  actionLabel,
  destructive = false,
  run,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  passwordChosen: boolean;
  title: string;
  description: string;
  actionLabel: string;
  destructive?: boolean;
  /** Returns an error message, or null when it worked. */
  run: (password: string | undefined) => Promise<string | null>;
}) {
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const failure = await run(passwordChosen ? password : undefined);
      if (failure) setError(failure);
      else setPassword("");
    } catch {
      setError("This is unavailable right now. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!pending) { onOpenChange(next); setError(""); setPassword(""); } }}>
      <DialogPopup>
        <Form className="contents" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            <InlineError message={error} />
            {passwordChosen ? (
              <Field name="password" className="w-full">
                <FieldLabel>Current password</FieldLabel>
                <Input type="password" size="lg" value={password} onChange={(event) => setPassword(event.target.value)} required autoComplete="current-password" />
                <FieldError match="valueMissing">Enter your password.</FieldError>
              </Field>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
            <Button type="submit" variant={destructive ? "destructive" : "default"} loading={pending}>{actionLabel}</Button>
          </DialogFooter>
        </Form>
      </DialogPopup>
    </Dialog>
  );
}

function SecondFactorCard() {
  const client = useQueryClient();
  const summary = useSummary();
  const [enrolOpen, setEnrolOpen] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [action, setAction] = useState<"codes" | "off" | null>(null);
  const data = summary.data;

  async function refresh() {
    await client.invalidateQueries({ queryKey: summaryKey });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle render={<h3 />} className="flex flex-wrap items-center gap-2">
          Second factor
          {data ? <Badge variant={data.twoFactorEnabled ? "success" : "outline"}>{data.twoFactorEnabled ? "On" : "Off"}</Badge> : null}
        </CardTitle>
        <CardDescription>A code from your phone, on top of your password or sign-in link.</CardDescription>
      </CardHeader>
      <CardPanel className="flex flex-col gap-4">
        <CardState loading={summary.isLoading} error={summary.isError} retry={() => void summary.refetch()}>
          {data ? (
            <>
              <div className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">
                  {data.twoFactorEnabled ? "An authenticator app is set up. You can use a backup code if you lose your phone." : "No authenticator app yet."}
                </p>
                {data.secondFactorRequired && data.twoFactorEnabled ? (
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Lock aria-hidden="true" className="size-3.5 shrink-0" />
                    Your role needs a second factor, so you can&apos;t turn it off. You can replace it.
                  </p>
                ) : null}
              </div>
              <div className="flex flex-nowrap items-center gap-2">
                <Button type="button" onClick={() => setEnrolOpen(true)}>
                  <ShieldCheck aria-hidden="true" /> {data.twoFactorEnabled ? "Replace authenticator app" : "Set up authenticator app"}
                </Button>
                {data.twoFactorEnabled ? (
                  <RichMenu>
                    <RichMenuTrigger render={<Button type="button" variant="outline" size="icon" aria-label="More second factor actions" />}>
                      <EllipsisVertical aria-hidden="true" />
                    </RichMenuTrigger>
                    <RichMenuContent>
                      <RichMenuItem onClick={() => setAction("codes")}>Show new backup codes</RichMenuItem>
                      <RichMenuItem destructive disabled={data.secondFactorRequired} onClick={() => setAction("off")}>
                        Turn off{data.secondFactorRequired ? " (needed for your role)" : ""}
                      </RichMenuItem>
                    </RichMenuContent>
                  </RichMenu>
                ) : null}
              </div>
            </>
          ) : null}
        </CardState>
      </CardPanel>

      <Dialog open={enrolOpen} onOpenChange={(open) => { setEnrolOpen(open); if (!open) { setCodes(null); void refresh(); } }}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{codes ? "Save your backup codes" : "Set up an authenticator app"}</DialogTitle>
            <DialogDescription>{codes ? "Keep these somewhere safe." : "Scan a code with an app such as Google Authenticator or 1Password."}</DialogDescription>
          </DialogHeader>
          <DialogPanel className="pb-6">
            {codes ? (
              <BackupCodesView codes={codes} onContinue={() => { setEnrolOpen(false); setCodes(null); void refresh(); }} />
            ) : (
              <AuthenticatorEnrol passwordChosen={data?.passwordChosen ?? true} onEnrolled={(next) => setCodes(next)} />
            )}
          </DialogPanel>
        </DialogPopup>
      </Dialog>

      <PasswordDialog
        open={action === "codes" && codes === null}
        onOpenChange={(open) => { if (!open) setAction(null); }}
        passwordChosen={data?.passwordChosen ?? true}
        title="Show new backup codes"
        description="This replaces your old backup codes. Your old ones stop working."
        actionLabel="Show new codes"
        run={async (password) => {
          const result = await authClient.twoFactor.generateBackupCodes(password ? { password } : {});
          if (result.error || !result.data) return result.error?.code === "INVALID_PASSWORD" ? "That password is not right. Try again." : authFailureText(result.error, "Could not make new codes. Try again.");
          setCodes(result.data.backupCodes);
          return null;
        }}
      />
      <Dialog open={action === "codes" && codes !== null} onOpenChange={(open) => { if (!open) { setAction(null); setCodes(null); } }}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Your new backup codes</DialogTitle>
            <DialogDescription>The old codes no longer work.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="pb-6">
            {codes ? <BackupCodesView codes={codes} onContinue={() => { setAction(null); setCodes(null); }} /> : null}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
      <PasswordDialog
        open={action === "off"}
        onOpenChange={(open) => { if (!open) setAction(null); }}
        passwordChosen={data?.passwordChosen ?? true}
        title="Turn off the second factor?"
        description="You will sign in with only your password or link. Other devices will be signed out."
        actionLabel="Turn off"
        destructive
        run={async (password) => {
          const result = await authClient.twoFactor.disable(password ? { password } : {});
          if (result.error) return result.error.code === "INVALID_PASSWORD" ? "That password is not right. Try again." : authFailureText(result.error, "Could not turn it off. Try again.");
          setAction(null);
          toastManager.add({ title: "Second factor turned off", type: "success" });
          await refresh();
          return null;
        }}
      />
    </Card>
  );
}

function PasskeysCard() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: passkeysKey,
    queryFn: async (): Promise<PasskeyRow[]> => {
      const result = await authClient.passkey.listUserPasskeys();
      if (result.error) throw new Error("passkeys");
      return (result.data ?? []).map((item) => ({ id: item.id, name: item.name ?? "Passkey", createdAt: String(item.createdAt ?? ""), deviceType: String(item.deviceType ?? "") }));
    },
  });
  const [removing, setRemoving] = useState<PasskeyRow | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function refresh() {
    await Promise.all([client.invalidateQueries({ queryKey: passkeysKey }), client.invalidateQueries({ queryKey: summaryKey })]);
  }

  async function remove(item: PasskeyRow) {
    setPending(true);
    setError("");
    try {
      const result = await authClient.passkey.deletePasskey({ id: item.id });
      if (result.error) {
        setError("The passkey could not be removed. Try again.");
        return;
      }
      client.setQueryData<PasskeyRow[]>(passkeysKey, (rows) => (rows ?? []).filter((row) => row.id !== item.id));
      setRemoving(null);
      toastManager.add({ title: "Passkey removed", type: "success" });
      await refresh();
    } catch {
      setError("This is unavailable right now. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  const rows = query.data ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle render={<h3 />}>Passkeys</CardTitle>
        <CardDescription>Sign in with your fingerprint, face or screen lock. Nothing to type.</CardDescription>
      </CardHeader>
      <CardPanel className="flex flex-col gap-4">
        <InlineError message={error} />
        <CardState loading={query.isLoading} error={query.isError} retry={() => void query.refetch()}>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No passkeys yet. Add one to sign in faster on this device.</p>
          ) : (
            <ul className="flex flex-col divide-y rounded-lg border" aria-label="Your passkeys">
              {rows.map((item) => (
                <li key={item.id} className="flex items-center gap-3 p-3">
                  <Fingerprint aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{item.name}</span>
                    <span className="text-xs text-muted-foreground">Added {dateText(item.createdAt)}{item.deviceType ? ` · ${item.deviceType === "multiDevice" ? "Synced" : "This device only"}` : ""}</span>
                  </div>
                  <Button type="button" variant="outline" size="sm" aria-label={`Remove passkey ${item.name}`} onClick={() => { setError(""); setRemoving(item); }}>Remove</Button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-nowrap items-center gap-2">
            <PasskeyAddButton onAdded={async () => { toastManager.add({ title: "Passkey added", type: "success" }); await refresh(); }} />
          </div>
        </CardState>
      </CardPanel>
      <AlertDialog open={removing !== null} onOpenChange={(open) => { if (!open && !pending) setRemoving(null); }}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this passkey?</AlertDialogTitle>
            <AlertDialogDescription>{removing?.name} will no longer sign you in. You can add it again later.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" disabled={pending} />}>Keep it</AlertDialogClose>
            <Button variant="destructive" loading={pending} onClick={() => { if (removing) void remove(removing); }}>Remove passkey</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </Card>
  );
}

function DevicesCard() {
  const client = useQueryClient();
  const router = useRouter();
  const query = useQuery({
    queryKey: devicesKey,
    queryFn: async (): Promise<DeviceRow[]> => {
      const [list, current] = await Promise.all([authClient.listSessions(), authClient.getSession()]);
      if (list.error) throw new Error("devices");
      const currentToken = current.data?.session.token;
      return (list.data ?? []).map((item) => ({
        id: item.id,
        token: item.token,
        label: deviceLabel(item.userAgent),
        place: maskedAddress(item.ipAddress),
        lastUsed: String(item.updatedAt ?? item.createdAt ?? ""),
        current: item.token === currentToken,
      }));
    },
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const rows = query.data ?? [];

  async function signOutDevice(row: DeviceRow) {
    setBusy(row.id);
    setError("");
    try {
      const result = await authClient.revokeSession({ token: row.token });
      if (result.error) {
        setError(`Could not sign out ${row.label}. Try again.`);
        return;
      }
      client.setQueryData<DeviceRow[]>(devicesKey, (current) => (current ?? []).filter((item) => item.id !== row.id));
      toastManager.add({ title: `Signed out ${row.label}`, type: "success" });
    } catch {
      setError("This is unavailable right now. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  }

  async function signOutOthers() {
    setBusy("others");
    setError("");
    try {
      const result = await authClient.revokeOtherSessions();
      if (result.error) {
        setError("Could not sign out your other devices. Try again.");
        return;
      }
      client.setQueryData<DeviceRow[]>(devicesKey, (current) => (current ?? []).filter((item) => item.current));
      toastManager.add({ title: "Signed out everywhere else", type: "success" });
    } catch {
      setError("This is unavailable right now. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  }

  async function signOutAll() {
    setBusy("all");
    setError("");
    try {
      const result = await authClient.revokeSessions();
      if (result.error) {
        setError("Could not sign you out. Try again.");
        return;
      }
      router.replace("/sign-in");
      router.refresh();
    } catch {
      setError("This is unavailable right now. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  }

  const others = rows.filter((row) => !row.current).length;
  return (
    <Card>
      <CardHeader>
        <CardTitle render={<h3 />}>Signed-in devices</CardTitle>
        <CardDescription>Where your account is signed in now. Sign out any you don&apos;t know.</CardDescription>
      </CardHeader>
      <CardPanel className="flex flex-col gap-4">
        <InlineError message={error} />
        <CardState loading={query.isLoading} error={query.isError} retry={() => void query.refetch()}>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No devices to show.</p>
          ) : (
            <ul className="flex flex-col divide-y rounded-lg border" aria-label="Signed-in devices">
              {rows.map((row) => {
                const Icon = /iOS|Android/.test(row.label) ? Smartphone : Laptop;
                return (
                  <li key={row.id} className="flex items-center gap-3 p-3">
                    <Icon aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        {row.label}
                        {row.current ? <Badge variant="success">This device</Badge> : null}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {row.place ? `${row.place} · ` : ""}Last used {lastUsedText(row.lastUsed)}
                      </span>
                    </div>
                    {row.current ? null : (
                      <Button type="button" variant="outline" size="sm" aria-label={`Sign out ${row.label}`} loading={busy === row.id} disabled={busy !== null && busy !== row.id} onClick={() => void signOutDevice(row)}>
                        Sign out
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {rows.length > 0 ? (
            <div className="flex flex-nowrap items-center gap-2">
              <Button type="button" variant="outline" disabled={others === 0 || (busy !== null && busy !== "others")} loading={busy === "others"} onClick={() => void signOutOthers()}>
                Sign out everywhere
              </Button>
              <RichMenu>
                <RichMenuTrigger render={<Button type="button" variant="outline" size="icon" aria-label="More device actions" />}>
                  <EllipsisVertical aria-hidden="true" />
                </RichMenuTrigger>
                <RichMenuContent>
                  <RichMenuItem destructive onClick={() => void signOutAll()}>Sign out on all devices, including this one</RichMenuItem>
                </RichMenuContent>
              </RichMenu>
            </div>
          ) : null}
        </CardState>
      </CardPanel>
    </Card>
  );
}

function PolicyCard() {
  const client = useQueryClient();
  const summary = useSummary();
  const { runWithStepUp } = useStepUp();
  const t = useTerms();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const on = summary.data?.policy.requireSecondFactorForAll ?? false;

  async function change(next: boolean) {
    setPending(true);
    setError("");
    try {
      await runWithStepUp(() => staffMutation("/api/staff/security/policy", "PUT", { requireSecondFactorForAll: next }));
      await client.invalidateQueries({ queryKey: summaryKey });
      toastManager.add({ title: next ? "Everyone will be asked for a second factor" : "Only owners and admins are asked", type: "success" });
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "This could not be saved.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle render={<h3 />}>Team sign-in rules</CardTitle>
        <CardDescription>Owners and admins always need a second factor. Choose whether your whole {t.business} team does too.</CardDescription>
      </CardHeader>
      <CardPanel className="flex flex-col gap-4">
        <InlineError message={error} />
        <CardState loading={summary.isLoading} error={summary.isError} retry={() => void summary.refetch()}>
          <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
            <span id="policy-label" className="text-sm font-medium">Ask everyone on the team for a second factor</span>
            <Switch checked={on} disabled={pending} aria-labelledby="policy-label" onCheckedChange={(next) => void change(next)} />
          </div>
          <p className="text-xs text-muted-foreground">Changing this needs a fresh code from you. People without a second factor set one up the next time they sign in.</p>
        </CardState>
      </CardPanel>
    </Card>
  );
}

/** The Security section of the profile screen: second factor, passkeys, signed-in devices and, for owners and admins, the team rule. */
export function SecurityPanel() {
  const access = useStaffAccess();
  return (
    <section aria-labelledby="security-heading" className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <KeyRound aria-hidden="true" className="size-5 text-muted-foreground" />
        <h2 id="security-heading" className="text-lg font-semibold">Security</h2>
      </div>
      <SecondFactorCard />
      <PasskeysCard />
      <DevicesCard />
      {access.can("settings.manage") ? <PolicyCard /> : null}
    </section>
  );
}
