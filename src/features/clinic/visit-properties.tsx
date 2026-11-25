"use client";

import { useState, type KeyboardEvent, type ReactNode } from "react";
import {
  Accessibility, Activity, ArrowDown, ArrowUp, Baby, Bell, Bookmark, Briefcase, Calendar, Car, Check, CircleDot, Clock,
  DoorOpen, Eye, EyeOff, FileText, Flag, Folder, Gift, Hash, Heart, House, Inbox, Languages, Layers, Link as LinkIcon, List, Lock, Mail,
  MapPin, MessageSquare, Percent, Phone, Pill, Plus, RotateCcw, Scissors, Search, Shield, Smile, Sparkles, SquareCheck, Star, Stethoscope,
  StickyNote, Tag, Tags, Thermometer, Trash2, TriangleAlert, Type, User, Users, Wallet, X, Zap, type LucideIcon,
} from "lucide-react";

import { InlineDatePicker } from "@/components/date-picker";
import { inlineInputClass, inlineTriggerClass } from "@/components/inline-field";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { NumberField, NumberFieldDecrement, NumberFieldGroup, NumberFieldIncrement, NumberFieldInput } from "@/components/ui/number-field";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { arrangeList, moveInList } from "@/lib/workspace-layout";
import { cn } from "@/lib/utils";
import {
  fieldColors,
  fieldIconNames,
  isEmptyFieldValue,
  newFieldId,
  visitFieldSet,
  type CustomField,
  type CustomFieldType,
  type CustomFieldValue,
  type FieldColor,
  type FieldIconName,
  type FieldOption,
  type FieldSet,
} from "@/lib/visit-fields";

import { useFieldSet } from "./workspace-layout-provider";

export const fieldIcons: Record<FieldIconName, LucideIcon> = {
  "circle-dot": CircleDot, hash: Hash, clock: Clock, calendar: Calendar, user: User, users: Users, stethoscope: Stethoscope,
  "door-open": DoorOpen, layers: Layers, inbox: Inbox, "file-text": FileText, wallet: Wallet, "message-square": MessageSquare,
  "sticky-note": StickyNote, tag: Tag, tags: Tags, list: List, "check-square": SquareCheck, flag: Flag, star: Star, heart: Heart,
  alert: TriangleAlert, pill: Pill, baby: Baby, shield: Shield, "map-pin": MapPin, phone: Phone, mail: Mail, link: LinkIcon, type: Type,
  bookmark: Bookmark, folder: Folder, activity: Activity, thermometer: Thermometer, smile: Smile, sparkles: Sparkles, zap: Zap,
  briefcase: Briefcase, scissors: Scissors, car: Car, home: House, gift: Gift, percent: Percent, languages: Languages,
  accessibility: Accessibility, eye: Eye, bell: Bell, lock: Lock,
};

export function FieldIcon({ name, className }: { name: FieldIconName; className?: string }) {
  const Icon = fieldIcons[name] ?? CircleDot;
  return <Icon aria-hidden="true" className={cn("size-3.5 shrink-0", className)} />;
}

export const fieldTypeInfo: Record<CustomFieldType, { label: string; icon: FieldIconName; hint: string }> = {
  select: { label: "Select", icon: "tag", hint: "One choice, like a category" },
  multi_select: { label: "Multi-select", icon: "tags", hint: "Several choices, like tags" },
  text: { label: "Text", icon: "type", hint: "A short note" },
  checkbox: { label: "Checkbox", icon: "check-square", hint: "Yes or no" },
  number: { label: "Number", icon: "hash", hint: "A count or amount" },
  date: { label: "Date", icon: "calendar", hint: "A day" },
};

