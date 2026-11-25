"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileUp, FolderOpen, Plus, Send, ShieldCheck, Undo2, X } from "lucide-react";

import { SelectField, TextField, TextareaField } from "@/components/form-fields";
import { WorkspaceFrame, WorkspacePage } from "@/components/workspace-page";
import { PersonAvatar } from "@/components/person-avatar";
import { Accordion, AccordionItem, AccordionPanel, AccordionTrigger } from "@/components/ui/accordion";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Combobox, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList, ComboboxPopup } from "@/components/ui/combobox";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Label } from "@/components/ui/label";
import { Drawer, DrawerDescription, DrawerFooter, DrawerHeader, DrawerPanel, DrawerPopup, DrawerTitle } from "@/components/ui/drawer";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { maxRecordBodyLength, recordFileAccept } from "@/lib/record-files";
import { isClinicalBusinessType } from "@/lib/business-types";
import { recordKindLabelsFor, type RecordAccessRequest, type RecordsList, type VisitRecordDetail, type VisitRecordKind } from "@/lib/visit-records";

import { useBusinessProfile, useFeatures, useTerms } from "../terms/business-profile-context";
import { RecordFileList } from "../records/record-file-list";
import { databaseRecordsClient, previewRecordsClient, type RecordsClient } from "../records/records-client";
import { useCatalogLookups } from "./clinic-catalog";
import { appointmentDateTime } from "./clinic-format";
import { patientName } from "./patient-directory";
import { RecordsGrid } from "./records-grid";
import { usePreviewAppointments } from "./preview-appointments";

/** Record words for this business: healthcare and dental keep their medical names. */
function useRecordWords() {
  const t = useTerms();
  const profile = useBusinessProfile();
  const kindLabels = useMemo(() => recordKindLabelsFor(profile), [profile]);
  const kindOptions = useMemo(() => (Object.keys(kindLabels) as VisitRecordKind[]).map((value) => ({ value, label: kindLabels[value] })), [kindLabels]);
  return { t, clinical: isClinicalBusinessType(profile.businessType), kindLabels, kindOptions };
}

function day(iso: string) {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date(iso));
}

function dayTime(iso: string) {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(new Date(iso));
}

const message = (cause: unknown, fallback: string) => cause instanceof Error ? cause.message : fallback;

interface PendingConfirm {
  title: string;
  description: string;
  action: string;
  destructive?: boolean;
  run: () => Promise<void>;
}

type RecordsWorkspaceProps = {
  initialPatientId?: string;
  initialVisitId?: string;
  openNew?: boolean;
};

export function RecordsWorkspace(props: RecordsWorkspaceProps) {
  const features = useFeatures();
  if (!features.records) {
    return (
      <WorkspacePage nav="records">
        <WorkspaceFrame>
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyMedia variant="icon"><FolderOpen aria-hidden="true" /></EmptyMedia>
              <EmptyTitle>Records are turned off</EmptyTitle>
              <EmptyDescription>Turn them on in Settings, Business profile.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </WorkspaceFrame>
      </WorkspacePage>
    );
  }
  return <RecordsWorkspaceBody {...props} />;
}

