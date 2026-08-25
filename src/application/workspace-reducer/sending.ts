/** A send: the prompt the composer hands over, and the queue behind a run already going. */
import { apply } from "./dispatch.js";
import { CHECKOUT_RUNNING_ERROR, MISSING_PROJECT_ERROR, WORKTREE_CREATING_ERROR, WORKTREE_ELSEWHERE_ERROR, WORKTREE_MISSING_ERROR, clearedDraft, forkableContinuation, queuedFor, resolveWorkspaceEffect, runsInWorkspace, sentPrompt, settled, targetId, withAttendedRun, withPending, withQueued } from "./shared.js";
import type { WorkspaceInput, WorkspaceTransition } from "./types.js";
import { annotationsFor, filesFor, pastesFor } from "../composer-drafts.js";
import { threadHandleOptions } from "../thread-projection.js";
import { promptKey, worktreeById, worktreeFor, type PendingRun, type QueuedMessage, type WorkspaceState } from "../workspace-state.js";
import { findProject } from "../../domain/task.js";
import { expandThreadHandles } from "../../domain/thread-handles.js";

type SendInput = Extract<WorkspaceInput, {
  type: "task.send" | "task.steer-queued" | "task.drop-queued";
}>;

export function reduceSending(state: WorkspaceState, input: SendInput): WorkspaceTransition {
  switch (input.type) {
    case "task.send": {
      const attachments = input.attachments ?? [];
      /** A send that carries its own text is not the composer's: it neither reads nor clears a draft. */
      const draftKey = input.text === undefined ? input.taskId ?? promptKey(state) : undefined;
      const drafted = (input.text ?? (draftKey === undefined ? undefined : state.prompts[draftKey]) ?? "").trim();
      /** `@handles` are a composer affordance, so only a draft's own text is read for them. */
      const text = draftKey === undefined || !drafted.includes("@") ? drafted : expandThreadHandles(drafted, threadHandleOptions(state, draftKey));
      /** The anchors mark drafts in the transcript; the sent message keeps only quote and note. */
      const annotations = (draftKey === undefined ? [] : annotationsFor(state, draftKey)).map(({ anchor: _anchored, ...annotation }) => annotation);
      const pastes = draftKey === undefined ? [] : pastesFor(state, draftKey);
      const files = draftKey === undefined ? [] : filesFor(state, draftKey);
      const alreadySending = draftKey !== undefined && Object.values(state.pendingRuns).some((pending) => pending.draftKey === draftKey);
      if ((!text && attachments.length === 0 && annotations.length === 0 && pastes.length === 0 && files.length === 0) || alreadySending) return settled(state);
      if (input.taskId !== undefined && !targetId(state, input.taskId)) return settled(state);
      /** A side chat has nothing to say until the thread it forks from has a session to fork. */
      if (input.taskId !== undefined && state.sideChats.some((chat) => chat.id === input.taskId) && !forkableContinuation(state, input.taskId)) return settled(state);
      /** Only the composer's own send falls back to the current task; a send with its own text starts a thread. */
      const task = state.tasks.find((item) => item.id === (input.taskId ?? (draftKey === undefined ? null : state.currentId)));
      /** A thread halfway into a checkout of its own has nowhere settled to run, so the send waits for the user. */
      if (task && state.creatingWorktrees.includes(task.id)) return settled({ ...state, actionError: WORKTREE_CREATING_ERROR });
      if (task && state.activeRuns[task.id]) {
        const queued: QueuedMessage = {
          id: crypto.randomUUID(),
          text,
          prompt: sentPrompt(text, pastes, annotations, attachments, files),
          attachments: attachments.map((attachment) => attachment.path),
          ...(annotations.length ? { annotations } : {}),
          ...(pastes.length ? { pastes } : {}),
          ...(files.length ? { files } : {}),
        };
        const drafted = draftKey === undefined ? state : clearedDraft(state, draftKey);
        const next = withQueued(drafted, task.id, [...queuedFor(state, task.id), queued]);
        return input.steer ? apply(next, { type: "task.steer-queued", taskId: task.id, messageId: queued.id }) : settled(next);
      }
      /**
       * Which checkout a thread yet to exist starts in: one the caller named, else the one the draft
       * is pointed at. The checkout says which project the thread belongs to, so a `project` that
       * disagrees is a contradiction rather than something to silently pick a winner for.
       */
      const namedWorktreeId = task ? undefined : (input.worktreeId ?? (draftKey === undefined ? undefined : state.draftWorktreeId ?? undefined));
      const namedWorktree = namedWorktreeId ? worktreeById(state, namedWorktreeId) : undefined;
      if (namedWorktreeId && !namedWorktree) return settled({ ...state, actionError: WORKTREE_MISSING_ERROR });
      const named = input.project === undefined ? undefined : findProject(state.projects, input.project);
      if (named && "error" in named) return settled({ ...state, actionError: named.error });
      if (namedWorktree && named && named.project.id !== namedWorktree.projectId) {
        return settled({ ...state, actionError: WORKTREE_ELSEWHERE_ERROR });
      }
      const projectId = task?.projectId ?? namedWorktree?.projectId ?? named?.project.id ?? (draftKey === undefined ? null : state.draftProjectId);
      const project = projectId ? state.projects.find((item) => item.id === projectId) : undefined;
      if (projectId && !project) return settled({ ...state, actionError: MISSING_PROJECT_ERROR });
      const pending: PendingRun = {
        id: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        origin: "composer",
        ...(task ? { taskId: task.id } : {}),
        ...(project ? { projectId: project.id } : {}),
        ...(namedWorktree ? { worktreeId: namedWorktree.id } : {}),
        ...(draftKey === undefined ? {} : { draftKey }),
        text,
        prompt: sentPrompt(text, pastes, annotations, attachments, files),
        attachments: attachments.map((attachment) => attachment.path),
        ...(annotations.length ? { annotations } : {}),
        ...(pastes.length ? { pastes } : {}),
        ...(files.length ? { files } : {}),
      };
      /** Only a thread being created here reads the draft answers; an existing one keeps its own. */
      /** Only a thread yet to exist can be told where to start; one that exists already moved. */
      const wantsWorktree = task ? false : !namedWorktree && (input.worktree ?? state.draftWorktree);
      const branch = task ? null : state.draftBranch;
      /** Starting from a branch without a checkout of its own moves the project, so nothing may be running in it. */
      if (branch && !wantsWorktree && project && runsInWorkspace(state, project.workspaceId)) {
        return settled({ ...state, actionError: CHECKOUT_RUNNING_ERROR });
      }
      const resolving = resolveWorkspaceEffect(pending.id, task, project, namedWorktree ?? worktreeFor(state, task), wantsWorktree, branch);
      return settled(withPending(state, { ...pending, ...(resolving.createWorktree ? { creatingWorktree: true } : {}) }), [resolving]);
    }

    case "task.steer-queued": {
      const taskId = targetId(state, input.taskId);
      const active = taskId ? state.activeRuns[taskId] : undefined;
      const queued = taskId ? queuedFor(state, taskId) : [];
      const message = queued.find((item) => item.id === input.messageId);
      if (!taskId || !active || !message || message.steering) return settled(state);
      return settled(
        withAttendedRun(withQueued(state, taskId, queued.map((item) => item.id === message.id ? { ...item, steering: true } : item)), taskId),
        [{ type: "send-run-command", command: { type: "steer", taskId, runId: active.runId, messageId: message.id, prompt: message.prompt } }],
      );
    }

    /** A steered message is already on its way to the agent, so only an unsteered one can be dropped. */
    case "task.drop-queued": {
      const taskId = targetId(state, input.taskId);
      const queued = taskId ? queuedFor(state, taskId) : [];
      const message = queued.find((item) => item.id === input.messageId);
      if (!taskId || !message || message.steering) return settled(state);
      return settled(withQueued(state, taskId, queued.filter((item) => item.id !== message.id)));
    }
  }
}
