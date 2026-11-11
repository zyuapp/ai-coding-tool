/** A send: the prompt the composer hands over, and the queue behind a run already going. */
import { ARCHIVED_SEND_ERROR, CHECKOUT_RUNNING_ERROR, MISSING_PROJECT_ERROR, WORKTREE_CREATING_ERROR, WORKTREE_RELEASING_ERROR } from "./errors.js";
import { attendedRun, drainingQueued, fileThread, forkableContinuation, pendingStep, queuedFor, resolveWorkspaceEffect, sentPrompt, sideChatPrompt, undeliveredIn } from "./run-queue.js";
import { queuedIn, questionAnswerIn, runsOf } from "./run-edits.js";
import { editableQueued, QUEUED_SENT } from "../state/runs.js";
import { targetId } from "./shared.js";
import { andThen, type Step } from "./slice.js";
import { nudgedIn, restoredIn, threadsOf, unsnoozedIn, type ThreadsEdit } from "./thread-edits.js";
import type { WorkspaceInput } from "./types.js";
import { annotationsFor, clearedDraftIn, composerOf, filesFor, focusComposerIn, handedBackIn, pastesFor } from "../composer-drafts.js";
import { docksOf, focusedTabIn } from "./dock-tabs.js";
import { tabHolderOf } from "../workspace-dock.js";
import { queueHolder } from "../computers.js";
import { threadHandleOptions } from "../thread-projection.js";
import { leavingThreadIds, namedPlace, worktreeFor } from "../thread-location.js";
import { promptKey, type PendingRun, type QueuedMessage, type WorkspaceState } from "../workspace-state.js";
import { engineBlocker, modelEngine, noModel, threadModel, unknownModel } from "../../domain/agent-engine.js";
import { enginesOf, refreshedEnginesIn } from "../engine-access.js";
import { catalogOf, engineOffersModel, engineReadinessOf } from "../state/engines.js";
import { expandThreadHandles } from "../../domain/thread-handles.js";
import { runsInWorkspace } from "../run-record.js";
import { coordinationSendOf, senderPrompt, type CoordinationSend } from "../coordination-messages.js";
import type { RemoteLead } from "../../domain/coordination.js";
import { originFields, type MessageOrigin } from "../../domain/message-origin.js";
import { heldByLimit } from "../limit-pauses.js";

export const SEND_INPUTS = ["task.send", "question.answer", "question.set-answer", "task.steer-queued", "task.drop-queued", "task.edit-queued"] as const;
type SendInput = Extract<WorkspaceInput, { type: (typeof SEND_INPUTS)[number] }>;

/**
 * What the reducer itself says of a send, never fields of the command: which decision it answers, and
 * whether it is a next step pressed on a coordinator's card, whose outcome that coordinator is waiting on.
 */
export type SendSaid = { answers?: string; step?: true };

/**
 * A send, which any slice may make: every change it makes is the runs', the threads', the composers'
 * or the engines' own edit. `coordination` and `said` are what the reducer itself adds to a send:
 * which suggestion a thread it starts is, when the user started one, and what else it says of the message.
 */