function RecordsWorkspaceBody({ initialPatientId, initialVisitId, openNew }: RecordsWorkspaceProps) {
  const { t, clinical, kindLabels } = useRecordWords();
  const { patients, appointments, operations, database } = usePreviewAppointments();
  const catalog = useCatalogLookups();
  const clock = operations.clockIso;
  const client: RecordsClient = useMemo(() => database ? databaseRecordsClient : previewRecordsClient(clock), [clock, database]);

  const [list, setList] = useState<RecordsList | null>(null);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [patientFilter, setPatientFilter] = useState(initialPatientId ?? "");
  const [adding, setAdding] = useState(Boolean(openNew));
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<PendingConfirm | null>(null);
  const [confirmError, setConfirmError] = useState("");
  const [confirmPending, setConfirmPending] = useState(false);

  const load = useCallback(async () => {
    try {
      setList(await client.list());
      setLoadError("");
    } catch (cause: unknown) {
      setLoadError(message(cause, "Records could not be loaded."));
    }
  }, [client]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active) void load(); });
    return () => { active = false; };
  }, [load]);

  const records = useMemo(() => {
    const search = query.trim().toLowerCase();
    return (list?.records ?? []).filter((record) => {
      if (patientFilter && record.patientId !== patientFilter) return false;
      return !search || `${record.patientName} ${record.title} ${kindLabels[record.kind]}`.toLowerCase().includes(search);
    });
  }, [kindLabels, list, patientFilter, query]);

  const filteredName = patientFilter
    ? (list?.records.find((record) => record.patientId === patientFilter)?.patientName
      ?? (() => { const patient = patients.find((item) => item.id === patientFilter); return patient ? patientName(patient) : `this ${t.customer}`; })())
    : "";

  async function runConfirm() {
    if (!confirming) return;
    setConfirmPending(true);
    setConfirmError("");
    try {
      await confirming.run();
      setConfirming(null);
    } catch (cause: unknown) {
      setConfirmError(message(cause, "That didn't work. Try again."));
    } finally {
      setConfirmPending(false);
    }
  }

  const askConfirm = (next: PendingConfirm) => {
    setConfirmError("");
    setConfirming(next);
  };

  const confirmAccess = (request: RecordAccessRequest) => askConfirm({
    title: `Open ${request.patientName}'s documents?`,
    description: `The account signed in with ${request.contact} will see every document you share for ${request.patientName}. Confirm only after checking ID.`,
    action: "I checked ID, confirm",
    run: async () => {
      await client.confirmAccess(request.accessId);
      await load();
      toastManager.add({ title: `${request.patientName}'s documents are open to them`, type: "success" });
    },
  });

  const portalRequests = list?.accessRequests.length ? (
        <section aria-label="Portal requests" className="border-b">
          <div className="flex flex-col gap-0.5 border-b bg-muted/40 px-4 py-2">
            <h2 className="text-sm font-medium">Portal requests</h2>
            <p className="text-xs text-muted-foreground">{t.Customers} asking to open their documents. Check ID first.</p>
          </div>
            <ul className="divide-y">
              {list.accessRequests.map((request) => (
                <li key={request.accessId} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                  <PersonAvatar name={request.patientName} />
                  <div className="min-w-0 flex-1 basis-40">
                    <p className="text-sm font-medium">{request.patientName}</p>
                    <p className="text-xs text-muted-foreground">Signed in with {request.contact} · {dayTime(request.requestedAt)}</p>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => confirmAccess(request)}><ShieldCheck aria-hidden="true" /> Confirm</Button>
                </li>
              ))}
            </ul>
        </section>
      ) : null;

  return (
    <WorkspacePage
      nav="records"
      bar={[{ id: "add", label: "Add record", icon: <Plus aria-hidden="true" />, variant: "default", onSelect: () => setAdding(true), pinned: true }]}
    >
      {loadError ? (
        <Alert variant="error" role="alert"><AlertDescription>{loadError}</AlertDescription></Alert>
      ) : null}


      {!list && !loadError ? (
        <WorkspaceFrame panelClassName="gap-2"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></WorkspaceFrame>
      ) : (
        <RecordsGrid
          records={records}
          kindLabels={kindLabels}
          terms={t}
          query={query}
          onQueryChange={setQuery}
          onOpen={setOpenId}
          top={portalRequests}
          extra={patientFilter ? (
            <Button variant="outline" size="sm" onClick={() => setPatientFilter("")} aria-label={`Stop filtering by ${filteredName}`}>
              {filteredName} <X aria-hidden="true" />
            </Button>
          ) : null}
          empty={(
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon"><FolderOpen aria-hidden="true" /></EmptyMedia>
                <EmptyTitle>{list?.records.length ? "No matching records" : "No records yet"}</EmptyTitle>
                <EmptyDescription>{list?.records.length ? "Try another search or filter." : (clinical ? "Add a note, report or prescription for a patient." : `Add a note, report or document for ${t.aCustomer}.`)}</EmptyDescription>
              </EmptyHeader>
              {list?.records.length ? null : <EmptyContent><Button onClick={() => setAdding(true)}><Plus aria-hidden="true" /> Add record</Button></EmptyContent>}
            </Empty>
          )}
        />
      )}

      <Drawer position="right" open={adding} onOpenChange={setAdding}>
        <DrawerPopup showCloseButton variant="inset">
          <AddRecordForm
            patients={patients.map((patient) => ({ value: patient.id, label: patientName(patient) }))}
            visitsFor={(patientId) => appointments
              .filter((appointment) => appointment.patientId === patientId)
              .map((appointment) => ({
                value: appointment.id,
                label: `${appointmentDateTime(appointment.startsAt)} · ${catalog.serviceName(appointment.serviceId)}`,
                practitionerName: catalog.practitionerName(appointment.practitionerId),
              }))}
            initialPatientId={initialPatientId}
            initialVisitId={initialVisitId}
            client={client}
            onCancel={() => setAdding(false)}
            onCreated={(id) => {
              setAdding(false);
              setOpenId(id);
              void load();
            }}
          />
        </DrawerPopup>
      </Drawer>

      <Drawer position="right" open={openId !== null} onOpenChange={(next) => { if (!next) setOpenId(null); }}>
        <DrawerPopup showCloseButton variant="inset">
          {openId ? (
            <RecordDetail
              key={openId}
              id={openId}
              client={client}
              database={database}
              askConfirm={askConfirm}
              onChanged={() => void load()}
              onClosed={() => { setOpenId(null); void load(); }}
            />
          ) : null}
        </DrawerPopup>
      </Drawer>

      <AlertDialog open={confirming !== null} onOpenChange={(next) => { if (!next && !confirmPending) setConfirming(null); }}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirming?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirming?.description}</AlertDialogDescription>
            {confirmError ? <Alert variant="error" role="alert"><AlertDescription>{confirmError}</AlertDescription></Alert> : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" disabled={confirmPending} />}>Cancel</AlertDialogClose>
            <Button variant={confirming?.destructive ? "destructive" : "default"} disabled={confirmPending} onClick={() => void runConfirm()}>
              {confirmPending ? <Spinner aria-hidden="true" /> : null}
              {confirming?.action}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </WorkspacePage>
  );
}

