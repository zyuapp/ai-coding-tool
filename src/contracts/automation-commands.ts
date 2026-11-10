import { isAutomationDraft, isAutomationPatch, type AutomationDraft, type AutomationPatch } from "../domain/automation.js";
import { optionalText, record, text, type Declarations } from "./command-declaration.js";

export type AutomationCommand =
  /**
   * What a scheduled run found, which puts its thread in front of the user and outlives every later
   * run. A turn that is not a scheduled run raises nothing: silence is only ever earned by a schedule.
   */
  | { type: "automation.notify"; taskId: string; headline: string; detail?: string; key?: string }
  /** A scheduled run saying it looked and found nothing, which is the only thing that earns silence. */
  | { type: "automation.nothing-to-report"; taskId: string; checked: string }
  | { type: "automation.save"; taskId?: string; draft: Omit<AutomationDraft, "taskId"> }
  | { type: "automation.update"; taskId?: string; patch: AutomationPatch }
  | { type: "automation.delete"; taskId?: string }
  | { type: "automation.run-now"; taskId?: string };

function isScheduleDraft(value: unknown): value is Omit<AutomationDraft, "taskId"> {
  return record(value) && isAutomationDraft({ ...value, taskId: "view" });
}

export const automationCommands = {
  "automation.notify": { fields: { taskId: text, headline: text, detail: optionalText, key: optionalText }, at: "thread" },
  "automation.nothing-to-report": { fields: { taskId: text, checked: text }, at: "thread" },
  "automation.save": { fields: { taskId: optionalText, draft: isScheduleDraft }, at: "thread" },
  "automation.update": { fields: { taskId: optionalText, patch: isAutomationPatch }, at: "thread" },
  "automation.delete": { fields: { taskId: optionalText }, at: "thread" },
  "automation.run-now": { fields: { taskId: optionalText }, at: "thread" },
} satisfies Declarations<AutomationCommand>;
