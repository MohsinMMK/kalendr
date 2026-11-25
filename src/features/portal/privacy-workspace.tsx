"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Download, Eraser, FileCheck2, LockKeyhole, PencilLine, ShieldCheck, TriangleAlert } from "lucide-react";

import { SelectField, TextareaField, TextField } from "@/components/form-fields";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { toastManager } from "@/components/ui/toast";
import { decisionReasonLabels } from "@/server/privacy/rules";

import { portalAuth } from "../records/records-client";
import { useTerms } from "../terms/business-profile-context";
import { PortalShell } from "./portal-shell";
import {
  pendingRequestKey,
  portalPrivacyApi,
  PrivacyApiError,
  type ConsentPurpose,
  type DataRequestType,
  type DataRequestView,
  type GuardianInput,
  type PortalPrivacy,
} from "./privacy-client";
import { NoticeDialog, NoticeLanguageSwitch, type NoticeLanguage } from "./privacy-notice";

type Person = PortalPrivacy["people"][number];

/** The four choices, in the words a customer sees. The long explanation beside each comes from the notice. */
const purposeRows: { purpose: ConsentPurpose; label: string; fallback: string }[] = [
  { purpose: "appointment_messages", label: "Appointment messages", fallback: "Confirmations, reminders and changes to your bookings." },
  { purpose: "marketing_messages", label: "Marketing messages", fallback: "News and offers. We only send these if you say yes." },
  { purpose: "reviews", label: "Reviews", fallback: "A message after your visit asking how it went." },
  { purpose: "records_sharing", label: "Sharing my records", fallback: "Letting you see documents such as notes and reports in your portal." },
];

const typeLabels: Record<DataRequestType, string> = {
  export: "Download my data",
  erasure: "Delete my data",
  correction: "Correct my details",
};

const dayFormat = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const day = (iso: string) => dayFormat.format(new Date(iso));

const exportLinkDays = 7;

interface PendingRequest { clinicSlug: string; patientId: string; type: DataRequestType; note?: string }

function readPending(): PendingRequest | null {
  try {
    const raw = window.sessionStorage.getItem(pendingRequestKey);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { clinicSlug, patientId, type, note } = value as Record<string, unknown>;
    if (typeof clinicSlug !== "string" || typeof patientId !== "string") return null;
    if (type !== "export" && type !== "erasure" && type !== "correction") return null;
    return { clinicSlug, patientId, type, note: typeof note === "string" ? note : undefined };
  } catch {
    return null;
  }
}

function writePending(value: PendingRequest | null) {
  try {
    if (value) window.sessionStorage.setItem(pendingRequestKey, JSON.stringify(value));
    else window.sessionStorage.removeItem(pendingRequestKey);
  } catch {
    // The request simply has to be asked again after sign-in.
  }
}

export function PortalPrivacyUnavailable() {
  return (
    <PortalShell>
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon"><LockKeyhole aria-hidden="true" /></EmptyMedia>
          <EmptyTitle>Privacy choices are not available in the preview</EmptyTitle>
          <EmptyDescription>They are saved with your business. Sign in to a real portal to see them.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent><Button variant="outline" render={<Link href="/portal" />}>Back to your bookings</Button></EmptyContent>
      </Empty>
    </PortalShell>
  );
}

