import { isSnoozeHours, type SnoozeHours } from "../domain/thread-snooze.js";
import { isThreadRole, type ThreadRole } from "../domain/thread-role.js";
import { isNextStep, isThreadBrief, MAX_ANSWER, MAX_MEMORY_PROMPT, MAX_PROPOSAL_PROJECT, MAX_PROPOSAL_TITLE, MAX_PROPOSALS, type NextStep, type RemoteLead, type ThreadBrief } from "../domain/coordination.js";
import { isAgentEffort, isAgentEngine, isModelId, type AgentEngine, type AgentModel } from "../domain/agent-engine.js";
import { EXECUTION_POLICIES, isExecutionPolicy, type AgentEffort, type ExecutionPolicy } from "../domain/run.js";
import { MAX_ATTACHMENT_ENCODED_BYTES, type OutgoingAttachment, type RunAttachment } from "../domain/conversation.js";
import type { ImageAnnotation } from "../domain/image-annotation.js";
import { isScreenshotContext } from "../domain/screenshot-context.js";
import type { ThreadDropTarget } from "../domain/project.js";
import type { WorktreeDestination } from "../domain/worktree.js";
import type { RemoteSender } from "../domain/message-origin.js";
import { agentId, agentThread, array, boolean, deviceId, literals, namesThread, nullable, nullableText, number, object, optional, optionalBoolean, optionalText, record, text, type Declarations, type Validator } from "./command-declaration.js";
import { isString, MAX_PROMPT_LENGTH } from "./ipc.js";
import * as phone from "./phone-commands.js";
import { sendStaysInReach } from "./task-send.js";

export type TaskDropTarget = ThreadDropTarget;

