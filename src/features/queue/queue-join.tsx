"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { DoorClosed, Users } from "lucide-react";

import { OptionSelect, PhoneField, TextField } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Card, CardPanel } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { doorJoinInputSchema, type QueueJoinView } from "@/lib/queue-door-contracts";

const ANYONE = "";

/** The page behind the QR code at the door: a first name and a phone number, and you have a token. */
export function QueueJoin({ token, initial }: { token: string; initial: QueueJoinView }) {
  const router = useRouter();
  const [firstName, setFirstName] = useState("");
  const [phone, setPhone] = useState("");
  const [practitionerId, setPractitionerId] = useState(ANYONE);
  const [notify, setNotify] = useState(true);
  const [errors, setErrors] = useState<Partial<Record<"firstName" | "phone" | "form", string>>>({});
  const [sending, setSending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = doorJoinInputSchema.safeParse({ firstName, phone, practitionerId: practitionerId || undefined, notify });
    if (!parsed.success) {
      const next: typeof errors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if ((key === "firstName" || key === "phone") && !next[key]) next[key] = issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    setSending(true);
    try {
      const response = await fetch(`/api/public/queue/join/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const body = (await response.json().catch(() => null)) as { data?: { ticketPath: string }; error?: { message?: string } } | null;
      if (!response.ok || !body?.data) throw new Error(body?.error?.message ?? "That didn't go through. Please try again.");
      router.replace(body.data.ticketPath);
    } catch (cause: unknown) {
      setErrors({ form: cause instanceof Error ? cause.message : "That didn't go through. Please try again." });
      setSending(false);
    }
  }

  if (!initial.open) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 p-6 text-center">
        <DoorClosed aria-hidden="true" className="size-8 text-muted-foreground" />
        <h1 className="text-xl font-semibold">{initial.closed ? "The queue is closed for today" : "Joining from the door isn't open right now"}</h1>
        <p className="text-muted-foreground">Please ask at the front desk at {initial.locationName}.</p>
      </main>
    );
  }
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-4 p-5">
      <header>
        <h1 className="font-heading text-xl font-semibold">Join the queue</h1>
        <p className="text-sm text-muted-foreground">{initial.businessName} · {initial.locationName}</p>
        <p className="mt-2 flex items-center gap-2 text-sm">
          <Users aria-hidden="true" className="size-4 text-muted-foreground" />
          {initial.waitingCount === 0 ? "Nobody is waiting" : `${initial.waitingCount} waiting now`}
        </p>
      </header>
      <Card>
        <CardPanel>
          <form noValidate onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
            <TextField
              label="First name"
              name="firstName"
              autoComplete="given-name"
              value={firstName}
              onChange={(event) => setFirstName(event.target.value)}
              error={errors.firstName}
              hint="Only staff see your name. The screen shows your token number."
              required
            />
            <PhoneField label="Phone number" value={phone} onChange={setPhone} error={errors.phone} autoComplete="tel" required />
            {initial.practitioners.length > 1 ? (
              <Field>
                <FieldLabel id="queue-join-who">Who would you like to see?</FieldLabel>
                <OptionSelect
                  aria-labelledby="queue-join-who"
                  value={practitionerId}
                  onValueChange={setPractitionerId}
                  options={[{ value: ANYONE, label: "First available" }, ...initial.practitioners.map((item) => ({ value: item.id, label: item.name }))]}
                />
              </Field>
            ) : null}
            <Label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg">
              <Checkbox className="mt-0.5" checked={notify} onCheckedChange={(checked) => setNotify(checked)} />
              <span className="flex flex-col gap-0.5">
                <span>Message me when I&apos;m nearly next</span>
                <span className="text-xs font-normal text-muted-foreground">So you can wait outside. One message, about this visit only.</span>
              </span>
            </Label>
            {errors.form ? <p role="alert" className="text-sm text-destructive-foreground">{errors.form}</p> : null}
            <Button type="submit" size="lg" className="min-h-11" loading={sending}>Get my token</Button>
          </form>
        </CardPanel>
      </Card>
    </main>
  );
}
