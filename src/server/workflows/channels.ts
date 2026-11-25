/**
 * Which channels a workflow step may use, and whether each can send right now.
 *
 * A channel is a plain string key (`email`, `whatsapp`, `sms`). The sender for a key is the worker's provider
 * adapter for that key (`ProviderAdapters` in src/worker/delivery.ts), so adding WhatsApp or SMS is one entry
 * here saying it is ready, plus the adapter the worker already registers under the same key.
 */
import { smsChannelFromEnv } from "../channels/sms-config";
import { whatsappChannelFromEnv } from "../channels/whatsapp-config";
import { channelLabels, workflowChannelKeys, type WorkflowChannelKey, type WorkflowChannelStatus } from "../../lib/workflow-contracts";

type Readiness = { ready: true } | { ready: false; reason: string };

/** A channel is ready when its provider is set up in this server's environment, the same test the worker uses to register its adapter. */
const readiness: Record<WorkflowChannelKey, () => Readiness> = {
  email: () => ({ ready: true }),
  whatsapp: () => whatsappChannelFromEnv({ localOnly: false })
    ? { ready: true }
    : { ready: false, reason: "WhatsApp isn't connected yet. Ask whoever set up your account to add the WhatsApp details." },
  sms: () => smsChannelFromEnv({ localOnly: false })
    ? { ready: true }
    : { ready: false, reason: "Text messages aren't connected yet. Ask whoever set up your account to add the SMS details." },
};

export function workflowChannelStatuses(): WorkflowChannelStatus[] {
  return workflowChannelKeys.map((key) => {
    const state = readiness[key]();
    return { key, label: channelLabels[key], ready: state.ready, reason: state.ready ? "" : state.reason };
  });
}