/** Commands that carry no `taskId` act on the task the user is looking at, read from `currentId`. */
export type TaskCommand =
  /** `worktreeId` starts the thread in a checkout the project already has, rather than in the project. */
  | { type: "task.new"; projectId?: string; worktreeId?: string }
  | { type: "task.select"; taskId: string }
  | { type: "task.archive"; taskId: string }
  | { type: "task.restore"; taskId: string }
  | { type: "task.clear-archive" }
  | { type: "task.rename"; taskId: string; title: string }
  /** `null` takes the role off. With no thread yet, the role waits for the first message. */
  /** `sender` is a thread on another computer that asked, which only this app's own link says. */
  | { type: "task.set-role"; taskId?: string; role: ThreadRole | null; sender?: RemoteSender }
  /** Moves a thread under a coordinator, or out from under one with `null`. */
  | { type: "task.set-coordinator"; taskId: string; coordinatorId: string | null }
  /**
   * Said by the computer holding a thread's coordinator: it is archived or no longer a coordinator, so
   * the thread stands on its own, or it is back, and the thread works under it again.
   */
  | { type: "task.set-lead-away"; taskId: string; away: boolean }
  /** Files a thread under a coordinator away as resolved once nothing is left for it, or opens it again. */
  | { type: "task.resolve"; taskId: string }
  | { type: "task.reopen"; taskId: string }
  /** Answers a choice a thread put to the user. The answer reaches that thread as a message. */
  | { type: "decision.answer"; taskId: string; decisionId: string; answer: string }
  /**
   * What a coordinator's new threads run on unless it names another. An effort the model lacks moves to
   * the nearest it takes. An older computer names no engine, so the model's is read from the catalogue.
   */
  | { type: "coordination.set-thread-model"; taskId: string; engine?: AgentEngine; model: AgentModel; effort?: AgentEffort }
  /** Keeps every desktop notice from a coordinator and its threads back, or lets them through again. */
  | { type: "coordination.set-muted"; taskId: string; muted: boolean }
  /** Stops a coordinator and every thread under it, none of which wakes it to carry on. */
  | { type: "coordination.stop-all"; taskId: string }
  /** A coordinator's purpose and the notes it keeps, which it and every thread it starts read. An empty purpose clears it. */
  | { type: "memory.set-purpose"; taskId: string; purpose: string | null }
  | { type: "memory.add"; taskId: string; text: string }
  | { type: "memory.edit"; taskId: string; noteId: string; text: string }
  | { type: "memory.forget"; taskId: string; noteId: string }
  /** Tells a thread under a coordinator, in the user's own words, to take a next step its card offers. */
  | { type: "coordination.next-step"; taskId: string; step: NextStep }
  /**
   * Starts a thread a coordinator suggested, as it would have started it, or those of `proposalIds`
   * suggested here, which is what Start all names, or with neither every one it suggested here. One
   * asked for on a paired computer starts there in the `place` the user picked: a project there, and
   * whether it gets a worktree of its own.
   */
  | { type: "proposal.start"; taskId: string; proposalId?: string; proposalIds?: string[]; place?: { project: string; worktree: boolean } }
  /**
   * Turns a suggested thread down, or those of `proposalIds` suggested here, or with neither every one
   * suggested here. The coordinator hears so once, without being woken.
   */
  | { type: "proposal.dismiss"; taskId: string; proposalId?: string; proposalIds?: string[] }
  /** Takes the dot off a thread, which is the only thing that does. Opening the thread only dims it. */
  | { type: "task.dismiss"; taskId?: string }
  | { type: "task.snooze"; taskId: string; hours: SnoozeHours }
  /** Brings a snoozed thread back before its time. */
  | { type: "task.unsnooze"; taskId: string }
  /** Dismisses Priority in the sidebar's computer filter. Forwarded requests stop at the receiving computer. */
  /** `projectId` narrows it to one project's threads, as a narrowed Priority shows them. */
  | { type: "task.dismiss-all"; localOnly?: boolean; projectId?: string }
  /** Marks every thread read in the sidebar's computer filter. Forwarded requests stop at the receiving computer. */
  | { type: "task.read-all"; localOnly?: boolean }
  | { type: "task.move"; taskId: string; target: TaskDropTarget }
  /**
   * Copies a thread into a new one beside it, carrying its conversation and its session. The copy
   * runs nothing of its own until the user sends something; `worktree` gives it a checkout of its own.
   * Without a `title` the copy is named after the thread it came from.
   */
  | { type: "task.fork"; taskId?: string; worktree?: boolean; title?: string }
  /** Without a `taskId` the setting also becomes the draft the next new task starts from. */
  | { type: "task.set-policy"; taskId?: string; policy: ExecutionPolicy }
  /** A thread keeps its engine; the pair only moves the draft, and a model or effort the engine lacks changes nothing. No model means the engine's default. */
  | { type: "task.set-model"; taskId?: string; engine: AgentEngine; model?: AgentModel }
  | { type: "task.set-fast-mode"; taskId?: string; fastMode: boolean }
  | { type: "task.set-effort"; taskId?: string; engine: AgentEngine; effort: AgentEffort }
  /**
   * Asks the thread to run in its own checkout, or to come back to the project. The worktree is
   * only made on the next send; switching back commits whatever the worktree still holds.
   */
  | { type: "task.set-worktree"; taskId?: string; worktree: boolean }
  /**
   * Moves the thread while leaving existing files and checkouts in place. `afterRun` is a thread
   * moving itself: the run that asked waits to end before the move instead of refusing it. `sender`
   * is a thread on another computer that asked for the move, which only this app's own link says.
   * `then` is what a thread moving itself goes on with, as its next turn in the new checkout.
   */
  | { type: "task.move-worktree"; taskId?: string; destination: WorktreeDestination; afterRun?: true; sender?: RemoteSender; then?: string }
  /** The branch a thread starts from. Only a thread that does not exist yet can be told. */
  | { type: "task.set-branch"; branch: string | null; create?: boolean }
  /**
   * Moves the checkout the thread works in — its worktree, or the project's — onto `branch`,
   * making it at the checkout's own HEAD first when `create`. Never forced, so uncommitted work
   * that the switch would overwrite stops it.
   */
  | { type: "task.checkout-branch"; taskId?: string; branch: string; create?: boolean }
  /**
   * While a run is going the message is queued instead; `steer` pushes it into that run straight away.
   * `text` sends that message instead of the composer draft and leaves the draft alone: only the
   * composer's own send falls back to the current task, so a send carrying `text` and no `taskId`
   * always starts a new task, in `project` — its folder name, its path, or its id. `worktree` starts
   * that new task in a checkout of its own; `worktreeId` starts it in one the project already has,
   * and names the project itself, so a `project` that disagrees with it is refused. Naming one takes
   * precedence over asking for a new one. `model`, the `engine` it runs on, `effort` and `role` apply only to a new task and leave
   * the shared draft settings alone, as do `coordinatorId`, which starts it under that coordinator, and
   * the `brief` it is handed, and `title`, which names it in place of a title written from its first
   * message. `from` names the thread that sent the message, which both the agent and the user are
   * shown. `lead` starts it under a coordinator on another computer, which hands it the `memory` it
   * keeps as the thread reads it; a lead naming a suggestion of its already started here names that
   * thread back instead.
   */
  | { type: "task.send"; taskId?: string; project?: string; text?: string; attachments?: RunAttachment[]; steer?: boolean; worktree?: boolean; worktreeId?: string; model?: AgentModel; engine?: AgentEngine; effort?: AgentEffort; role?: ThreadRole; coordinatorId?: string; brief?: ThreadBrief; title?: string; from?: string; sender?: RemoteSender; lead?: RemoteLead; memory?: string }
  /**
   * Sends the composer's message with the images in its strip, which are written out to disk first:
   * the run is started only once they are all there, and a failure to write one stops the send.
   */
  /** `text` is the words a phone sends with its images; the desktop sends its composer's own. */
  | { type: "attachments.send"; taskId?: string; steer?: boolean; attachments: OutgoingAttachment[]; text?: string }
  /** What the composer's image strip has to say for itself, such as an image it could not read. */
  | { type: "attachments.notice"; taskId?: string; message: string | null }
  /** Moves to the thread `delta` away in the sidebar, which is where the keyboard walks the list. */
  | { type: "task.steer-queued"; taskId?: string; messageId: string }
  /** `ifWaiting` asks to hear when the message was no longer waiting rather than have nothing happen. */
  | { type: "task.drop-queued"; taskId?: string; messageId: string; ifWaiting?: true }
  /** Takes one of the user's own queued messages back into the composer to be rewritten and sent again. */
  | { type: "task.edit-queued"; taskId?: string; messageId: string };

