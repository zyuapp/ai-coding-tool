import { Cron } from "croner";
import { randomUUID } from "node:crypto";
import {
  automationAfterRun,
  didRun,
  isOneShotSchedule,
  quietTick,
  scheduleFieldCount,
  type Automation,
  type AutomationDraft,
  type AutomationPatch,
  type AutomationRunStatus,
  type AutomationView,
  type TickKind,
} from "../../domain/automation.js";

export type AutomationStore = {
  listAutomations(): Automation[];
  saveAutomation(automation: Automation): void;
  deleteAutomation(id: string): void;
};

/** Resolves when the scheduled run reaches a terminal state, so overrun protection can hold the next tick. */
export type AutomationDispatch = (automation: Automation, tick: TickKind) => Promise<AutomationRunStatus>;

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
      if (!this.arm(automation)) this.markMissed(automation.id);
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

  forThread(taskId: string): AutomationView | null {
    const automation = this.find(taskId);
    return automation ? this.view(automation) : null;
  }

  /** One automation per thread: creating a second one replaces the first. */
  save(draft: AutomationDraft): AutomationView {
    assertSchedule(draft.schedule, draft.timezone);
    const existing = this.find(draft.taskId);
    const at = this.now();
    /** Rewriting a schedule leaves its quiet where it was: an empty sentence is how the quiet is taken off. */
    const surfaceWhen = draft.surfaceWhen ?? existing?.surfaceWhen;
    const automation: Automation = {
      id: existing?.id ?? randomUUID(),
      taskId: draft.taskId,
      prompt: draft.prompt,
      schedule: draft.schedule,
      ...(draft.timezone === undefined ? {} : { timezone: draft.timezone }),
      ...(draft.policy === undefined ? {} : { policy: draft.policy }),
      ...(surfaceWhen ? { surfaceWhen } : {}),
      paused: draft.paused ?? false,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
      runCount: existing?.runCount ?? 0,
      ...(existing?.lastRunAt === undefined ? {} : { lastRunAt: existing.lastRunAt }),
      ...(existing?.lastStatus === undefined ? {} : { lastStatus: existing.lastStatus }),
      ...(existing?.lastStatusAt === undefined ? {} : { lastStatusAt: existing.lastStatusAt }),
      ...(existing?.consecutiveDeclines === undefined ? {} : { consecutiveDeclines: existing.consecutiveDeclines }),
      ...(existing?.overrunCount === undefined ? {} : { overrunCount: existing.overrunCount }),
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
    const { surfaceWhen: _spoken, ...silent } = existing;
    const automation: Automation = {
      /** An empty sentence is how the panel takes a schedule off quiet, so it drops the field. */
      ...(patch.surfaceWhen === "" ? silent : existing),
      ...(patch.surfaceWhen ? { surfaceWhen: patch.surfaceWhen } : {}),
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

  /**
   * Fires outside the schedule. Declines while a scheduled run is still in flight, like a real tick
   * would. The button is the only way here, so the user is watching by construction and it is loud.
   */
  async runNow(taskId: string): Promise<AutomationRunStatus | "busy"> {
    const existing = this.find(taskId);
    if (!existing) throw new Error("This task has no automation.");
    if (this.firing.has(existing.id) || this.crons.get(existing.id)?.isBusy()) return "busy";
    return this.fire(existing.id, true);
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

  /** Returns false when the schedule cannot fire again, which must never throw out of start(). */
  private arm(automation: Automation) {
    this.disarm(automation.id);
    let cron: Cron;
    try {
      cron = new Cron(automation.schedule, {
        /** A tick dropped for overrunning is recorded nowhere else: croner never calls the callback. */
        protect: () => this.countOverrun(automation.id),
        paused: automation.paused,
        ...(automation.timezone === undefined ? {} : { timezone: automation.timezone }),
        catch: true,
      }, async () => { await this.fire(automation.id, false); });
    } catch {
      return false;
    }
    if (!cron.nextRun()) {
      cron.stop();
      return false;
    }
    this.crons.set(automation.id, cron);
    return true;
  }

  private disarm(id: string) {
    this.crons.get(id)?.stop();
    this.crons.delete(id);
  }

  private async fire(id: string, manual: boolean): Promise<AutomationRunStatus> {
    const automation = this.automations.get(id);
    if (!automation || this.firing.has(id)) return "skipped";
    this.firing.add(id);
    let status: AutomationRunStatus;
    try {
      status = await this.dispatch(automation, { quiet: quietTick(automation, manual), unattended: !manual });
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
    // A spent schedule is only finished if this tick actually ran; otherwise the moment was missed.
    if (this.canFireAgain(id)) this.notify();
    else if (didRun(status)) this.remove(updated.taskId);
    else this.markMissed(id);
    return status;
  }

  private countOverrun(id: string) {
    const automation = this.automations.get(id);
    if (!automation) return;
    const counted = { ...automation, overrunCount: (automation.overrunCount ?? 0) + 1, updatedAt: this.now() };
    this.automations.set(id, counted);
    this.store.saveAutomation(counted);
    this.notify();
  }

  private canFireAgain(id: string) {
    const cron = this.crons.get(id);
    return cron ? cron.nextRun() !== null : false;
  }

  /** Keeps a one-shot that can no longer fire, plainly marked, so it never disappears unrun. */
  private markMissed(id: string) {
    const automation = this.automations.get(id);
    if (!automation || automation.lastStatus === "missed") return;
    const missed = automationAfterRun(automation, "missed", this.now());
    this.automations.set(id, missed);
    this.store.saveAutomation(missed);
    this.notify();
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