function AddRecordForm({ patients, visitsFor, initialPatientId, initialVisitId, client, onCancel, onCreated }: {
  patients: { value: string; label: string }[];
  visitsFor: (patientId: string) => { value: string; label: string; practitionerName: string }[];
  initialPatientId?: string;
  initialVisitId?: string;
  client: RecordsClient;
  onCancel: () => void;
  onCreated: (id: string) => void;
}) {
  const { t, kindOptions } = useRecordWords();
  const [patient, setPatient] = useState(() => patients.find((item) => item.value === initialPatientId) ?? null);
  const [visit, setVisit] = useState(initialVisitId ?? "none");
  const [kind, setKind] = useState<VisitRecordKind>("note");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const visits = patient ? visitsFor(patient.value) : [];
  const chosenVisit = visits.find((item) => item.value === visit);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!patient) {
      setError(`Choose ${t.aCustomer}.`);
      return;
    }
    setPending(true);
    setError("");
    try {
      const { id } = await client.create({
        patientId: patient.value,
        patientName: patient.label,
        appointmentId: chosenVisit?.value ?? null,
        practitionerName: chosenVisit?.practitionerName ?? null,
        kind,
        title: title.trim(),
        body,
      });
      onCreated(id);
    } catch (cause: unknown) {
      setError(message(cause, "The record could not be saved."));
      setPending(false);
    }
  }

  return (
    <form className="contents" onSubmit={(event) => void save(event)}>
      <DrawerHeader>
        <DrawerTitle>Add a record</DrawerTitle>
        <DrawerDescription>It stays a private draft until you share it.</DrawerDescription>
      </DrawerHeader>
      <DrawerPanel className="flex flex-col gap-4">
        {error ? <Alert variant="error" role="alert"><AlertDescription>{error}</AlertDescription></Alert> : null}
        <div className="flex flex-col gap-2">
          <Label htmlFor="record-patient">{t.Customer}</Label>
          <Combobox
            items={patients}
            value={patient}
            onValueChange={(next) => { setPatient(next); setVisit("none"); }}
            isItemEqualToValue={(item, value) => item.value === value.value}
          >
            <ComboboxInput id="record-patient" placeholder={`Search ${t.customers}`} autoComplete="off" />
            <ComboboxPopup>
              <ComboboxEmpty>No {t.customer} found.</ComboboxEmpty>
              <ComboboxList>
                {(item: { value: string; label: string }) => <ComboboxItem key={item.value} value={item}>{item.label}</ComboboxItem>}
              </ComboboxList>
            </ComboboxPopup>
          </Combobox>
        </div>
        <SelectField
          id="record-visit"
          label={t.Visit}
          optional
          value={visit}
          onValueChange={setVisit}
          options={[{ value: "none", label: `Not linked to ${t.aVisit}` }, ...visits.map(({ value, label }) => ({ value, label }))]}
        />
        <SelectField id="record-kind" label="Type" value={kind} onValueChange={(next) => setKind(next as VisitRecordKind)} options={kindOptions} />
        <TextField id="record-title" label="Title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} required />
        <TextareaField id="record-body" label="Note" optional rows={6} value={body} onChange={(event) => setBody(event.target.value)} maxLength={maxRecordBodyLength} />
      </DrawerPanel>
      <DrawerFooter className="flex-row items-center justify-between sm:justify-between">
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={pending || !title.trim()}>
          {pending ? <Spinner aria-hidden="true" /> : null}
          Save draft
        </Button>
      </DrawerFooter>
    </form>
  );
}

