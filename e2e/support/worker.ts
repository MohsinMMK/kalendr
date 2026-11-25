import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const captureUrl = process.env.KALENDR_CAPTURE_URL ?? "http://127.0.0.1:3199";
const appUrl = process.env.KALENDR_APP_URL ?? "http://localhost:3100";

function runtimeEnv(): Record<string, string> {
  return Object.fromEntries(
    readFileSync(resolve(process.cwd(), process.env.KALENDR_E2E_STATE_DIR ?? ".e2e", "runtime.env"), "utf8").split("\n").filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

/**
 * The outbox worker in local_capture mode: WhatsApp, email and text go to the capture server, so a customer's sign-in code
 * and step-up code (feature 8) can be read from there. Specs start it in beforeAll and kill it in afterAll.
 *
 * The worker now imports the web app's booking code, which marks itself "server-only"; the container image bundles the
 * worker with that marker emptied (scripts/build-jobs.mjs), and this run does the same through its own tsconfig.
 */
export function startWorker(): ChildProcess {
  const runtime = runtimeEnv();
  return spawn(resolve(process.cwd(), "node_modules/.bin/tsx"), ["--tsconfig", "e2e/support/tsconfig.worker.json", "src/worker/run.ts"], {
    cwd: process.cwd(),
    stdio: "ignore",
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "development",
      KALENDR_WORKER_MODE: "local_capture",
      KALENDR_PREVIEW_MODE: "false",
      // Same fake calendars as the web server (playwright.config.ts), so a calendar connected by another spec is never called for real.
      CALENDAR_PROVIDER_MODE: "fake",
      DATABASE_URL: runtime.DATABASE_URL,
      WORKER_DATABASE_URL: runtime.WORKER_DATABASE_URL,
      KALENDR_RECORDS_KEY: runtime.KALENDR_RECORDS_KEY,
      KALENDR_KEY_PROVIDER: runtime.KALENDR_KEY_PROVIDER,
      KALENDR_LOCAL_MASTER_KEY: runtime.KALENDR_LOCAL_MASTER_KEY,
      BETTER_AUTH_SECRET: runtime.BETTER_AUTH_SECRET,
      BETTER_AUTH_URL: appUrl,
      EMAIL_FROM: "Kalendr Tests <tests@example.com>",
      RESEND_API_KEY: "e2e-capture-only",
      EMAIL_API_URL: `${captureUrl}/emails`,
      WHATSAPP_ACCESS_TOKEN: "e2e-capture-only",
      WHATSAPP_PHONE_NUMBER_ID: "e2e-phone-number",
      WHATSAPP_APP_SECRET: "kalendr-test-whatsapp-app-secret-0001",
      WHATSAPP_API_URL: `${captureUrl}/whatsapp`,
      LOG_LEVEL: "warn",
    },
  });
}

interface CapturedWhatsApp {
  to: string;
  template: { components?: Array<{ type: string; parameters?: Array<{ text?: string }> }> } | null;
}

/** The code in the newest WhatsApp authentication message to this number, waiting up to 30 seconds for the worker. */
export async function whatsAppCode(phone: string, after = 0): Promise<{ code: string; copyButtonCode: string | null; count: number }> {
  const digits = phone.replace(/\D/g, "");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const messages = (await (await fetch(`${captureUrl}/whatsapp/messages?to=${digits}`)).json()) as CapturedWhatsApp[];
    if (messages.length > after) {
      const components = messages.at(-1)!.template?.components ?? [];
      const code = components.find((component) => component.type === "body")?.parameters?.[0]?.text ?? "";
      const button = components.find((component) => component.type === "button")?.parameters?.[0]?.text ?? null;
      return { code, copyButtonCode: button, count: messages.length };
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error("No WhatsApp message arrived for this number.");
}

export async function whatsAppCount(phone: string): Promise<number> {
  const messages = (await (await fetch(`${captureUrl}/whatsapp/messages?to=${phone.replace(/\D/g, "")}`)).json()) as unknown[];
  return messages.length;
}
