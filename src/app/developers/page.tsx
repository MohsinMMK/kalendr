import type { Metadata } from "next";
import Link from "next/link";

import { Code, Heading, Operation, Prose, SimpleTable, Json } from "@/app/developers/parts";
import { loadReference } from "@/app/developers/reference";
import { errorExample, nodeVerify, pageExample, pythonVerify, quickStart } from "@/app/developers/samples";
import { ScrollAreaPrimitive, ScrollBar } from "@/components/ui/scroll-area";
import { apiScopeLabels } from "@/lib/api-scopes";
import { publicAppUrl } from "@/server/env";
import { sharedErrors } from "@/server/openapi-operations";
import { webhookEvents, webhookHeaders } from "@/server/openapi-webhooks";

export const metadata: Metadata = {
  title: "Developers",
  description: "The Kalendr REST API and webhooks: book, move and cancel appointments from your own software.",
};

export const dynamic = "force-dynamic";

const toc = [
  ["quick-start", "Quick start"],
  ["authentication", "Authentication"],
  ["conventions", "Pagination, errors, limits"],
  ["endpoints", "Endpoints"],
  ["webhooks", "Webhooks"],
  ["verify-signature", "Verify a signature"],
] as const;

export default function DevelopersPage() {
  const baseUrl = publicAppUrl();
  const operations = loadReference();
  const link = "text-primary underline underline-offset-2 hover:text-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

  const tocNav = (
    <ul className="space-y-1 text-sm">
      {toc.map(([id, label]) => <li key={id}><a className={link} href={`#${id}`}>{label}</a></li>)}
      <li className="pt-2 font-medium text-muted-foreground">Operations</li>
      {operations.map((operation) => (
        <li key={operation.id}>
          <a className={`${link} break-words`} href={`#${operation.anchor}`}>
            <span className="font-mono text-xs text-muted-foreground">{operation.method}</span> {operation.summary}
          </a>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="border-b bg-card">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-4 sm:px-6">
          <Link href="/" className="font-heading text-lg font-semibold">Kalendr</Link>
          <a className={`${link} text-sm`} href="/api/v1/openapi.json">OpenAPI document (JSON)</a>
        </div>
      </header>
      <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-10">
        <aside className="mb-8 lg:mb-0">
          <nav aria-label="On this page" className="lg:sticky lg:top-6">
            <ScrollAreaPrimitive.Root>
              <ScrollAreaPrimitive.Viewport data-slot="scroll-area-viewport" className="rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring lg:max-h-[calc(100svh-3rem)]">
                <ScrollAreaPrimitive.Content style={{ minWidth: 0 }}>
                  <details className="rounded-lg border bg-card p-3 lg:hidden">
                    <summary className="cursor-pointer text-sm font-medium">On this page</summary>
                    <div className="mt-3">{tocNav}</div>
                  </details>
                  <div className="hidden lg:block">{tocNav}</div>
                </ScrollAreaPrimitive.Content>
              </ScrollAreaPrimitive.Viewport>
              <ScrollBar orientation="vertical" />
            </ScrollAreaPrimitive.Root>
          </nav>
        </aside>
        <main id="main" className="min-w-0 space-y-10">
          <div className="space-y-3">
            <h1 className="font-heading text-3xl font-semibold tracking-tight">Kalendr API</h1>
            <p className="max-w-prose text-base leading-relaxed text-muted-foreground">
              Book, move and cancel appointments, and keep your own system in step with webhooks. Version 1 is stable: we add fields and endpoints but never rename or remove them.
              Your keys and webhook addresses are managed in Settings, under Developers.
            </p>
          </div>

          <section aria-labelledby="quick-start" className="space-y-3">
            <Heading id="quick-start">Quick start</Heading>
            <Prose><p>Create a key in Settings with the scopes you need, then book your first appointment in three calls. Times are ISO 8601 with an offset.</p></Prose>
            <Code label="Quick start with curl">{quickStart(baseUrl)}</Code>
          </section>

          <section aria-labelledby="authentication" className="space-y-3">
            <Heading id="authentication">Authentication</Heading>
            <Prose>
              <p>Send the key in the <code>Authorization</code> header as <code>Bearer kal_live_...</code> on every call. A key belongs to one business and can only reach that business&apos;s data. Keep it on your server; never put it in a web page or app.</p>
              <p>Each key has scopes, and each endpoint below names the one it needs. A <code>kal_test_</code> key can read but never change anything. Revoked or expired keys get <code>401 invalid_api_key</code>.</p>
            </Prose>
            <SimpleTable label="API scopes" head={["Scope", "Allows"]} rows={Object.entries(apiScopeLabels).map(([scope, label]) => [scope, label.description])} />
          </section>

          <section aria-labelledby="conventions" className="space-y-3">
            <Heading id="conventions">Pagination, errors, idempotency and limits</Heading>
            <Prose>
              <p><strong>Pagination.</strong> Lists return <code>{"{ data, nextCursor, hasMore }"}</code>. Ask for <code>limit</code> (1 to 100, default 25) and pass the previous <code>nextCursor</code> as <code>cursor</code> until <code>hasMore</code> is false. Treat cursors as opaque.</p>
            </Prose>
            <Code label="A paged list">{pageExample}</Code>
            <Prose>
              <p><strong>Errors.</strong> Every error has the same shape. Match on <code>code</code>, not <code>message</code>.</p>
            </Prose>
            <Code label="An error response">{errorExample}</Code>
            <SimpleTable label="Shared error codes" head={["Status", "Code and meaning"]} rows={sharedErrors.map((error) => [String(error.status), `${error.code}: ${error.description}`])} />
            <Prose>
              <p><strong>Idempotency.</strong> Creating an appointment or a customer needs an <code>Idempotency-Key</code> header, a value you choose (8 to 160 letters, digits and <code>. _ : -</code>). Send the same key and body again after a network failure and you get the original result instead of a second booking. The same key with a different body is <code>409 idempotency_conflict</code>.</p>
              <p><strong>Rate limits.</strong> 600 requests per minute for each key. Every response carries <code>X-RateLimit-Limit</code>, <code>X-RateLimit-Remaining</code> and <code>X-RateLimit-Reset</code> (Unix seconds). Past the limit you get <code>429 rate_limited</code> with <code>Retry-After</code> in seconds.</p>
              <p><strong>Changing an appointment.</strong> Appointments carry a <code>version</code>. Send it to reschedule or cancel and the call is refused with <code>409 version_conflict</code> if someone else changed the appointment since you read it. Leave it out and the current version is used.</p>
            </Prose>
          </section>

          <section aria-labelledby="endpoints" className="space-y-4">
            <Heading id="endpoints">Endpoints</Heading>
            <Prose><p>Every operation, generated from the same definitions the server uses. The machine-readable version is <a className={link} href="/api/v1/openapi.json">/api/v1/openapi.json</a>.</p></Prose>
            {operations.map((operation) => <Operation key={operation.id} operation={operation} baseUrl={baseUrl} />)}
          </section>

          <section aria-labelledby="webhooks" className="space-y-3">
            <Heading id="webhooks">Webhooks</Heading>
            <Prose>
              <p>Add an address in Settings, Developers and pick the events you want. Kalendr sends each event as a <code>POST</code> with a JSON body. Only <code>https</code> addresses on public servers are accepted. Answer with any 2xx within 10 seconds.</p>
              <p>Every event has the same envelope: <code>{"{ id, type, apiVersion: \"v1\", createdAt, data }"}</code>. The <code>id</code> stays the same across retries, so use it to ignore repeats.</p>
              <p><strong>Retries.</strong> A delivery that fails is retried up to 8 times over about 24 hours. An address that keeps failing is disabled and the business owner is told; turn it back on in Settings.</p>
            </Prose>
            <SimpleTable label="Webhook headers" head={["Header", "Meaning"]} rows={webhookHeaders.map((header) => [header.name, header.description])} />
            <div className="space-y-4">
              {webhookEvents.map((event) => (
                <section key={event.type} id={`event-${event.type}`} aria-labelledby={`event-${event.type}-title`} className="scroll-mt-20 space-y-2 rounded-xl border bg-card p-4 sm:p-5">
                  <h3 id={`event-${event.type}-title`} className="font-mono text-base font-semibold">{event.type}</h3>
                  <p className="text-sm text-muted-foreground">{event.description}</p>
                  <Json label={`${event.type} example`} value={event.example} />
                </section>
              ))}
            </div>
          </section>

          <section aria-labelledby="verify-signature" className="space-y-3">
            <Heading id="verify-signature">Verify a signature</Heading>
            <Prose>
              <p>Each delivery has <code>X-Kalendr-Signature: t=&lt;unix seconds&gt;,v1=&lt;hex&gt;</code>. Compute HMAC-SHA256 with your endpoint&apos;s secret over <code>&lt;t&gt;.&lt;raw body&gt;</code> and compare it to <code>v1</code> in constant time. Reject the call if <code>|now - t|</code> is more than 300 seconds, so an old capture cannot be replayed. Verify the raw body before you parse it.</p>
            </Prose>
            <h3 className="font-heading text-base font-semibold">Node</h3>
            <Code label="Verify a signature in Node">{nodeVerify}</Code>
            <h3 className="font-heading text-base font-semibold">Python</h3>
            <Code label="Verify a signature in Python">{pythonVerify}</Code>
          </section>
        </main>
      </div>
    </div>
  );
}