function RecordDetail({ id, client, database, askConfirm, onChanged, onClosed }: {
  id: string;
  client: RecordsClient;
  database: boolean;
  askConfirm: (next: PendingConfirm) => void;
  onChanged: () => void;
  onClosed: () => void;
}) {
  const { t, kindLabels, kindOptions } = useRecordWords();
  const [record, setRecord] = useState<VisitRecordDetail | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState(false);
  const [kind, setKind] = useState<VisitRecordKind>("note");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    setRecord(await client.get(id));
  }, [client, id]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      reload().catch((cause: unknown) => setError(message(cause, "This record could not be opened.")));
    });
    return () => { active = false; };
  }, [reload]);

  // A new file is virus-checked before anyone can open or share it: look again until the check is done.
  const checking = Boolean(record?.files.some((file) => file.scanStatus === "pending"));
  useEffect(() => {
    if (!checking) return;
    const timer = window.setInterval(() => void reload().catch(() => undefined), 4_000);
    return () => window.clearInterval(timer);
  }, [checking, reload]);

  async function act(action: () => Promise<void>, fallback: string) {
    setPending(true);
    setError("");
    try {
      await action();
      await reload();
      onChanged();
    } catch (cause: unknown) {
      setError(message(cause, fallback));
    } finally {
      setPending(false);
    }
  }

  if (!record) {
    return (
      <>
        <DrawerHeader><DrawerTitle>Record</DrawerTitle></DrawerHeader>
        <DrawerPanel>
          {error ? <Alert variant="error" role="alert"><AlertDescription>{error}</AlertDescription></Alert> : <Skeleton className="h-40 w-full" />}
        </DrawerPanel>
      </>
    );
  }

  const isDraft = record.status === "draft";

  const startEditing = () => {
    setKind(record.kind);
    setTitle(record.title);
    setBody(record.body);
    setEditing(true);
  };

  const share = () => askConfirm({
    title: `Share with ${record.patientName}?`,
    description: `It appears in their ${t.customer} portal straight away. Withdraw it later if you need to change it.`,
    action: "Share",
    run: async () => {
      await client.share(record.id);
      await reload();
      onChanged();
      toastManager.add({
        title: `Shared with ${record.patientName}`,
        description: database ? `It's in their portal, and ${t.aCustomer} update is queued.` : "It's in their portal.",
        type: "success",
      });
    },
  });

  const withdraw = () => askConfirm({
    title: "Withdraw from the portal?",
    description: `${record.patientName} won't see this any more. It goes back to draft and stays on file.`,
    action: "Withdraw",
    destructive: true,
    run: async () => {
      await client.withdraw(record.id);
      await reload();
      onChanged();
    },
  });

  const remove = () => askConfirm({
    title: "Delete this draft?",
    description: "It was never shared, so it can be deleted. This can't be undone.",
    action: "Delete draft",
    destructive: true,
    run: async () => {
      await client.remove(record.id);
      onClosed();
    },
  });

  if (editing) {
    return (
      <form className="contents" onSubmit={(event) => {
        event.preventDefault();
        void act(async () => {
          await client.edit(record.id, { kind, title: title.trim(), body });
          setEditing(false);
        }, "The record could not be saved.");
      }}>
        <DrawerHeader>
          <DrawerTitle>Edit draft</DrawerTitle>
          <DrawerDescription>{record.patientName}</DrawerDescription>
        </DrawerHeader>
        <DrawerPanel className="flex flex-col gap-4">
          {error ? <Alert variant="error" role="alert"><AlertDescription>{error}</AlertDescription></Alert> : null}
          <SelectField id="record-edit-kind" label="Type" value={kind} onValueChange={(next) => setKind(next as VisitRecordKind)} options={kindOptions} />
          <TextField id="record-edit-title" label="Title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} required />
          <TextareaField id="record-edit-body" label="Note" optional rows={8} value={body} onChange={(event) => setBody(event.target.value)} maxLength={maxRecordBodyLength} />
        </DrawerPanel>
        <DrawerFooter className="flex-row items-center justify-between sm:justify-between">
          <Button type="button" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
          <Button type="submit" disabled={pending || !title.trim()}>
            {pending ? <Spinner aria-hidden="true" /> : null}
            Save
          </Button>
        </DrawerFooter>
      </form>
    );
  }

  return (
    <>
      <DrawerHeader>
        <DrawerTitle>{record.title}</DrawerTitle>
        <DrawerDescription>
          {[record.patientName, kindLabels[record.kind], record.practitionerName].filter(Boolean).join(" · ")}
        </DrawerDescription>
        <div>
          <Badge variant={isDraft ? "outline" : "success"}>{isDraft ? (record.everShared ? "Draft, withdrawn from portal" : "Draft, only staff can see this") : `Shared ${day(record.sharedAt ?? record.createdAt)}`}</Badge>
        </div>
      </DrawerHeader>
      <DrawerPanel className="flex flex-col gap-5">
        {error ? <Alert variant="error" role="alert"><AlertDescription>{error}</AlertDescription></Alert> : null}
        {record.body ? <p className="text-sm whitespace-pre-wrap">{record.body}</p> : <p className="text-sm text-muted-foreground">No note written.</p>}
        <section className="flex flex-col gap-2" aria-label="Files">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium">Files</h3>
            {isDraft ? (
              <>
                <input
                  ref={fileInput}
                  type="file"
                  accept={recordFileAccept}
                  className="sr-only"
                  tabIndex={-1}
                  aria-label="Choose a file to upload"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void act(() => client.addFile(record.id, file), "The file could not be uploaded.");
                  }}
                />
                <Button variant="outline" size="sm" disabled={pending} onClick={() => fileInput.current?.click()}>
                  {pending ? <Spinner aria-hidden="true" /> : <FileUp aria-hidden="true" />}
                  Add file
                </Button>
              </>
            ) : null}
          </div>
          {record.files.length ? (
            <RecordFileList
              files={record.files}
              hrefFor={(file) => client.fileHref(record.id, file)}
              disabled={pending}
              onRemove={isDraft ? (file) => void act(() => client.removeFile(record.id, file.id), "The file could not be removed.") : undefined}
            />
          ) : <p className="text-sm text-muted-foreground">{isDraft ? "PDF, PNG or JPEG, up to 15 MB." : "No files."}</p>}
        </section>
        {record.accessLog ? (
          <Accordion>
            <AccordionItem value="log">
              <AccordionTrigger>Access log</AccordionTrigger>
              <AccordionPanel>
                <ul className="flex flex-col gap-2">
                  {record.accessLog.map((entry) => (
                    <li key={entry.id} className="flex flex-wrap justify-between gap-x-3 text-sm">
                      <span><span className="font-medium">{entry.who}</span> <span className="text-muted-foreground">{entry.action.toLowerCase()}</span></span>
                      <span className="text-xs text-muted-foreground">{dayTime(entry.occurredAt)}</span>
                    </li>
                  ))}
                </ul>
              </AccordionPanel>
            </AccordionItem>
          </Accordion>
        ) : null}
      </DrawerPanel>
      <DrawerFooter className="flex-row items-center justify-between sm:justify-between">
        {isDraft ? (
          <>
            {record.everShared ? <span /> : <Button variant="ghost" onClick={remove} disabled={pending}>Delete</Button>}
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={startEditing} disabled={pending}>Edit</Button>
              <Button onClick={share} disabled={pending || checking}><Send aria-hidden="true" /> Share with {t.customer}</Button>
            </div>
          </>
        ) : (
          <Button variant="outline" className="ms-auto" onClick={withdraw} disabled={pending}><Undo2 aria-hidden="true" /> Withdraw</Button>
        )}
      </DrawerFooter>
    </>
  );
}
