import { estimateTokens, type LlmBlock, type LlmClient, type LlmMessage, type LlmRequest, type LlmResponse } from "./model";

/**
 * A small rule-based stand-in for the model (feature 30), used only when ASSISTANT_PROVIDER_MODE=fake: local development and the
 * browser tests. It reads the conversation and the tool results the way the real model would and calls the same tools, so a whole
 * booking runs through the real server code with no network. It is not a language model and says so nowhere to customers: it is never
 * reachable in production (the setting is refused unless the app's own address is on this machine).
 */

interface Seen { services: Array<{ id: string; name: string; personIds: string[] }>; times: Array<{ startsAt: string; when: string; personId: string; personName: string | null }>; bookings: Array<{ id: string; service: string; when: string }> }

const blocksOf = (message: LlmMessage): LlmBlock[] => (typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content);
const textsOf = (message: LlmMessage): string[] => blocksOf(message).flatMap((block) => (block.type === "text" ? [block.text] : []));

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

function resultsOf(messages: readonly LlmMessage[]): Array<{ name: string; data: unknown; isError: boolean }> {
  const names = new Map<string, string>();
  const results: Array<{ name: string; data: unknown; isError: boolean }> = [];
  for (const message of messages) {
    for (const block of blocksOf(message)) {
      if (block.type === "tool_use") names.set(block.id, block.name);
      if (block.type === "tool_result") results.push({ name: names.get(block.tool_use_id) ?? "", data: parseJson(block.content), isError: block.is_error === true });
    }
  }
  return results;
}

function record(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : {}; }
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
const str = (value: unknown): string => (typeof value === "string" ? value : "");

function seenSoFar(messages: readonly LlmMessage[]): Seen {
  const seen: Seen = { services: [], times: [], bookings: [] };
  for (const result of resultsOf(messages)) {
    const data = record(result.data);
    if (result.name === "list_services") seen.services = list(data.services).map((entry) => ({ id: str(record(entry).id), name: str(record(entry).name), personIds: list(record(entry).personIds).map(str) }));
    if (result.name === "find_times") seen.times = list(data.times).map((entry) => ({ startsAt: str(record(entry).startsAt), when: str(record(entry).when), personId: str(record(entry).personId), personName: str(record(entry).personName) || null }));
    if (result.name === "find_my_bookings") seen.bookings = list(data.bookings).map((entry) => ({ id: str(record(entry).id), service: str(record(entry).service), when: str(record(entry).when) }));
  }
  return seen;
}

const customerTexts = (messages: readonly LlmMessage[]): string[] => messages.filter((message) => message.role === "user").flatMap((message) => textsOf(message).filter((text) => !text.startsWith("[SERVER NOTE]")));

function dayWindow(text: string, now: Date): { from: string; to: string } {
  const lower = text.toLowerCase();
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const target = days.findIndex((day) => lower.includes(day));
  const start = new Date(now);
  if (lower.includes("tomorrow")) start.setUTCDate(start.getUTCDate() + 1);
  else if (target >= 0) start.setUTCDate(start.getUTCDate() + ((target - start.getUTCDay() + 7) % 7 || 7));
  start.setUTCHours(0, 0, 0, 0);
  const from = start.getTime() < now.getTime() ? now : start;
  const to = new Date(start.getTime() + (target >= 0 || lower.includes("tomorrow") ? 86_400_000 : 7 * 86_400_000));
  return { from: from.toISOString(), to: to.toISOString() };
}

function pickTime(text: string, times: Seen["times"]): Seen["times"][number] | null {
  const lower = text.toLowerCase();
  const ordinal = /\b(first|1st|one)\b/.test(lower) ? 0 : /\b(second|2nd|two)\b/.test(lower) ? 1 : /\b(third|3rd|three)\b/.test(lower) ? 2 : -1;
  if (ordinal >= 0 && times[ordinal]) return times[ordinal] ?? null;
  const clock = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(lower);
  if (clock) {
    const hour = Number(clock[1]) % 12 + (clock[3] === "pm" ? 12 : 0);
    const minute = clock[2] ?? "00";
    const label = `${((hour + 11) % 12) + 1}:${minute} ${hour >= 12 ? "pm" : "am"}`;
    return times.find((time) => time.when.toLowerCase().includes(label)) ?? null;
  }
  return null;
}