/**
 * A side chat forks the current thread and is discarded when it closes. Its thread is an ordinary
 * task, so everything else it does — sending, queueing, steering, cancelling, changing its model —
 * travels on the task commands above with the chat id as the `taskId`.
 */
export type SideChatCommand =
  | { type: "side-chat.open"; chatId: string }
  | { type: "side-chat.close"; chatId: string };

const policy = literals(...EXECUTION_POLICIES);
const dropTarget = object({ projectId: nullableText, index: number });
const runAttachment = object<RunAttachment>({ path: text, labels: array(text), context: optional(isScreenshotContext) });
const remoteSender = object<RemoteSender>({ threadId: deviceId, title: text, computer: deviceId });
const remoteLead = object<RemoteLead>({ threadId: deviceId, title: text, computer: deviceId, proposalId: optional(deviceId) });
const memoryText: Validator<string> = (value): value is string => typeof value === "string" && value.length <= MAX_MEMORY_PROMPT;
/** The name a thread starts with holds words, and runs no longer than a suggestion's, which becomes one. */
const promptText: Validator<string> = (value): value is string => isString(value, MAX_PROMPT_LENGTH) && value.trim().length > 0;
export const startTitle: Validator<string> = (value): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= MAX_PROPOSAL_TITLE;
const proposalPlace = object<{ project: string; worktree: boolean }>({ project: text, worktree: boolean });
/** The suggestions Start all or Dismiss all names, each as a single one is named, and never more than wait at once. */
const proposalIds: Validator<string[]> = (value): value is string[] => array(text)(value) && value.length > 0 && value.length <= MAX_PROPOSALS;
const imageAnnotation = object<ImageAnnotation>({ kind: literals("box", "arrow"), x: number, y: number, width: number, height: number, text });
/** Image data URLs need the encoded byte budget plus room for their MIME prefix. */
const attachmentSource: Validator<string> = (value): value is string => typeof value === "string" && value.length <= MAX_ATTACHMENT_ENCODED_BYTES + 256;
const outgoingAttachment = object<OutgoingAttachment>({ id: text, source: attachmentSource, annotations: array(imageAnnotation), path: optionalText, context: optional(isScreenshotContext) });

