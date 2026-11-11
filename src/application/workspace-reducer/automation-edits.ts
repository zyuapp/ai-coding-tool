/** Schedules as one input leaves them. Only the functions here make one. */
import { ownFields } from "./slice.js";
import { withoutMatching } from "../removals.js";
import type { AutomationsState } from "../state/automations.js";

class AutomationsChange {
  private declare readonly owned: never;
  constructor(readonly view: AutomationsState) {}
}

export type AutomationsEdit = AutomationsChange;

export function automationsOf(state: AutomationsState): AutomationsEdit {
  return new AutomationsChange(ownFields<AutomationsState>(state, { automations: true, automationEdits: true }));
}

/** Threads gone for good have no schedule left listed. */
export function automationsForgottenIn(edit: AutomationsEdit, removed: Set<string>): AutomationsEdit {
  return new AutomationsChange({ ...edit.view, automations: withoutMatching(edit.view.automations, (automation) => removed.has(automation.taskId)) });
}
