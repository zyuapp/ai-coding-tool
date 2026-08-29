import assert from "node:assert/strict";
import { reduce, type WorkspaceEffect, type WorkspaceInput, type WorkspaceTransition } from "../../src/application/workspace-reducer.ts";
import { dockFor, dockOwner, emptyWorkspaceState, type WorkspaceState } from "../../src/application/workspace-state.ts";
import { viewPreferences } from "../../src/application/view-preferences.ts";
import type { ActiveRun } from "../../src/application/thread-run-state.ts";
import type { AutomationView } from "../../src/domain/automation.ts";
import type { CreatedWorktree, RunEvent } from "../../src/contracts/ipc.ts";
import type { ViewPreferences } from "../../src/contracts/preferences.ts";
import type { Project } from "../../src/domain/project.ts";
import type { Thread } from "../../src/domain/thread.ts";
import type { WorkspaceRecord } from "../../src/domain/workspace.ts";
import type { Worktree } from "../../src/domain/worktree.ts";

/** The dock a thread was left in: the one on screen unless a thread is named. */
export function dock(state: WorkspaceState, owner?: string) {
  return dockFor(state, owner ?? dockOwner(state));
}

export function task(id: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id,
    title: id,
    engine: "claude",
    executionPolicy: "confirm",
    messages: [],
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: 1 },
    updatedAt: 1,
    ...overrides,
  };
}

export function workspace(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return { ...emptyWorkspaceState(), ...overrides };
}

export function activeRun(taskId: string, runId: string, overrides: Partial<ActiveRun> = {}): ActiveRun {
  return {
    taskId,
    runId,
    sequence: 0,
    status: "running",
    origin: "composer",
    quiet: false,
    notified: false,
    acknowledged: false,
    reportedIssues: [],
    messagesBefore: 0,
    before: { updatedAt: 1 },
    ...overrides,
  };
}

export function automation(taskId: string): AutomationView {
  return {
    id: `automation-${taskId}`,
    taskId,
    prompt: "Poll",
    schedule: "0 * * * *",
    paused: false,
    createdAt: 1,
    updatedAt: 1,
    runCount: 0,
    nextRunAt: null,
  };
}

export const preferences = (overrides: Partial<ViewPreferences>): ViewPreferences => ({ ...viewPreferences(emptyWorkspaceState()), ...overrides });

export function effectAt<Type extends WorkspaceEffect["type"]>(
  transition: WorkspaceTransition,
  type: Type,
  index = 0,
): Extract<WorkspaceEffect, { type: Type }> {
  const effect = transition.effects[index];
  assert.ok(effect?.type === type, `expected effect ${type} at index ${index}`);
  return effect as Extract<WorkspaceEffect, { type: Type }>;
}

export function effectOf<Type extends WorkspaceEffect["type"]>(
  transition: WorkspaceTransition,
  type: Type,
): Extract<WorkspaceEffect, { type: Type }> {
  const effect = transition.effects.find((candidate) => candidate.type === type);
  assert.ok(effect?.type === type, `expected effect ${type}`);
  return effect as Extract<WorkspaceEffect, { type: Type }>;
}

export function required<Value>(value: Value | null | undefined, message = "expected value"): Value {
  assert.ok(value !== null && value !== undefined, message);
  return value;
}

export type RunEventPayload = RunEvent extends infer Event
  ? Event extends RunEvent
    ? Omit<Event, "taskId" | "runId" | "sequence">
    : never
  : never;

export function correlatedRunEvent(taskId: string, runId: string, sequence: number, payload: RunEventPayload): WorkspaceInput {
  return { type: "run.event", event: { taskId, runId, sequence, ...payload } as RunEvent };
}

/** Drives a command and the events its effects would produce, the way the renderer does. */
export function run(state: WorkspaceState, inputs: WorkspaceInput[]): WorkspaceState {
  return inputs.reduce((current, input) => reduce(current, input).state, state);
}

/** A task mid-run, which is the only state in which a message can be queued or steered. */
export function running(taskId = "task-a", runId = "run-a", overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return workspace({
    threads: [task(taskId)],
    currentId: taskId,
    activeRuns: { [taskId]: activeRun(taskId, runId) },
    runStatuses: { [taskId]: "running" },
    ...overrides,
  });
}

export function queueMessage(state: WorkspaceState, text: string, steer = false): WorkspaceState {
  return run(state, [{ type: "view.set-prompt", prompt: text }, { type: "task.send", attachments: [], ...(steer ? { steer } : {}) }]);
}

export const PROJECT: Project = { id: "project-a", root: "/repo", workspaceId: "workspace-a" };

export function projected(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return workspace({ projects: [PROJECT], draftProjectId: PROJECT.id, ...overrides });
}

/** What the desktop answers with: the checkout on disk, before the reducer says whose project it is. */
export function madeWorktree(id = "wt1"): CreatedWorktree {
  return { id, root: `/worktrees/repo-${id}`, workspaceId: `worktree-${id}`, baseCommit: "abcdef1234", createdAt: 2, lastUsedAt: 2 };
}

/** A checkout the app already holds a record of, the way a loaded store carries one. */
export function heldWorktree(id = "wt1"): Worktree {
  return { ...madeWorktree(id), projectId: PROJECT.id };
}

/** Puts `threads` in `worktree` the way state does: a record on one side, a claim on the other. */
export function inside(worktree: Worktree, threads: Thread[]): Pick<WorkspaceState, "worktrees" | "threads"> {
  return { worktrees: [worktree], threads: threads.map((item) => ({ ...item, worktreeId: worktree.id })) };
}

/** Sends the composer draft and answers the workspace resolution with `resolution`. */
export function send(
  state: WorkspaceState,
  resolution: WorkspaceRecord,
  worktree?: CreatedWorktree,
): WorkspaceTransition & { request: Extract<WorkspaceEffect, { type: "resolve-run-workspace" }> } {
  const sending = reduce(state, { type: "task.send", attachments: [] });
  const request = effectAt(sending, "resolve-run-workspace");
  const resolved = reduce(sending.state, {
    type: "run.resolved",
    pendingId: request.pendingId,
    workspace: resolution,
    ...(worktree ? { worktree } : {}),
  });
  return { request, ...resolved };
}