function isWorktreeDestination(value: unknown): value is WorktreeDestination {
  if (!record(value)) return false;
  if (value.kind === "local" || value.kind === "new") return true;
  return value.kind === "worktree" && text(value.id);
}

/** Only the window says which thread on another computer asked. */
function givesRole(command: Extract<TaskCommand, { type: "task.set-role" }>): boolean {
  return namesThread(command) && command.sender === undefined;
}

/** Where a thread starts is held to what a suggestion's place is, since a thread started from one starts the same way. */
function agentSend(command: Extract<TaskCommand, { type: "task.send" }>): boolean {
  return agentId(command.taskId)
    /** A project is named by its folder name, its path, or its id. */
    && (command.project === undefined || isString(command.project, MAX_PROPOSAL_PROJECT))
    /** An agent's send carries only its text, so a blank one would be answered as sent with nothing sent. */
    && isString(command.text, MAX_PROMPT_LENGTH) && command.text.trim().length > 0
    /** An id, never a path: the reducer resolves it against the checkouts the app itself made. */
    && agentId(command.worktreeId)
    && sendStaysInReach(command, "agent");
}

/**
 * Into a new checkout, one that already exists, or back to the project's own. Without a thread named
 * it is the thread that asked, and only the window says whether a move waits for that thread's run to end
 * or which thread on another computer asked for it.
 */
function movesToCheckout(command: Extract<TaskCommand, { type: "task.move-worktree" }>): boolean {
  return agentId(command.taskId) && command.afterRun === undefined && command.sender === undefined && (command.destination.kind !== "worktree" || isString(command.destination.id));
}

function isDestination(value: unknown): value is WorktreeDestination {
  if (!phone.isRecord(value)) return false;
  if (value.kind === "local" || value.kind === "new") return true;
  return value.kind === "worktree" && phone.isString(value.id);
}

/**
 * A phone sends a message and nothing else: never files, never the shape of a thread being started,
 * which the draft's settings set, and never who the message is from or who the thread works under.
 */
const sends: phone.PhoneRule = (command) => phone.named(command)
  && (command.project === undefined || phone.isString(command.project, phone.MAX_PATH_LENGTH))
  && (command.text === undefined || phone.isString(command.text, phone.MAX_PROMPT_LENGTH))
  && (command.steer === undefined || typeof command.steer === "boolean")
  && (command.worktree === undefined || typeof command.worktree === "boolean")
  && (command.worktreeId === undefined || phone.isString(command.worktreeId))
  && sendStaysInReach(command, "phone");

const starts: phone.PhoneRule = (command) => (command.projectId === undefined || phone.isString(command.projectId))
  && (command.worktreeId === undefined || phone.isString(command.worktreeId));

const dismissesAll: phone.PhoneRule = (command) => (command.localOnly === undefined || typeof command.localOnly === "boolean")
  && (command.projectId === undefined || phone.isString(command.projectId));

/** The longest title a phone may give a thread, which its rename field holds it to. */
const MAX_TITLE_LENGTH = 1_000;

const renames: phone.PhoneRule = (command) => phone.isString(command.taskId) && phone.isBlankable(command.title, MAX_TITLE_LENGTH);

const forks: phone.PhoneRule = (command) => phone.named(command) && (command.worktree === undefined || typeof command.worktree === "boolean");

const setsPolicy: phone.PhoneRule = (command) => phone.named(command) && isExecutionPolicy(command.policy);

const setsModel: phone.PhoneRule = (command) => phone.named(command) && isAgentEngine(command.engine) && (command.model === undefined || isModelId(command.model));

const setsFastMode: phone.PhoneRule = (command) => phone.named(command) && typeof command.fastMode === "boolean";

const setsEffort: phone.PhoneRule = (command) => phone.named(command) && isAgentEngine(command.engine) && isAgentEffort(command.effort);

const setsWorktree: phone.PhoneRule = (command) => phone.named(command) && typeof command.worktree === "boolean";

/** Only an agent moving its own thread waits for its run to end or says what it goes on with, and only the link names a thread elsewhere that asked: the host says each, never the caller. */
const movesWorktree: phone.PhoneRule = (command) => phone.named(command) && isDestination(command.destination)
  && command.afterRun === undefined && command.sender === undefined && command.then === undefined;

