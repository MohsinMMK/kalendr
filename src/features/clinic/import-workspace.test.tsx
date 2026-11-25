/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BusinessProfileProvider } from "@/features/terms/business-profile-context";
import { resolveBusinessProfile } from "@/lib/terminology";
import { chooseOption } from "@/test/choose-option";
import { TestQueryProvider } from "@/test/query-wrapper";

import { rememberSetup } from "./import/api";
import type { ImportCounts, ImportField, ImportJob, ImportSetup, PreviewRow, RowStatus } from "./import/types";
import { ImportWorkspace } from "./import-workspace";

const catalog = vi.hoisted(() => ({ database: true }));
vi.mock("./clinic-catalog", () => ({ useCatalogLookups: () => catalog }));

const opts = { dateFormat: "dd/mm/yyyy", duplicateRule: "skip", consentConfirmed: false, sendConfirmations: false } as const;
const zero: ImportCounts = { ready: 0, update: 0, skip: 0, error: 0, created: 0, updated: 0, skipped: 0, failed: 0 };
const fields: ImportField[] = [
  { key: "firstName", label: "First name", required: true, description: "Their first name" },
  { key: "phone", label: "Phone", required: true, description: "A mobile number" },
  { key: "email", label: "Email", required: false, description: "Optional" },
  { key: "consent", label: "Messaging consent", required: false, description: "Yes or no" },
];
const headers = ["Name", "Mobile", "E-mail", "OK to text"];
const suggested = { firstName: 0, phone: 1, email: 2, consent: null };

function makeJob(over: Partial<ImportJob> = {}): ImportJob {
  return {
    id: "job1", kind: "customers", fileFormat: "csv", status: "uploaded", rowCount: 4, counts: zero, options: null, mapping: null,
    failureCode: null, undoUntil: null, undoneAt: null, startedAt: null, finishedAt: null, version: 1, createdAt: "2026-11-18T10:00:00Z", ...over,
  };
}

const rowsByStatus: Record<RowStatus, { rowNumber: number; status: RowStatus; errorCode: string | null; errorField: string | null }[]> = {
  error: [{ rowNumber: 4, status: "error", errorCode: "invalid_phone", errorField: "phone" }],
  will_skip: [{ rowNumber: 3, status: "will_skip", errorCode: null, errorField: null }],
  will_update: [],
  ready: [{ rowNumber: 2, status: "ready", errorCode: null, errorField: null }],
};

