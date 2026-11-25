"use client";

import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/** Smallest comfortable touch target on a phone; desktop keeps the compact size. */
export const touchTarget = "min-h-11 sm:min-h-8";

/** A "are you sure" step with a plain consequence. The confirm button stays busy until the work is done. */
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, destructive = false, busy, onConfirm }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  busy: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" className={touchTarget} />}>Cancel</AlertDialogClose>
          <Button variant={destructive ? "destructive" : "default"} className={touchTarget} loading={busy} onClick={onConfirm}>{confirmLabel}</Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
