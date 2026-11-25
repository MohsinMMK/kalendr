import { PgBoss } from "pg-boss";
import type postgres from "postgres";

import { pollCalendars, renewCalendarChannels, resnapshotCalendars } from "./calendar/jobs";
import { alertOverduePrivacyRequests, applyPrivacyRetention, applyRetention, expireSlotHolds, reportDeadLetters, sweepReminders, sweepWaitlist } from "./jobs";
import { sweepBilling } from "./billing-jobs";
import { sweepCredits, sweepMemberships } from "./offers";
import { purgeMergeSnapshots } from "./customer-jobs";
import { sweepCampaigns } from "./campaign-jobs";
import { expireRequests, expireRescheduleRequests, remindAboutRequests } from "./request-jobs";
import { expireUnpaidHolds, queueReconciliation, sweepStuckRefunds } from "./payments/jobs";
import { reconcileWorkflows, sweepWorkflowMessages } from "./workflow-jobs";
import { sweepDomains } from "./domain-jobs";
import { sweepEmailDomains } from "./email-domain-jobs";
import { sweepOnboarding } from "./onboarding-jobs";
import { purgeImportFiles } from "./import-jobs";
import { sendOwnerSummaries } from "./owner-summary-jobs";
import { sendStaffDigests } from "./staff-digest-jobs";
import { backfillMedia, reEncryptStorage, rotateDueKeys, storageHealth } from "./storage-jobs";

/** pg-boss keeps its own tables in this schema, apart from Kalendr's. The migration creates it. */
export const JOBS_SCHEMA = "kalendr_jobs";

export type JobLog = (job: string, fields: Record<string, number>) => void;

interface TimedJob {
  name: string;
  cron: string;
  run: (database: postgres.Sql) => Promise<Record<string, number>>;
}

/**
 * The repeating jobs. pg-boss stores each schedule once, so any number of workers can call
 * `schedule` and each minute still runs one job. `singleton` keeps a slow run from overlapping
 * the next one. Times are UTC.
 */