/** A small pretend server. Each test changes `server.job` and the queue of answers a polled GET gives. */
const server = {
  jobs: [] as ImportJob[],
  job: makeJob(),
  /** Answers handed out one per GET of the job; the last one repeats. */
  polls: [] as ImportJob[],
  listStatus: 200,
  patchStatus: 200,
  calls: [] as string[],
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const preview: PreviewRow[] = [{ rowNumber: 2, values: { firstName: "Asha", phone: "+919876543210", email: "asha@example.com" } }];

beforeEach(() => {
  catalog.database = true;
  server.jobs = [];
  server.job = makeJob();
  server.polls = [];
  server.listStatus = 200;
  server.patchStatus = 200;
  server.calls = [];
  window.sessionStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    server.calls.push(`${method} ${url}`);
    if (url === "/api/staff/imports" && method === "GET") return server.listStatus === 200 ? json({ data: { jobs: server.jobs } }) : json({ error: { code: "x", message: "Down" } }, server.listStatus);
    if (url === "/api/staff/imports" && method === "POST") {
      const setup: ImportSetup = { job: server.job, headers, suggestedMapping: suggested, fields };
      return json({ data: setup }, 201);
    }
    if (url.includes("/rows")) {
      const status = new URL(url, "http://x").searchParams.get("status") as RowStatus;
      return json({ data: { rows: rowsByStatus[status], nextCursor: null } });
    }
    if (url.endsWith("/check") && method === "POST") { server.job = makeJob({ ...server.job, status: "checking" }); return json({ data: {} }, 202); }
    if (url.endsWith("/commit") && method === "POST") { server.job = { ...server.job, status: "queued" }; return json({ data: {} }, 202); }
    if (url.endsWith("/undo") && method === "POST") { server.job = { ...server.job, status: "undoing" }; return json({ data: {} }, 202); }
    if (method === "PATCH") {
      if (server.patchStatus !== 200) return json({ error: { code: "version_conflict", message: "Changed" } }, server.patchStatus);
      const body: unknown = JSON.parse(String(init?.body));
      const options = typeof body === "object" && body !== null && "options" in body ? (body.options as ImportJob["options"]) : null;
      server.job = { ...server.job, status: "mapped", version: server.job.version + 1, options };
      return json({ data: { job: server.job, preview } });
    }
    if (method === "GET" && url.startsWith("/api/staff/imports/")) {
      const next = server.polls.length > 1 ? server.polls.shift() : server.polls[0];
      if (next) server.job = next;
      return json({ data: { job: server.job } });
    }
    return json({ error: { code: "nope", message: "Unexpected request" } }, 404);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderWorkspace(search = "", business: ReactNode = null) {
  const profile = resolveBusinessProfile({ businessType: "wellness" });
  return render(
    <TestQueryProvider>
      <NuqsTestingAdapter searchParams={search} hasMemory>
        <BusinessProfileProvider profile={business ? profile : null}>
          <ImportWorkspace />
        </BusinessProfileProvider>
      </NuqsTestingAdapter>
    </TestQueryProvider>,
  );
}

function keepSetup(job: ImportJob) {
  rememberSetup({ job, headers, suggestedMapping: suggested, fields });
}

const csv = (name = "people.csv", body = "Name,Mobile\nAsha,98765") => new File([body], name, { type: "text/csv" });

describe("preview and access", () => {
  it("says plainly that importing is unavailable in the preview, and calls nothing", async () => {
    catalog.database = false;
    renderWorkspace();
    expect(await screen.findByText("Importing is not available in the preview")).toBeInTheDocument();
    expect(server.calls).toEqual([]);
  });
});

describe("step 1: upload", () => {
  it("offers the three kinds in the business's own words, with a sample file link per kind", async () => {
    renderWorkspace("", "salon");
    expect(await screen.findByRole("radio", { name: /Clients/ })).toBeInTheDocument();
    expect(screen.queryByText(/patient/i)).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Future appointments/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Download a sample file for clients/ })).toHaveAttribute("href", "/api/staff/imports/samples/customers");
    await userEvent.click(screen.getByRole("radio", { name: /Services/ }));
    expect(screen.getByRole("link", { name: /Download a sample file for services/ })).toHaveAttribute("href", "/api/staff/imports/samples/services");
    expect(screen.getByText(/Nothing is sent to your clients/)).toBeInTheDocument();
  });

  it("refuses a file that is not CSV or XLSX, or is too big, before uploading", async () => {
    const user = userEvent.setup({ applyAccept: false });
    renderWorkspace();
    const input = await screen.findByLabelText(/Drag a file here/);
    await user.upload(input, new File(["x"], "notes.pdf", { type: "application/pdf" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/CSV or XLSX/);
    const big = new File(["x"], "big.csv", { type: "text/csv" });
    Object.defineProperty(big, "size", { value: 11 * 1024 * 1024 });
    await user.upload(input, big);
    expect(await screen.findByRole("alert")).toHaveTextContent(/bigger than 10 MB/);
    expect(screen.getByRole("button", { name: "Upload and continue" })).toBeDisabled();
    expect(server.calls.filter((call) => call.startsWith("POST"))).toEqual([]);
  });

  it("uploads, then lands on matching with the guessed columns chosen", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await user.upload(await screen.findByLabelText(/Drag a file here/), csv());
    await user.click(screen.getByRole("button", { name: "Upload and continue" }));
    expect(await screen.findByRole("heading", { name: /Step 2 of 4/ })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /First name/ })).toHaveTextContent("Name");
    expect(screen.getByRole("combobox", { name: /^Phone(?! numbers)/ })).toHaveTextContent("Mobile");
    expect(screen.getByRole("navigation", { name: "Import steps" }).querySelector("[aria-current=step]")).toHaveTextContent(/Match/);
  });

  it("shows the server's reason when the upload is refused", async () => {
    const user = userEvent.setup();
    vi.mocked(fetch).mockImplementationOnce(async () => json({ data: { jobs: [] } }));
    renderWorkspace();
    await user.upload(await screen.findByLabelText(/Drag a file here/), csv());
    vi.mocked(fetch).mockImplementationOnce(async () => json({ error: { code: "unreadable_file", message: "We could not read this file." } }, 422));
    await user.click(screen.getByRole("button", { name: "Upload and continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("We could not read this file.");
  });
});

describe("recent imports", () => {
  it("shows an empty state", async () => {
    renderWorkspace();
    expect(await screen.findByText("No imports yet")).toBeInTheDocument();
  });

  it("shows an error with a retry", async () => {
    const user = userEvent.setup();
    server.listStatus = 500;
    renderWorkspace();
    expect(await screen.findByText("Your recent imports could not be loaded.")).toBeInTheDocument();
    server.listStatus = 200;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No imports yet")).toBeInTheDocument();
  });

  it("lists unfinished and finished imports with their undo window, and opens one", async () => {
    const user = userEvent.setup();
    const soon = new Date(Date.now() + 3 * 86_400_000).toISOString();
    server.jobs = [
      makeJob({ id: "a", status: "checked", rowCount: 40, counts: { ...zero, ready: 38, error: 2 } }),
      makeJob({ id: "b", status: "done", rowCount: 10, undoUntil: soon, counts: { ...zero, created: 9, skipped: 1 } }),
    ];
    server.job = server.jobs[1];
    renderWorkspace();
    const list = await screen.findByRole("list", { name: "Recent imports" }, { timeout: 3000 });
    expect(within(list).getByText("Ready to import")).toBeInTheDocument();
    expect(within(list).getByText(/Can be undone until/)).toBeInTheDocument();
    await user.click(within(list).getByRole("button", { name: /View or undo/ }));
    expect(await screen.findByRole("heading", { name: /Step 4 of 4/ })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Undo this import/ })).toBeInTheDocument();
  });
});

