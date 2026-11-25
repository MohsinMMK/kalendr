import { appointmentMessageHandler, type HandlerDependencies } from "./appointment-message";
import type { EventHandler } from "./types";
import { standDownForWorkflows } from "./workflow-message";

/** Asks for a review a little after a visit is finished. Later edits don't cancel it; a visit that isn't finished does. */
export function reviewRequestHandler(dependencies: HandlerDependencies): EventHandler {
  return standDownForWorkflows(appointmentMessageHandler(dependencies));
}
