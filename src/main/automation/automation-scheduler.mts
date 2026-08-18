import { Cron } from "croner";
import { randomUUID } from "node:crypto";
import {
  automationAfterRun,
  isOneShotSchedule,
  scheduleFieldCount,
  type Automation,
  type AutomationDraft,
  type AutomationPatch,
  type AutomationRunStatus,
  type AutomationView,
} from "../../domain/automation.js";

export type AutomationStore = {
  listAutomations(): Automation[];
  saveAutomation(automation: Automation): void;
  deleteAutomation(id: string): void;
};

/** Resolves when the scheduled run reaches a terminal state, so overrun protection can hold the next tick. */
export type AutomationDispatch = (automation: Automation) => Promise<AutomationRunStatus>;

export type AutomationSchedulerOptions = {
  now?: () => number;
  onChange?: (automations: AutomationView[]) => void;
};

export class AutomationScheduler {
  private readonly automations = new Map<string, Automation>();
  private readonly crons = new Map<string, Cron>();
  /** Guards manual runs the way croner's `protect` guards scheduled ticks: one run per automation at a time. */
  private readonly firing = new Set<string>();
  private readonly now: () => number;

  constructor(
    private readonly store: AutomationStore,
    private readonly dispatch: AutomationDispatch,
    private readonly options: AutomationSchedulerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  /** Rebuilds the in-memory timers from storage. Ticks missed while the app was closed are not replayed. */
  start() {
    for (const automation of this.store.listAutomations()) {
      this.automations.set(automation.id, automation);
      this.arm(automation);
    }
    this.notify();
  }

  stop() {
    for (const cron of this.crons.values()) cron.stop();
    this.crons.clear();
    this.automations.clear();
  }

  list(): AutomationView[] {
    return [...this.automations.values()]
      .map((automation) => this.view(automation))
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  forTask(taskId: string): AutomationView | null {
    const automation = this.find(taskId);
    return automation ? this.view(automation) : null;
  }

  /** One automation per task: creating a second one replaces the first. */
  save(draft: AutomationDraft): AutomationView {
    assertSchedule(draft.schedule, draft.timezone);
    const existing = this.find(draft.taskId);
    const at = this.now();
    const automation: Automation = {
      id: existing?.id ?? randomUUID(),
      taskId: draft.taskId,
      prompt: draft.prompt,
      schedule: draft.schedule,
      ...(draft.timezone === undefined ? {} : { timezone: draft.timezone }),
      ...(draft.policy === undefined ? {} : { policy: draft.policy }),
      paused: draft.paused ?? false,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
      runCount: existing?.runCount ?? 0,
      ...(existing?.lastRunAt === undefined ? {} : { lastRunAt: existing.lastRunAt }),
      ...(existing?.lastStatus === undefined ? {} : { lastStatus: existing.lastStatus }),
    };
    this.commit(automation);
    return this.view(automation);
  }

  update(taskId: string, patch: AutomationPatch): AutomationView {
    const existing = this.find(taskId);
    if (!existing) throw new Error("This task has no automation.");
    const schedule = patch.schedule ?? existing.schedule;
    const timezone = patch.timezone ?? existing.timezone;
    if (patch.schedule !== undefined || patch.timezone !== undefined) assertSchedule(schedule, timezone);
    const automation: Automation = {
      ...existing,
      ...(patch.prompt === undefined ? {} : { prompt: patch.prompt }),
      schedule,
      ...(timezone === undefined ? {} : { timezone }),
      ...(patch.policy === undefined ? {} : { policy: patch.policy }),
      ...(patch.paused === undefined ? {} : { paused: patch.paused }),
      updatedAt: this.now(),
    };
    this.commit(automation);
    return this.view(automation);
  }

  remove(taskId: string): boolean {
    const existing = this.find(taskId);
    if (!existing) return false;
    this.disarm(existing.id);
    this.automations.delete(existing.id);
    this.store.deleteAutomation(existing.id);
    this.notify();
    return true;
  }

  /** Fires outside the schedule. Declines while a scheduled run is still in flight, like a real tick would. */
  async runNow(taskId: string): Promise<AutomationRunStatus | "busy"> {
    const existing = this.find(taskId);
    if (!existing) throw new Error("This task has no automation.");
    if (this.firing.has(existing.id) || this.crons.get(existing.id)?.isBusy()) return "busy";
    return this.fire(existing.id);
  }

  private find(taskId: string) {
    for (const automation of this.automations.values()) {
      if (automation.taskId === taskId) return automation;
    }
    return undefined;
  }

  private commit(automation: Automation) {
    this.automations.set(automation.id, automation);
    this.store.saveAutomation(automation);
    this.arm(automation);
    this.notify();
  }

  /** Returns false when the stored schedule cannot be armed, which must never throw out of start(). */
  private arm(automation: Automation) {
    this.disarm(automation.id);
    let cron: Cron;
    try {
      cron = new Cron(automation.schedule, {
        protect: true,
        paused: automation.paused,
        ...(automation.timezone === undefined ? {} : { timezone: automation.timezone }),
        catch: true,
      }, async () => { await this.fire(automation.id); });
    } catch {
      return false;
    }
    this.crons.set(automation.id, cron);
    return true;
  }

  private disarm(id: string) {
    this.crons.get(id)?.stop();
    this.crons.delete(id);
  }

  private async fire(id: string): Promise<AutomationRunStatus> {
    const automation = this.automations.get(id);
    if (!automation || this.firing.has(id)) return "skipped";
    this.firing.add(id);
    let status: AutomationRunStatus;
    try {
      status = await this.dispatch(automation);
    } catch {
      status = "failed";
    } finally {
      this.firing.delete(id);
    }
    const current = this.automations.get(id);
    // The run itself may have deleted the automation once its stop condition was met.
    if (!current) return status;
    const updated = automationAfterRun(current, status, this.now());
    this.automations.set(id, updated);
    this.store.saveAutomation(updated);
    if (this.crons.get(id)?.nextRun() === null) this.remove(updated.taskId);
    else this.notify();
    return status;
  }

  private view(automation: Automation): AutomationView {
    const nextRun = automation.paused ? null : this.crons.get(automation.id)?.nextRun() ?? null;
    return { ...automation, nextRunAt: nextRun ? nextRun.getTime() : null };
  }

  private notify() {
    this.options.onChange?.(this.list());
  }
}

/** Rejects anything croner cannot parse, sub-minute cadence, and one-shots that can never fire. */
export function assertSchedule(schedule: string, timezone?: string) {
  if (!isOneShotSchedule(schedule) && scheduleFieldCount(schedule) > 5) {
    throw new Error("Automations run at most once a minute, so seconds are not supported. Use a five-field cron expression.");
  }
  let cron: Cron;
  try {
    cron = new Cron(schedule, { paused: true, ...(timezone === undefined ? {} : { timezone }) });
  } catch (error) {
    throw new Error(`"${schedule}" is not a valid schedule: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    if (!cron.nextRun()) throw new Error(`"${schedule}" has no future run.`);
  } finally {
    cron.stop();
  }
}