describe("step 2: match columns", () => {
  it("marks required fields, previews the saved rows, and goes on to checking", async () => {
    const user = userEvent.setup();
    server.job = makeJob();
    keepSetup(server.job);
    renderWorkspace("?job=job1");
    expect(await screen.findByRole("heading", { name: /Step 2 of 4/ })).toBeInTheDocument();
    expect(screen.getAllByText("Required")).toHaveLength(2);
    const table = await screen.findByRole("table", { name: /as they will be saved/ });
    expect(within(table).getByText("+919876543210")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Check the file/ }));
    await waitFor(() => expect(server.calls).toContain("POST /api/staff/imports/job1/check"));
    expect(await screen.findByRole("heading", { name: /Step 3 of 4/ })).toBeInTheDocument();
  });

  it("will not go on while a required column is not matched, and says which", async () => {
    const user = userEvent.setup();
    keepSetup(server.job);
    renderWorkspace("?job=job1");
    await chooseOption(user, await screen.findByRole("combobox", { name: /^Phone(?! numbers)/ }), "Don't import");
    expect(screen.getByRole("button", { name: /Check the file/ })).toBeDisabled();
    expect(screen.getAllByText(/Phone/).some((node) => /Still to match/.test(node.textContent ?? ""))).toBe(true);
  });

  it("makes the owner confirm consent when a consent column is matched", async () => {
    const user = userEvent.setup();
    keepSetup(server.job);
    renderWorkspace("?job=job1");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    await chooseOption(user, await screen.findByRole("combobox", { name: /Messaging consent/ }), "OK to text");
    const box = await screen.findByRole("checkbox", { name: /I confirm these patients agreed to receive messages/ });
    const go = screen.getByRole("button", { name: /Check the file/ });
    expect(go).toBeDisabled();
    await user.click(box);
    expect(go).toBeEnabled();
    await user.click(go);
    await waitFor(() => {
      const patch = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "PATCH").at(-1);
      expect(JSON.parse(String(patch?.[1]?.body)).options.consentConfirmed).toBe(true);
    });
  });

  it("offers Send confirmations, off, only for appointments", async () => {
    server.job = makeJob({ kind: "appointments" });
    keepSetup(server.job);
    renderWorkspace("?job=job1");
    expect(await screen.findByRole("switch", { name: "Send confirmations" })).not.toBeChecked();
  });

  it("explains a version conflict and loads the latest", async () => {
    const user = userEvent.setup();
    keepSetup(server.job);
    server.patchStatus = 409;
    renderWorkspace("?job=job1");
    expect(await screen.findByText(/changed somewhere else/)).toBeInTheDocument();
    server.patchStatus = 200;
    await user.click(screen.getByRole("button", { name: /Load the latest/ }));
    await waitFor(() => expect(screen.queryByText(/changed somewhere else/)).not.toBeInTheDocument());
  });

  it("asks for a new upload when the column names are gone after a reload", async () => {
    server.job = makeJob();
    renderWorkspace("?job=job1");
    expect(await screen.findByText("Upload the file again to match its columns")).toBeInTheDocument();
  });
});

