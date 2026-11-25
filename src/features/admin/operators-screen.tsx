"use client";

import { UserCog, UserPlus } from "lucide-react";
import { useState } from "react";

import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Frame, FramePanel } from "@/components/ui/frame";
import { toastManager } from "@/components/ui/toast";

import { adminActions, useAdminAction, useOperators } from "./admin-api";
import { formatDate, roleLabels, shortId } from "./admin-format";
import { AddOperatorDialog } from "./add-operator-dialog";
import { useAdminCan } from "./admin-role";
import { EmptyPanel, ErrorPanel, LoadingRows, ScreenHeader } from "./screen-states";

export function OperatorsScreen() {
  const can = useAdminCan();
  const query = useOperators(can.manageOperators);
  const [adding, setAdding] = useState(false);
  const save = useAdminAction(adminActions.saveOperator);

  if (!can.manageOperators) {
    return (
      <>
        <ScreenHeader title="Operators" description="Who can use this console." />
        <EmptyPanel icon={<UserCog aria-hidden="true" />} title="Super admins only" description="Ask a super admin to add or switch off an operator." />
      </>
    );
  }
  return (
    <>
      <ScreenHeader
        title="Operators"
        description="Who can use this console. Everyone needs a second factor to sign in."
        actions={<Button size="lg" className="min-h-11" onClick={() => setAdding(true)}><UserPlus aria-hidden="true" />Add or change operator</Button>}
      />
      {query.isPending ? <LoadingRows label="Loading operators" rows={3} /> : null}
      {query.isError ? <ErrorPanel error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} /> : null}
      {query.data && query.data.length === 0 ? <EmptyPanel icon={<UserCog aria-hidden="true" />} title="No operators" description="Add the first one with their sign-in email." /> : null}
      {query.data && query.data.length > 0 ? (
        <Frame>
          <FramePanel>
            <ul className="flex flex-col divide-y" aria-label="Operators">
              {query.data.map((row) => (
                <li key={row.userId} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 text-sm">
                  <div className="min-w-0 flex-1 basis-48">
                    <p className="font-medium">{roleLabels[row.role]}</p>
                    <p className="text-xs text-muted-foreground">Account <span className="font-mono">{shortId(row.userId)}</span> · added {formatDate(row.createdAt)}</p>
                  </div>
                  {row.isActive ? <StatusBadge tone="success">Active</StatusBadge> : <StatusBadge tone="neutral">Switched off</StatusBadge>}
                </li>
              ))}
            </ul>
          </FramePanel>
        </Frame>
      ) : null}
      <AddOperatorDialog open={adding} onOpenChange={setAdding} onSave={async (input) => { await save.mutateAsync(input); toastManager.add({ title: "Operator saved", type: "success" }); }} />
    </>
  );
}
