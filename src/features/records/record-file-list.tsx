"use client";

import { Download, ExternalLink, FileText, FileX2, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { fileSizeLabel } from "@/lib/record-files";
import type { RecordFileSummary } from "@/lib/visit-records";

/**
 * Real files open through an audited route, so every view is logged. Preview files are data URLs, which browsers won't
 * open in a new tab, so they only download. A file still being virus-checked, or removed because a virus was found,
 * cannot be opened or downloaded.
 */
export function RecordFileList({ files, hrefFor, onRemove, disabled }: {
  files: RecordFileSummary[];
  hrefFor: (file: RecordFileSummary) => string;
  onRemove?: (file: RecordFileSummary) => void;
  disabled?: boolean;
}) {
  return (
    <ul className="flex flex-col gap-2">
      {files.map((file) => {
        const href = hrefFor(file);
        const checking = file.scanStatus === "pending";
        const infected = file.scanStatus === "infected";
        const ready = !checking && !infected;
        return (
          <li key={file.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border p-2 ps-3">
            {infected ? (
              <FileX2 aria-hidden="true" className="size-4 shrink-0 text-destructive-foreground" />
            ) : checking ? (
              <Spinner aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <FileText aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0 flex-1 basis-32">
              <p className={`truncate text-sm font-medium ${infected ? "text-muted-foreground line-through" : ""}`}>{file.name}</p>
              <p className="text-xs text-muted-foreground" role={checking || infected ? "status" : undefined}>
                {checking ? "Checking file… It can be opened and shared once the check is done." : null}
                {infected ? "Removed — a virus was found. Nobody can open it." : null}
                {ready ? fileSizeLabel(file.byteSize) : null}
              </p>
            </div>
            <div className="flex items-center gap-1">
              {file.previewDataUrl || !ready ? null : (
                <Button variant="ghost" size="sm" render={<a href={href} target="_blank" rel="noopener noreferrer" aria-label={`Open ${file.name}`} />}>
                  <ExternalLink aria-hidden="true" /> Open
                </Button>
              )}
              {ready ? (
                <Button
                  variant="ghost"
                  size="sm"
                  render={<a href={file.previewDataUrl ? href : `${href}?download`} download={file.name} aria-label={`Download ${file.name}`} />}
                >
                  <Download aria-hidden="true" /> Download
                </Button>
              ) : null}
              {onRemove ? (
                <Button variant="ghost" size="icon-sm" aria-label={`Remove ${file.name}`} disabled={disabled} onClick={() => onRemove(file)}>
                  <Trash2 aria-hidden="true" />
                </Button>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