export const TIMED_JOBS: readonly TimedJob[] = [
  { name: "reminder-sweep", cron: "* * * * *", run: async (database) => ({ ...(await sweepReminders(database)) }) },
  { name: "hold-expiry", cron: "* * * * *", run: async (database) => ({ ...(await expireSlotHolds(database)) }) },
  // Smart waitlist (feature 21): see docs/WORKER.md.
  { name: "waitlist-sweep", cron: "* * * * *", run: async (database) => ({ ...(await sweepWaitlist(database)) }) },
  // Requests nobody answered (feature 41): see request-jobs.ts.
  { name: "request-expire", cron: "* * * * *", run: async (database) => ({ ...(await expireRequests(database)) }) },
  { name: "reschedule-expire", cron: "*/5 * * * *", run: async (database) => ({ ...(await expireRescheduleRequests(database)) }) },
  { name: "request-reminder", cron: "*/5 * * * *", run: async (database) => ({ ...(await remindAboutRequests(database)) }) },
  // Calendar sync (feature 16): channels renewed hourly, calendars that cannot push read every 5 minutes, snapshots refreshed daily.
  // Online payments (feature 23): unpaid holds released each minute, stuck refunds queued again, the day's payments compared with the provider's at 21:00 UTC.
  { name: "payment-hold-expiry", cron: "* * * * *", run: async (database) => ({ ...(await expireUnpaidHolds(database)) }) },
  { name: "payment-refund-sweep", cron: "*/10 * * * *", run: async (database) => ({ ...(await sweepStuckRefunds(database)) }) },
  { name: "payment-reconcile", cron: "0 21 * * *", run: async (database) => ({ ...(await queueReconciliation(database)) }) },
  // Packages and memberships (feature 25): expired credits written off and reminders queued at 02:30 UTC; lapsed memberships paused hourly.
  { name: "package-credit-sweep", cron: "30 2 * * *", run: async (database) => ({ ...(await sweepCredits(database)) }) },
  { name: "membership-grace-sweep", cron: "10 * * * *", run: async (database) => ({ ...(await sweepMemberships(database)) }) },
  // Customer profiles (feature 27): the saved details of a merge are dropped once its 30 days to undo have passed.
  { name: "customer-merge-purge", cron: "40 3 * * *", run: async (database) => ({ ...(await purgeMergeSnapshots(database)) }) },
  { name: "calendar-renewal", cron: "0 * * * *", run: async (database) => ({ ...(await renewCalendarChannels(database)) }) },
  { name: "calendar-poll", cron: "*/5 * * * *", run: async (database) => ({ ...(await pollCalendars(database)) }) },
  { name: "calendar-resnapshot", cron: "15 * * * *", run: async (database) => ({ ...(await resnapshotCalendars(database)) }) },
  { name: "retention", cron: "0 3 * * *", run: async (database) => ({ ...(await applyRetention(database)) }) },
  { name: "dead-letter-report", cron: "0 * * * *", run: async (database) => ({ ...(await reportDeadLetters(database)) }) },
  // Privacy centre (feature 7): see docs/privacy-centre.md.
  { name: "privacy-retention", cron: "20 3 * * *", run: async (database) => ({ ...(await applyPrivacyRetention(database)) }) },
  { name: "privacy-overdue", cron: "0 4 * * *", run: async (database) => ({ ...(await alertOverduePrivacyRequests(database)) }) },
  // Message workflows (feature 5): see workflow-jobs.ts.
  { name: "workflow-sweep", cron: "* * * * *", run: async (database) => ({ ...(await sweepWorkflowMessages(database)) }) },
  { name: "workflow-reconcile", cron: "* * * * *", run: async (database) => ({ ...(await reconcileWorkflows(database)) }) },
  // Campaigns and win-back (feature 28): queues due fan-outs, hands messages on at a steady rate, credits bookings, pauses unhealthy campaigns.
  { name: "campaign-tick", cron: "* * * * *", run: async (database) => ({ ...(await sweepCampaigns(database)) }) },
  // Protected storage (feature 10): see storage-jobs.ts.
  { name: "storage-re-encrypt", cron: "*/10 * * * *", run: async (database) => ({ ...(await reEncryptStorage(database)) }) },
  { name: "key-rotation", cron: "30 2 * * *", run: async (database) => ({ ...(await rotateDueKeys(database)) }) },
  { name: "media-backfill", cron: "*/15 * * * *", run: async (database) => ({ ...(await backfillMedia(database)) }) },
  // Plans and billing (feature 14): trials, grace periods, pending downgrades and cancellations. See billing-jobs.ts.
  { name: "billing-sweep", cron: "*/5 * * * *", run: async (database) => ({ ...(await sweepBilling(database)) }) },
  // Own web addresses (feature 13): pending ones every 5 minutes for 72 hours, live ones daily. See domain-jobs.ts.
  { name: "domain-sweep", cron: "*/5 * * * *", run: async (database) => ({ ...(await sweepDomains(database)) }) },
  // Company email domains (feature 53): the owner's TXT record, looked up here and never in a request. See email-domain-jobs.ts.
  { name: "email-domain-sweep", cron: "*/5 * * * *", run: async (database) => ({ ...(await sweepEmailDomains(database)) }) },
  // Onboarding emails to new owners (feature 11): finish setting up at day 1, share your link at day 3. See onboarding-jobs.ts.
  { name: "onboarding-sweep", cron: "*/15 * * * *", run: async (database) => ({ ...(await sweepOnboarding(database)) }) },
  { name: "storage-health", cron: "5 * * * *", run: async (database) => ({ ...(await storageHealth(database)) }) },
  // Data import (feature 12): stored files are removed once the undo window has closed.
  // Staff morning digest (feature 56): checked every 15 minutes, sent once per person per local day. See staff-digest-jobs.ts.
  { name: "staff-digest", cron: "*/15 * * * *", run: async (database) => ({ ...(await sendStaffDigests(database)) }) },
  // Owner summary (Cal.com parity wave): the weekly or monthly email of counts, checked hourly. See owner-summary-jobs.ts.
  { name: "owner-summary", cron: "10 * * * *", run: async (database) => ({ ...(await sendOwnerSummaries(database)) }) },
  { name: "import-file-purge", cron: "40 * * * *", run: async (database) => ({ ...(await purgeImportFiles(database)) }) },
];

export interface Scheduler {
  stop(): Promise<void>;
}

export async function startScheduler(
  connectionString: string,
  database: postgres.Sql,
  log: JobLog,
  onError: (job: string, error: unknown) => void,
): Promise<Scheduler> {
  const boss = new PgBoss({
    connectionString,
    schema: JOBS_SCHEMA,
    createSchema: false,
    application_name: "kalendr-worker-jobs",
    max: 2,
  });
  // pg-boss reports its own connection trouble here. Log the kind only: the message may hold connection details.
  boss.on("error", (error: unknown) => onError("pg-boss", error));
  await boss.start();
  for (const job of TIMED_JOBS) {
    await boss.createQueue(job.name, { policy: "singleton", retryLimit: 2, expireInSeconds: 300 });
    await boss.schedule(job.name, job.cron);
    await boss.work(job.name, async () => {
      try {
        log(job.name, await job.run(database));
      } catch (error) {
        onError(job.name, error);
        throw error;
      }
    });
  }
  return {
    async stop() {
      await boss.stop({ graceful: true, timeout: 20_000 });
    },
  };
}
