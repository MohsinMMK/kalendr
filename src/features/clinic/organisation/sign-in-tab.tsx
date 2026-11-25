"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Check, Copy, Ellipsis, Globe2, KeyRound, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { RichMenu, RichMenuContent, RichMenuItem, RichMenuTrigger } from "@/components/rich-menu";
import { SelectField, TextareaField, TextField } from "@/components/form-fields";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { toastManager } from "@/components/ui/toast";
import { useBusinessProfile } from "@/features/terms/business-profile-context";
import { domainPattern, type DomainView, type SsoConnectionView } from "@/lib/enterprise-contracts";
import { roleLabelsFor } from "@/lib/permissions";

import { useOptionalStaffSnapshot } from "../staff-snapshot-provider";
import { useDomains, useOrgChange } from "./api";
import { errorText, formatStamp, QueryState, SecretRevealDialog, serverFieldErrors } from "./shared";

const joinRoles = ["receptionist", "practitioner", "billing", "read_only"] as const;

/** Settings > Organisation > Sign-in: company domains, the identity provider that signs people in, and whether it is required. */
export function SignInTab() {
  const query = useDomains();
  const change = useOrgChange<DomainView>({ stepUp: true });
  const [adding, setAdding] = useState(false);
  const [record, setRecord] = useState<{ host: string; value: string; domain: string } | null>(null);
  const [connecting, setConnecting] = useState<DomainView | null>(null);
  const [removing, setRemoving] = useState<DomainView | null>(null);

  async function remove() {
    if (!removing) return;
    try {
      await change.mutateAsync({ path: `/api/staff/org/domains/${encodeURIComponent(removing.id)}`, method: "DELETE" });
      toastManager.add({ title: "Domain removed", type: "success" });
    } catch (cause: unknown) {
      toastManager.add({ title: "Could not remove the domain", description: errorText(cause, "Try again."), type: "error" });
    } finally {
      setRemoving(null);
    }
  }

  return (
    <QueryState query={query} label="Company sign-in">
      {(domains) => (
        <div className="flex flex-col gap-4">
          {domains.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon"><Globe2 aria-hidden="true" /></EmptyMedia>
                <EmptyTitle>No company domain yet</EmptyTitle>
                <EmptyDescription>Add your company&apos;s email domain, prove it with one DNS record, then connect Okta, Azure AD or Google Workspace so your team signs in with their company account.</EmptyDescription>
              </EmptyHeader>
              <EmptyContent><Button type="button" size="lg" onClick={() => setAdding(true)}><Plus aria-hidden="true" /> Add a domain</Button></EmptyContent>
            </Empty>
          ) : (
            <>
              <div className="flex items-start justify-between gap-3">
                <p className="text-muted-foreground text-sm">People with an address on a proved domain can sign in through your identity provider.</p>
                <Button type="button" size="lg" onClick={() => setAdding(true)}><Plus aria-hidden="true" /> Add a domain</Button>
              </div>
              {domains.map((domain) => (
                <DomainCard key={domain.id} domain={domain} onConnect={() => setConnecting(domain)} onRemove={() => setRemoving(domain)} onRecord={(next) => setRecord({ ...next, domain: domain.domain })} />
              ))}
            </>
          )}
          <AddDomainDialog open={adding} onClose={() => setAdding(false)} onAdded={(domain) => { setAdding(false); if (domain.dnsRecord) setRecord({ ...domain.dnsRecord, domain: domain.domain }); }} />
          <SecretRevealDialog
            open={record !== null}
            title="Publish this DNS record"
            description={record ? `Add a TXT record named ${record.host} to ${record.domain}. We check every few minutes, and it can take up to an hour to appear.` : ""}
            label="DNS record value"
            secret={record?.value ?? ""}
            onDone={() => setRecord(null)}
          />
          <ConnectionDialog domain={connecting} onClose={() => setConnecting(null)} />
          <AlertDialog open={removing !== null} onOpenChange={(open) => { if (!open) setRemoving(null); }}>
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle>Remove {removing?.domain}?</AlertDialogTitle>
                <AlertDialogDescription>Company sign-in for this domain stops, along with its connection. People keep their accounts and can use their password or a sign-in link.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose render={<Button type="button" variant="ghost" size="lg" />}>Keep domain</AlertDialogClose>
                <Button type="button" variant="destructive" size="lg" disabled={change.isPending} onClick={() => void remove()}>Remove domain</Button>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
        </div>
      )}
    </QueryState>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <span className="font-medium text-xs">{label}</span>
      <div className="flex items-center gap-2">
        <Input readOnly size="lg" value={value} aria-label={label} className="font-mono" onFocus={(event) => event.currentTarget.select()} />
        <Button type="button" variant="outline" size="icon-lg" aria-label={`Copy ${label.toLowerCase()}`} onClick={() => { void navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => toastManager.add({ title: "Could not copy", description: "Select the text and copy it yourself.", type: "error" })); }}>
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </Button>
      </div>
    </div>
  );
}