export function reduceSending(state: WorkspaceState, input: SendInput, coordination: Pick<CoordinationSend, "proposalId"> = {}, said: SendSaid = {}): Step {
  switch (input.type) {
    case "question.set-answer":
    case "question.answer": {
      const active = state.activeRuns[input.taskId];
      const question = active?.questions?.find((question) => question.requestId === input.requestId && question.questionId === input.questionId);
      if (!active || active.runId !== input.runId || !question) return input.type === "question.set-answer" ? {} : { refusal: "That question is no longer waiting for an answer." };
      if (question.submitting) return {};
      if (input.type === "question.set-answer") {
        if (question.answer === input.text) return {};
        return { edits: [questionAnswerIn(runsOf(state), input.taskId, question, { answer: input.text })] };
      }
      const text = (input.text ?? question.answer ?? "").trim();
      if (!text) return {};
      const answering = { edits: [questionAnswerIn(runsOf(state), input.taskId, question, { answer: text, submitting: true })] };
      return andThen(state, answering, (next) => ({
        ...attendedRun(next, input.taskId),
        effects: [{ type: "send-run-command", command: { type: "answer-question", taskId: input.taskId, runId: input.runId, requestId: input.requestId, questionId: input.questionId, text } }],
      }));
    }
    case "task.send":
      return sent(state, input, coordination, said);

    case "task.steer-queued": {
      const taskId = targetId(state, input.taskId);
      const active = taskId ? state.activeRuns[taskId] : undefined;
      const queued = taskId ? queuedFor(state, taskId) : [];
      const message = queued.find((item) => item.id === input.messageId);
      if (!taskId || !active || !message || message.steering) return {};
      const thread = state.threads.find((item) => item.id === taskId);
      const steering = { edits: [...thread ? [unsnoozed(threadsOf(state), thread)] : [], queuedIn(runsOf(state), taskId, queued.map((item) => item.id === message.id ? { ...item, steering: true } : item))] };
      return andThen(state, steering, (next) => ({
        ...attendedRun(next, taskId),
        effects: [{ type: "send-run-command", command: { type: "steer", taskId, runId: active.runId, messageId: message.id, prompt: sideChatPrompt(state, taskId, message.prompt) } }],
      }));
    }

    /**
     * A steered message, or one a starting run is taking, is already on its way to the agent, so only
     * one still waiting can be dropped. Asked `ifWaiting`, the caller hears when it was not, without an
     * error shown here.
     */
    case "task.drop-queued": {
      const taskId = targetId(state, input.taskId);
      const queued = taskId ? queuedFor(state, taskId) : [];
      const message = queued.find((item) => item.id === input.messageId);
      if (!taskId || !message || message.steering || drainingQueued(state, taskId, message.id)) return input.ifWaiting ? { result: { ok: false, message: QUEUED_SENT } } : {};
      return { edits: [queuedIn(runsOf(state), taskId, queued.filter((item) => item.id !== message.id)), undeliveredIn(threadsOf(state), taskId, [message])] };
    }

    /**
     * Editing takes the message out of the queue and back into the composer, so a run that finishes
     * mid-edit never sends the old words. Only the user's own messages are theirs to rewrite.
     */
    case "task.edit-queued": {
      /** A paired computer's thread has already been told to let the message go; only the draft is this computer's. */
      const remote = state.computers.paired.length ? queueHolder(state, input.taskId) : null;
      const taskId = remote ? remote.taskId : targetId(state, input.taskId);
      const queued = !taskId ? [] : remote ? (remote.computer.state ? queuedFor(remote.computer.state, taskId) : []) : queuedFor(state, taskId);
      const edit = editableQueued(queued, input.messageId);
      if (!taskId || "refusal" in edit) return {};
      const handed = handedBackIn(composerOf(state), taskId, [edit.message]);
      const holder = tabHolderOf(state, taskId);
      return {
        edits: [
          ...remote ? [] : [queuedIn(runsOf(state), taskId, queued.filter((item) => item.id !== edit.message.id))],
          ...holder ? [handed, focusedTabIn(docksOf(state), holder, taskId)] : [focusComposerIn(handed)],
        ],
      };
    }
  }
}