const namesQueued: phone.PhoneRule = (command) => phone.named(command) && phone.isString(command.messageId);

/** An edit names its thread, since the phone's composer takes the words for the thread it shows. */
const editsQueued: phone.PhoneRule = (command) => phone.isString(command.taskId) && phone.isString(command.messageId);

/** An answer to a decision a thread raised, in the user's own words or an option's label. */
const answersDecision: phone.PhoneRule = (command) => phone.isString(command.taskId) && phone.isString(command.decisionId) && phone.isString(command.answer, MAX_ANSWER);

/** One suggestion started where its coordinator suggested it, never several at once or in a place the phone picked. */
const startsProposal: phone.PhoneRule = (command) => phone.isString(command.taskId) && phone.isString(command.proposalId)
  && command.proposalIds === undefined && command.place === undefined;

const snoozes: phone.PhoneRule = (command) => phone.isString(command.taskId) && isSnoozeHours(command.hours);

/** A thread or the draft made a coordinator or made plain again; only an agent says who asked. */
const setsRole: phone.PhoneRule = (command) => phone.named(command) && (command.role === null || isThreadRole(command.role)) && command.sender === undefined;

/** How large one image a phone sends may be, as a data URL: a photo the phone has already shrunk, never a raw camera file. */
export const MAX_PHONE_IMAGE_LENGTH = 8 * 1024 * 1024;
/** How many images one phone send carries, as the desktop's composer strip holds. */
export const MAX_PHONE_IMAGES = 6;

const PHONE_IMAGE = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;

/**
 * Images a phone sends into a thread or the draft, with the words that go with them: each a picture
 * the phone holds, so never a path on this computer, a screenshot's context, or marks drawn over it.
 */
const sendsImages: phone.PhoneRule = (command) => phone.named(command)
  && (command.steer === undefined || typeof command.steer === "boolean")
  && (command.text === undefined || phone.isString(command.text, phone.MAX_PROMPT_LENGTH))
  && Array.isArray(command.attachments) && command.attachments.length > 0 && command.attachments.length <= MAX_PHONE_IMAGES
  && command.attachments.every((attachment: unknown) => phone.isRecord(attachment) && phone.isString(attachment.id)
    && typeof attachment.source === "string" && attachment.source.length <= MAX_PHONE_IMAGE_LENGTH && PHONE_IMAGE.test(attachment.source)
    && Array.isArray(attachment.annotations) && attachment.annotations.length === 0
    && attachment.path === undefined && attachment.context === undefined);

