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
  listAutomations(): Automation[] | Promise<Automation[]>;
  saveAutomation(automation: Automation): void | Promise<void>;
  deleteAutomation(id: string): void | Promise<void>;
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
  private changes: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly store: AutomationStore,
    private readonly dispatch: AutomationDispatch,
    private readonly options: AutomationSchedulerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  /** Rebuilds the in-memory timers from storage. Ticks missed while the app was closed are not replayed. */
  async start() {
    await this.changes.catch(() => {});
    this.stopped = false;
    const automations = await this.store.listAutomations();
    if (this.stopped) return;
    this.automations.clear();
    for (const automation of automations) {
      this.automations.set(automation.id, automation);
      if (!this.arm(automation)) await this.markMissed(automation.id);
    }
    this.notify();
  }

  stop() {
    this.stopped = true;
    for (const cron of this.crons.values()) cron.stop();
    this.crons.clear();
  }

  flush(): Promise<void> { return this.changes; }

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
  save(draft: AutomationDraft): Promise<AutomationView> {
    return this.change(() => this.saveDraft(draft));
  }

  private async saveDraft(draft: AutomationDraft): Promise<AutomationView> {
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
    await this.commit(automation);
    return this.view(automation);
  }

  update(taskId: string, patch: AutomationPatch): Promise<AutomationView> {
    return this.change(() => this.updateDraft(taskId, patch));
  }

  private async updateDraft(taskId: string, patch: AutomationPatch): Promise<AutomationView> {
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
    await this.commit(automation);
    return this.view(automation);
  }

  remove(taskId: string): Promise<boolean> {
    return this.change(() => this.removeStored(taskId));
  }

  private async removeStored(taskId: string): Promise<boolean> {
    const existing = this.find(taskId);
    if (!existing) return false;
    await this.store.deleteAutomation(existing.id);
    this.disarm(existing.id);
    this.automations.delete(existing.id);
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

  private async commit(automation: Automation) {
    await this.store.saveAutomation(automation);
    this.automations.set(automation.id, automation);
    if (this.stopped) return;
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
        protect: () => { void this.countOverrun(automation.id).catch((error) => console.error("Could not record automation overrun:", error)); },
        paused: automation.paused,
        ...(automation.timezone === undefined ? {} : { timezone: automation.timezone }),
        catch: (error) => console.error("Could not record automation result:", error),
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
    if (!automation || this.stopped || this.firing.has(id)) return "skipped";
    this.firing.add(id);
    try {
      let status: AutomationRunStatus;
      try {
        status = await this.dispatch(automation, { quiet: quietTick(automation, manual), unattended: !manual });
      } catch {
        status = "failed";
      }
      if (this.stopped) return status;
      await this.change(async () => {
        const current = this.automations.get(id);
        // The run itself may have deleted the automation once its stop condition was met.
        if (!current) return;
        const updated = automationAfterRun(current, status, this.now());
        await this.store.saveAutomation(updated);
        this.automations.set(id, updated);
        if (this.stopped) return;
        // A spent schedule is only finished if this tick actually ran; otherwise the moment was missed.
        if (this.canFireAgain(id)) this.notify();
        else if (didRun(status)) await this.removeStored(updated.taskId);
        else await this.markMissed(id);
      });
      return status;
    } finally {
      this.firing.delete(id);
    }
  }

  private countOverrun(id: string) {
    return this.change(async () => {
      const automation = this.automations.get(id);
      if (!automation) return;
      const counted = { ...automation, overrunCount: (automation.overrunCount ?? 0) + 1, updatedAt: this.now() };
      await this.store.saveAutomation(counted);
      this.automations.set(id, counted);
      if (this.stopped) return;
      this.notify();
    });
  }

  private canFireAgain(id: string) {
    const cron = this.crons.get(id);
    return cron ? cron.nextRun() !== null : false;
  }

  /** Keeps a one-shot that can no longer fire, plainly marked, so it never disappears unrun. */
  private async markMissed(id: string) {
    const automation = this.automations.get(id);
    if (!automation || automation.lastStatus === "missed") return;
    const missed = automationAfterRun(automation, "missed", this.now());
    await this.store.saveAutomation(missed);
    this.automations.set(id, missed);
    if (this.stopped) return;
    this.notify();
  }

  private view(automation: Automation): AutomationView {
    const nextRun = automation.paused ? null : this.crons.get(automation.id)?.nextRun() ?? null;
    return { ...automation, nextRunAt: nextRun ? nextRun.getTime() : null };
  }

  private notify() {
    this.options.onChange?.(this.list());
  }

  /** Store mutations settle in order so concurrent requests cannot replace each other's updates. */
  private change<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.changes.catch(() => {}).then(operation);
    this.changes = result.then(() => {});
    void this.changes.catch(() => {});
    return result;
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
