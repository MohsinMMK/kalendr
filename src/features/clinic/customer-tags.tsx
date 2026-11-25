"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Plus, Tag } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import { MAX_TAGS_PER_CUSTOMER, tagColors, type CustomerTag, type TagColor } from "@/lib/customer-contracts";

import { errorText, TagChip, tagDots } from "./customer-parts";
import { customerKeys, useCustomerTags } from "./queries/customers";
import { staffMutation } from "./queries/http";
import { useCustomerChanged } from "./customer-dialogs";
import { ScrollAreaPrimitive, ScrollBar } from "@/components/ui/scroll-area";

/**
 * The tags on one customer as chips, with a dropdown to pick from the business's tags or make a new one on the spot.
 * Choosing sets the whole set at once, so two people editing never leave a half-applied list.
 */
export function CustomerTagsEditor({ patientId, current, canEdit }: { patientId: string; current: Omit<CustomerTag, "count">[]; canEdit: boolean }) {
  const [open, setOpen] = useState(false);
  const t = useTerms();
  const [name, setName] = useState("");
  const [color, setColor] = useState<TagColor>("blue");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const tags = useCustomerTags(open);
  const client = useQueryClient();
  const changed = useCustomerChanged();
  const selected = new Set(current.map((tag) => tag.id));

  async function save(ids: string[]) {
    setBusy(true); setMessage("");
    try {
      await staffMutation(`/api/staff/customers/${encodeURIComponent(patientId)}/tags`, "PUT", { tagIds: ids });
      changed();
    } catch (cause: unknown) {
      setMessage(errorText(cause, "The tags could not be saved. Try again."));
    } finally {
      setBusy(false);
    }
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true); setMessage("");
    try {
      const created = await staffMutation<CustomerTag>("/api/staff/customer-tags", "POST", { name: name.trim(), color });
      await client.invalidateQueries({ queryKey: customerKeys.tags() });
      setName("");
      if (selected.size < MAX_TAGS_PER_CUSTOMER) await save([...selected, created.id]);
      else toastManager.add({ title: "Tag created", description: `Each ${t.customer} can have up to ${MAX_TAGS_PER_CUSTOMER} tags.`, type: "info" });
    } catch (cause: unknown) {
      setMessage(errorText(cause, "The tag could not be made. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="customer-tags">
      {current.map((tag) => <TagChip key={tag.id} name={tag.name} color={tag.color} />)}
      {current.length === 0 && !canEdit ? <span className="text-muted-foreground text-sm">No tags</span> : null}
      {canEdit ? (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger render={<Button size="sm" variant="ghost" className="min-h-11 sm:min-h-7" />}><Tag aria-hidden="true" />{current.length ? "Edit tags" : "Add a tag"}</PopoverTrigger>
          <PopoverPopup align="start" className="w-72">
            <div className="flex flex-col gap-3">
              <p className="font-medium text-sm">Tags</p>
              {tags.isPending ? <div role="status" aria-label="Loading tags" className="flex items-center gap-2 text-muted-foreground text-sm"><Spinner />Loading…</div> : null}
              {tags.isError ? <p className="text-destructive-foreground text-sm">The tags could not be loaded. <button type="button" className="underline" onClick={() => void tags.refetch()}>Try again</button></p> : null}
              {tags.data?.length === 0 ? <p className="text-muted-foreground text-sm">No tags yet. Make the first one below.</p> : null}
              <ScrollAreaPrimitive.Root><ScrollAreaPrimitive.Viewport data-slot="scroll-area-viewport" className="max-h-56 rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"><ScrollAreaPrimitive.Content style={{ minWidth: 0 }}><ul aria-label="Choose tags" className="flex flex-col">
                {tags.data?.map((tag) => (
                  <li key={tag.id}>
                    <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-1 hover:bg-accent sm:min-h-8">
                      <Checkbox checked={selected.has(tag.id)} disabled={busy} onCheckedChange={(checked) => void save(checked ? [...selected, tag.id] : [...selected].filter((id) => id !== tag.id))} />
                      <span aria-hidden="true" className={`size-2 rounded-full ${tagDots[tag.color]}`} />
                      <span className="min-w-0 flex-1 truncate text-sm">{tag.name}</span>
                      <span className="text-muted-foreground text-xs tabular-nums">{tag.count}</span>
                    </label>
                  </li>
                ))}
              </ul></ScrollAreaPrimitive.Content></ScrollAreaPrimitive.Viewport><ScrollBar orientation="vertical" /></ScrollAreaPrimitive.Root>
              <form onSubmit={(event) => void create(event)} className="flex flex-col gap-2 border-t pt-3" aria-label="Make a tag">
                <Input aria-label="New tag name" placeholder="New tag, like VIP" maxLength={40} value={name} onChange={(event) => setName(event.target.value)} />
                <div role="radiogroup" aria-label="Tag colour" className="flex flex-wrap gap-1">
                  {tagColors.map((option) => (
                    <button key={option} type="button" role="radio" aria-checked={color === option} aria-label={option} onClick={() => setColor(option)}
                      className={`flex size-7 items-center justify-center rounded-full border-2 pointer-coarse:size-11 ${color === option ? "border-foreground" : "border-transparent"}`}>
                      <span className={`size-4 rounded-full ${tagDots[option]}`} />
                    </button>
                  ))}
                </div>
                <Button type="submit" size="sm" variant="outline" disabled={busy || !name.trim()}><Plus aria-hidden="true" />Make and add</Button>
              </form>
              {message ? <p role="alert" className="text-destructive-foreground text-xs">{message}</p> : null}
            </div>
          </PopoverPopup>
        </Popover>
      ) : null}
    </div>
  );
}
