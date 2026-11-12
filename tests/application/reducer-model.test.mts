/**
 * Random command and event sequences against the real reducer, with a fake runtime that resolves
 * checkouts and a fake engine that reports in the order the run coordinator does. Every rule below
 * is checked after every input. `FC_RUNS` and `FC_SEED` set how many sequences run and which.
 */
import assert from "node:assert/strict";
import fc from "fast-check";
import { test } from "vitest";
import { reduce, type WorkspaceEffect, type WorkspaceInput } from "../../src/application/workspace-reducer.ts";
import { promptKey, type WorkspaceState } from "../../src/application/workspace-state.ts";
import type { RunEvent } from "../../src/contracts/ipc.ts";
import { task, workspace } from "./workspace-reducer-fixtures.mts";

type EngineRun = { taskId: string; runId: string; sequence: number; approvals: number; asking: boolean; answered: number; cancel: boolean; steers: string[]; done: boolean };

const ACTIONS = [
  "type-send", "type-steer", "select", "new-thread", "cancel", "decide", "archive", "restore", "dismiss",
  "drop-queued", "edit-queued", "steer-queued", "limit-resume", "limit-cancel", "limits-elapsed",
  "resolve", "unresolve",
  "eng-started", "eng-delta", "eng-approval", "eng-approval-ack", "eng-succeed", "eng-fail", "eng-limit-session", "eng-limit-weekly",
  "eng-cancelled", "eng-steer-delivered", "eng-steer-failed", "eng-usage",
] as const;
type Action = (typeof ACTIONS)[number];
type Step = { action: Action; a: number; b: number };

const PROJECTLESS = { id: "projectless", kind: "projectless", root: "/tmp" } as const;
const pick = <T,>(list: readonly T[], n: number) => list.length ? list[n % list.length] : undefined;

class World {
  state = workspace({ threads: [task("A"), task("B")], currentId: "A" });
  /** Checkouts the runtime has been asked to resolve and has not answered yet. */
  resolving: string[] = [];
  engine: EngineRun[] = [];
  /** Every message typed, by a token unique to it, and the ones the user removed. */
  typed: string[] = [];
  removed = new Set<string>();
  log: string[] = [];

  dispatch(input: WorkspaceInput) {
    this.log.push(JSON.stringify(input).slice(0, 220));
    const transition = reduce(this.state, input);
    this.state = transition.state;
    for (const effect of transition.effects) this.perform(effect);
  }

  perform(effect: WorkspaceEffect) {
    if (effect.type === "resolve-run-workspace") this.resolving.push(effect.pendingId);
    else if (effect.type === "start-run") {
      this.engine.push({ taskId: effect.command.taskId, runId: effect.command.runId, sequence: 0, approvals: 0, asking: false, answered: 0, cancel: false, steers: [], done: false });
    } else if (effect.type === "send-run-command") {
      const { command } = effect;
      const run = "runId" in command ? this.engine.find((item) => item.runId === command.runId && !item.done) : undefined;
      if (!run) return;
      if (command.type === "cancel") run.cancel = true;
      if (command.type === "approval") run.answered += 1;
      if (command.type === "steer") run.steers.push(command.messageId);
    }
  }

  emit(run: EngineRun, payload: Record<string, unknown>) {
    run.sequence += 1;
    this.dispatch({ type: "run.event", event: { taskId: run.taskId, runId: run.runId, sequence: run.sequence, ...payload } as RunEvent });
  }

  finish(run: EngineRun, payload: Record<string, unknown>) {
    run.done = true;
    this.emit(run, { type: "run.status", ...payload });
  }

  queued() {
    return Object.entries(this.state.queuedMessages).flatMap(([taskId, list]) => list.map((message) => ({ taskId, message })));
  }