function DomainCard({ domain, onConnect, onRemove, onRecord }: { domain: DomainView; onConnect: () => void; onRemove: () => void; onRecord: (record: { host: string; value: string }) => void }) {
  const change = useOrgChange<DomainView>({ stepUp: true });
  const profile = useBusinessProfile();
  const labels = roleLabelsFor(profile);
  const snapshot = useOptionalStaffSnapshot()?.snapshot ?? null;
  const owners = snapshot?.team.filter((member) => member.role === "owner" && member.isActive) ?? [];
  const connection = domain.connection;

  async function update(body: Record<string, unknown>, success: string) {
    try {
      await change.mutateAsync({ path: `/api/staff/org/domains/${encodeURIComponent(domain.id)}`, method: "PATCH", body: { ...body, version: domain.version } });
      toastManager.add({ title: success, type: "success" });
    } catch (cause: unknown) {
      toastManager.add({ title: "Could not save that", description: errorText(cause, "Try again."), type: "error" });
    }
  }
  async function newRecord() {
    try {
      const fresh = await change.mutateAsync({ path: `/api/staff/org/domains/${encodeURIComponent(domain.id)}/record`, method: "POST" });
      if (fresh?.dnsRecord) onRecord(fresh.dnsRecord);
    } catch (cause: unknown) {
      toastManager.add({ title: "Could not make a new record", description: errorText(cause, "Try again."), type: "error" });
    }
  }
  async function switchConnection(status: "active" | "disabled") {
    try {
      await change.mutateAsync({ path: `/api/staff/org/domains/${encodeURIComponent(domain.id)}/sso`, method: "PATCH", body: { status } });
      toastManager.add({ title: status === "active" ? "Company sign-in is on" : "Company sign-in is off", type: "success" });
    } catch (cause: unknown) {
      toastManager.add({ title: "Could not change company sign-in", description: errorText(cause, "Try again."), type: "error" });
    }
  }
  async function chooseBreakGlass(membershipId: string) {
    try {
      await change.mutateAsync({ path: "/api/staff/org/break-glass", method: "PUT", body: { membershipId } });
      toastManager.add({ title: "Break-glass owner chosen", type: "success" });
    } catch (cause: unknown) {
      toastManager.add({ title: "Could not choose that owner", description: errorText(cause, "Try again."), type: "error" });
    }
  }

  return (
    <Frame>
      <FrameHeader className="flex-row items-start justify-between gap-3">
        <div className="min-w-0">
          <FrameTitle className="truncate">{domain.domain}</FrameTitle>
          <FrameDescription className="flex flex-wrap items-center gap-2">
            {domain.verified ? <Badge variant="success">Proved</Badge> : <Badge variant="warning">Waiting for the DNS record</Badge>}
            {domain.requireSso ? <Badge variant="info">Company sign-in required</Badge> : null}
          </FrameDescription>
        </div>
        <RichMenu>
          <RichMenuTrigger render={<Button type="button" variant="ghost" size="icon-lg" aria-label={`More for ${domain.domain}`} />}><Ellipsis aria-hidden="true" /></RichMenuTrigger>
          <RichMenuContent>
            {!domain.verified ? <RichMenuItem icon={<RefreshCw aria-hidden="true" />} onClick={() => void newRecord()}>Get a new DNS record</RichMenuItem> : null}
            <RichMenuItem destructive icon={<Trash2 aria-hidden="true" />} onClick={onRemove}>Remove domain</RichMenuItem>
          </RichMenuContent>
        </RichMenu>
      </FrameHeader>
      {!domain.verified ? (
        <FramePanel className="flex flex-col gap-2">
          <p className="text-sm">{domain.lastCheckNote ?? "We haven't looked yet. We check every few minutes for a week."}</p>
          {domain.lastCheckedAt ? <p className="text-muted-foreground text-xs">Last looked {formatStamp(domain.lastCheckedAt)}.</p> : null}
          <p className="text-muted-foreground text-xs">Lost the record? Use &ldquo;Get a new DNS record&rdquo; in the menu. The old one stops working.</p>
        </FramePanel>
      ) : (
        <>
          <FramePanel className="flex flex-col gap-3">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="font-medium text-sm">Your identity provider</p>
                <p className="text-muted-foreground text-xs">{connection ? `${connection.kind === "saml" ? "SAML" : "OpenID Connect"} · ${connection.status === "active" ? "on" : connection.status === "draft" ? "set up, not switched on" : "off"}` : "Not connected yet."}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={onConnect}><KeyRound aria-hidden="true" /> {connection ? "Edit" : "Connect"}</Button>
                {connection ? <Switch aria-label="Company sign-in on" checked={connection.status === "active"} disabled={change.isPending} onCheckedChange={(next: boolean) => void switchConnection(next ? "active" : "disabled")} /> : null}
              </div>
            </div>
            {connection?.status === "active" ? (
              <Button type="button" variant="ghost" size="sm" className="self-start" render={<a href={`/api/sso/${connection.kind}/${connection.id}/start`} />}>Try company sign-in</Button>
            ) : null}
          </FramePanel>
          <FramePanel className="flex flex-col gap-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <label htmlFor={`auto-${domain.id}`} className="font-medium text-sm">Let anyone at {domain.domain} join</label>
                <p className="text-muted-foreground text-xs">The first time they sign in through the company, they&apos;re added with the role below.</p>
              </div>
              <Switch id={`auto-${domain.id}`} checked={domain.autoJoinEnabled} disabled={change.isPending || !connection} onCheckedChange={(next: boolean) => void update({ autoJoinEnabled: next }, next ? "Anyone at the company can join" : "Joining by themselves is off")} />
            </div>
            {domain.autoJoinEnabled ? (
              <SelectField label="They join as" value={domain.autoJoinRole} onValueChange={(value) => void update({ autoJoinRole: value }, "Role saved")} options={joinRoles.map((role) => ({ value: role, label: labels[role] }))} />
            ) : null}
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <label htmlFor={`require-${domain.id}`} className="font-medium text-sm">Require company sign-in</label>
                <p className="text-muted-foreground text-xs">Everyone at {domain.domain} must use it. Passwords and sign-in links stop working for them, except for the break-glass owner.</p>
              </div>
              <Switch id={`require-${domain.id}`} checked={domain.requireSso} disabled={change.isPending || connection?.status !== "active"} onCheckedChange={(next: boolean) => void update({ requireSso: next }, next ? "Company sign-in is now required" : "Company sign-in is optional again")} />
            </div>
            <div className="flex flex-col gap-2 rounded-lg bg-muted/48 p-3">
              <p className="font-medium text-sm">Break-glass owner</p>
              <p className="text-muted-foreground text-xs">One owner who can still sign in with a password and a second factor if your identity provider is down. They need an authenticator app or a passkey first.</p>
              <p className="text-xs">{domain.breakGlassName ? <>Now: <span className="font-medium">{domain.breakGlassName}</span></> : "Nobody chosen yet."}</p>
              {owners.length > 0 ? (
                <SelectField label="Choose who" value="" placeholder="Choose an owner" onValueChange={(value) => { if (value) void chooseBreakGlass(value); }} options={owners.map((owner) => ({ value: owner.membershipId, label: owner.name }))} />
              ) : null}
            </div>
          </FramePanel>
        </>
      )}
    </Frame>
  );
}

