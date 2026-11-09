/**
 * What a paired phone's command must satisfy, one rule per command a phone may send. A rule reads the
 * command as sent, so it checks every field it lets through.
 */
import { isAgentEffort, isAgentEngine, isModelId } from "../domain/agent-engine.js";
import { isExecutionPolicy } from "../domain/run.js";
import { isThreadRole } from "../domain/thread-role.js";
import { isSnoozeHours } from "../domain/thread-snooze.js";
import { MAX_ANSWER } from "../domain/coordination.js";
import type { Annotation, AnnotationAnchor, PastedText } from "../domain/conversation.js";
import type { WorktreeDestination } from "../domain/worktree.js";
import { sendStaysInReach } from "./task-send.js";

export type PhoneRule = (command: Readonly<Record<string, unknown>>) => boolean;

const MAX_ID_LENGTH = 256;
export const MAX_PROMPT_LENGTH = 1_000_000;
/** The longest title a phone may give a thread, which its rename field holds it to. */
export const MAX_TITLE_LENGTH = 1_000;
const MAX_QUOTE_LENGTH = 100_000;
export const MAX_PATH_LENGTH = 4_096;
/** How many drafted annotations or pastes one recall may carry. */
const MAX_RECALL = 100;

export function isString(value: unknown, maxLength = MAX_ID_LENGTH): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