  apply({ action, a, b }: Step) {
    const ids = this.state.threads.map((thread) => thread.id);
    const id = pick(ids, a);
    const live = this.engine.filter((run) => !run.done);
    const run = pick(live, a);
    switch (action) {
      case "type-send":
      case "type-steer": {
        const token = `<<m${this.typed.length + 1}>>`;
        this.typed.push(token);
        const draft = this.state.prompts[promptKey(this.state)];
        this.dispatch({ type: "view.set-prompt", prompt: draft ? `${draft} ${token}` : token });
        this.dispatch({ type: "task.send", attachments: [], ...(action === "type-steer" ? { steer: true } : {}) });
        return;
      }
      case "select": if (id) this.dispatch({ type: "task.select", taskId: id }); return;
      case "new-thread": this.dispatch({ type: "task.new" }); return;
      case "cancel": if (id) this.dispatch({ type: "run.cancel", taskId: id }); return;
      case "archive": if (id) this.dispatch({ type: "task.archive", taskId: id }); return;
      case "restore": if (id) this.dispatch({ type: "task.restore", taskId: id }); return;
      case "dismiss": if (id) this.dispatch({ type: "task.dismiss", taskId: id }); return;
      case "limit-resume": if (id) this.dispatch({ type: "limit.resume", taskId: id }); return;
      case "limit-cancel": if (id) this.dispatch({ type: "limit.cancel", taskId: id }); return;
      case "limits-elapsed": this.dispatch({ type: "limits.elapsed", at: Date.now() + 10 * 3600_000 }); return;
      case "decide": {
        const approval = pick(Object.values(this.state.approvals), a);
        if (approval) this.dispatch({ type: "run.decide", allow: b % 2 === 0, taskId: approval.taskId, runId: approval.runId, approvalId: approval.approvalId });
        return;
      }
      case "drop-queued":
      case "edit-queued":
      case "steer-queued": {
        const entry = pick(this.queued(), a);
        if (!entry) return;
        const type = action === "drop-queued" ? "task.drop-queued" : action === "edit-queued" ? "task.edit-queued" : "task.steer-queued";
        const before = this.state.queuedMessages[entry.taskId]?.length ?? 0;
        this.dispatch({ type, taskId: entry.taskId, messageId: entry.message.id });
        if (type === "task.drop-queued" && (this.state.queuedMessages[entry.taskId]?.length ?? 0) < before) {
          for (const token of entry.message.text.match(/<<m\d+>>/g) ?? []) this.removed.add(token);
        }
        return;
      }
      case "resolve":
      case "unresolve": {
        if (!this.resolving.length) return;
        const [pendingId] = this.resolving.splice(a % this.resolving.length, 1);
        if (action === "resolve") this.dispatch({ type: "run.resolved", pendingId: pendingId!, workspace: PROJECTLESS });
        else this.dispatch({ type: "run.unresolved", pendingId: pendingId!, message: "Could not create the worktree" });
        return;
      }
      default: this.engineReports(action, run, live);
    }
  }

  engineReports(action: Action, run: EngineRun | undefined, live: EngineRun[]) {
    switch (action) {
      case "eng-started": if (run) this.emit(run, { type: "run.started" }); return;
      case "eng-delta": if (run) this.emit(run, { type: "assistant.delta", messageId: `r-${run.runId}`, text: "hi", append: true }); return;
      case "eng-usage": if (run) this.emit(run, { type: "context.usage", tokens: 10, limit: 100, model: "claude-opus-5-5" }); return;
      case "eng-approval": {
        if (!run || run.asking || run.cancel) return;
        run.asking = true;
        run.approvals += 1;
        this.emit(run, { type: "approval.requested", approvalId: `ap-${run.runId}-${run.approvals}`, intent: { name: "Bash", input: { command: "ls" } }, title: "Bash needs approval", description: "Review" });
        this.emit(run, { type: "run.status", status: "awaiting-approval" });
        return;
      }
      case "eng-approval-ack": {
        if (!run || !run.asking || run.answered < run.approvals) return;
        run.asking = false;
        this.emit(run, { type: "run.status", status: "running" });
        return;
      }
      case "eng-succeed": if (run && !run.asking) this.finish(run, { status: "succeeded" }); return;
      case "eng-fail": if (run) this.finish(run, { status: "failed", message: "boom" }); return;
      case "eng-limit-session": if (run) this.finish(run, { status: "failed", message: "limit", limit: { resetsAt: Date.now() + 3600_000, window: "session" } }); return;
      case "eng-limit-weekly": if (run) this.finish(run, { status: "failed", message: "limit", limit: { resetsAt: Date.now() + 3600_000, window: "weekly" } }); return;
      case "eng-cancelled": {
        const target = live.find((item) => item.cancel);
        if (target) this.finish(target, { status: "cancelled" });
        return;
      }
      case "eng-steer-delivered":
      case "eng-steer-failed": {
        const target = live.find((item) => item.steers.length);
        if (!target) return;
        const messageId = target.steers.shift()!;
        this.emit(target, action === "eng-steer-delivered" ? { type: "queued.delivered", messageId } : { type: "queued.steer-failed", messageId, message: "rejected" });
        return;
      }
    }
  }
}

