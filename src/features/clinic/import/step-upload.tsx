"use client";

import { Download, FileSpreadsheet, ShieldCheck, TriangleAlert, Upload } from "lucide-react";
import { useId, useRef, useState, type DragEvent } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Frame, FrameFooter, FramePanel } from "@/components/ui/frame";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { useTerms } from "@/features/terms/business-profile-context";
import { cn } from "@/lib/utils";

import { sampleUrl, useUploadImport } from "./api";
import { maxFileBytes, type ImportKind, type ImportSetup } from "./types";
import { kindWords } from "./words";

const kinds: ImportKind[] = ["customers", "services", "appointments"];
const accepted = ".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function fileProblem(file: File): string | null {
  if (!/\.(csv|xlsx)$/i.test(file.name)) return "Choose a CSV or XLSX file. To use another spreadsheet, save it as CSV first.";
  if (file.size > maxFileBytes) return "This file is bigger than 10 MB. Split it into smaller files and import them one by one.";
  if (file.size === 0) return "This file is empty.";
  return null;
}

const size = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

export function UploadStep({ onUploaded }: { onUploaded: (setup: ImportSetup) => void }) {
  const t = useTerms();
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const upload = useUploadImport();
  const [kind, setKind] = useState<ImportKind>("customers");
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState("");
  const [dragging, setDragging] = useState(false);
  const words = kindWords(kind, t);
  const blurbs: Record<ImportKind, string> = { customers: `Your list of ${t.customers}`, services: `What you offer`, appointments: `Already booked` };

  function choose(next: File | undefined) {
    if (!next) return;
    const issue = fileProblem(next);
    setProblem(issue ?? "");
    setFile(issue ? null : next);
    upload.reset();
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    choose(event.dataTransfer.files[0]);
  }

  async function submit() {
    if (!file) return;
    setProblem("");
    upload.mutate({ file, kind }, { onSuccess: onUploaded });
  }

  const serverProblem = upload.error ? upload.error.message : "";
  const shown = problem || serverProblem;

  return (
    <Frame>
      <FramePanel className="flex flex-col gap-5">
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">What do you want to import?</legend>
          <RadioGroup aria-label="What do you want to import?" value={kind} onValueChange={(next) => setKind(next as ImportKind)} className="grid gap-2 sm:grid-cols-3">
            {kinds.map((option) => {
              const label = kindWords(option, t);
              return (
                <label key={option} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 has-data-checked:border-primary/48 has-data-checked:bg-accent/50 has-focus-visible:ring-2 has-focus-visible:ring-ring">
                  <Radio value={option} className="mt-0.5" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{label.title}</span>
                    <span className="block text-xs text-muted-foreground">{blurbs[option]}</span>
                  </span>
                </label>
              );
            })}
          </RadioGroup>
          <p className="text-sm text-muted-foreground">{words.summary}</p>
          <Button variant="link" size="sm" className="min-h-11 self-start px-0" render={<a href={sampleUrl(kind)} download />}>
            <Download aria-hidden="true" /> Download a sample file for {words.noun}
          </Button>
        </fieldset>

        <div className="flex flex-col gap-2">
          <label
            htmlFor={inputId}
            onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={cn(
              "flex min-h-32 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-6 text-center has-focus-visible:ring-2 has-focus-visible:ring-ring",
              dragging ? "border-primary bg-accent/50" : "bg-muted/32 hover:bg-accent/32",
            )}
          >
            <FileSpreadsheet aria-hidden="true" className="size-6 text-muted-foreground" />
            <span className="text-sm font-medium">{file ? file.name : "Drag a file here, or choose one"}</span>
            <span className="text-xs text-muted-foreground">{file ? `${size(file.size)}. Choose another to replace it.` : "CSV or XLSX, up to 10 MB. The first row must hold the column names."}</span>
            <input
              ref={input}
              id={inputId}
              type="file"
              accept={accepted}
              className="sr-only"
              onChange={(event) => { choose(event.target.files?.[0]); event.target.value = ""; }}
            />
          </label>
        </div>

        {shown ? (
          <Alert variant="error" role="alert"><TriangleAlert aria-hidden="true" /><AlertDescription>{shown}</AlertDescription></Alert>
        ) : null}

        <Alert variant="info" role="note">
          <ShieldCheck aria-hidden="true" />
          <AlertDescription>Nothing is sent to your {t.customers} by importing. You will check every row before anything is saved, and you can undo an import for 7 days.</AlertDescription>
        </Alert>
      </FramePanel>
      <FrameFooter className="flex justify-end">
        <Button onClick={submit} disabled={!file || upload.isPending}>
          {upload.isPending ? <Spinner aria-hidden="true" /> : <Upload aria-hidden="true" />}
          {upload.isPending ? "Uploading…" : "Upload and continue"}
        </Button>
      </FrameFooter>
    </Frame>
  );
}