export const taskCommands = {
  "task.new": { fields: { projectId: optionalText, worktreeId: optionalText }, at: "own", leaves: true, phone: starts },
  "task.select": { fields: { taskId: text }, at: "select", leaves: true, phone: phone.namesThread },
  "task.archive": { fields: { taskId: text }, at: "thread", agent: namesThread, phone: phone.namesThread },
  "task.restore": { fields: { taskId: text }, at: "thread", phone: phone.namesThread },
  "task.clear-archive": { fields: {}, at: "thread" },
  "task.rename": { fields: { taskId: text, title: text }, at: "thread", phone: renames },
  "task.set-role": { fields: { taskId: optionalText, role: nullable(isThreadRole), sender: optional(remoteSender) }, at: "thread", agent: givesRole, phone: setsRole },
  "task.set-coordinator": { fields: { taskId: text, coordinatorId: nullableText }, at: "thread" },
  "task.set-lead-away": { fields: { taskId: text, away: boolean }, at: "thread" },
  "task.resolve": { fields: { taskId: text }, at: "thread" },
  "task.reopen": { fields: { taskId: text }, at: "thread" },
  "decision.answer": { fields: { taskId: text, decisionId: text, answer: text }, at: "thread", phone: answersDecision },
  "coordination.set-thread-model": { fields: { taskId: text, engine: optional(isAgentEngine), model: isModelId, effort: optional(isAgentEffort) }, at: "thread" },
  "coordination.set-muted": { fields: { taskId: text, muted: boolean }, at: "thread" },
  "coordination.stop-all": { fields: { taskId: text }, at: "thread", phone: phone.namesThread },
  "memory.set-purpose": { fields: { taskId: text, purpose: nullableText }, at: "thread" },
  "memory.add": { fields: { taskId: text, text }, at: "thread" },
  "memory.edit": { fields: { taskId: text, noteId: text, text }, at: "thread" },
  "memory.forget": { fields: { taskId: text, noteId: text }, at: "thread" },
  "coordination.next-step": { fields: { taskId: text, step: isNextStep }, at: "thread" },
  "proposal.start": { fields: { taskId: text, proposalId: optionalText, proposalIds: optional(proposalIds), place: optional(proposalPlace) }, at: "thread", phone: startsProposal },
  "proposal.dismiss": { fields: { taskId: text, proposalId: optionalText, proposalIds: optional(proposalIds) }, at: "thread" },
  "task.dismiss": { fields: { taskId: optionalText }, at: "thread", agent: agentThread, phone: phone.namesThread },
  "task.snooze": { fields: { taskId: text, hours: isSnoozeHours }, at: "thread", phone: snoozes },
  "task.unsnooze": { fields: { taskId: text }, at: "thread", phone: phone.namesThread },
  /** The reducer itself carries this to the computers shown in the sidebar. */
  "task.dismiss-all": { fields: { localOnly: optionalBoolean, projectId: optionalText }, at: "local", phone: dismissesAll },
  "task.read-all": { fields: { localOnly: optionalBoolean }, at: "local" },
  "task.move": { fields: { taskId: text, target: dropTarget }, at: "thread" },
  "task.fork": { fields: { taskId: optionalText, worktree: optionalBoolean, title: optional(startTitle) }, at: "thread", phone: forks },
  "task.set-policy": { fields: { taskId: optionalText, policy: policy }, at: "thread", phone: setsPolicy },
  "task.set-model": { fields: { taskId: optionalText, engine: isAgentEngine, model: optional(isModelId) }, at: "thread", phone: setsModel },
  "task.set-fast-mode": { fields: { taskId: optionalText, fastMode: boolean }, at: "thread", phone: setsFastMode },
  "task.set-effort": { fields: { taskId: optionalText, engine: isAgentEngine, effort: isAgentEffort }, at: "thread", phone: setsEffort },
  "task.set-worktree": { fields: { taskId: optionalText, worktree: boolean }, at: "thread", phone: setsWorktree },
  "task.move-worktree": { fields: { taskId: optionalText, destination: isWorktreeDestination, afterRun: optional(literals(true)), sender: optional(remoteSender), then: optional(promptText) }, at: "thread", agent: movesToCheckout, phone: movesWorktree },
  "task.set-branch": { fields: { branch: nullableText, create: optionalBoolean }, at: "thread" },
  "task.checkout-branch": { fields: { taskId: optionalText, branch: text, create: optionalBoolean }, at: "thread" },
  "task.send": { fields: { taskId: optionalText, project: optionalText, text: optionalText, attachments: optional(array(runAttachment)), steer: optionalBoolean, worktree: optionalBoolean, worktreeId: optionalText, model: optional(isModelId), engine: optional(isAgentEngine), effort: optional(isAgentEffort), role: optional(isThreadRole), coordinatorId: optionalText, brief: optional(isThreadBrief), title: optional(startTitle), from: optionalText, sender: optional(remoteSender), lead: optional(remoteLead), memory: optional(memoryText) }, at: "own", agent: agentSend, phone: sends },
  "attachments.send": { fields: { taskId: optionalText, steer: optionalBoolean, attachments: array(outgoingAttachment), text: optionalText }, at: "own", phone: sendsImages },
  "attachments.notice": { fields: { taskId: optionalText, message: nullableText }, at: "local" },
  "task.steer-queued": { fields: { taskId: optionalText, messageId: text }, at: "thread", phone: namesQueued },
  "task.drop-queued": { fields: { taskId: optionalText, messageId: text, ifWaiting: optional(literals(true)) }, at: "thread", phone: namesQueued },
  "task.edit-queued": { fields: { taskId: optionalText, messageId: text }, at: "own", phone: editsQueued },
} satisfies Declarations<TaskCommand>;

export const sideChatCommands = {
  "side-chat.open": { fields: { chatId: text }, at: "thread" },
  "side-chat.close": { fields: { chatId: text }, at: "thread" },
} satisfies Declarations<SideChatCommand>;
