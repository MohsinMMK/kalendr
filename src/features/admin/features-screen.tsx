"use client";

import { Pencil, Plus, SlidersHorizontal } from "lucide-react";
import { useState } from "react";

import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Frame, FramePanel } from "@/components/ui/frame";
import { toastManager } from "@/components/ui/toast";
import type { RolloutRow } from "@/lib/admin-contracts";

import { adminActions, useAdminAction, useRollouts } from "./admin-api";
import { formatDateTime } from "./admin-format";
import { useAdminCan } from "./admin-role";
import { RolloutDialog } from "./rollout-dialog";
import { EmptyPanel, ErrorPanel, LoadingRows, ScreenHeader } from "./screen-states";

export function rolloutSummary(row: Pick<RolloutRow, "mode" | "percent" | "tenantIds">): string {
  switch (row.mode) {
    case "off": return "Off for everyone";
    case "all": return "On for every business";
    case "percent": return `On for ${row.percent}% of businesses`;
    case "listed": return `On for ${row.tenantIds.length} listed ${row.tenantIds.length === 1 ? "business" : "businesses"}`;
  }
}

export function FeaturesScreen() {
  const can = useAdminCan();
  const query = useRollouts();
  const [editing, setEditing] = useState<RolloutRow | "new" | null>(null);
  const save = useAdminAction(adminActions.saveRollout);

  return (
    <>
      <ScreenHeader
        title="Features"
        description="Switch a feature on for a few businesses first, then more. A business's own switch still applies on top."
        actions={can.editRollouts ? <Button size="lg" className="min-h-11" onClick={() => setEditing("new")}><Plus aria-hidden="true" />New rollout</Button> : null}
      />
      {can.editRollouts ? null : <p className="text-sm text-muted-foreground">Only a super admin can change rollouts. You can look but not edit.</p>}
      {query.isPending ? <LoadingRows label="Loading rollouts" rows={3} /> : null}
      {query.isError ? <ErrorPanel error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} /> : null}
      {query.data && query.data.length === 0 ? <EmptyPanel icon={<SlidersHorizontal aria-hidden="true" />} title="No rollouts yet" description="Every feature follows each business's own switches until you add a rollout." /> : null}
      {query.data && query.data.length > 0 ? (
        <Frame>
          <FramePanel>
            <ul className="flex flex-col divide-y" aria-label="Rollouts">
              {query.data.map((row) => (
                <li key={row.featureKey} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 text-sm">
                  <div className="min-w-0 flex-1 basis-56">
                    <p className="font-medium">{row.featureKey}</p>
                    <p className="text-xs text-muted-foreground">Changed {formatDateTime(row.updatedAt)}</p>
                  </div>
                  <StatusBadge tone={row.mode === "off" ? "neutral" : row.mode === "all" ? "success" : "info"}>{rolloutSummary(row)}</StatusBadge>
                  {can.editRollouts ? <Button variant="outline" size="sm" onClick={() => setEditing(row)} aria-label={`Edit ${row.featureKey}`}><Pencil aria-hidden="true" />Edit</Button> : null}
                </li>
              ))}
            </ul>
          </FramePanel>
        </Frame>
      ) : null}
      <RolloutDialog
        open={editing !== null}
        row={editing === "new" ? null : editing}
        onOpenChange={(next) => { if (!next) setEditing(null); }}
        onSave={async (input) => {
          await save.mutateAsync(input);
          toastManager.add({ title: "Rollout saved", type: "success" });
        }}
      />
    </>
  );
}
