/** A send: the prompt the composer hands over, and the queue behind a run already going. */
import { CHECKOUT_RUNNING_ERROR, MISSING_PROJECT_ERROR, WORKTREE_CREATING_ERROR, WORKTREE_ELSEWHERE_ERROR, WORKTREE_MISSING_ERROR, WORKTREE_RELEASING_ERROR, clearedDraft, forkableContinuation, queuedFor, resolveWorkspaceEffect, runsInWorkspace, sentPrompt, settled, targetId, withAttendedRun, withPending, withQueued } from "./shared.js";
import type { WorkspaceInput, WorkspaceTransition } from "./types.js";
import { annotationsFor, filesFor, pastesFor } from "../composer-drafts.js";
import { threadHandleOptions } from "../thread-projection.js";
import { leavingThreadIds, worktreeById, worktreeFor } from "../thread-location.js";
import { promptKey, type PendingRun, type QueuedMessage, type WorkspaceState } from "../workspace-state.js";
import { engineBlocker } from "../../domain/agent-engine.js";
import { engineReadinessOf, refreshEngines } from "../engine-access.js";
import { findProject } from "../../domain/project.js";
import { expandThreadHandles } from "../../domain/thread-handles.js";

type SendInput = Extract<WorkspaceInput, {
  type: "task.send" | "question.answer" | "question.reply-mode" | "task.steer-queued" | "task.drop-queued";
}>;

export function reduceSending(state: WorkspaceState, input: SendInput): WorkspaceTransition {
  switch (input.type) {
    case "question.reply-mode": {
      const active = state.activeRuns[input.taskId];
      if (!active || active.runId !== input.runId) return settled(state);
      return settled({ ...state, activeRuns: { ...state.activeRuns, [input.taskId]: { ...active, replyingToQuestion: input.replying } }, composerFocus: state.composerFocus + 1 });
    }
    case "question.answer": {
      const active = state.activeRuns[input.taskId];
      const question = active?.questions?.find((question) => question.requestId === input.requestId && question.questionId === input.questionId);
      if (!active || active.runId !== input.runId || !question) return settled({ ...state, actionError: "That question is no longer waiting for an answer. Your draft has been kept." });
      if (question.submitting) return settled(state);
      const text = (input.text ?? state.prompts[input.taskId] ?? "").trim();
      const pastes = input.text === undefined ? pastesFor(state, input.taskId) : [];
      if (!text && !pastes.length) return settled(state);
      if (input.attachments?.length || filesFor(state, input.taskId).length || annotationsFor(state, input.taskId).length || state.images[input.taskId]?.length) {
        return settled({ ...state, actionError: "Reply with text, or send attachments as a separate message." });
      }
      const answer = sentPrompt(text, pastes, [], [], []);
      const drafted = input.text === undefined ? clearedDraft(state, input.taskId) : state;
      const next = { ...drafted, activeRuns: { ...drafted.activeRuns, [input.taskId]: { ...active, questions: active.questions?.map((pending) => pending === question ? { ...pending, submitting: true } : pending) } } };
      return settled(withAttendedRun(next, input.taskId), [{ type: "send-run-command", command: { type: "answer-question", taskId: input.taskId, runId: input.runId, requestId: input.requestId, questionId: input.questionId, text: answer } }]);
    }
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
      /** Only the composer's own send falls back to the current thread; a send with its own text starts a thread. */
      const thread = state.threads.find((item) => item.id === (input.taskId ?? (draftKey === undefined ? null : state.currentId)));
      /** A thread halfway into a checkout of its own has nowhere settled to run, so the send waits for the user. */
      if (thread && state.creatingWorktrees.includes(thread.id)) return settled({ ...state, actionError: WORKTREE_CREATING_ERROR });
      /** A checkout on its way out is the same: the folder a run would start in is about to go. */
      if (thread && leavingThreadIds(state).has(thread.id)) return settled({ ...state, actionError: WORKTREE_RELEASING_ERROR });
      /** The engine is a command on this machine, so a missing or too old one is said before a run starts. */
      const engine = thread?.engine ?? state.draftEngine;
      const blocked = engineBlocker(engine, engineReadinessOf(state, engine));
      if (blocked) {
        /** The user may have fixed it since the app last looked, so the refusal also asks again. */
        const asked = refreshEngines({ ...state, actionError: blocked, actionErrorPage: "engines" });
        return settled(asked.state, asked.effects);
      }
      if (thread && state.activeRuns[thread.id]) {
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
        const next = withQueued(drafted, thread.id, [...queuedFor(state, thread.id), queued]);
        return input.steer ? reduceSending(next, { type: "task.steer-queued", taskId: thread.id, messageId: queued.id }) : settled(next);
      }
      /**
       * Which checkout a thread yet to exist starts in: one the caller named, else the one the draft
       * is pointed at. The checkout says which project the thread belongs to, so a `project` that
       * disagrees is a contradiction rather than something to silently pick a winner for.
       */
      const namedWorktreeId = thread ? undefined : (input.worktreeId ?? (draftKey === undefined ? undefined : state.draftWorktreeId ?? undefined));
      const namedWorktree = namedWorktreeId ? worktreeById(state, namedWorktreeId) : undefined;
      if (namedWorktreeId && !namedWorktree) return settled({ ...state, actionError: WORKTREE_MISSING_ERROR });
      const named = input.project === undefined ? undefined : findProject(state.projects, input.project);
      if (named && "error" in named) return settled({ ...state, actionError: named.error });
      if (namedWorktree && named && named.project.id !== namedWorktree.projectId) {
        return settled({ ...state, actionError: WORKTREE_ELSEWHERE_ERROR });
      }
      const projectId = thread?.projectId ?? namedWorktree?.projectId ?? named?.project.id ?? (draftKey === undefined ? null : state.draftProjectId);
      const project = projectId ? state.projects.find((item) => item.id === projectId) : undefined;
      if (projectId && !project) return settled({ ...state, actionError: MISSING_PROJECT_ERROR });
      const pending: PendingRun = {
        id: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        origin: "composer",
        ...(thread ? { taskId: thread.id } : {}),
        ...(project ? { projectId: project.id } : {}),
        ...(namedWorktree ? { worktreeId: namedWorktree.id } : {}),
        ...(thread || input.model === undefined ? {} : { model: input.model }),
        ...(thread || input.effort === undefined ? {} : { effort: input.effort }),
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
      const wantsWorktree = thread ? false : !namedWorktree && (input.worktree ?? state.draftWorktree);
      const branch = thread ? null : state.draftBranch;
      /** Starting from a branch without a checkout of its own moves the project, so nothing may be running in it. */
      if (branch && !wantsWorktree && project && runsInWorkspace(state, project.workspaceId)) {
        return settled({ ...state, actionError: CHECKOUT_RUNNING_ERROR });
      }
      const resolving = resolveWorkspaceEffect(pending.id, thread, project, namedWorktree ?? worktreeFor(state, thread), wantsWorktree, branch);
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
