// A stand-in for the outside services the app talks to during browser tests, so no test
// ever reaches a real provider. It keeps everything in memory.
//
//   POST /emails                  Resend-shaped send; the app's EMAIL_API_URL points here.
//                                 A repeated Idempotency-Key returns the first id, as Resend does.
//   POST /api/<project>/envelope/ Sentry envelopes; the app's SENTRY_DSN points here
//   POST /whatsapp/v23.0/<id>/messages   Graph-API-shaped WhatsApp send; WHATSAPP_API_URL points at /whatsapp
//   GET  /whatsapp/messages?to=<digits>  WhatsApp messages sent to that number, newest last
//   POST /sms/api/v5/flow/ , /sms/2010-04-01/Accounts/<sid>/Messages.json   MSG91- and Twilio-shaped sends
//   GET  /sms/messages?to=<digits>       texts sent to that number, newest last
//   GET  /messages?to=<email>     emails sent to that address, newest last
//   GET  /errors                  Sentry events received
//   GET  /health                  readiness probe for Playwright
import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";

const port = Number(process.env.KALENDR_CAPTURE_PORT ?? 3199);
const messages = [];
const byIdempotencyKey = new Map();
const errors = [];
// Ids carry a per-start token so they never collide with ids stored by an earlier run in the same database.
const runToken = Math.random().toString(36).slice(2, 8);
const whatsappMessages = [];
const smsMessages = [];

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks);
      resolve(request.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw);
    });
    request.on("error", reject);
  });
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  try {
    if (request.method === "GET" && url.pathname === "/health") return json(response, 200, { status: "ok" });
    if (request.method === "POST" && url.pathname === "/emails") {
      const body = JSON.parse((await readBody(request)).toString("utf8"));
      const key = request.headers["idempotency-key"];
      if (typeof key === "string" && byIdempotencyKey.has(key)) return json(response, 200, { id: byIdempotencyKey.get(key) });
      const to = Array.isArray(body.to) ? body.to : [body.to];
      const id = `captured-${runToken}-${messages.length + 1}`;
      messages.push({
        id,
        to,
        from: body.from ?? "",
        replyTo: body.reply_to ?? null,
        subject: body.subject,
        text: body.text ?? "",
        html: body.html ?? "",
        idempotencyKey: typeof key === "string" ? key : null,
        // Attachments arrive base64-encoded; keep them decoded so tests can read the calendar file.
        attachments: (body.attachments ?? []).map((attachment) => ({
          filename: attachment.filename,
          contentType: attachment.content_type ?? attachment.contentType ?? null,
          content: Buffer.from(String(attachment.content ?? ""), "base64").toString("utf8"),
        })),
      });
      if (typeof key === "string") byIdempotencyKey.set(key, id);
      return json(response, 200, { id });
    }
    if (request.method === "POST" && /^\/whatsapp\/v\d+\.\d+\/[^/]+\/messages$/.test(url.pathname)) {
      const body = JSON.parse((await readBody(request)).toString("utf8"));
      const id = `wamid.captured-${runToken}-${whatsappMessages.length + 1}`;
      whatsappMessages.push({ id, to: String(body.to ?? ""), type: body.type, template: body.template ?? null, text: body.text?.body ?? null });
      return json(response, 200, { messaging_product: "whatsapp", contacts: [{ wa_id: body.to }], messages: [{ id }] });
    }
    if (request.method === "GET" && url.pathname === "/whatsapp/messages") {
      const to = url.searchParams.get("to");
      return json(response, 200, whatsappMessages.filter((message) => !to || message.to === to));
    }
    if (request.method === "POST" && (url.pathname === "/sms/api/v5/flow/" || /^\/sms\/2010-04-01\/Accounts\/[^/]+\/Messages\.json$/.test(url.pathname))) {
      const raw = (await readBody(request)).toString("utf8");
      const id = `sms-captured-${runToken}-${smsMessages.length + 1}`;
      if (url.pathname === "/sms/api/v5/flow/") {
        const body = JSON.parse(raw);
        const recipient = body.recipients?.[0] ?? {};
        smsMessages.push({ id, to: String(recipient.mobiles ?? ""), templateId: body.template_id ?? null, variables: recipient });
        return json(response, 200, { type: "success", message: id });
      }
      const form = new URLSearchParams(raw);
      smsMessages.push({ id, to: (form.get("To") ?? "").replace(/\D/g, ""), templateId: null, body: form.get("Body") });
      return json(response, 201, { sid: id, status: "queued" });
    }
    if (request.method === "GET" && url.pathname === "/sms/messages") {
      const to = url.searchParams.get("to");
      return json(response, 200, smsMessages.filter((message) => !to || message.to === to));
    }
    if (request.method === "GET" && url.pathname === "/messages") {
      const to = url.searchParams.get("to");
      return json(response, 200, messages.filter((message) => !to || message.to.includes(to)));
    }
    if (request.method === "POST" && /^\/api\/\d+\/envelope\/?$/.test(url.pathname)) {
      // An envelope is newline-separated JSON: a header, then item header / payload pairs.
      const lines = (await readBody(request)).toString("utf8").split("\n").filter(Boolean);
      for (let index = 1; index + 1 < lines.length; index += 2) {
        const itemHeader = JSON.parse(lines[index]);
        if (itemHeader.type === "event") errors.push(JSON.parse(lines[index + 1]));
      }
      return json(response, 200, {});
    }
    if (request.method === "GET" && url.pathname === "/errors") return json(response, 200, errors);
    json(response, 404, { error: "not_found" });
  } catch {
    json(response, 400, { error: "bad_request" });
  }
});

server.listen(port, "127.0.0.1");