/** Soft colours for options, readable in light and dark. */
export const optionTone: Record<FieldColor, string> = {
  gray: "bg-muted text-foreground/80",
  blue: "bg-blue-500/14 text-blue-800 dark:text-blue-200",
  green: "bg-emerald-500/14 text-emerald-800 dark:text-emerald-200",
  yellow: "bg-amber-400/22 text-amber-900 dark:text-amber-200",
  orange: "bg-orange-500/16 text-orange-800 dark:text-orange-200",
  red: "bg-red-500/14 text-red-800 dark:text-red-200",
  purple: "bg-violet-500/14 text-violet-800 dark:text-violet-200",
  pink: "bg-pink-500/14 text-pink-800 dark:text-pink-200",
};
const dotTone: Record<FieldColor, string> = {
  gray: "bg-muted-foreground/60", blue: "bg-blue-500", green: "bg-emerald-500", yellow: "bg-amber-400",
  orange: "bg-orange-500", red: "bg-red-500", purple: "bg-violet-500", pink: "bg-pink-500",
};
const colorNames: Record<FieldColor, string> = { gray: "Gray", blue: "Blue", green: "Green", yellow: "Yellow", orange: "Orange", red: "Red", purple: "Purple", pink: "Pink" };

export function OptionChip({ option }: { option: FieldOption }) {
  return <span className={cn("inline-flex max-w-full items-center truncate rounded-sm px-1.5 py-0.5 text-xs leading-4 font-medium", optionTone[option.color])}>{option.label}</span>;
}

/** A property this business ships with, such as Service or Time. */
export interface BuiltInProperty {
  id: string;
  label: string;
  icon: FieldIconName;
  /** Some properties, like Status, are always shown. */
  required?: boolean;
}

/** A property as the business arranged it. */
export interface VisitProperty {
  id: string;
  label: string;
  icon: FieldIconName;
  hidden: boolean;
  /** Set for built-in properties; the name to go back to. */
  defaultLabel?: string;
  required?: boolean;
  /** Set for the business's own properties. */
  custom?: CustomField;
}

export interface PropertyEditor {
  rename: (property: VisitProperty, name: string) => void;
  setIcon: (property: VisitProperty, icon: FieldIconName) => void;
  setHidden: (property: VisitProperty, hidden: boolean) => void;
  move: (property: VisitProperty, direction: -1 | 1) => void;
  add: (type: CustomFieldType, name: string) => CustomField | null;
  change: (field: CustomField) => void;
  remove: (property: VisitProperty) => void;
}

export interface VisitProperties {
  shown: VisitProperty[];
  hidden: VisitProperty[];
  all: VisitProperty[];
  /** The business's own properties, by id. */
  custom: CustomField[];
  canEdit: boolean;
  editor: PropertyEditor;
}

function without<T>(list: T[] | undefined, item: T): T[] | undefined {
  const next = (list ?? []).filter((entry) => entry !== item);
  return next.length ? next : undefined;
}