const domainSchema = z.object({ domain: z.string().trim().toLowerCase().min(3, "Enter your company domain.").max(253).regex(domainPattern, "Enter a domain such as yourcompany.com.") });

function AddDomainDialog({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: (domain: DomainView) => void }) {
  const change = useOrgChange<DomainView>({ stepUp: true });
  const { register, handleSubmit, reset, setError, formState: { errors } } = useForm<z.infer<typeof domainSchema>>({ resolver: zodResolver(domainSchema), defaultValues: { domain: "" } });
  useEffect(() => { if (open) { reset({ domain: "" }); change.reset(); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps -- reset only when the dialog opens

  const submit = handleSubmit(async (values) => {
    try {
      onAdded(await change.mutateAsync({ path: "/api/staff/org/domains", method: "POST", body: values }));
    } catch (cause: unknown) {
      const fields = serverFieldErrors(cause);
      if (fields.domain) setError("domain", { message: fields.domain });
    }
  });
  const formError = change.isError && Object.keys(serverFieldErrors(change.error)).length === 0 ? errorText(change.error, "The domain could not be added.") : "";
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !change.isPending) onClose(); }}>
      <DialogPopup>
        <form onSubmit={(event) => void submit(event)} noValidate className="flex min-h-0 flex-col">
          <DialogHeader>
            <DialogTitle>Add a company domain</DialogTitle>
            <DialogDescription>The part of your work email after the @. You&apos;ll get one DNS record to publish.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            {formError ? <Alert variant="error"><AlertDescription>{formError}</AlertDescription></Alert> : null}
            <TextField label="Domain" autoComplete="off" placeholder="yourcompany.com" inputMode="url" error={errors.domain?.message} {...register("domain")} />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" size="lg" onClick={onClose} disabled={change.isPending}>Cancel</Button>
            <Button type="submit" size="lg" disabled={change.isPending}>{change.isPending ? <Spinner aria-hidden="true" /> : null}Add domain</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

const samlSchema = z.object({
  idpEntityId: z.string().trim().min(3, "Enter the provider's entity id.").max(500),
  idpSsoUrl: z.string().trim().url("Enter the sign-in address, starting with https://").max(1000),
  idpCertificate: z.string().trim().min(100, "Paste the provider's signing certificate.").max(8000),
});
const oidcSchema = z.object({
  oidcIssuer: z.string().trim().url("Enter the issuer address, starting with https://").max(500),
  oidcClientId: z.string().trim().min(1, "Enter the client id.").max(300),
  oidcClientSecret: z.string().trim().max(500),
});

function ConnectionDialog({ domain, onClose }: { domain: DomainView | null; onClose: () => void }) {
  return (
    <Dialog open={domain !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPopup className="sm:max-w-xl">
        {domain ? <ConnectionBody key={domain.id} domain={domain} onClose={onClose} /> : null}
      </DialogPopup>
    </Dialog>
  );
}

function ConnectionBody({ domain, onClose }: { domain: DomainView; onClose: () => void }) {
  const [kind, setKind] = useState<"saml" | "oidc">(domain.connection?.kind ?? "saml");
  return (
    <>
      <DialogHeader>
        <DialogTitle>Connect your identity provider</DialogTitle>
        <DialogDescription>For {domain.domain}. Saving switches the connection off until you turn it on and try it.</DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-4">
        <Tabs value={kind} onValueChange={(value) => setKind(value === "oidc" ? "oidc" : "saml")} className="gap-4">
          <TabsList variant="underline" aria-label="How your provider connects">
            <TabsTab value="saml">SAML</TabsTab>
            <TabsTab value="oidc">OpenID Connect</TabsTab>
          </TabsList>
          <TabsPanel value="saml"><SamlForm domain={domain} onDone={onClose} /></TabsPanel>
          <TabsPanel value="oidc"><OidcForm domain={domain} onDone={onClose} /></TabsPanel>
        </Tabs>
      </DialogPanel>
    </>
  );
}

function ProviderDetails({ connection, kind }: { connection: SsoConnectionView; kind: "saml" | "oidc" }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <p className="font-medium text-sm">Paste these into your identity provider</p>
      {kind === "saml" ? (
        <>
          <CopyRow label="Entity id (audience)" value={connection.serviceProvider.entityId} />
          <CopyRow label="Reply address (ACS URL)" value={connection.serviceProvider.acsUrl} />
          <CopyRow label="Metadata address" value={connection.serviceProvider.metadataUrl} />
          <p className="text-muted-foreground text-xs">Name ID format: email address. Send the person&apos;s email as the Name ID or as an attribute called &ldquo;email&rdquo;.</p>
        </>
      ) : <CopyRow label="Redirect address" value={connection.serviceProvider.redirectUri} />}
    </div>
  );
}

function SamlForm({ domain, onDone }: { domain: DomainView; onDone: () => void }) {
  const change = useOrgChange<SsoConnectionView>({ stepUp: true });
  const existing = domain.connection?.kind === "saml" ? domain.connection : null;
  const { register, handleSubmit, setError, formState: { errors } } = useForm<z.infer<typeof samlSchema>>({
    resolver: zodResolver(samlSchema), defaultValues: { idpEntityId: existing?.idpEntityId ?? "", idpSsoUrl: existing?.idpSsoUrl ?? "", idpCertificate: "" },
  });
  const submit = handleSubmit(async (values) => {
    try {
      await change.mutateAsync({ path: `/api/staff/org/domains/${encodeURIComponent(domain.id)}/sso`, method: "PUT", body: { kind: "saml", ...values } });
      toastManager.add({ title: "Connection saved", description: "Switch it on when you're ready to try it.", type: "success" });
      onDone();
    } catch (cause: unknown) {
      for (const [field, message] of Object.entries(serverFieldErrors(cause))) if (field in values) setError(field as keyof typeof values, { message });
    }
  });
  const formError = change.isError && Object.keys(serverFieldErrors(change.error)).length === 0 ? errorText(change.error, "The connection could not be saved.") : "";
  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-4">
      {formError ? <Alert variant="error"><AlertTitle>Not saved</AlertTitle><AlertDescription>{formError}</AlertDescription></Alert> : null}
      {existing ? <ProviderDetails connection={existing} kind="saml" /> : <Alert variant="info"><AlertDescription>Save once to get the addresses to paste into your provider.</AlertDescription></Alert>}
      <TextField label="Provider entity id" autoComplete="off" error={errors.idpEntityId?.message} {...register("idpEntityId")} />
      <TextField label="Provider sign-in address" autoComplete="off" inputMode="url" placeholder="https://" error={errors.idpSsoUrl?.message} {...register("idpSsoUrl")} />
      <TextareaField label="Signing certificate" rows={5} hint={existing ? "Paste it again to replace the one we have." : "From your provider's metadata or setup page."} error={errors.idpCertificate?.message} {...register("idpCertificate")} />
      <div className="flex justify-end"><Button type="submit" size="lg" disabled={change.isPending}>{change.isPending ? <Spinner aria-hidden="true" /> : null}Save SAML connection</Button></div>
    </form>
  );
}