export function PortalPrivacyWorkspace() {
  const router = useRouter();
  const [language, setLanguage] = useState<NoticeLanguage>("en");
  const [data, setData] = useState<PortalPrivacy | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [chosen, setChosen] = useState("");
  const [notice, setNotice] = useState("");
  const [now] = useState(() => Date.now());

  const load = useCallback(async (next: NoticeLanguage, quiet: boolean) => {
    if (!quiet) setState("loading");
    try {
      const result = await portalPrivacyApi.load(next);
      setData(result);
      setState("ready");
      setError("");
    } catch (cause: unknown) {
      if (cause instanceof PrivacyApiError && cause.status === 401) {
        router.replace("/portal/sign-in");
        return;
      }
      setError(cause instanceof Error ? cause.message : "Your privacy choices could not be loaded.");
      if (!quiet) setState("error");
    }
  }, [router]);

  useEffect(() => {
    queueMicrotask(() => void load(language, false));
  }, [load, language]);

  const people = data?.people ?? [];
  const person = people.find((item) => `${item.clinicSlug}/${item.patientId}` === chosen) ?? people[0];

  async function signOutForCode() {
    await portalAuth.signOut().catch(() => undefined);
    router.replace("/portal/sign-in?next=privacy");
    router.refresh();
  }

  const signOutAction = (
    <Button variant="outline" size="sm" render={<Link href="/portal" />}>Your bookings</Button>
  );

  return (
    <PortalShell actions={signOutAction}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-heading text-xl font-semibold">Your privacy</h1>
          <p className="text-sm text-muted-foreground">Choose what we may send you, and ask for a copy of your details or for them to be removed.</p>
        </div>
        {people.length > 1 && person ? (
          <SelectField
            id="privacy-person"
            label="Showing"
            fieldClassName="w-full sm:w-64"
            value={`${person.clinicSlug}/${person.patientId}`}
            onValueChange={setChosen}
            options={people.map((item) => ({ value: `${item.clinicSlug}/${item.patientId}`, label: people.some((other) => other !== item && other.clinicSlug !== item.clinicSlug) ? `${item.name} · ${item.clinicName}` : item.name }))}
          />
        ) : null}
      </div>

      {notice ? <Alert variant="success" role="status"><FileCheck2 aria-hidden="true" /><AlertDescription>{notice}</AlertDescription></Alert> : null}
      {state === "loading" ? (
        <div role="status" aria-label="Loading your privacy choices" className="flex flex-col gap-3">
          <Skeleton className="h-56 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : null}
      {state === "error" ? (
        <Alert variant="error">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>We could not load this page</AlertTitle>
          <AlertDescription>
            <p>{error}</p>
            <Button variant="outline" size="sm" className="self-start" onClick={() => void load(language, false)}>Try again</Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {state === "ready" && !person ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><ShieldCheck aria-hidden="true" /></EmptyMedia>
            <EmptyTitle>We do not hold any details about you</EmptyTitle>
            <EmptyDescription>Once you book with a business, your choices appear here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {state === "ready" && data && person ? (
        <PersonPrivacy
          key={`${person.clinicSlug}/${person.patientId}`}
          data={data}
          person={person}
          language={language}
          now={now}
          partialError={error}
          onLanguage={setLanguage}
          onChanged={() => load(language, true)}
          onNeedCode={signOutForCode}
          onNotice={setNotice}
        />
      ) : null}
    </PortalShell>
  );
}

function PersonPrivacy({ data, person, language, now, partialError, onLanguage, onChanged, onNeedCode, onNotice }: {
  data: PortalPrivacy;
  person: Person;
  language: NoticeLanguage;
  now: number;
  partialError: string;
  onLanguage: (next: NoticeLanguage) => void;
  onChanged: () => Promise<void>;
  onNeedCode: () => Promise<void>;
  onNotice: (text: string) => void;
}) {
  const t = useTerms();
  const notice = data.notices[person.clinicSlug];
  const version = notice?.version ?? data.noticeVersion;
  const [granted, setGranted] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [guardianFor, setGuardianFor] = useState<{ purpose: ConsentPurpose; granted: boolean } | null>(null);
  const [asking, setAsking] = useState<"erasure" | "correction" | null>(null);
  const [needCode, setNeedCode] = useState(false);
  const [requestBusy, setRequestBusy] = useState<DataRequestType | null>(null);

  const stateOf = useCallback((purpose: ConsentPurpose) => {
    if (purpose in granted) return granted[purpose];
    return person.consents.find((item) => item.purpose === purpose)?.granted ?? purpose !== "marketing_messages";
  }, [granted, person.consents]);

  async function choose(purpose: ConsentPurpose, next: boolean, guardian?: GuardianInput) {
    const label = purposeRows.find((row) => row.purpose === purpose)?.label ?? "This choice";
    setMessage("");
    setBusy(purpose);
    setGranted((current) => ({ ...current, [purpose]: next }));
    try {
      const result = await portalPrivacyApi.setConsent({ clinicSlug: person.clinicSlug, patientId: person.patientId, purpose, granted: next, wordingVersion: version, guardian });
      if (result.changed) {
        toastManager.add({
          title: next ? `${label} are on` : `${label} are off`,
          description: "You can change this at any time.",
          type: "success",
        });
      }
      setGuardianFor(null);
      await onChanged();
      setGranted((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== purpose)));
    } catch (cause: unknown) {
      setGranted((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== purpose)));
      const code = cause instanceof PrivacyApiError ? cause.code : "";
      if (code === "guardian_required") setGuardianFor({ purpose, granted: next });
      else setMessage(cause instanceof Error ? cause.message : "That choice could not be saved.");
    } finally {
      setBusy(null);
    }
  }

  async function ask(type: DataRequestType, note?: string) {
    setRequestBusy(type);
    setMessage("");
    try {
      const result = await portalPrivacyApi.createRequest({ clinicSlug: person.clinicSlug, patientId: person.patientId, type, ...(note ? { note } : {}) });
      writePending(null);
      setAsking(null);
      const said = result.created
        ? type === "export" ? "We are preparing your download. We will email you a link within a minute." : "Your request is sent. We will tell you what we decide."
        : "You already have an open request of this kind. We have not sent a second one.";
      onNotice(said);
      toastManager.add({ title: result.created ? "Request sent" : "Already asked", description: said, type: result.created ? "success" : "info" });
      await onChanged();
    } catch (cause: unknown) {
      if (cause instanceof PrivacyApiError && cause.code === "fresh_code_required") {
        writePending({ clinicSlug: person.clinicSlug, patientId: person.patientId, type, note });
        setAsking(null);
        setNeedCode(true);
      } else {
        setMessage(cause instanceof Error ? cause.message : "Your request could not be sent.");
      }
    } finally {
      setRequestBusy(null);
    }
  }

  // Back from the sign-in code step: send the request the person already asked for.
  useEffect(() => {
    const pending = readPending();
    if (!pending || pending.clinicSlug !== person.clinicSlug || pending.patientId !== person.patientId) return;
    writePending(null);
    queueMicrotask(() => void ask(pending.type, pending.note));
    // Runs once for this person.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const requests = person.requests;

  return (
    <>
      {partialError ? <Alert variant="warning"><TriangleAlert aria-hidden="true" /><AlertDescription>{partialError} What you see may be out of date.</AlertDescription></Alert> : null}
      {message ? <Alert variant="error"><TriangleAlert aria-hidden="true" /><AlertDescription>{message}</AlertDescription></Alert> : null}
      {person.isMinor && !person.guardianOnFile ? (
        <Alert variant="info" role="note">
          <ShieldCheck aria-hidden="true" />
          <AlertTitle>A parent or guardian needs to choose for {person.name}</AlertTitle>
          <AlertDescription>{person.name} is under 18. Before you turn anything on, we will ask who the parent or guardian is.</AlertDescription>
        </Alert>
      ) : null}

      <Frame>
        <FrameHeader>
          <FrameTitle>What we may send {person.name}</FrameTitle>
          <FrameDescription>{person.clinicName}. Each choice is separate. Turning one off takes effect straight away.</FrameDescription>
        </FrameHeader>
        <FramePanel className="flex flex-col divide-y p-0">
          {purposeRows.map((row) => {
            const minorMarketing = person.isMinor && row.purpose === "marketing_messages";
            const text = notice?.purposes[row.purpose]?.text ?? row.fallback;
            const id = `privacy-${row.purpose}`;
            return (
              <div key={row.purpose} className="flex min-h-11 items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <Label htmlFor={id} className="font-medium">{row.label}</Label>
                  <p className="text-xs text-muted-foreground">{text}</p>
                  {minorMarketing ? <p className="text-xs text-muted-foreground">We never send marketing to anyone under 18.</p> : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {busy === row.purpose ? <Spinner aria-hidden="true" /> : null}
                  <Switch id={id} checked={minorMarketing ? false : stateOf(row.purpose)} disabled={minorMarketing || busy === row.purpose} onCheckedChange={(next) => void choose(row.purpose, next)} />
                </div>
              </div>
            );
          })}
        </FramePanel>
      </Frame>

      <Frame>
        <FrameHeader>
          <FrameTitle>Your details</FrameTitle>
          <FrameDescription>We aim to answer every request within 90 days. We will tell you what we decide.</FrameDescription>
        </FrameHeader>
        <FramePanel className="flex flex-col gap-4">
          <RequestAction
            icon={<Download aria-hidden="true" />}
            label="Download my data"
            text="We email you a link to a file with your details, your bookings and your choices. The link works once, for 7 days."
            busy={requestBusy === "export"}
            onClick={() => void ask("export")}
          />
          <RequestAction
            icon={<PencilLine aria-hidden="true" />}
            label="Ask for a correction"
            text={`Tell the ${t.business} what is wrong, and we will fix it.`}
            busy={false}
            onClick={() => setAsking("correction")}
          />
          <RequestAction
            icon={<Eraser aria-hidden="true" />}
            label="Ask us to delete my data"
            text="We remove what we can. Some records, such as payments, must be kept for a set time. We will tell you what was kept and why."
            busy={false}
            onClick={() => setAsking("erasure")}
          />
        </FramePanel>
      </Frame>

      <Frame>
        <FrameHeader>
          <FrameTitle>Your requests</FrameTitle>
        </FrameHeader>
        <FramePanel className="p-0">
          {requests.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">You have not asked for anything yet.</p>
          ) : (
            <ul className="divide-y">
              {requests.map((request) => <RequestRow key={request.id} request={request} now={now} />)}
            </ul>
          )}
        </FramePanel>
      </Frame>

      <Frame>
        <FrameHeader>
          <FrameTitle>{notice?.title ?? "How we use your information"}</FrameTitle>
          <FrameDescription>Notice version {version}. You can read it in English or Hindi.</FrameDescription>
        </FrameHeader>
        <FramePanel className="flex flex-col items-start gap-3">
          <NoticeLanguageSwitch value={language} onChange={onLanguage} />
          {notice ? (
            <>
              <p className="text-sm text-muted-foreground" lang={notice.language}>{notice.paragraphs[0]}</p>
              <NoticeDialog notice={notice} language={language} onLanguageChange={onLanguage} />
            </>
          ) : <p className="text-sm text-muted-foreground">The notice could not be shown right now.</p>}
        </FramePanel>
      </Frame>

      <GuardianDialog
        open={guardianFor !== null}
        personName={person.name}
        onClose={() => setGuardianFor(null)}
        onSubmit={(guardian) => guardianFor ? choose(guardianFor.purpose, guardianFor.granted, guardian) : Promise.resolve()}
      />
      <RequestDialog
        type={asking}
        busy={requestBusy !== null}
        onClose={() => setAsking(null)}
        onSubmit={(type, note) => void ask(type, note)}
      />
      <Dialog open={needCode} onOpenChange={setNeedCode}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>We need a new sign-in code</DialogTitle>
            <DialogDescription>To keep your details safe, we ask for a new code before we do this. We will sign you out, ask for a code, and bring you back here.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { writePending(null); setNeedCode(false); }}>Not now</Button>
            <Button onClick={() => void onNeedCode()}>Get a new code</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}

function RequestAction({ icon, label, text, busy, onClick }: { icon: ReactNode; label: string; text: string; busy: boolean; onClick: () => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Button variant="outline" size="lg" className="w-full justify-start" onClick={onClick} disabled={busy}>
        {busy ? <Spinner aria-hidden="true" /> : icon}
        {label}
      </Button>
      <p className="text-xs text-muted-foreground">{text}</p>
    </div>
  );
}

function RequestDialog({ type, busy, onClose, onSubmit }: { type: "erasure" | "correction" | null; busy: boolean; onClose: () => void; onSubmit: (type: DataRequestType, note: string) => void }) {
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const correction = type === "correction";
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!type) return;
    if (correction && note.trim().length < 3) {
      setError("Tell us what needs to change.");
      return;
    }
    onSubmit(type, note.trim());
  }
  return (
    <Dialog open={type !== null} onOpenChange={(open) => { if (!open) { setNote(""); setError(""); onClose(); } }}>
      <DialogPopup>
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <DialogHeader>
            <DialogTitle>{correction ? "Ask for a correction" : "Ask us to delete my data"}</DialogTitle>
            <DialogDescription>
              {correction
                ? "Say what is wrong and what it should be."
                : "We will check it is you. Then we remove your details, except records we must keep. You get an email that lists both."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="pb-6">
            <TextareaField
              label={correction ? "What should we change?" : "Anything you want us to know"}
              optional={!correction}
              maxLength={500}
              rows={4}
              autoFocus
              value={note}
              error={error}
              onChange={(event) => { setNote(event.target.value); setError(""); }}
            />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? <Spinner aria-hidden="true" /> : null}Send request</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

const relationships = [
  { value: "mother", label: "Mother" },
  { value: "father", label: "Father" },
  { value: "legal guardian", label: "Legal guardian" },
  { value: "other", label: "Someone else" },
];

function GuardianDialog({ open, personName, onClose, onSubmit }: { open: boolean; personName: string; onClose: () => void; onSubmit: (guardian: GuardianInput) => Promise<void> }) {
  const [name, setName] = useState("");
  const [relationship, setRelationship] = useState("");
  const [contact, setContact] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !relationship || contact.trim().length < 3) {
      setError("Fill in the name, how they are related, and an email or phone number.");
      return;
    }
    setPending(true);
    try {
      await onSubmit({ name: name.trim(), relationship, contact: contact.trim() });
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogPopup>
        <form onSubmit={(event) => void submit(event)} className="flex min-h-0 flex-col">
          <DialogHeader>
            <DialogTitle>Who is the parent or guardian?</DialogTitle>
            <DialogDescription>{personName} is under 18, so a parent or guardian makes these choices. We keep these details private.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4 pb-6">
            {error ? <Alert variant="error"><AlertDescription>{error}</AlertDescription></Alert> : null}
            <TextField label="Their name" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" />
            <SelectField label="How are they related?" value={relationship} onValueChange={setRelationship} options={relationships} placeholder="Choose one" />
            <TextField label="Their email or phone number" value={contact} onChange={(event) => setContact(event.target.value)} autoComplete="email" />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={pending}>{pending ? <Spinner aria-hidden="true" /> : null}Save and continue</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function requestState(request: DataRequestView, now: number): { label: string; tone: "success" | "attention" | "neutral" | "danger" | "info" } {
  switch (request.status) {
    case "requested": return { label: "Waiting for a decision", tone: "attention" };
    case "approved": return { label: request.type === "export" ? "Preparing your download" : "Approved, being removed", tone: "info" };
    case "processing": return { label: "In progress", tone: "info" };
    case "completed": return { label: request.type === "export" && exportExpired(request, now) ? "Link expired" : "Done", tone: request.type === "export" && exportExpired(request, now) ? "neutral" : "success" };
    case "refused": return { label: "Not done", tone: "neutral" };
    case "failed": return { label: "Needs attention", tone: "danger" };
  }
}

function exportExpired(request: DataRequestView, now: number): boolean {
  return request.completedAt !== null && now > Date.parse(request.completedAt) + exportLinkDays * 86_400_000;
}

function RequestRow({ request, now }: { request: DataRequestView; now: number }) {
  const state = requestState(request, now);
  const open = request.status === "requested" || request.status === "approved" || request.status === "processing";
  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">{typeLabels[request.type]}</p>
          <p className="text-xs text-muted-foreground">Asked on {day(request.createdAt)}</p>
        </div>
        <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
      </div>
      {open ? (
        <p className="text-xs text-muted-foreground">
          {request.overdue ? `This is taking longer than we promised. It was due on ${day(request.dueAt)}.` : `We aim to finish by ${day(request.dueAt)}.`}
        </p>
      ) : null}
      {request.type === "export" && request.status === "completed" && !exportExpired(request, now) ? (
        <p className="text-sm">Your download is ready. We emailed the link. It works once, for 7 days.</p>
      ) : null}
      {request.type === "export" && request.status === "completed" && exportExpired(request, now) ? (
        <p className="text-sm text-muted-foreground">The link has expired. Ask for a new download.</p>
      ) : null}
      {request.type === "export" && (request.status === "approved" || request.status === "processing") ? (
        <p className="text-sm text-muted-foreground">We will email you a link within a minute.</p>
      ) : null}
      {request.status === "refused" ? (
        <p className="text-sm">{request.decisionReason ? decisionReasonLabels[request.decisionReason] : "We could not act on this request."}{request.decisionNote ? ` ${request.decisionNote}` : ""}</p>
      ) : null}
      {request.type !== "export" && request.status === "completed" && !request.summary ? (
        <p className="text-sm">Done{request.decisionNote ? `. ${request.decisionNote}` : "."}</p>
      ) : null}
      {request.summary ? (
        <div className="flex flex-col gap-3 text-sm">
          <ResultList title="What we removed" lines={request.summary.removed} />
          <ResultList title="What we kept, and why" lines={request.summary.kept} />
        </div>
      ) : null}
    </li>
  );
}

function ResultList({ title, lines }: { title: string; lines: string[] }) {
  if (!lines.length) return null;
  return (
    <div>
      <p className="font-medium">{title}</p>
      <ul className="mt-1 list-disc ps-5 text-muted-foreground">
        {lines.map((line) => <li key={line}>{line}</li>)}
      </ul>
    </div>
  );
}