export function isBlankable(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

export function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAnchor(value: unknown): value is AnnotationAnchor {
  if (!isRecord(value)) return false;
  if (value.kind === "message") return isString(value.messageId) && isCount(value.start) && isCount(value.end);
  if (value.kind !== "diff") return false;
  return isString(value.comparison, 4_096)
    && isString(value.path, 4_096)
    && isString(value.start)
    && isString(value.end)
    && (value.side === "old" || value.side === "new");
}

function isAnnotation(value: unknown): value is Annotation {
  if (!isRecord(value)) return false;
  return isString(value.id)
    && isString(value.quote, MAX_QUOTE_LENGTH)
    && isBlankable(value.note, MAX_QUOTE_LENGTH)
    && (value.anchor === undefined || isAnchor(value.anchor));
}

function isPastedText(value: unknown): value is PastedText {
  return isRecord(value) && isString(value.id) && isString(value.text, MAX_PROMPT_LENGTH);
}

function isBoundedList<T>(value: unknown, item: (entry: unknown) => entry is T): value is T[] {
  return Array.isArray(value) && value.length <= MAX_RECALL && value.every(item);
}

function isDestination(value: unknown): value is WorktreeDestination {
  if (!isRecord(value)) return false;
  if (value.kind === "local" || value.kind === "new") return true;
  return value.kind === "worktree" && isString(value.id);
}

/** A thread named by id, or none for the thread on screen. */
const named: PhoneRule = (command) => command.taskId === undefined || isString(command.taskId);

export const namesThread: PhoneRule = (command) => isString(command.taskId);

/**
 * A phone sends a message and nothing else: never files, never the shape of a thread being started,
 * which the draft's settings set, and never who the message is from or who the thread works under.
 */
export const sends: PhoneRule = (command) => named(command)
  && (command.project === undefined || isString(command.project, MAX_PATH_LENGTH))
  && (command.text === undefined || isString(command.text, MAX_PROMPT_LENGTH))
  && (command.steer === undefined || typeof command.steer === "boolean")
  && (command.worktree === undefined || typeof command.worktree === "boolean")
  && (command.worktreeId === undefined || isString(command.worktreeId))
  && sendStaysInReach(command, "phone");

export const starts: PhoneRule = (command) => (command.projectId === undefined || isString(command.projectId))
  && (command.worktreeId === undefined || isString(command.worktreeId));

export const dismissesAll: PhoneRule = (command) => (command.localOnly === undefined || typeof command.localOnly === "boolean")
  && (command.projectId === undefined || isString(command.projectId));

export const renames: PhoneRule = (command) => isString(command.taskId) && isBlankable(command.title, MAX_TITLE_LENGTH);

export const forks: PhoneRule = (command) => named(command) && (command.worktree === undefined || typeof command.worktree === "boolean");

export const setsPolicy: PhoneRule = (command) => named(command) && isExecutionPolicy(command.policy);

export const setsModel: PhoneRule = (command) => named(command) && isAgentEngine(command.engine) && (command.model === undefined || isModelId(command.model));

export const setsFastMode: PhoneRule = (command) => named(command) && typeof command.fastMode === "boolean";

export const setsEffort: PhoneRule = (command) => named(command) && isAgentEngine(command.engine) && isAgentEffort(command.effort);

export const setsWorktree: PhoneRule = (command) => named(command) && typeof command.worktree === "boolean";

/** Only an agent moving its own thread waits for its run to end or says what it goes on with, and only the link names a thread elsewhere that asked: the host says each, never the caller. */
export const movesWorktree: PhoneRule = (command) => named(command) && isDestination(command.destination)
  && command.afterRun === undefined && command.sender === undefined && command.then === undefined;

export const namesQueued: PhoneRule = (command) => named(command) && isString(command.messageId);

/** An edit names its thread, since the phone's composer takes the words for the thread it shows. */
export const editsQueued: PhoneRule = (command) => isString(command.taskId) && isString(command.messageId);

export const cancels: PhoneRule = named;

export const decides: PhoneRule = (command) => isString(command.taskId) && isString(command.runId) && isString(command.approvalId) && typeof command.allow === "boolean";

/** An answer to a decision a thread raised, in the user's own words or an option's label. */
export const answersDecision: PhoneRule = (command) => isString(command.taskId) && isString(command.decisionId) && isString(command.answer, MAX_ANSWER);

/** One suggestion started where its coordinator suggested it, never several at once or in a place the phone picked. */
export const startsProposal: PhoneRule = (command) => isString(command.taskId) && isString(command.proposalId)
  && command.proposalIds === undefined && command.place === undefined;

export const snoozes: PhoneRule = (command) => isString(command.taskId) && isSnoozeHours(command.hours);

export const stopsProcess: PhoneRule = (command) => named(command) && isString(command.processId);

export const answers: PhoneRule = (command) => isString(command.taskId) && isString(command.runId)
  && isString(command.requestId) && isString(command.questionId)
  && (command.text === undefined || isString(command.text, MAX_PROMPT_LENGTH)) && command.attachments === undefined;

export const annotates: PhoneRule = (command) => named(command)
  && isString(command.quote, MAX_QUOTE_LENGTH)
  && (command.note === undefined || isBlankable(command.note, MAX_QUOTE_LENGTH))
  && (command.anchor === undefined || isAnchor(command.anchor));

export const notesAnnotation: PhoneRule = (command) => named(command) && isString(command.annotationId) && isBlankable(command.note, MAX_QUOTE_LENGTH);

export const removesAnnotation: PhoneRule = (command) => named(command) && isString(command.annotationId);

export const recallsAnnotations: PhoneRule = (command) => named(command) && isBoundedList(command.annotations, isAnnotation);

export const pastes: PhoneRule = (command) => named(command) && isString(command.text, MAX_PROMPT_LENGTH);

export const removesPaste: PhoneRule = (command) => named(command) && isString(command.pasteId);

export const recallsPastes: PhoneRule = (command) => named(command) && isBoundedList(command.pastes, isPastedText);

/** A thread or the draft made a coordinator or made plain again; only an agent says who asked. */
export const setsRole: PhoneRule = (command) => named(command) && (command.role === null || isThreadRole(command.role)) && command.sender === undefined;

/** A folder on this computer opened as a project, never one on another computer the desktop is linked to. */
export const addsProject: PhoneRule = (command) => isString(command.root, MAX_PATH_LENGTH) && command.root.trim().length > 0
  && command.computerId === undefined && (command.start === undefined || command.start === true);

/** How large one image a phone sends may be, as a data URL: a photo the phone has already shrunk, never a raw camera file. */
export const MAX_PHONE_IMAGE_LENGTH = 8 * 1024 * 1024;
/** How many images one phone send carries, as the desktop's composer strip holds. */
export const MAX_PHONE_IMAGES = 6;

const PHONE_IMAGE = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;

/**
 * Images a phone sends into a thread or the draft, with the words that go with them: each a picture
 * the phone holds, so never a path on this computer, a screenshot's context, or marks drawn over it.
 */
export const sendsImages: PhoneRule = (command) => named(command)
  && (command.steer === undefined || typeof command.steer === "boolean")
  && (command.text === undefined || isString(command.text, MAX_PROMPT_LENGTH))
  && Array.isArray(command.attachments) && command.attachments.length > 0 && command.attachments.length <= MAX_PHONE_IMAGES
  && command.attachments.every((attachment: unknown) => isRecord(attachment) && isString(attachment.id)
    && typeof attachment.source === "string" && attachment.source.length <= MAX_PHONE_IMAGE_LENGTH && PHONE_IMAGE.test(attachment.source)
    && Array.isArray(attachment.annotations) && attachment.annotations.length === 0
    && attachment.path === undefined && attachment.context === undefined);

export const setsPrompt: PhoneRule = (command) => named(command) && isBlankable(command.prompt, MAX_PROMPT_LENGTH);

/** The app on this computer, never one on a computer the desktop is linked to. */
export const updatesHere: PhoneRule = (command) => command.computerId === undefined;

export const updatesEngineHere: PhoneRule = (command) => isAgentEngine(command.engine) && command.computerId === undefined;

/** A phone looks for a newer build without a dialog, since nobody may be at the computer to close one. */
export const checksQuietly: PhoneRule = (command) => command.quiet === true;

/** This computer's own limits, never a paired computer's. */
export const readsUsageHere: PhoneRule = (command) => command.everywhere === undefined;

export const dismissesUsageWarning: PhoneRule = (command) => isString(command.warning);

export const rereadsEngines: PhoneRule = (command) => command.refresh === true;
