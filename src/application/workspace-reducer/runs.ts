/** A run's life: the checkout it resolves to, what it reports, and how it ends. */
import { ack, beginRun, clearedDraft, drainQueue, handOverDraftDock, now, queuedFor, readDiffFrom, settled, sideChannelFor, startRunCommand, targetId, withAttendedRun, withDeliveredMessage, withQueued, withSideChat, withUsedWorktree, withoutPending } from "./shared.js";
import type { WorkspaceEffect, WorkspaceInput, WorkspaceTransition } from "./types.js";
import { taskTitleFor } from "../attachments.js";
import { fileTitle } from "../files.js";
import { announced } from "../notices.js";
import { pasteTitle } from "../pastes.js";
import { outcomeFor, settledHeadline, whyRunSurfaces, withSettledTick } from "../run-testimony.js";
import { nextSortIndex } from "../task-order.js";
import { applyRunEvent, applyTask, applyThreadEvent, threadMark, withBackgroundProcesses, withWorkflows } from "../task-workspace.js";
import { DRAFT_DOCK, taskWorkspaceId, worktreeById, worktreeFor, type PendingRun, type WorkspaceState } from "../workspace-state.js";
import type { CreatedWorktree } from "../../contracts/ipc.js";
import { createTaskMessage, type Task } from "../../domain/task.js";
import type { WorkspaceRecord } from "../../domain/workspace.js";

type RunInput = Extract<WorkspaceInput, {
  type: "run.resolved" | "run.unresolved" | "run.cancel" | "run.stop-process" | "run.decide"
    | "run.event" | "thread.event";
}>;

