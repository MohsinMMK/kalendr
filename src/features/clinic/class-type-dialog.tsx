"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { TriangleAlert } from "lucide-react";

import { TextareaField, TextField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { CheckboxGroup } from "@/components/ui/checkbox-group";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import { classTypeSchema } from "@/lib/classes-contracts";
import { amountInputValue, parseAmountInput } from "@/lib/money";

import { classKeys, createClassType } from "./class-model";
import { useCatalogLookups } from "./clinic-catalog";

function Choices({ legend, items, value, onChange }: { legend: string; items: Array<{ id: string; name: string }>; value: string[]; onChange: (next: string[]) => void }) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 font-medium text-base/4.5 sm:text-sm/4">{legend}</legend>
      <CheckboxGroup aria-label={legend} value={value} onValueChange={onChange} className="gap-1">
        {items.map((item) => (
          <Label key={item.id} className="flex min-h-11 w-full items-center gap-3 rounded-lg border px-3 sm:min-h-9">
            <Checkbox value={item.id} />
            <span className="truncate">{item.name}</span>
          </Label>
        ))}
      </CheckboxGroup>
    </fieldset>
  );
}

/** "New class": what it is called, how long it runs, how many seats, where and who teaches it. */
export function ClassTypeDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (serviceId: string) => void }) {
  const t = useTerms();
  const lookups = useCatalogLookups();
  const queryClient = useQueryClient();
  const currency = lookups.clinic.currency ?? "INR";
  const places = lookups.locations.filter((place) => place.isActive !== false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [minutes, setMinutes] = useState("60");
  const [seats, setSeats] = useState("10");
  const [price, setPrice] = useState("");
  const [locationIds, setLocationIds] = useState<string[]>(places.length === 1 ? [places[0]!.id] : []);
  const [practitionerIds, setPractitionerIds] = useState<string[]>(lookups.practitioners.length === 1 ? [lookups.practitioners[0]!.id] : []);
  const [room, setRoom] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const priceMinor = price.trim() === "" ? null : parseAmountInput(price);
  const priceBad = price.trim() !== "" && priceMinor === null;

  async function submit() {
    setError("");
    const parsed = classTypeSchema.safeParse({
      name, description, durationMinutes: Number(minutes), capacity: Number(seats), priceMinor, locationIds, practitionerIds, requiredResourceKind: room ? "room" : null,
    });
    if (priceBad || !parsed.success) {
      setError(priceBad ? `Write the price as a number, like ${amountInputValue(80000)}.` : "Give the class a name, a length of 10 to 480 minutes, seats of 1 to 500, and choose at least one place and one teacher.");
      return;
    }
    setPending(true);
    try {
      const created = await createClassType(parsed.data);
      await queryClient.invalidateQueries({ queryKey: classKeys.types });
      toastManager.add({ title: "Class added", description: "Now add a session for it.", type: "success" });
      onCreated(created.serviceId);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "The class could not be saved.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(next) => { if (!next && !pending) onClose(); }}>
      <DialogPopup showCloseButton={!pending}>
        <form onSubmit={(event) => { event.preventDefault(); if (!pending) void submit(); }} className="contents" noValidate>
          <DialogHeader>
            <DialogTitle>New class</DialogTitle>
            <DialogDescription>A class is something you run for a group, like yoga or a workshop. Sessions are added next.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            {error ? <Alert variant="error" role="alert"><TriangleAlert aria-hidden="true" /><AlertDescription>{error}</AlertDescription></Alert> : null}
            <TextField label="Name" autoComplete="off" value={name} onChange={(event) => setName(event.target.value)} />
            <TextareaField label="Description" optional value={description} maxLength={1000} onChange={(event) => setDescription(event.target.value)} />
            <div className="grid gap-4 sm:grid-cols-3">
              <TextField label="Length (minutes)" type="number" inputMode="numeric" min={10} max={480} value={minutes} onChange={(event) => setMinutes(event.target.value)} />
              <TextField label="Seats" type="number" inputMode="numeric" min={1} max={500} value={seats} onChange={(event) => setSeats(event.target.value)} />
              <TextField label={`Price (${currency})`} optional inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} error={priceBad ? "Write it as a number." : undefined} />
            </div>
            <Choices legend={`Places (${t.locations})`} items={places} value={locationIds} onChange={setLocationIds} />
            <Choices legend="Teachers" items={lookups.practitioners} value={practitionerIds} onChange={setPractitionerIds} />
            <Label className="flex min-h-11 items-center justify-between gap-3 rounded-lg border px-3">
              <span>A room is needed</span>
              <Switch checked={room} onCheckedChange={setRoom} />
            </Label>
          </DialogPanel>
          <DialogFooter>
            <DialogClose disabled={pending} render={<Button type="button" variant="ghost" />}>Not now</DialogClose>
            <Button type="submit" loading={pending}>Add class</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
