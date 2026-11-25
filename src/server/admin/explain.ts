/**
 * One plain sentence about why a message was or was not delivered, for support. Built only from the status, the
 * failure code and the attempt count: never from an address, a name or the message text, none of which this module sees.
 */
export interface MessageFacts {
  status: string;
  failureCode: string | null;
  attemptCount: number;
  scheduledAt: string;
  channel: string;
}

const codeMeanings: Record<string, string> = {
  bounced: "the address bounced earlier",
  bounced_soft: "the inbox was full or unavailable",
  suppressed_bounced: "the address bounced earlier",
  complained: "the person marked an earlier message as spam",
  rejected: "the provider rejected it",
  provider_error: "the provider had an error",
  provider_failed: "the provider could not send it",
  provider_not_configured: "this channel is not set up",
  resend_rate_limit_exceeded: "the email provider's rate limit was hit",
  resend_validation_error: "the email provider found the request invalid",
  opted_out: "the person opted out",
  no_consent: "there is no messaging consent on file",
  invalid_destination: "the contact details are not valid",
};

function plainCode(code: string): string {
  return codeMeanings[code] ?? `code ${code}`;
}

function attempts(count: number): string {
  return count === 1 ? "1 attempt" : `${count} attempts`;
}

/** `now` is injected so the sentence for a queued message is the same in a test as in production. */
export function explainMessage(facts: MessageFacts, now: Date = new Date()): string {
  const code = facts.failureCode;
  switch (facts.status) {
    case "delivered":
      return "Delivered.";
    case "cancelled":
      return code ? `Skipped: ${plainCode(code)}.` : "Skipped: it was cancelled before it was sent, for example because the visit changed.";
    case "failed":
      if (code && /^(suppressed|bounced|complained|opted_out|no_consent)/.test(code)) return `Skipped: ${plainCode(code)}.`;
      return code ? `Failed after ${attempts(facts.attemptCount)}: ${plainCode(code)}.` : `Failed after ${attempts(facts.attemptCount)}; no reason was recorded.`;
    case "sending":
      return `Sending now (${attempts(facts.attemptCount)} so far).`;
    case "queued": {
      const due = new Date(facts.scheduledAt);
      if (Number.isNaN(due.getTime())) return "Waiting in the queue.";
      return due.getTime() > now.getTime()
        ? `Waiting: scheduled for ${due.toISOString().slice(0, 16).replace("T", " ")} UTC.`
        : `Waiting in the queue; it was due at ${due.toISOString().slice(0, 16).replace("T", " ")} UTC and has not been picked up yet.${facts.attemptCount > 0 ? ` ${attempts(facts.attemptCount)} so far.` : ""}`;
    }
    default:
      return `Status is ${facts.status}.`;
  }
}