export function reduceRuns(state: WorkspaceState, input: RunInput): WorkspaceTransition {
  switch (input.type) {
    case "run.resolved": {
      const pending = state.pendingRuns[input.pendingId];
      if (!pending) return settled(state);
      let next = withoutPending(state, input.pendingId);
      const project = pending.projectId ? next.projects.find((item) => item.id === pending.projectId) : undefined;
      /**
       * A project with no workspace of its own adopts the one the picker just opened for the same
       * folder. Where a project lives is the picker's to say, so no run ever moves one.
       */
      const adopts = project && !project.workspaceId && input.workspace.kind === "project" && input.workspace.root === project.root;
      if (adopts) {
        next = { ...next, projects: next.projects.map((item) => item.id === project.id ? { ...item, workspaceId: input.workspace.id } : item) };
      }
      return pending.origin === "automation"
        ? startAutomationRun(next, pending, input.workspace, input.worktree)
        : startComposerRun(next, pending, input.workspace, input.worktree);
    }

    case "run.unresolved": {
      const pending = state.pendingRuns[input.pendingId];
      if (!pending) return settled(state);
      const next = withoutPending(state, input.pendingId);
      if (pending.origin === "automation") return settled(next, ack(pending, false));
      /** A side chat lives in the dock, so its failure belongs there and not in the main thread's banner. */
      if (pending.taskId && next.sideChats.some((chat) => chat.id === pending.taskId)) {
        return settled(withSideChat(next, pending.taskId, (chat) => ({ ...chat, error: input.message })));
      }
      return settled({ ...next, actionError: input.message });
    }

    case "run.cancel": {
      const taskId = targetId(state, input.taskId);
      const active = taskId ? state.activeRuns[taskId] : undefined;
      if (!active) return settled(state);
      return settled(state, [{ type: "send-run-command", command: { type: "cancel", taskId: active.taskId, runId: active.runId } }]);
    }

    /** The kill is the agent process's to make; the row only says a stop is on its way. */
    case "run.stop-process": {
      const taskId = targetId(state, input.taskId);
      if (!taskId) return settled(state);
      const stop: WorkspaceEffect[] = [{ type: "send-run-command", command: { type: "stop-process", taskId, processId: input.processId } }];
      const processes = state.backgroundProcesses[taskId] ?? [];
      const target = processes.find((process) => process.id === input.processId);
      if (target) {
        const marked = processes.map((process) => process.id === target.id ? { ...process, stopping: true } : process);
        return target.stopping ? settled(state) : settled(withBackgroundProcesses(state, taskId, marked), stop);
      }
      /** A workflow is a task of the agent process like any other, so the same stop reaches it. */
      const workflows = state.workflows[taskId] ?? [];
      const workflow = workflows.find((candidate) => candidate.id === input.processId);
      if (!workflow || workflow.stopping || workflow.status !== "running") return settled(state);
      return settled(
        withWorkflows(state, taskId, workflows.map((candidate) => candidate.id === workflow.id ? { ...candidate, stopping: true } : candidate)),
        stop,
      );
    }

    case "run.decide": {
      const taskId = input.taskId ?? state.currentId;
      const active = taskId ? state.activeRuns[taskId] : undefined;
      const approval = active ? state.approvals[active.runId] : undefined;
      if (!active || !approval) return settled(state);
      const { [active.runId]: _decided, ...approvals } = state.approvals;
      /** Answering a run's question is joining it, exactly as steering into it is. */
      return settled(withAttendedRun({ ...state, approvals }, active.taskId), [{
        type: "send-run-command",
        command: { type: "approval", taskId: active.taskId, runId: active.runId, approvalId: approval.approvalId, allow: input.allow },
      }]);
    }

    case "run.event": {
      const { event } = input;
      /** A turn the agent started itself belongs to no run yet, so the thread takes one on for it. */
      const opening = event.type === "run.started" && event.agentInitiated && !state.activeRuns[event.taskId] && state.tasks.some((task) => task.id === event.taskId);
      const opened = opening ? beginRun(state, event.taskId, event.runId) : state;
      const active = opened.activeRuns[event.taskId];
      if (!active || event.runId !== active.runId || event.sequence <= active.sequence) return settled(state);
      const applied = applyRunEvent(opened, event);
      const outcome = outcomeFor(event);
      /** Read before the run is applied: a terminal status takes the run, and its provenance, away. */
      const surfacing = whyRunSurfaces(active, event);
      const unseen = surfacing === null;
      /**
       * Every settled run leaves its verdict, which is what ranks the thread. Only a thread the
       * user was not already on is marked unread by it; the one on screen they cannot have missed.
       * A tick that looked and found nothing leaves neither, and leaves the thread where it was.
       * A thread already filed away is past ranking, so a run ending under it leaves no verdict.
       */
      let next = outcome && !unseen
        ? applyTask(applied, event.taskId, (task) => task.archivedAt !== undefined ? task : ({
            ...task,
            outcome,
            ...(state.currentId === event.taskId ? {} : { outcomeUnread: true as const }),
          }))
        : applied;
      if (outcome) next = withSettledTick(next, event.taskId, active, surfacing);
      if (event.type === "computer-use.setup-required") next = { ...next, computerUseSetup: true };
      /**
       * What this event puts on the desktop. A run that settles says how it ended; a run that stops
       * to ask says what it is waiting for, and only when a person is the one it waits on.
       */
      const headline = event.type === "approval.requested" && active.origin === "composer"
        ? `Waiting for your permission to use ${event.intent.name}`
        : settledHeadline(surfacing, event.type === "run.status" ? event.message : undefined);
      const noticed = headline ? next.tasks.find((task) => task.id === event.taskId) : undefined;
      const said = noticed && headline ? announced(next.notifications, noticed, headline) : [];
      if (event.type === "queued.delivered") next = withDeliveredMessage(next, event.taskId, event.messageId);
      const finished = event.type === "run.status" && (event.status === "succeeded" || event.status === "failed");
      const workspaceId = taskWorkspaceId(state, state.tasks.find((task) => task.id === event.taskId));
      /** A review the thread has open is only as current as the run that was writing under it. */
      const settledDiff = finished && workspaceId && next.diffs[event.taskId]
        ? readDiffFrom(next, event.taskId, workspaceId, next.diffs[event.taskId].range)
        : settled(next);
      next = settledDiff.state;
      const environment: WorkspaceEffect[] = finished && workspaceId
        ? [{ type: "refresh-environment", workspaceId, taskId: event.taskId, runId: event.runId }, ...settledDiff.effects]
        : [];
      if (event.type !== "run.status" || event.status === "running" || event.status === "awaiting-approval") return settled(next, [...environment, ...said]);
      const drained = drainQueue(next, event.taskId, event.status);
      return settled(drained.state, [...environment, ...said, ...drained.effects]);
    }

    case "thread.event": {
      const { event } = input;
      if (!state.tasks.some((task) => task.id === event.taskId)) return settled(state);
      return settled(applyThreadEvent(state, event));
    }
  }
}