function withoutKey<V>(record: Record<string, V> | undefined, key: string): Record<string, V> | undefined {
  if (!record || !(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return Object.keys(next).length ? next : undefined;
}

/**
 * The properties of a visit, Notion style: the built-in ones in `builtIns`, then the business's own, in the
 * order, names and icons the business chose. Owners and admins can change them; the change is saved for the team.
 */
export function useVisitProperties(builtIns: BuiltInProperty[]): VisitProperties {
  const { fieldSet, canEdit, update } = useFieldSet(visitFieldSet);
  const custom = fieldSet.custom ?? [];
  const items: Omit<VisitProperty, "hidden">[] = [
    ...builtIns.map((item) => ({
      id: item.id,
      label: fieldSet.labels?.[item.id] ?? item.label,
      icon: fieldSet.icons?.[item.id] ?? item.icon,
      defaultLabel: item.label,
      required: item.required,
    })),
    ...custom.map((field) => ({ id: field.id, label: field.name, icon: field.icon ?? fieldTypeInfo[field.type].icon, custom: field })),
  ];
  const arranged = arrangeList(items, { order: fieldSet.order, hidden: fieldSet.hidden });
  const all = arranged.map(({ item, hidden }) => ({ ...item, hidden: hidden && !item.required }));

  const save = (next: FieldSet) => update(next);
  const editor: PropertyEditor = {
    rename(property, name) {
      const clean = name.trim().slice(0, 40);
      if (!clean || clean === property.label) return;
      if (property.custom) {
        save({ ...fieldSet, custom: custom.map((field) => (field.id === property.id ? { ...field, name: clean } : field)) });
        return;
      }
      save({ ...fieldSet, labels: clean === property.defaultLabel ? withoutKey(fieldSet.labels, property.id) : { ...fieldSet.labels, [property.id]: clean } });
    },
    setIcon(property, icon) {
      if (property.custom) {
        save({ ...fieldSet, custom: custom.map((field) => (field.id === property.id ? { ...field, icon } : field)) });
        return;
      }
      const builtIn = builtIns.find((item) => item.id === property.id);
      save({ ...fieldSet, icons: builtIn?.icon === icon ? withoutKey(fieldSet.icons, property.id) : { ...fieldSet.icons, [property.id]: icon } });
    },
    setHidden(property, hidden) {
      if (property.required) return;
      save({ ...fieldSet, hidden: hidden ? [...(fieldSet.hidden ?? []).filter((id) => id !== property.id), property.id] : without(fieldSet.hidden, property.id) });
    },
    move(property, direction) {
      const ids = all.map((item) => item.id);
      const moved = moveInList(ids, property.id, direction);
      // Keep the place of properties this screen does not show, like Location on the booking sheet.
      const others = (fieldSet.order ?? []).filter((id) => !ids.includes(id));
      save({ ...fieldSet, order: [...moved, ...others] });
    },
    add(type, name) {
      if (custom.length >= 24) return null;
      const field: CustomField = {
        id: newFieldId("cf"),
        name: name.trim().slice(0, 40) || fieldTypeInfo[type].label,
        type,
        icon: fieldTypeInfo[type].icon,
        ...(type === "select" || type === "multi_select" ? { options: [] } : {}),
      };
      save({ ...fieldSet, custom: [...custom, field] });
      return field;
    },
    change(field) {
      save({ ...fieldSet, custom: custom.map((item) => (item.id === field.id ? field : item)) });
    },
    remove(property) {
      if (!property.custom) return;
      save({
        ...fieldSet,
        custom: custom.filter((field) => field.id !== property.id),
        order: without(fieldSet.order, property.id),
        hidden: without(fieldSet.hidden, property.id),
      });
    },
  };

  return { shown: all.filter((item) => !item.hidden), hidden: all.filter((item) => item.hidden), all, custom, canEdit, editor };
}

/** Text that reads like text and edits in place. Saves on Enter or when focus leaves; Escape puts it back. */
export function InlineText({
  value,
  onCommit,
  placeholder = "Empty",
  label,
  multiline = false,
  maxLength,
  disabled = false,
  className,
}: {
  value: string;
  onCommit: (next: string) => Promise<boolean> | boolean | void;
  placeholder?: string;
  label: string;
  multiline?: boolean;
  maxLength?: number;
  disabled?: boolean;
  className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const shown = draft ?? value;

  async function commit() {
    if (draft === null) return;
    if (draft.trim() === value.trim()) {
      setDraft(null);
      return;
    }
    setSaving(true);
    try {
      await onCommit(draft.trim());
    } finally {
      setSaving(false);
      setDraft(null);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      setDraft(null);
      requestAnimationFrame(() => (event.target as HTMLElement).blur());
    } else if (event.key === "Enter" && (!multiline || event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      (event.target as HTMLElement).blur();
    }
  }

  const shared = {
    "aria-label": label,
    value: shown,
    placeholder: disabled ? "" : placeholder,
    maxLength,
    disabled,
    onBlur: () => void commit(),
  };
  const wrapper = cn(inlineInputClass, saving && "opacity-64", className);
  return multiline
    ? <Textarea size="sm" rows={1} className={wrapper} {...shared} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKeyDown} />
    : <Input size="sm" className={wrapper} {...shared} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKeyDown} />;
}

/** A number edited in place on the coss NumberField. Saves when committed: on Enter, a step or leaving it. */
function InlineNumber({ label, value, disabled, onCommit }: {
  label: string;
  value: number | undefined;
  disabled: boolean;
  onCommit: (next: number | null) => void;
}) {
  return (
    <NumberField
      // Starts again from the saved value whenever it changes elsewhere.
      key={value ?? "empty"}
      size="sm"
      defaultValue={value}
      disabled={disabled}
      format={{ maximumFractionDigits: 6, useGrouping: false }}
      onValueCommitted={(next) => { if (next !== (value ?? null)) onCommit(next); }}
      className="-mx-1.5 w-[calc(100%+--spacing(3))]"
    >
      <NumberFieldGroup className="group/number border-transparent bg-transparent shadow-none before:hidden not-focus-within:not-data-disabled:hover:bg-accent focus-within:bg-background dark:bg-transparent">
        <NumberFieldInput aria-label={label} placeholder={disabled ? "" : "Empty"} className="text-start in-data-[size=sm]:px-[calc(--spacing(1.5)-1px)] placeholder:text-muted-foreground/72" />
        <span className="flex opacity-0 transition-opacity group-hover/number:opacity-100 group-focus-within/number:opacity-100">
          <NumberFieldDecrement aria-label={`Decrease ${label.toLocaleLowerCase()}`} />
          <NumberFieldIncrement aria-label={`Increase ${label.toLocaleLowerCase()}`} />
        </span>
      </NumberFieldGroup>
    </NumberField>
  );
}

interface PickerItem {
  id: string;
  label: string;
  option?: FieldOption;
}

const createId = "__create__";

/**
 * Picks one option, or several, from a property's choices, on the coss Combobox with the search inside the
 * popup. Editors can add a choice by typing it.
 */
export function OptionPicker({
  field,
  value,
  onChange,
  onAddOption,
  disabled = false,
}: {
  field: CustomField;
  value: string[];
  onChange: (next: string[]) => void;
  /** Adds a choice to the property for everyone, when the person may change properties. */
  onAddOption?: (label: string) => FieldOption | null;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const options = field.options ?? [];
  const multi = field.type === "multi_select";
  const chosen = options.filter((option) => value.includes(option.id));
  const typed = query.trim();
  const exact = options.some((option) => option.label.toLocaleLowerCase() === typed.toLocaleLowerCase());
  const canCreate = Boolean(onAddOption && typed && !exact);
  const items: PickerItem[] = [
    ...options.map((option) => ({ id: option.id, label: option.label, option })),
    ...(canCreate ? [{ id: createId, label: typed }] : []),
  ];
  const selectedItems = items.filter((item) => item.option && value.includes(item.id));

  function close() {
    setOpen(false);
    setQuery("");
  }

  /** Adds the typed choice and returns its id, or nothing if it could not be added. */
  function created(): string | null {
    return onAddOption?.(typed)?.id ?? null;
  }

  function pickOne(item: PickerItem | null) {
    if (!item) return;
    const id = item.id === createId ? created() : item.id;
    if (id) onChange([id]);
    close();
  }

  function pickMany(next: PickerItem[]) {
    const ids: string[] = [];
    for (const item of next) {
      const id = item.id === createId ? created() : item.id;
      if (id && !ids.includes(id)) ids.push(id);
    }
    onChange(ids);
    setQuery("");
  }

  const trigger = (
    <ComboboxTrigger
      className={cn(inlineTriggerClass, "h-auto min-h-7 flex-wrap gap-1 py-1")}
      aria-label={`${field.name}: ${chosen.map((option) => option.label).join(", ") || "Empty"}`}
    >
      {chosen.length ? chosen.map((option) => <OptionChip key={option.id} option={option} />) : <span className="text-muted-foreground/72">{disabled ? "" : "Empty"}</span>}
    </ComboboxTrigger>
  );
  const popup = (
    <ComboboxPopup aria-label={field.name} className="w-64">
      <div className="border-b p-1.5">
        <ComboboxInput
          size="sm"
          showTrigger={false}
          startAddon={<Search />}
          aria-label={onAddOption ? "Search or add a choice" : "Search choices"}
          placeholder={onAddOption ? "Search or add a choice" : "Search"}
          className="border-transparent bg-transparent shadow-none before:hidden has-focus-visible:border-transparent has-focus-visible:ring-0"
        />
      </div>
      <ComboboxEmpty>{options.length ? "No match" : onAddOption ? "Type to add the first choice" : "No choices yet"}</ComboboxEmpty>
      <ComboboxList>
        {(item: PickerItem) => (
          <ComboboxItem key={item.id} value={item}>
            {item.option
              ? <OptionChip option={item.option} />
              : <span className="flex min-w-0 items-center gap-1.5"><Plus aria-hidden="true" className="size-4 text-muted-foreground" /><span className="truncate">Add “{item.label}”</span></span>}
          </ComboboxItem>
        )}
      </ComboboxList>
      {chosen.length ? (
        <div className="border-t p-1">
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => { onChange([]); close(); }}>
            <X aria-hidden="true" />Clear
          </Button>
        </div>
      ) : null}
    </ComboboxPopup>
  );
  const shared = {
    items,
    open,
    disabled,
    // Enter picks the first match, or adds the typed choice when nothing matches.
    autoHighlight: true,
    inputValue: query,
    onInputValueChange: (next: string) => setQuery(next),
    onOpenChange: (next: boolean) => { setOpen(next); if (!next) setQuery(""); },
    itemToStringLabel: (item: PickerItem) => item.label,
    isItemEqualToValue: (a: PickerItem, b: PickerItem) => a.id === b.id,
    // The "Add" row always shows while it is offered; choices match on their label.
    filter: (item: PickerItem, text: string) => item.id === createId || item.label.toLocaleLowerCase().includes(text.trim().toLocaleLowerCase()),
  };
  // Only a pick from the open list counts: typing on the closed trigger must never save a change.
  return multi ? (
    <Combobox<PickerItem, true> {...shared} multiple value={selectedItems} onValueChange={(next) => { if (open) pickMany(next); }}>
      {trigger}
      {popup}
    </Combobox>
  ) : (
    <Combobox<PickerItem> {...shared} value={selectedItems[0] ?? null} onValueChange={(next) => { if (open) pickOne(next); }}>
      {trigger}
      {popup}
    </Combobox>
  );
}

/** Adds a choice to a select property, in the next colour along. */
export function withNewOption(field: CustomField, label: string): { field: CustomField; option: FieldOption } | null {
  const clean = label.trim().slice(0, 40);
  const options = field.options ?? [];
  if (!clean || options.length >= 30) return null;
  const option: FieldOption = { id: newFieldId("o"), label: clean, color: fieldColors[(options.length + 1) % fieldColors.length] };
  return { field: { ...field, options: [...options, option] }, option };
}

/** Edits the value of one of the business's own properties, in place. */
export function CustomValue({
  field,
  value,
  onChange,
  editor,
  canEditProperties,
  disabled = false,
}: {
  field: CustomField;
  value: CustomFieldValue | undefined;
  onChange: (next: CustomFieldValue) => Promise<boolean> | boolean | void;
  editor: PropertyEditor;
  canEditProperties: boolean;
  disabled?: boolean;
}) {
  // Shows the new value at once while it saves.
  const [pending, setPending] = useState<{ value: CustomFieldValue } | null>(null);
  const current = pending ? pending.value : value;

  async function set(next: CustomFieldValue) {
    setPending({ value: next });
    try {
      await onChange(next);
    } finally {
      setPending(null);
    }
  }

  switch (field.type) {
    case "checkbox":
      return (
        <span className="flex h-7 items-center">
          <Checkbox aria-label={field.name} checked={current === true} disabled={disabled} onCheckedChange={(checked) => void set(Boolean(checked))} />
        </span>
      );
    case "select":
    case "multi_select": {
      const ids = Array.isArray(current) ? current : [];
      return (
        <OptionPicker
          field={field}
          value={ids}
          disabled={disabled}
          onChange={(next) => void set(next)}
          onAddOption={canEditProperties ? (label) => {
            const added = withNewOption(field, label);
            if (!added) return null;
            editor.change(added.field);
            return added.option;
          } : undefined}
        />
      );
    }
    case "number":
      return (
        <InlineNumber
          label={field.name}
          disabled={disabled}
          value={typeof current === "number" ? current : undefined}
          onCommit={(next) => void set(next === null ? "" : next)}
        />
      );
    case "date":
      return (
        <InlineDatePicker
          label={field.name}
          disabled={disabled}
          placeholder={disabled ? "" : "Empty"}
          value={typeof current === "string" ? current : ""}
          onValueChange={(next) => void set(next)}
          onClear={() => void set("")}
        />
      );
    default:
      return <InlineText label={field.name} maxLength={500} disabled={disabled} value={typeof current === "string" ? current : ""} onCommit={(text) => onChange(text)} />;
  }
}

/** Whether a property has a value worth showing to someone who cannot edit it. */
export function hasValue(value: CustomFieldValue | undefined) {
  return !isEmptyFieldValue(value);
}

function IconGrid({ value, onPick }: { value: FieldIconName; onPick: (icon: FieldIconName) => void }) {
  return (
    <div role="radiogroup" aria-label="Icon" className="grid grid-cols-8 gap-0.5 rounded-lg border p-1">
      {fieldIconNames.map((name) => (
        <button
          key={name}
          type="button"
          role="radio"
          aria-checked={value === name}
          aria-label={name.replace(/-/g, " ")}
          title={name.replace(/-/g, " ")}
          className={cn(
            "flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
            value === name && "bg-accent text-foreground",
          )}
          onClick={() => onPick(name)}
        >
          <FieldIcon name={name} className="size-4" />
        </button>
      ))}
    </div>
  );
}

function OptionsEditor({ field, onChange }: { field: CustomField; onChange: (field: CustomField) => void }) {
  const [label, setLabel] = useState("");
  const options = field.options ?? [];
  const update = (id: string, change: Partial<FieldOption>) => onChange({ ...field, options: options.map((option) => (option.id === id ? { ...option, ...change } : option)) });
  function add() {
    const added = withNewOption(field, label);
    if (!added) return;
    onChange(added.field);
    setLabel("");
  }
  return (
    <section aria-label="Choices" className="flex flex-col gap-1">
      <h4 className="px-1 text-xs font-medium text-muted-foreground">Choices</h4>
      <ul className="flex flex-col gap-0.5">
        {options.map((option) => (
          <li key={option.id} className="flex items-center gap-1">
            <Popover>
              <PopoverTrigger
                className="flex size-7 shrink-0 items-center justify-center rounded-md outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Colour of ${option.label}: ${colorNames[option.color]}`}
              >
                <span aria-hidden="true" className={cn("size-3 rounded-full", dotTone[option.color])} />
              </PopoverTrigger>
              <PopoverPopup align="start" className="w-40 [&_[data-slot=popover-viewport]]:p-1">
                <div role="radiogroup" aria-label="Colour" className="flex flex-col">
                  {fieldColors.map((color) => (
                    <button
                      key={color}
                      type="button"
                      role="radio"
                      aria-checked={option.color === color}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none hover:bg-accent focus-visible:bg-accent"
                      onClick={() => update(option.id, { color })}
                    >
                      <span aria-hidden="true" className={cn("size-3 rounded-full", dotTone[color])} />
                      <span className="flex-1 text-start">{colorNames[color]}</span>
                      {option.color === color ? <Check aria-hidden="true" className="size-4 text-muted-foreground" /> : null}
                    </button>
                  ))}
                </div>
              </PopoverPopup>
            </Popover>
            <InlineText label={`Choice ${option.label}`} value={option.label} maxLength={40} onCommit={(next) => { if (next) update(option.id, { label: next }); }} className="mx-0 w-full" />
            <Button variant="ghost" size="icon-xs" aria-label={`Remove ${option.label}`} onClick={() => onChange({ ...field, options: options.filter((item) => item.id !== option.id) })}>
              <X aria-hidden="true" />
            </Button>
          </li>
        ))}
      </ul>
      {options.length < 30 ? (
        <form className="flex items-center gap-1" onSubmit={(event) => { event.preventDefault(); add(); }}>
          <Input size="sm" aria-label="New choice" placeholder="Add a choice" value={label} maxLength={40} onChange={(event) => setLabel(event.target.value)} />
          <Button type="submit" variant="ghost" size="icon-sm" aria-label="Add choice" disabled={!label.trim()}><Plus aria-hidden="true" /></Button>
        </form>
      ) : null}
    </section>
  );
}

/** What opens when an owner clicks a property's name: rename, icon, choices, order, hide or delete. */
function PropertySettings({ property, index, total, editor, onDone }: { property: VisitProperty; index: number; total: number; editor: PropertyEditor; onDone: () => void }) {
  const [name, setName] = useState(property.label);
  const [picking, setPicking] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const commitName = () => editor.rename(property, name);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <Button variant="outline" size="icon-sm" aria-label="Change icon" aria-expanded={picking} onClick={() => setPicking((value) => !value)}>
          <FieldIcon name={property.icon} className="size-4" />
        </Button>
        <Input
          size="sm"
          aria-label="Property name"
          value={name}
          maxLength={40}
          onChange={(event) => setName(event.target.value)}
          onBlur={commitName}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitName();
              onDone();
            }
          }}
        />
      </div>
      {picking ? <IconGrid value={property.icon} onPick={(icon) => { editor.setIcon(property, icon); setPicking(false); }} /> : null}
      {property.custom ? (
        <p className="px-1 text-xs text-muted-foreground">
          <FieldIcon name={fieldTypeInfo[property.custom.type].icon} className="me-1 inline size-3 align-[-2px]" />
          {fieldTypeInfo[property.custom.type].label}
        </p>
      ) : null}
      {property.custom && (property.custom.type === "select" || property.custom.type === "multi_select") ? (
        <OptionsEditor field={property.custom} onChange={editor.change} />
      ) : null}
      <div className="-mx-1 flex flex-col border-t pt-1">
        <Button variant="ghost" size="sm" className="justify-start" disabled={index <= 0} onClick={() => editor.move(property, -1)}>
          <ArrowUp aria-hidden="true" />Move up
        </Button>
        <Button variant="ghost" size="sm" className="justify-start" disabled={index >= total - 1} onClick={() => editor.move(property, 1)}>
          <ArrowDown aria-hidden="true" />Move down
        </Button>
        {property.required ? null : (
          <Button variant="ghost" size="sm" className="justify-start" onClick={() => { editor.setHidden(property, !property.hidden); onDone(); }}>
            {property.hidden ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
            {property.hidden ? "Show property" : "Hide property"}
          </Button>
        )}
        {property.defaultLabel && property.label !== property.defaultLabel ? (
          <Button variant="ghost" size="sm" className="justify-start" onClick={() => { editor.rename(property, property.defaultLabel!); setName(property.defaultLabel!); }}>
            <RotateCcw aria-hidden="true" />Reset name to “{property.defaultLabel}”
          </Button>
        ) : null}
        {property.custom ? (
          <Button
            variant="ghost"
            size="sm"
            className="justify-start text-destructive-foreground"
            onClick={() => {
              if (!confirmDelete) {
                setConfirmDelete(true);
                return;
              }
              editor.remove(property);
              onDone();
            }}
          >
            <Trash2 aria-hidden="true" />{confirmDelete ? "Click again to delete" : "Delete property"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function PropertyLabel({ property, index, total, canEdit, editor }: { property: VisitProperty; index: number; total: number; canEdit: boolean; editor: PropertyEditor }) {
  const [open, setOpen] = useState(false);
  const content = (
    <>
      <FieldIcon name={property.icon} />
      <span className="min-w-0 truncate">{property.label}</span>
    </>
  );
  if (!canEdit) {
    return <dt className="flex h-7 min-w-0 items-center gap-1.5 text-sm text-muted-foreground">{content}</dt>;
  }
  return (
    <dt className="min-w-0">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          className="-mx-1.5 flex h-7 w-[calc(100%+--spacing(3))] min-w-0 items-center gap-1.5 rounded-md px-1.5 text-start text-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/24 data-popup-open:bg-accent data-popup-open:text-foreground"
          aria-label={`${property.label} property settings`}
        >
          {content}
        </PopoverTrigger>
        <PopoverPopup align="start" className="w-72">
          {open ? <PropertySettings property={property} index={index} total={total} editor={editor} onDone={() => setOpen(false)} /> : null}
        </PopoverPopup>
      </Popover>
    </dt>
  );
}

function AddProperty({ editor, onAdded }: { editor: PropertyEditor; onAdded?: (field: CustomField) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<CustomFieldType>("select");
  function create() {
    const field = editor.add(type, name);
    if (field) onAdded?.(field);
    setName("");
    setOpen(false);
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="ghost" size="sm" className="-ms-2 self-start text-muted-foreground" />}>
        <Plus aria-hidden="true" />Add a property
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-72">
        <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); create(); }}>
          <Input size="sm" aria-label="Property name" placeholder={`Name, like ${type === "select" ? "Category" : type === "checkbox" ? "First visit" : type === "number" ? "Weight" : type === "date" ? "Follow-up" : "Referred by"}`} value={name} maxLength={40} autoFocus onChange={(event) => setName(event.target.value)} />
          <div role="radiogroup" aria-label="Type" className="grid grid-cols-2 gap-1">
            {(Object.keys(fieldTypeInfo) as CustomFieldType[]).map((item) => (
              <button
                key={item}
                type="button"
                role="radio"
                aria-checked={type === item}
                title={fieldTypeInfo[item].hint}
                className={cn(
                  "flex items-center gap-2 rounded-md border px-2 py-1.5 text-start text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                  type === item ? "border-primary/50 bg-primary/6" : "border-transparent",
                )}
                onClick={() => setType(item)}
              >
                <FieldIcon name={fieldTypeInfo[item].icon} className="size-4 text-muted-foreground" />
                {fieldTypeInfo[item].label}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{fieldTypeInfo[type].hint}. Everyone on the team sees it on every {"visit"}.</p>
          <Button type="submit" size="sm">Add property</Button>
        </form>
      </PopoverPopup>
    </Popover>
  );
}

/**
 * Properties as rows, Notion style: an icon and a name on the left, the value on the right. Owners click a
 * name to rename it, change its icon, move or hide it, and can add the business's own properties.
 */
export function PropertyRows({
  properties,
  renderValue,
  className,
}: {
  properties: VisitProperties;
  renderValue: (property: VisitProperty) => ReactNode;
  className?: string;
}) {
  const [showHidden, setShowHidden] = useState(false);
  const { shown, hidden, all, canEdit, editor } = properties;
  const rows = showHidden ? all : shown;
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <dl className="grid grid-cols-[minmax(6.5rem,8.5rem)_minmax(0,1fr)] items-start gap-x-3 gap-y-0.5">
        {rows.map((property) => {
          const index = all.indexOf(property);
          return (
            <div key={property.id} className={cn("contents", property.hidden && "[&>*]:opacity-60")}>
              <PropertyLabel property={property} index={index} total={all.length} canEdit={canEdit} editor={editor} />
              <dd className="flex min-h-7 min-w-0 items-center text-sm break-words">{renderValue(property)}</dd>
            </div>
          );
        })}
      </dl>
      <div className="flex flex-wrap items-center gap-1">
        {hidden.length ? (
          <Button variant="ghost" size="sm" className="-ms-2 text-muted-foreground" aria-expanded={showHidden} onClick={() => setShowHidden((value) => !value)}>
            {showHidden ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
            {showHidden ? "Hide" : "Show"} {hidden.length} hidden {hidden.length === 1 ? "property" : "properties"}
          </Button>
        ) : null}
        {canEdit ? <AddProperty editor={editor} /> : null}
      </div>
    </div>
  );
}
