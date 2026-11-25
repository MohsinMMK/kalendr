// The Kalendr command line. It is a thin wrapper over /api/v1, so it can do exactly what the key's scopes allow
// and nothing more. The key comes from KALENDR_API_KEY and is never printed. Answers are JSON, one document per call.

const HELP = `kalendr: talk to the Kalendr API from a terminal

Set KALENDR_API_KEY (an API key from Settings > Developers) and, if you do not use the hosted app, KALENDR_URL.

Usage: kalendr <command> [options]

Commands:
  services                          List services                              (services:read)
  staff                             List staff who take bookings              (staff:read)
  times --service ID [--from ISO] [--to ISO] [--staff ID]
                                    Find open times                            (availability:read)
  bookings [--from ISO] [--to ISO] [--status S]
                                    List bookings, newest first                (appointments:read)
  customers [--phone P] [--email E] Find customers                             (customers:read)
  book --service ID --staff ID --at ISO --first N --last N --phone P --email E
                                    Book a time for a new customer             (appointments:write)
  reschedule ID --at ISO [--staff ID]
                                    Move a booking                             (appointments:write)
  cancel ID [--reason TEXT]         Cancel a booking                           (appointments:write)
  mcp-config                        Print the MCP server settings for an AI assistant
  help                              Show this text

Options for every command: --limit N (lists), --url URL (overrides KALENDR_URL).`;

/** Flags are \`--name value\`; anything else is a positional argument. */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new CliError(`Give --${name} a value.`);
      flags[name] = value;
      index += 1;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

export class CliError extends Error {}

function need(flags, name) {
  const value = flags[name];
  if (!value) throw new CliError(`Missing --${name}. Run \`kalendr help\`.`);
  return value;
}

function query(flags, names) {
  const params = new URLSearchParams();
  for (const [flag, param] of names) if (flags[flag]) params.set(param, flags[flag]);
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** The request for each command: method, path and body. Kept as data so it is easy to read and to test. */
export function planRequest(command, positional, flags) {
  const limit = flags.limit ? [["limit", "limit"]] : [];
  switch (command) {
    case "services": return { method: "GET", path: `/api/v1/services${query(flags, limit)}` };
    case "staff": return { method: "GET", path: `/api/v1/staff${query(flags, limit)}` };
    case "times": {
      need(flags, "service");
      return { method: "GET", path: `/api/v1/availability${query(flags, [["service", "serviceId"], ["from", "from"], ["to", "to"], ["staff", "staffId"]])}` };
    }
    case "bookings": return { method: "GET", path: `/api/v1/appointments${query(flags, [...limit, ["from", "from"], ["to", "to"], ["status", "status"]])}` };
    case "customers": return { method: "GET", path: `/api/v1/customers${query(flags, [...limit, ["phone", "phone"], ["email", "email"]])}` };
    case "book":
      return {
        method: "POST", path: "/api/v1/appointments", idempotent: true,
        body: {
          serviceId: need(flags, "service"), staffId: need(flags, "staff"), startsAt: need(flags, "at"),
          customer: { firstName: need(flags, "first"), lastName: need(flags, "last"), phone: need(flags, "phone"), email: need(flags, "email") },
        },
      };
    case "reschedule": {
      const id = positional[0];
      if (!id) throw new CliError("Give the booking id: kalendr reschedule ID --at ISO");
      return { method: "POST", path: `/api/v1/appointments/${encodeURIComponent(id)}/reschedule`, idempotent: true, body: { startsAt: need(flags, "at"), ...(flags.staff ? { staffId: flags.staff } : {}) } };
    }
    case "cancel": {
      const id = positional[0];
      if (!id) throw new CliError("Give the booking id: kalendr cancel ID");
      return { method: "POST", path: `/api/v1/appointments/${encodeURIComponent(id)}/cancel`, idempotent: true, body: flags.reason ? { reason: flags.reason } : {} };
    }
    default: throw new CliError(`Unknown command "${command}". Run \`kalendr help\`.`);
  }
}

export async function run(argv, io) {
  try {
    const [command = "help", ...rest] = argv;
    if (command === "help" || command === "--help" || command === "-h") {
      io.out(HELP);
      return 0;
    }
    const { positional, flags } = parseArgs(rest);
    const baseUrl = (flags.url ?? io.env.KALENDR_URL ?? "http://localhost:3000").replace(/\/$/, "");
    if (command === "mcp-config") {
      io.out(JSON.stringify({ mcpServers: { kalendr: { type: "http", url: `${baseUrl}/api/mcp`, headers: { Authorization: "Bearer ${KALENDR_API_KEY}" } } } }, null, 2));
      return 0;
    }
    const request = planRequest(command, positional, flags);
    const key = io.env.KALENDR_API_KEY;
    if (!key) throw new CliError("Set KALENDR_API_KEY to an API key from Settings > Developers.");
    const response = await io.fetch(`${baseUrl}${request.path}`, {
      method: request.method,
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        ...(request.body ? { "Content-Type": "application/json" } : {}),
        // A fresh key per run: re-running the command books again; the key only protects a retry inside one call.
        ...(request.idempotent ? { "Idempotency-Key": globalThis.crypto.randomUUID() } : {}),
      },
      ...(request.body ? { body: JSON.stringify(request.body) } : {}),
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      // handled below
    }
    if (!response.ok) {
      const error = body?.error;
      io.err(`${error?.code ?? "request_failed"}: ${error?.message ?? `The server answered ${response.status}.`}`);
      return 1;
    }
    io.out(JSON.stringify(body, null, 2));
    return 0;
  } catch (error) {
    if (error instanceof CliError) {
      io.err(error.message);
      return 2;
    }
    io.err(`Could not reach the server: ${error instanceof Error ? error.message : "unknown error"}`);
    return 1;
  }
}