function startComposerRun(state: WorkspaceState, pending: PendingRun, workspace: WorkspaceRecord, worktree?: CreatedWorktree): WorkspaceTransition {
  const existing = pending.taskId ? state.tasks.find((item) => item.id === pending.taskId) : undefined;
  if (pending.taskId && (!existing || state.activeRuns[pending.taskId])) return settled(state);
  /** A checkout made on the way here has no record yet; it belongs to the project the run resolved in. */
  const created = worktree && pending.projectId ? { ...worktree, projectId: pending.projectId } : undefined;
  /** A thread that does not exist yet claims whichever checkout the send named, if it named one. */
  const arriving = created ?? worktreeFor(state, existing) ?? worktreeById(state, pending.worktreeId);
  /** This thread's own first run inside a checkout forks its session rather than resuming it there. */
  const entering = Boolean(arriving) && existing?.worktreeEnteredAt === undefined;
  const task: Task = existing ?? {
    id: crypto.randomUUID(),
    title: taskTitleFor(pending.text || pasteTitle(pending.pastes ?? []) || fileTitle(pending.files ?? []), pending.attachments.map((path) => ({ path, labels: [] }))),
    ...(pending.projectId ? { projectId: pending.projectId } : {}),
    executionPolicy: state.draftPolicy,
    engine: state.draftEngine,
    model: state.draftModel,
    effort: state.draftEffort,
    messages: [],
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: now() },
    sortIndex: nextSortIndex(state.tasks),
    createdAt: now(),
    updatedAt: now(),
  };
  const message = createTaskMessage("user", pending.text, undefined, pending.attachments, pending.annotations, pending.pastes, pending.files);
  /** Only a thread that was somewhere else is arriving; one already in this checkout has said so. */
  const arrival = arriving && existing?.worktreeId !== arriving.id
    ? [createTaskMessage("system", `Moved into a worktree at ${arriving.root}`, `Detached at ${arriving.baseCommit.slice(0, 7)}`)]
    : [];
  const located = arriving ? { ...task, worktreeId: arriving.id, worktreeEnteredAt: task.worktreeEnteredAt ?? now() } : task;
  /** A copied thread forks the session it inherited until a session of its own comes back to continue. */
  const inherited = located.inheritedContinuation;
  const updated = { ...located, messages: [...located.messages, ...arrival, message], updatedAt: now() };
  const tasks = existing ? state.tasks.map((item) => item.id === task.id ? updated : item) : [updated, ...state.tasks];
  /** Only a task the user's own send just created needs looking at; anything else leaves them where they are. */
  const focusing = !existing && pending.draftKey !== undefined;
  const spent = existing ? {} : { draftBranch: null, draftWorktree: false, draftWorktreeId: null };
  const owning = withUsedWorktree(focusing ? handOverDraftDock(state, task.id) : state, created, arriving?.id);
  const started = beginRun({ ...owning, tasks, ...spent, ...(focusing ? { currentId: task.id } : {}) }, task.id, pending.runId);
  const drained = pending.queuedIds
    ? withQueued(started, task.id, queuedFor(started, task.id).filter((message) => !pending.queuedIds!.includes(message.id)))
    : started;
  const titling: WorkspaceEffect[] = existing || (!pending.text && pending.attachments.length === 0) ? [] : [{ type: "suggest-title", taskId: task.id, engine: task.engine, text: pending.text, attachments: pending.attachments }];
  const command = {
    ...startRunCommand(state, updated, pending.runId, pending.prompt, workspace.id),
    ...((entering || inherited) && updated.continuation ? { forkContinuation: true as const } : {}),
    ...sideChannelFor(state, updated),
  };
  /**
   * A review carried over from the draft was read against the project, and against a dock that no
   * longer exists, so it is asked for again under the thread and the checkout the send settled on.
   */
  const handed = focusing && state.diffs[DRAFT_DOCK];
  const reviewing = handed ? readDiffFrom(drained, task.id, workspace.id, handed.range) : settled(drained);
  return settled(
    pending.draftKey ? clearedDraft(reviewing.state, pending.draftKey) : reviewing.state,
    [{ type: "start-run", command }, ...titling, ...reviewing.effects],
  );
}

function startAutomationRun(state: WorkspaceState, pending: PendingRun, workspace: WorkspaceRecord, worktree?: CreatedWorktree): WorkspaceTransition {
  const taskId = pending.taskId!;
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task || task.archivedAt !== undefined || state.activeRuns[taskId]) return settled(state, ack(pending, false));
  /** A quiet tick's own label counts for nothing in the thread's activity, like the rest of its run. */
  const message = { ...createTaskMessage("user", pending.text, pending.detail), ...(pending.quiet ? { withdrawn: true as const } : {}) };
  const created = worktree && task.projectId ? { ...worktree, projectId: task.projectId } : undefined;
  const entered = created ?? worktreeFor(state, task);
  const withMessage = applyTask(withUsedWorktree(state, created, entered?.id), taskId, (item) => ({
    ...item,
    ...(entered ? { worktreeId: entered.id, worktreeEnteredAt: item.worktreeEnteredAt ?? now() } : {}),
    messages: [...item.messages, message],
    updatedAt: now(),
  }));
  /** Taken before the label lands, so a tick that settles unseen rolls that back with the rest of it. */
  return settled(beginRun(withMessage, taskId, pending.runId, { origin: "automation", quiet: pending.quiet === true }, threadMark(task)), [
    /** Only a tick that settles unseen answers its own questions; every other run waits for the user as it always has. */
    { type: "start-run", command: { ...startRunCommand(state, task, pending.runId, pending.prompt, workspace.id, pending.policy ?? task.executionPolicy), ...(pending.unattended ? { unattended: true as const } : {}) } },
    ...ack(pending, true),
  ]);
}
