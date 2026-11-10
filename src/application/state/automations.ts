import type { AutomationEdit, AutomationView } from "../../domain/automation.js";

export type AutomationsState = {
  automations: AutomationView[];
  /** Unsaved edits in each thread's automation panel. Session-only. */
  automationEdits: Record<string, AutomationEdit>;
};

export function initialAutomationsState(): AutomationsState {
  return { automations: [], automationEdits: {} };
}