function nameAndPhone(texts: readonly string[]): { firstName?: string; lastName?: string; phone?: string } {
  const joined = texts.join("\n");
  const phone = /(\+?\d[\d\s-]{8,16}\d)/.exec(joined)?.[1]?.trim();
  const name = /(?:my name is|i am|i'm|this is|name:)\s+([A-Za-z]+)\s+([A-Za-z]+)/i.exec(joined);
  return { ...(name?.[1] ? { firstName: name[1] } : {}), ...(name?.[2] ? { lastName: name[2] } : {}), ...(phone ? { phone } : {}) };
}

let counter = 0;
const call = (name: string, input: Record<string, unknown>): LlmBlock => ({ type: "tool_use", id: `toolu_local_${(counter += 1)}`, name, input });
const say = (text: string): LlmBlock[] => [{ type: "text", text }];

export function createLocalModel(now: () => Date = () => new Date()): LlmClient {
  return {
    mode: "fake",
    async complete(request: LlmRequest): Promise<LlmResponse> {
      const content = decide(request, now());
      const tool = content.some((block) => block.type === "tool_use");
      return {
        content, stopReason: tool ? "tool_use" : "end_turn",
        usage: { inputTokens: estimateTokens(JSON.stringify(request.messages)) + 600, outputTokens: estimateTokens(JSON.stringify(content)), cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
}

/** The staff copilot's side: find a customer, find a time, propose the booking. It proposes only; the staff member's button books. */
function decideCopilot(request: LlmRequest, now: Date): LlmBlock[] {
  const messages = request.messages;
  const last = messages[messages.length - 1];
  if (!last) return say("What would you like to look up?");
  const results = resultsOf(messages);
  const latestResult = results.at(-1);
  const toolTurn = last.role === "user" && blocksOf(last).some((block) => block.type === "tool_result");
  if (toolTurn && latestResult) {
    const data = record(latestResult.data);
    if (latestResult.isError) return say(str(data.error) || "That didn't work.");
    const seen = seenSoFar(messages);
    switch (latestResult.name) {
      case "search_customers": {
        const found = list(data.customers);
        return found.length === 0 ? say("I couldn't find that customer.") : [call("list_services", {})];
      }
      case "list_services": {
        const service = seen.services[0];
        if (!service) return say("There are no services to book.");
        const window = dayWindow("next week", now);
        return [call("find_times", { serviceId: service.id, from: window.from, to: new Date(new Date(window.from).getTime() + 7 * 86_400_000).toISOString() })];
      }
      case "find_times": {
        const time = seen.times[0];
        const service = seen.services[0];
        const customer = results.filter((entry) => entry.name === "search_customers").map((entry) => record(list(record(entry.data).customers)[0]))[0];
        if (!time || !service || !customer || !str(customer.id)) return say("I couldn't find a free time next week.");
        return [call("propose_booking", { customerId: str(customer.id), serviceId: service.id, personId: time.personId, startsAt: time.startsAt })];
      }
      case "propose_booking": return say(`I suggest: ${str(data.summary)} Press Confirm to book it.`);
      default: return say("Done.");
    }
  }
  const text = customerTexts(messages).at(-1) ?? "";
  const name = /\bfor\s+(?:Mrs?\.?|Ms\.?|Dr\.?)?\s*([A-Za-z][A-Za-z0-9]{2,})/.exec(text)?.[1];
  if (/\b(gap|slot|time|find)\b/i.test(text) && name) return [call("search_customers", { name })];
  if (/\b(come back|third|lapsed|rebook)\b/i.test(text)) return [call("lapsed_customers", {})];
  return say("I can find a gap for a customer, list who has not come back, or draft a reply.");
}

function decide(request: LlmRequest, now: Date): LlmBlock[] {
  if (request.stableSystem.includes("staff copilot")) return decideCopilot(request, now);
  const messages = request.messages;
  const last = messages[messages.length - 1];
  if (!last) return say("How can I help?");
  const texts = customerTexts(messages);
  const latest = texts[texts.length - 1] ?? "";
  const lower = latest.toLowerCase();
  const seen = seenSoFar(messages);
  const lastResults = last.role === "user" ? blocksOf(last).filter((block) => block.type === "tool_result") : [];
  const note = last.role === "user" ? textsOf(last).find((text) => text.startsWith("[SERVER NOTE]")) : undefined;

  if (note) {
    if (note.includes("could NOT be done")) return say("Sorry, that didn't go through. I can look for another time, or you can book on the booking page.");
    if (note.includes("this was done")) return say(`All set. ${note.replace(/^\[SERVER NOTE\] The customer confirmed and this was done: /, "").split(" Tell them")[0] ?? ""} A confirmation will be sent to you.`);
    if (note.includes("phone is now verified")) return [call("find_my_bookings", {})];
    if (note.includes("code the customer entered was wrong")) return say("That code didn't match. Please check it and try again.");
  }

  if (lastResults.length > 0) {
    const latestResult = resultsOf(messages).at(-1);
    const data = record(latestResult?.data);
    if (latestResult?.isError) return say(str(data.error) || "Sorry, I couldn't do that. You can use the booking page.");
    switch (latestResult?.name) {
      case "list_services": {
        const service = seen.services.find((entry) => texts.join(" ").toLowerCase().includes(entry.name.toLowerCase().split(" ")[0] ?? "~~"));
        if (!service) return say(`We offer: ${seen.services.map((entry) => entry.name).join(", ")}. Which would you like?`);
        const window = dayWindow(texts.join(" "), now);
        return [call("find_times", { serviceId: service.id, from: window.from, to: window.to })];
      }
      case "find_times": {
        if (seen.times.length === 0) return say("I couldn't find free times in that window. Would another day work?");
        return say(`Here are some times: ${seen.times.slice(0, 4).map((time, index) => `${index + 1}. ${time.when}${time.personName ? ` with ${time.personName}` : ""}`).join("; ")}. Which one suits you?`);
      }
      case "hold_and_book": return say(`${str(data.summary)} By confirming you accept the privacy notice and agree to reminders. Tap Confirm or reply yes.`);
      case "request_verification_code": return say("If that number has bookings here, I've sent a code by text. Please enter it in the code box.");
      case "find_my_bookings": {
        if (seen.bookings.length === 0) return say("I don't see any upcoming bookings for that number.");
        return say(`Your upcoming bookings: ${seen.bookings.map((booking, index) => `${index + 1}. ${booking.service}, ${booking.when}`).join("; ")}. Would you like to cancel or move one?`);
      }
      case "cancel":
      case "reschedule": return say(`${str(data.summary)} Tap Confirm or reply yes.`);
      case "get_business_info": return say(`${str(data.name)}${str(data.phone) ? `, phone ${str(data.phone)}` : ""}.`);
      default: return say("Done.");
    }
  }

  const everything = texts.join(" ").toLowerCase();
  if (/\b(my (bookings?|appointments?)|cancel|reschedule|move my)\b/.test(lower)) {
    const phone = nameAndPhone(texts).phone;
    if (seen.bookings.length > 0) {
      const wantsCancel = /\bcancel\b/.test(lower);
      const target = seen.bookings[0];
      if (target && wantsCancel) return [call("cancel", { appointmentId: target.id })];
      return say(`Your upcoming bookings: ${seen.bookings.map((booking, index) => `${index + 1}. ${booking.service}, ${booking.when}`).join("; ")}.`);
    }
    if (!phone) return say("I can help with that. What's the phone number you booked with? I'll send you a code to check it's you.");
    return [call("request_verification_code", { phone })];
  }
  if (/\b(hours|open|address|where|phone number|contact)\b/.test(lower)) return [call("get_business_info", {})];
  if (seen.services.length === 0 && /\b(book|appointment|consult\w*|haircut|treatment|session|time|slot|available|visit|see|want|need|like)\b/.test(everything)) return [call("list_services", {})];
  if (seen.times.length > 0) {
    const chosen = pickTime(latest, seen.times);
    if (chosen) {
      const details = nameAndPhone(texts);
      const service = seen.services.find((entry) => everything.includes(entry.name.toLowerCase().split(" ")[0] ?? "~~")) ?? seen.services[0];
      if (!details.firstName || !details.lastName || !details.phone) return say("Great. What's your first and last name, and the best phone number? For example: My name is Asha Rao, 98765 43210.");
      if (service) return [call("hold_and_book", { serviceId: service.id, personId: chosen.personId, startsAt: chosen.startsAt, ...details })];
    }
    const details = nameAndPhone(texts);
    const previous = pickTime(texts.slice(0, -1).join(" "), seen.times);
    if (previous && details.firstName && details.lastName && details.phone) {
      const service = seen.services.find((entry) => everything.includes(entry.name.toLowerCase().split(" ")[0] ?? "~~")) ?? seen.services[0];
      if (service) return [call("hold_and_book", { serviceId: service.id, personId: previous.personId, startsAt: previous.startsAt, ...details })];
    }
    return say("Which of those times would you like?");
  }
  return say("I can check times and help you book, move or cancel. What would you like to do?");
}
