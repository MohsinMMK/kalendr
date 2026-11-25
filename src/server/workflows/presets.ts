/** Turns on the standard set of workflows for one business. Safe to run again: each preset is added once. */
import { sql } from "drizzle-orm";

import type { BusinessTypeId } from "../../lib/business-types";
import { workflowPresetsFor } from "../../lib/workflow-presets";
import { asString, type Runner } from "./runner";

export async function applyWorkflowPresets(run: Runner, tenantId: string, businessType: BusinessTypeId): Promise<number> {
  let added = 0;
  for (const preset of workflowPresetsFor(businessType)) {
    const { workflow } = preset;
    const [created] = await run(sql`
      insert into workflows (tenant_id, name, trigger, offset_minutes, filters, active, preset_key)
      values (${tenantId}, ${workflow.name}, ${workflow.trigger}, ${workflow.offsetMinutes}, ${JSON.stringify(workflow.filters)}::text::jsonb, ${workflow.active}, ${preset.presetKey})
      on conflict (tenant_id, preset_key) where preset_key is not null do nothing
      returning id
    `);
    if (!created) continue;
    added += 1;
    for (const [position, step] of workflow.steps.entries()) {
      await run(sql`
        insert into workflow_steps (tenant_id, workflow_id, position, channel, subject, body, template_key, wait_minutes, ignore_quiet_hours, skip_if_confirmed)
        values (${tenantId}, ${asString(created.id)}, ${position}, ${step.channel}, ${step.subject}, ${step.body}, ${step.templateKey}, ${step.waitMinutes}, ${step.ignoreQuietHours}, ${step.skipIfConfirmed})
      `);
    }
  }
  // Marks the business as running on workflows (the fixed reminder stands down) and asks for a full re-plan.
  await run(sql`
    insert into workflow_settings (tenant_id, presets_applied_at) values (${tenantId}, now())
    on conflict (tenant_id) do update
      set presets_applied_at = coalesce(workflow_settings.presets_applied_at, now()), reconciled_at = null, updated_at = now()
  `);
  return added;
}
