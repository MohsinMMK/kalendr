import { apiOperations } from "@/server/openapi-operations";

/** Sample code shown on /developers. Plain strings, so the page needs no script and nothing runs in the browser. */

export function curlFor(operationId: string, baseUrl: string): string {
  const operation = apiOperations.find((candidate) => candidate.id === operationId);
  if (!operation) throw new Error(`No operation ${operationId}`);
  const path = operation.path.replace("{id}", "apt_77d2");
  const query = operation.queryExample ? `?${operation.queryExample}` : "";
  const lines = [`curl ${operation.method === "post" ? "-X POST " : ""}"${baseUrl}${path}${query}"`, `  -H "Authorization: Bearer $KALENDR_KEY"`];
  if (operation.idempotent) lines.push(`  -H "Idempotency-Key: $(uuidgen)"`);
  if (operation.requestExample) {
    lines.push(`  -H "Content-Type: application/json"`, `  -d '${JSON.stringify(operation.requestExample)}'`);
  }
  return lines.join(" \\\n");
}

export function quickStart(baseUrl: string): string {
  return [
    `export KALENDR_KEY="kal_live_..."   # from Settings, Developers`,
    ``,
    `# 1. Find a service`,
    curlFor("listServices", baseUrl),
    ``,
    `# 2. Find open times for it`,
    curlFor("listAvailability", baseUrl),
    ``,
    `# 3. Book one`,
    curlFor("createAppointment", baseUrl),
  ].join("\n");
}

export const nodeVerify = `import { createHmac, timingSafeEqual } from "node:crypto";

// rawBody must be the exact bytes you received, as a string. Do not parse and re-serialise it first.
export function verifyKalendr(rawBody, signatureHeader, secret) {
  const parts = {};
  for (const piece of signatureHeader.split(",")) {
    const at = piece.indexOf("=");
    parts[piece.slice(0, at)] = piece.slice(at + 1);
  }
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const expected = createHmac("sha256", secret).update(\`\${t}.\${rawBody}\`).digest();
  const given = Buffer.from(parts.v1 ?? "", "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}`;

export const pythonVerify = `import hmac, hashlib, time

def verify_kalendr(raw_body: bytes, signature_header: str, secret: str) -> bool:
    parts = dict(piece.split("=", 1) for piece in signature_header.split(","))
    try:
        t = int(parts["t"])
    except (KeyError, ValueError):
        return False
    if abs(time.time() - t) > 300:
        return False
    signed = str(t).encode() + b"." + raw_body
    expected = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts.get("v1", ""))`;

export const errorExample = `{
  "error": {
    "code": "validation_error",
    "message": "Please check the highlighted fields.",
    "fieldErrors": { "startsAt": ["Invalid ISO datetime"] }
  }
}`;

export const pageExample = `{
  "data": [ { "id": "apt_77d2", "status": "booked" } ],
  "nextCursor": "eyJ0IjoiMjAyNi0xMi0wMVQwOTozMDowMC4wMDBaIiwiaWQiOiJhcHRfNzdkMiJ9",
  "hasMore": true
}`;