describe("step 3: check", () => {
  const checked = (extra: Partial<ImportJob> = {}) => makeJob({ status: "checked", rowCount: 4, counts: { ...zero, ready: 1, skip: 1, error: 1, update: 1 }, version: 3, mapping: suggested, options: opts, ...extra });

  it("shows progress while checking, then follows the job to its totals", async () => {
    server.polls = [makeJob({ status: "checking" }), checked()];
    renderWorkspace("?job=job1");
    expect(await screen.findByText(/Checking 4 rows/)).toBeInTheDocument();
    expect(await screen.findByRole("list", { name: "Totals" }, { timeout: 6000 })).toBeInTheDocument();
  });

  it("shows the totals and the error rows in plain words, with a download", async () => {
    const user = userEvent.setup();
    server.job = checked();
    server.polls = [server.job];
    renderWorkspace("?job=job1");
    const totals = await screen.findByRole("list", { name: "Totals" });
    expect(within(totals).getByRole("button", { name: /Has errors/ })).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByText(/phone number is not valid/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Download the rows with errors/ })).toHaveAttribute("href", "/api/staff/imports/job1/errors");
    await user.click(within(totals).getByRole("button", { name: /Will skip/ }));
    expect(await screen.findByText(/already in your list/)).toBeInTheDocument();
  });

  it("shows an error with a retry when the rows will not load", async () => {
    const user = userEvent.setup();
    server.job = checked();
    server.polls = [server.job];
    let fail = true;
    const original = vi.mocked(fetch).getMockImplementation();
    vi.mocked(fetch).mockImplementation(async (input, init) => (fail && String(input).includes("/rows") ? json({ error: { code: "x", message: "no" } }, 500) : original!(input, init)));
    renderWorkspace("?job=job1");
    expect(await screen.findByText("The rows could not be loaded.")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/phone number is not valid/)).toBeInTheDocument();
  });

  it("cannot continue when nothing can be imported", async () => {
    server.job = checked({ counts: { ...zero, error: 4 } });
    server.polls = [server.job];
    renderWorkspace("?job=job1");
    expect(await screen.findByRole("button", { name: /Continue to import/ })).toBeDisabled();
  });
});

