"use client";

import { useId, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/** Where a setting that has a business-wide default stands for this one service. */
export interface BusinessDefault {
  /** True while the service follows the business's own value. */
  inherited: boolean;
  /** What the business uses, in a few words ("Mon to Fri, 9 to 5"). Shown beside "Uses business default". */
  summary?: string;
  /** Makes this service's own value, starting from the business's. */
  onCustomize: () => void;
  /** Goes back to the business's value. */
  onReset: () => void;
}

export interface SettingRowProps {
  /** Matches an entry of `settingsIndex`, so searching can jump here. */
  settingId: string;
  title: ReactNode;
  /** One line that says what the setting does. */
  help?: ReactNode;
  /** With a value the row has a switch and shows `children` only while it is on. Without one the row is a plain section that always shows its fields. */
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  /** For a setting with a business default: shows "Uses business default" with Customize, or Reset once changed. */
  businessDefault?: BusinessDefault;
  children?: ReactNode;
  className?: string;
}

/**
 * The one pattern for every service setting: a title, one help line and a switch that reveals the fields. When the
 * business has its own value for the setting, the row says so and offers Customize and Reset.
 */
export function SettingRow({ settingId, title, help, checked, onCheckedChange, disabled, businessDefault, children, className }: SettingRowProps) {
  const titleId = useId();
  const helpId = useId();
  const hasSwitch = checked !== undefined && onCheckedChange !== undefined;
  const inherited = businessDefault?.inherited === true;
  // A row that follows the business shows no fields: Customize is how they open.
  const showFields = children !== undefined && children !== null && !inherited && (!hasSwitch || checked);
  return (
    <section data-setting={settingId} aria-labelledby={titleId} className={cn("flex scroll-mt-24 flex-col gap-3 border-b py-4 last:border-b-0", className)}>
      <div className="flex min-h-11 items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 id={titleId} className="font-medium text-sm">{title}</h3>
          {help ? <p id={helpId} className="text-muted-foreground text-xs">{help}</p> : null}
          {businessDefault ? (
            <p className="flex flex-wrap items-center gap-2 pt-1 text-xs">
              {inherited ? <Badge variant="outline">Uses business default</Badge> : <Badge variant="info">Set for this one</Badge>}
              {inherited && businessDefault.summary ? <span className="text-muted-foreground">{businessDefault.summary}</span> : null}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {businessDefault ? (
            inherited
              ? <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={businessDefault.onCustomize}>Customize</Button>
              : <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={businessDefault.onReset}>Reset to default</Button>
          ) : null}
          {hasSwitch && !inherited ? <Switch checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} aria-labelledby={titleId} aria-describedby={help ? helpId : undefined} /> : null}
        </div>
      </div>
      {showFields ? <div className="flex flex-col gap-4">{children}</div> : null}
    </section>
  );
}