function checkRuns(state: WorkspaceState) {
  const threads = new Set(state.threads.map((thread) => thread.id));
  for (const [taskId, run] of Object.entries(state.activeRuns)) {
    assert.equal(run.taskId, taskId, "a live run is kept under its own thread");
    assert.ok(threads.has(taskId), `live run ${run.runId} belongs to a thread that exists`);
    assert.equal(state.lastRunIds[taskId], run.runId, "lastRunIds names the live run");
    if (run.status === "awaiting-approval") assert.ok(state.approvals[run.runId], `${taskId} awaits an approval it has none of`);
  }
  for (const thread of state.threads) {
    const active = state.activeRuns[thread.id];
    assert.equal(state.runStatuses[thread.id] === "running", Boolean(active), `${thread.id} says ${state.runStatuses[thread.id]} with${active ? "" : " no"} live run`);
    if (thread.archivedAt !== undefined && active) assert.ok(active.cancelling, `archived ${thread.id} keeps a run that is not being stopped`);
  }
  for (const approval of Object.values(state.approvals)) {
    assert.equal(state.activeRuns[approval.taskId]?.runId, approval.runId, `approval ${approval.approvalId} outlived its run`);
  }
}

/** Every message typed is in exactly one place: the transcript, a queue, a composer, or a run on its way. */
function checkMessages(world: World) {
  const { state } = world;
  const places = [
    ...state.threads.flatMap((thread) => thread.messages.filter((message) => message.kind === "user").map((message) => message.text)),
    ...Object.values(state.queuedMessages).flatMap((list) => list.map((message) => message.text)),
    ...Object.values(state.prompts),
    ...Object.values(state.pendingRuns).filter((pending) => !pending.draftKey && !pending.queuedIds).map((pending) => pending.text),
  ].join("\u0000");
  for (const token of world.typed) {
    if (world.removed.has(token)) continue;
    const count = places.split(token).length - 1;
    assert.equal(count, 1, `message ${token} is in ${count} places`);
  }
}

function checkQueues(world: World) {
  const { state } = world;
  for (const [taskId, list] of Object.entries(state.queuedMessages)) {
    if (!list.length) continue;
    const thread = state.threads.find((item) => item.id === taskId);
    assert.ok(thread, `a queue is kept for missing thread ${taskId}`);
    const busy = Boolean(state.activeRuns[taskId]) || Object.values(state.pendingRuns).some((pending) => pending.taskId === taskId);
    assert.ok(busy || thread.limitPause || state.creatingWorktrees.includes(taskId), `a queue of ${list.length} waits on idle ${taskId}`);
    for (const message of list) {
      if (!message.steering) continue;
      const asked = world.engine.some((run) => run.taskId === taskId && run.steers.includes(message.id));
      assert.ok(asked, `${message.id} reads as steering with no steer the engine has yet to answer`);
    }
  }
}

const WEIGHTS: Partial<Record<Action, number>> = { "type-send": 8, "type-steer": 2, resolve: 8, unresolve: 1, "eng-started": 2, "eng-delta": 2, "eng-approval": 3, "eng-approval-ack": 3, decide: 3, "eng-succeed": 4, "eng-cancelled": 3, "eng-steer-delivered": 2, select: 3 };
const step = fc.record({
  action: fc.oneof(...ACTIONS.map((action) => ({ arbitrary: fc.constant(action), weight: WEIGHTS[action] ?? 1 }))),
  a: fc.nat(7),
  b: fc.nat(7),
});

function play(steps: Step[]) {
  const world = new World();
  try {
    for (const next of steps) {
      world.apply(next);
      checkRuns(world.state);
      checkMessages(world);
      checkQueues(world);
    }
  } catch (error) {
    (error as Error).message += `\n--- inputs (${world.log.length}) ---\n${world.log.join("\n")}`;
    throw error;
  }
}

test("runs, queues, approvals and every typed message stay consistent over random sequences", () => {
  fc.assert(fc.property(fc.array(step, { minLength: 10, maxLength: 120, size: "max" }), play), {
    numRuns: Number(process.env.FC_RUNS ?? 300),
    ...(process.env.FC_SEED ? { seed: Number(process.env.FC_SEED) } : {}),
  });
});