describe("step 4: import and undo", () => {
  const checked = makeJob({ status: "checked", rowCount: 4, counts: { ...zero, ready: 3, error: 1 }, version: 3, mapping: suggested, options: opts });

  it("keeps Start disabled while a consent column is unconfirmed", async () => {
    server.job = { ...checked, mapping: { ...suggested, consent: 3 } };
    server.polls = [server.job];
    const user = userEvent.setup();
    renderWorkspace("?job=job1");
    await user.click(await screen.findByRole("button", { name: /Continue to import/ }));
    expect(await screen.findByRole("button", { name: /Start the import/ })).toBeDisabled();
    expect(screen.getByText(/confirm that these patients agreed/)).toBeInTheDocument();
  });

  it("confirms, follows live progress, shows the result, then undoes with a plain dialog", async () => {
    const user = userEvent.setup();
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString();
    server.job = checked;
    server.polls = [checked];
    renderWorkspace("?job=job1");
    await user.click(await screen.findByRole("button", { name: /Continue to import/ }));
    server.polls = [
      makeJob({ status: "running", rowCount: 4, counts: { ...zero, created: 1 }, version: 4 }),
      makeJob({ status: "done", rowCount: 4, counts: { ...zero, created: 3, failed: 1 }, undoUntil: soon, finishedAt: new Date().toISOString(), version: 5 }),
    ];
    await user.click(screen.getByRole("button", { name: /Start the import/ }));
    await waitFor(() => expect(JSON.parse(String(vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith("/commit"))?.[1]?.body))).toEqual({ expectedVersion: 3 }));
    const result = await screen.findByRole("list", { name: "Result" }, { timeout: 8000 });
    expect(within(result).getByText("Created").previousElementSibling).toHaveTextContent("3");
    expect(screen.getByRole("link", { name: /Download errors/ })).toHaveAttribute("href", "/api/staff/imports/job1/errors");
    expect(screen.getByText(/You can undo this import until/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Undo this import/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("What this removes")).toBeInTheDocument();
    expect(within(dialog).getByText("What this keeps")).toBeInTheDocument();
    expect(within(dialog).getByText(/3 patients this import added/)).toBeInTheDocument();
    server.polls = [makeJob({ status: "undoing", counts: { ...zero, created: 3, failed: 1 }, version: 6 }), makeJob({ status: "undone", counts: { ...zero, created: 3, failed: 1 }, undoneAt: new Date().toISOString(), version: 7 })];
    await user.click(within(dialog).getByRole("button", { name: "Undo the import" }));
    expect(await screen.findByText("Import undone", {}, { timeout: 8000 })).toBeInTheDocument();
    expect(server.calls).toContain("POST /api/staff/imports/job1/undo");
  }, 20_000);

  it("offers no undo once the 7 days have passed", async () => {
    server.job = makeJob({ status: "done", counts: { ...zero, created: 3 }, undoUntil: "2020-01-01T00:00:00Z", version: 5 });
    server.polls = [server.job];
    renderWorkspace("?job=job1");
    expect(await screen.findByText(/7 days to undo this import have passed/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Undo this import/ })).not.toBeInTheDocument();
  });

  it("explains a failed import in plain words", async () => {
    server.job = makeJob({ status: "failed", failureCode: "import_failed", counts: { ...zero, created: 1 } });
    server.polls = [server.job];
    renderWorkspace("?job=job1");
    expect(await screen.findByText(/The import stopped before it finished/)).toBeInTheDocument();
  });

  it("shows a missing job with a way to start again", async () => {
    vi.mocked(fetch).mockImplementation(async () => json({ error: { code: "not_found", message: "No such import" } }, 404));
    renderWorkspace("?job=gone");
    expect(await screen.findByText("This import no longer exists")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start a new import" })).toBeInTheDocument();
  });
});
