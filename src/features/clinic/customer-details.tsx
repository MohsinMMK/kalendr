"use client";

import { Plus } from "lucide-react";
import { useState } from "react";

import { SelectField, TextField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Fieldset, FieldsetLegend } from "@/components/ui/fieldset";
import { Field, FieldLabel } from "@/components/ui/field";
import { Card, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import type { CustomerFieldDefinition } from "@/lib/customer-contracts";
import { encodeMultiValue, parseMultiValue } from "@/lib/customer-field-values";
import { formatMoney } from "@/lib/money";

import { CustomFieldDialog } from "./custom-field-dialog";
import { FieldValueView } from "./custom-field-cell";
import { useCustomerChanged } from "./customer-dialogs";
import { errorText, ListSkeleton, LoadFailed } from "./customer-parts";
import { useCustomerSummary, useFieldDefinitions, useFieldValues } from "./queries/customers";
import { staffMutation, StaffApiError } from "./queries/http";
import { useStaffAccess } from "./staff-access";
import { Fact } from "./task-ui";

function FieldInput({ definition, value, error, onChange }: { definition: CustomerFieldDefinition; value: string; error?: string; onChange: (value: string) => void }) {
  if (definition.kind === "choice") {
    return <SelectField label={definition.label} value={value} error={error} onValueChange={onChange} placeholder="Not set" options={[{ value: "", label: "Not set" }, ...definition.choices.map((choice) => ({ value: choice, label: choice }))]} />;
  }
  if (definition.kind === "boolean") {
    return <SelectField label={definition.label} value={value} error={error} onValueChange={onChange} placeholder="Not set" options={[{ value: "", label: "Not set" }, { value: "true", label: "Yes" }, { value: "false", label: "No" }]} />;
  }
  if (definition.kind === "multichoice") {
    const picked = parseMultiValue(value);
    return (
      <Fieldset>
        <FieldsetLegend className="font-medium text-sm">{definition.label}</FieldsetLegend>
        <div className="flex flex-col gap-1">
          {definition.choices.map((choice) => (
            <label key={choice} className="flex min-h-8 items-center gap-2 text-sm">
              <Checkbox checked={picked.includes(choice)} onCheckedChange={(checked) => onChange(encodeMultiValue(definition.choices.filter((item) => (item === choice ? checked : picked.includes(item)))))} />
              {choice}
            </label>
          ))}
        </div>
        {error ? <p role="alert" className="text-destructive-foreground text-xs">{error}</p> : null}
      </Fieldset>
    );
  }
  const type = definition.kind === "date" ? "date" : definition.kind === "email" ? "email" : definition.kind === "phone" ? "tel" : definition.kind === "link" ? "url" : "text";
  return <TextField label={definition.label} type={type} inputMode={definition.kind === "number" ? "decimal" : undefined} value={value} error={error} maxLength={500} onChange={(event) => onChange(event.target.value)} />;
}

/** A saved answer as a person reads it; links, phone numbers and emails stay followable. */
function FieldAnswer({ definition, value }: { definition: CustomerFieldDefinition; value: string }) {
  return value ? <FieldValueView definition={definition} value={value} /> : <span className="text-muted-foreground">Not set</span>;
}

/** The extra details a business keeps, plus the money and messaging facts that explain how this customer behaves. */
export function CustomerDetails({ patientId }: { patientId: string }) {
  const t = useTerms();
  const access = useStaffAccess();
  const changed = useCustomerChanged();
  const summary = useCustomerSummary(patientId);
  const definitions = useFieldDefinitions();
  const values = useFieldValues(patientId);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const canEdit = access.can("customers.manage");
  // Defining the business's own fields is for owners and admins; everyone who may edit a customer fills the answers in.
  const canDefine = access.role === "owner" || access.role === "admin";

  // What is saved, with the person's unsaved edits laid over it.
  const saved = Object.fromEntries((values.data ?? []).map((entry) => [entry.fieldId, entry.value]));
  const current = (id: string) => draft[id] ?? saved[id] ?? "";

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setErrors({}); setMessage(""); setBusy(true);
    try {
      const sent = Object.fromEntries((definitions.data ?? []).map((definition) => {
        const text = current(definition.id).trim();
        return [definition.id, text && !(definition.kind === "multichoice" && parseMultiValue(text).length === 0) ? text : null];
      }));
      await staffMutation(`/api/staff/customers/${encodeURIComponent(patientId)}/fields`, "PUT", { values: sent });
      changed();
      toastManager.add({ title: "Details saved", type: "success" });
    } catch (cause: unknown) {
      if (cause instanceof StaffApiError && Object.keys(cause.fieldErrors).length > 0) setErrors(Object.fromEntries(Object.entries(cause.fieldErrors).map(([id, list]) => [id, list[0] ?? ""])));
      else setMessage(errorText(cause, "The details could not be saved. Try again."));
    } finally {
      setBusy(false);
    }
  }

  const data = summary.data;
  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle render={<h2 />} className="text-sm">How they behave</CardTitle></CardHeader>
        <CardPanel>
          {summary.isPending ? <ListSkeleton label="Loading figures" rows={2} /> : null}
          {summary.isError ? <LoadFailed message="The figures could not be loaded." onRetry={() => void summary.refetch()} /> : null}
          {data ? (
            <dl className="grid gap-4 sm:grid-cols-2">
              {data.lifetimeValueMinor !== null ? <Fact label="Lifetime value"><span className="tabular-nums">{formatMoney(data.lifetimeValueMinor, data.currency)}</span><span className="block text-muted-foreground text-xs">Paid, less refunds</span></Fact> : null}
              <Fact label={`Average gap between ${t.appointments}`}>{data.averageGapDays === null ? "Not enough visits yet" : <span className="tabular-nums">{data.averageGapDays} days</span>}</Fact>
              <Fact label="Marketing messages">{data.marketingConsent ? "Agreed" : "Has not agreed"}</Fact>
              <Fact label={`${t.Appointments} done`}><span className="tabular-nums">{data.visits}</span>, {data.noShows} {data.noShows === 1 ? "no-show" : "no-shows"}</Fact>
            </dl>
          ) : null}
        </CardPanel>
      </Card>
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle render={<h2 />} className="text-sm">Extra details</CardTitle>
          {canDefine ? <Button size="sm" variant="outline" onClick={() => setAdding(true)}><Plus aria-hidden="true" />Add a field</Button> : null}
        </CardHeader>
        <CardPanel>
          {definitions.isPending || values.isPending ? <ListSkeleton label="Loading details" rows={2} /> : null}
          {definitions.isError || values.isError ? <LoadFailed message="The details could not be loaded." onRetry={() => { void definitions.refetch(); void values.refetch(); }} /> : null}
          {definitions.isSuccess && values.isSuccess && definitions.data.length === 0 ? (
            <p className="text-muted-foreground text-sm">{canDefine ? `No extra details yet. Add a field to keep something your business needs for every ${t.customer}.` : "Your business has not added any extra details."}</p>
          ) : null}
          {definitions.isSuccess && values.isSuccess && definitions.data.length > 0 ? (
            <form className="flex flex-col gap-4" aria-label="Extra details" noValidate onSubmit={(event) => void save(event)}>
              {message ? <Alert variant="error"><AlertDescription>{message}</AlertDescription></Alert> : null}
              {definitions.data.map((definition) => (
                canEdit
                  ? <FieldInput key={definition.id} definition={definition} value={current(definition.id)} error={errors[definition.id]} onChange={(next) => setDraft((current) => ({ ...current, [definition.id]: next }))} />
                  : <Field key={definition.id}><FieldLabel>{definition.label}</FieldLabel><div className="text-sm"><FieldAnswer definition={definition} value={current(definition.id)} /></div></Field>
              ))}
              {canEdit ? <Button type="submit" className="self-start" disabled={busy}>{busy ? <Spinner /> : null}Save details</Button> : null}
            </form>
          ) : null}
        </CardPanel>
      </Card>
      <CustomFieldDialog open={adding} onOpenChange={setAdding} />
    </div>
  );
}