/** A message sent to a thread, or to start one: queued behind a run already going, or a run set on its way. */
function sent(state: WorkspaceState, input: Extract<SendInput, { type: "task.send" }>, coordination: Pick<CoordinationSend, "proposalId">, said: SendSaid): Step {
  const { answers } = said;
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
  if ((!text && attachments.length === 0 && annotations.length === 0 && pastes.length === 0 && files.length === 0) || alreadySending) return {};
  if (input.taskId !== undefined && !targetId(state, input.taskId)) return {};
  const asked = input.taskId === undefined && input.lead ? askedBefore(state, input.lead) : undefined;
  if (asked) return asked;
  /** A side chat has nothing to say until the thread it forks from has a session to fork. */
  if (input.taskId !== undefined && state.sideChats.some((chat) => chat.id === input.taskId) && !forkableContinuation(state, input.taskId)) return {};
  /** Only the composer's own send falls back to the current thread; a send with its own text starts a thread. */
  const thread = state.threads.find((item) => item.id === (input.taskId ?? (draftKey === undefined ? null : state.currentId)));
  /** A thread's message refused is answered to that thread alone; the user did nothing to be told of. */
  const fromThread = input.from !== undefined || input.sender !== undefined;
  const refuse = (message: string): Step => fromThread ? { result: { ok: false, message } } : { refusal: message };
  /**
   * An archived thread's work has ended, so another thread's message to it is refused, here or
   * from a paired computer. The user writing to one, wherever it is still on screen, brings it
   * back as restoring it would, then sends.
   */
  if (thread?.archivedAt !== undefined) {
    if (fromThread) return refuse(ARCHIVED_SEND_ERROR);
    const restored = andThen(state, { edits: [restoredIn(threadsOf(state), thread.id)] }, (next) => reduceSending(next, input, coordination, said));
    return { ...restored, effects: [...fileThread(state, thread, false), ...restored.effects ?? []] };
  }
  /** A thread halfway into a checkout of its own has nowhere settled to run, so the send waits for the user. */
  if (thread && state.creatingWorktrees.includes(thread.id)) return refuse(WORKTREE_CREATING_ERROR);
  /** A checkout on its way out is the same: the folder a run would start in is about to go. */
  if (thread && leavingThreadIds(state).has(thread.id)) return refuse(WORKTREE_RELEASING_ERROR);
  /** The run goes to the model the thread, the caller, or the draft names, which its engine must offer here. */
  const catalog = catalogOf(state);
  /** An older computer names a model without its engine, so the catalogue says which one it means. */
  const runEngine = thread?.engine ?? (input.model === undefined ? state.draftEngine : input.engine ?? modelEngine(catalog, input.model));
  /** The engine is a command on this machine, so a missing or too old one is said before a run starts. */
  const blocked = runEngine && engineBlocker(runEngine, engineReadinessOf(state, runEngine));
  if (blocked) {
    /** The user may have fixed it since the app last looked, so the refusal also asks again. */
    const asked = refreshedEnginesIn(enginesOf(state));
    return { error: { message: blocked, page: "engines" }, edits: [asked.engines], effects: asked.effects, refusal: blocked };
  }
  const runModel = thread ? threadModel(catalog, thread) : input.model ?? state.draftModel;
  if (runModel === undefined) return refuse(noModel(thread?.engine ?? state.draftEngine));
  if (!runEngine || !engineOffersModel(state, runEngine, runModel)) return refuse(unknownModel(runModel));
  const local = input.from === undefined || input.from === thread?.id ? undefined : state.threads.find((item) => item.id === input.from);
  /** A thread on another computer names itself, since this computer may not hold it. */
  const sender: { id: string; title: string; computer?: string } | undefined = local ? { id: local.id, title: local.title } : input.sender ? { id: input.sender.threadId, title: input.sender.title, computer: input.sender.computer } : undefined;
  const prompt = sentPrompt(text, pastes, annotations, attachments, files);
  const sentBy: MessageOrigin | undefined = sender ? { kind: "thread", threadId: sender.id, title: sender.title, ...(sender.computer ? { computer: sender.computer } : {}) } : undefined;
  const signed = sender ? `${senderPrompt(state.threads, sender, thread)}\n\n${prompt}` : prompt;
  /**
   * What the user wrote to a thread that is already there, which they are watching: never what any
   * thread sent, itself included, a decision's answer, or a step its coordinator offered.
   */
  const usersOwn = thread !== undefined && input.from === undefined && input.sender === undefined && answers === undefined && !said.step ? { usersOwn: true as const } : {};
  /** A thread waiting out its usage limit holds the message for when it lifts, and goes first then. */
  const held = Boolean(thread && !state.activeRuns[thread.id] && heldByLimit(state, thread.id, Date.now()));
  if (thread && (state.activeRuns[thread.id] || held)) {
    const queued: QueuedMessage = {
      id: crypto.randomUUID(),
      text,
      prompt: signed,
      ...originFields(sentBy),
      ...(answers ? { answers } : {}),
      ...usersOwn,
      attachments: attachments.map((attachment) => attachment.path),
      ...(annotations.length ? { annotations } : {}),
      ...(pastes.length ? { pastes } : {}),
      ...(files.length ? { files } : {}),
    };
    const sent = unsnoozed(threadsOf(state), thread);
    const waiting: Step = {
      edits: [
        ...draftKey === undefined ? [] : [clearedDraftIn(composerOf(state), draftKey)],
        held ? nudgedIn(sent, thread.id, Date.now()) : sent,
        queuedIn(runsOf(state), thread.id, [...queuedFor(state, thread.id), queued]),
      ],
    };
    return input.steer && !held ? andThen(state, waiting, (next) => reduceSending(next, { type: "task.steer-queued", taskId: thread.id, messageId: queued.id })) : waiting;
  }
  /** Which checkout a thread yet to exist starts in: one the caller named, else the one the draft is pointed at. */
  const named = namedPlace(state, { project: input.project, worktreeId: thread ? undefined : (input.worktreeId ?? (draftKey === undefined ? undefined : state.draftWorktreeId ?? undefined)) });
  if ("error" in named) return { refusal: named.error };
  const namedWorktree = named.worktree;
  const projectId = thread?.projectId ?? namedWorktree?.projectId ?? named.project?.id ?? (draftKey === undefined ? null : state.draftProjectId);
  const project = projectId ? state.projects.find((item) => item.id === projectId) : undefined;
  if (projectId && !project) return { refusal: MISSING_PROJECT_ERROR };
  /** The composer's own send takes the role the draft was given; a caller's `role` outranks it. */
  const role = thread ? undefined : input.role ?? (draftKey === undefined ? undefined : state.draftRole ?? undefined);
  const pending: PendingRun = {
    id: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    origin: "composer",
    ...(thread ? { taskId: thread.id } : {}),
    ...(project ? { projectId: project.id } : {}),
    ...(namedWorktree ? { worktreeId: namedWorktree.id } : {}),
    ...(thread || input.model === undefined ? {} : { model: input.model, engine: runEngine }),
    ...(thread || input.effort === undefined ? {} : { effort: input.effort }),
    ...(role ? { role } : {}),
    ...(thread || input.title === undefined ? {} : { title: input.title }),
    ...(thread ? {} : coordinationSendOf(state, { ...input, ...coordination })),
    ...(draftKey === undefined ? {} : { draftKey, draftText: state.prompts[draftKey] ?? "" }),
    text,
    prompt: signed,
    ...(sentBy ? { messageOrigin: sentBy } : {}),
    ...(answers ? { answers } : {}),
    ...usersOwn,
    attachments: attachments.map((attachment) => attachment.path),
    ...(annotations.length ? { annotations } : {}),
    ...(pastes.length ? { pastes } : {}),
    ...(files.length ? { files } : {}),
  };
  /** Only a thread being created here reads the draft answers; an existing one keeps its own. */
  /**
   * Only a thread yet to exist can be told where to start; one that exists already moved. Where the
   * draft is pointed is the composer's own, so a send with its own text never starts there.
   */
  const wantsWorktree = thread ? false : !namedWorktree && (input.worktree ?? (draftKey !== undefined && state.draftWorktree));
  const branch = thread || draftKey === undefined ? null : state.draftBranch;
  /** Starting from a branch without a checkout of its own moves the project, so nothing may be running in it. */
  if (branch && !wantsWorktree && project && runsInWorkspace(state, project.workspaceId)) {
    return { refusal: CHECKOUT_RUNNING_ERROR };
  }
  const resolving = resolveWorkspaceEffect(pending.id, thread, project, namedWorktree ?? worktreeFor(state, thread), wantsWorktree, branch);
  const pended = pendingStep(state, { ...pending, ...(resolving.createWorktree ? { creatingWorktree: true } : {}) });
  return { ...pended, edits: [...thread ? [unsnoozed(threadsOf(state), thread)] : [], ...pended.edits ?? []], effects: [resolving] };
}

/**
 * A suggestion a coordinator on another computer asked for is started here once, however often the
 * asking arrives, as an answer lost on the way back has that computer ask again: one that started is
 * named back, and one still starting says so.
 */
function askedBefore(state: WorkspaceState, lead: RemoteLead): Step | undefined {
  const { threadId, proposalId } = lead;
  if (proposalId === undefined) return undefined;
  const same = (held: RemoteLead | undefined) => held?.threadId === threadId && held.proposalId === proposalId;
  const started = state.threads.find((thread) => same(thread.remoteLead));
  if (started) return { result: { ok: true, taskId: started.id } };
  if (Object.values(state.pendingRuns).some((pending) => same(pending.coordination?.lead))) return { result: { ok: false, message: "That thread is still starting." } };
  return undefined;
}

/** A thread written to, which ends its snooze if it had one. */
function unsnoozed(edit: ThreadsEdit, thread: { id: string; snoozedUntil?: number }): ThreadsEdit {
  return thread.snoozedUntil === undefined ? edit : unsnoozedIn(edit, thread.id);
}