function OidcForm({ domain, onDone }: { domain: DomainView; onDone: () => void }) {
  const change = useOrgChange<SsoConnectionView>({ stepUp: true });
  const existing = domain.connection?.kind === "oidc" ? domain.connection : null;
  const { register, handleSubmit, setError, formState: { errors } } = useForm<z.infer<typeof oidcSchema>>({
    resolver: zodResolver(oidcSchema), defaultValues: { oidcIssuer: existing?.oidcIssuer ?? "", oidcClientId: existing?.oidcClientId ?? "", oidcClientSecret: "" },
  });
  const submit = handleSubmit(async (values) => {
    if (!existing?.hasClientSecret && !values.oidcClientSecret) { setError("oidcClientSecret", { message: "Enter the client secret." }); return; }
    try {
      await change.mutateAsync({ path: `/api/staff/org/domains/${encodeURIComponent(domain.id)}/sso`, method: "PUT", body: { kind: "oidc", oidcIssuer: values.oidcIssuer, oidcClientId: values.oidcClientId, ...(values.oidcClientSecret ? { oidcClientSecret: values.oidcClientSecret } : {}) } });
      toastManager.add({ title: "Connection saved", description: "Switch it on when you're ready to try it.", type: "success" });
      onDone();
    } catch (cause: unknown) {
      for (const [field, message] of Object.entries(serverFieldErrors(cause))) if (field in values) setError(field as keyof typeof values, { message });
    }
  });
  const formError = change.isError && Object.keys(serverFieldErrors(change.error)).length === 0 ? errorText(change.error, "The connection could not be saved.") : "";
  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-4">
      {formError ? <Alert variant="error"><AlertTitle>Not saved</AlertTitle><AlertDescription>{formError}</AlertDescription></Alert> : null}
      {existing ? <ProviderDetails connection={existing} kind="oidc" /> : <Alert variant="info"><AlertDescription>Save once to get the redirect address to paste into your provider.</AlertDescription></Alert>}
      <TextField label="Issuer address" autoComplete="off" inputMode="url" placeholder="https://" error={errors.oidcIssuer?.message} {...register("oidcIssuer")} />
      <TextField label="Client id" autoComplete="off" error={errors.oidcClientId?.message} {...register("oidcClientId")} />
      <TextField label="Client secret" type="password" autoComplete="off" optional={Boolean(existing?.hasClientSecret)} hint={existing?.hasClientSecret ? "Leave empty to keep the one we have. It is stored encrypted and never shown." : "Stored encrypted and never shown again."} error={errors.oidcClientSecret?.message} {...register("oidcClientSecret")} />
      <div className="flex justify-end"><Button type="submit" size="lg" disabled={change.isPending}>{change.isPending ? <Spinner aria-hidden="true" /> : null}Save OpenID connection</Button></div>
    </form>
  );
}
