import type { AppCommand } from "./commands.js";
import type { MobilePairingOffer, MobileServerState } from "../domain/mobile.js";
import type { AgentEffort, AgentModel, ExecutionPolicy } from "../domain/run.js";
import type { Annotation, AnnotationAnchor, PastedText, TaskMessageKind } from "../domain/task.js";

/**
 * The commands a paired phone may dispatch. The phone is the user on a small screen, not an agent,
 * so it gets the whole conversation: starting, opening, sending, queueing, forking, renaming,
 * archiving and restoring threads, answering approvals, stopping work, and changing what a thread
 * runs as. It gets nothing that only makes sense in front of the Mac — the terminal panel, the
 * browser panel, the diff panel, handing a checkout to another application, deleting a worktree,
 * removing a project, window and shortcut commands, and how the desktop is painted — because a
 * phone cannot see the result and a mistyped one would be felt on a machine nobody is watching.
 */
export type MobileCommand = Extract<AppCommand, {
  type:
    | "task.new" | "task.select" | "task.send" | "task.archive" | "task.restore" | "task.rename"
    | "task.dismiss" | "task.dismiss-all" | "task.fork" | "task.set-policy" | "task.set-model"
    | "task.set-effort" | "task.steer-queued" | "task.drop-queued"
    | "run.cancel" | "run.decide" | "run.stop-process"
    | "annotation.add" | "annotation.note" | "annotation.remove" | "annotation.recall"
    | "paste.add" | "paste.remove" | "paste.recall"
    | "view.set-prompt";
}>;

/** A thread's state as one row: what it is doing outranks what it last did. */
export type MobileRunStatus = "idle" | "running" | "stopped" | "awaiting-approval";

export type MobileThreadEntry = {
  id: string;
  title: string;
  status: MobileRunStatus;
  lastActivityAt: number;
  /** Whether the thread still carries the dot, which is the only thing the list shows beyond time. */
  unread: boolean;
};

/** The list, grouped the way the sidebar groups it. `projectId` is null for threads in no project. */
export type MobileProjectGroup = {
  projectId: string | null;
  name: string;
  threads: MobileThreadEntry[];
};

export type MobileMessage = {
  kind: TaskMessageKind;
  text: string;
  at: number;
};

/** The question a run is stopped on, with enough of its input to answer it. */
export type MobileApproval = {
  approvalId: string;
  runId: string;
  title: string;
  description: string;
  toolName: string;
  detail: string;
};

export type MobileQueuedMessage = {
  id: string;
  text: string;
};

/** What the open thread is set to run as, which the phone can change like any other command. */
export type MobileThreadSettings = {
  model: AgentModel;
  effort: AgentEffort;
  policy: ExecutionPolicy;
};

export type MobileThreadView = {
  id: string;
  title: string;
  /** What the thread's folder is called, or null when it belongs to no project. */
  projectName: string | null;
  messages: MobileMessage[];
  /** How many older messages the limit left out. */
  omitted: number;
  /** The unfinished end of a streaming reply, which is not a message yet. */
  streamingTail: string | null;
  status: MobileRunStatus;
  approval: MobileApproval | null;
  queued: MobileQueuedMessage[];
  /** The composer draft, which the phone and the desktop share. */
  prompt: string;
  settings: MobileThreadSettings;
};

/**
 * What a phone sees: the thread list grouped by project, and the one conversation it has open. It is
 * the desktop's own derivation narrowed to a small screen, so the two can never disagree.
 */
export type MobileView = {
  groups: MobileProjectGroup[];
  /** The thread the phone has open, which is the thread the desktop has open. */
  thread: MobileThreadView | null;
  /**
   * What went wrong, as the desktop is also showing it. A phone is acknowledged the moment the
   * reducer decides, so a failure raised by the work that decision described arrives only here.
   */
  error: string | null;
};

/** Everything about the open thread but which thread it is, so a change can name only what moved. */
export type MobileThreadDelta = Partial<Omit<MobileThreadView, "id" | "messages">> & {
  /** Messages that arrived at the end of the transcript the phone already holds. */
  appended?: MobileMessage[];
  /** The whole transcript, when it did not simply grow. */
  messages?: MobileMessage[];
};

/**
 * What changed between two views. The open thread is described three ways because they mean three
 * different things to a phone: it went away, it is a thread the phone has never seen, or it moved.
 */
export type MobilePatch = {
  groups?: MobileProjectGroup[];
  thread?:
    | { kind: "closed" }
    | { kind: "opened"; thread: MobileThreadView }
    | { kind: "changed"; id: string; delta: MobileThreadDelta };
  /** Present only when it moved, because null is a value here rather than an absence. */
  error?: string | null;
};

/** Bumped when a message shape changes in a way an older phone page could misread. */
export const MOBILE_PROTOCOL_VERSION = 1;

const MAX_ID_LENGTH = 256;
const MAX_PROMPT_LENGTH = 1_000_000;
const MAX_TITLE_LENGTH = 1_000;
const MAX_QUOTE_LENGTH = 100_000;
const MAX_DEVICE_NAME_LENGTH = 128;
const MAX_TOKEN_LENGTH = 512;
/** How many drafted annotations or pastes one recall may carry. */
const MAX_RECALL = 100;

function isString(value: unknown, maxLength = MAX_ID_LENGTH): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isBlankable(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPolicy(value: unknown): value is ExecutionPolicy {
  return value === "confirm" || value === "plan" || value === "allow-edits" || value === "autonomous";
}

function isModel(value: unknown): value is AgentModel {
  return value === "fable" || value === "opus" || value === "sonnet" || value === "haiku";
}

function isEffort(value: unknown): value is AgentEffort {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}

function isRecord(value: unknown): value is Record<string, unknown> {
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

/** The command surface open to a paired phone. Everything else is the desktop window's alone. */
export function isMobileCommand(value: unknown): value is MobileCommand {
  if (!isRecord(value)) return false;
  const command = value;
  const named = command.taskId === undefined || isString(command.taskId);
  if (typeof command.type !== "string") return false;
  if (command.type.startsWith("task.") || command.type.startsWith("run.")) return isThreadCommand(command, named);
  if (command.type.startsWith("annotation.")) return isAnnotationCommand(command, named);
  if (command.type.startsWith("paste.")) return isPasteCommand(command, named);
  if (command.type === "view.set-prompt") return named && isBlankable(command.prompt, MAX_PROMPT_LENGTH);
  return false;
}

function isThreadCommand(command: Record<string, unknown>, named: boolean) {
  switch (command.type) {
    /** A phone never carries files, so a send that names attachments is not one a phone made. */
    case "task.send":
      return named
        && (command.project === undefined || isString(command.project, 4_096))
        && (command.text === undefined || isString(command.text, MAX_PROMPT_LENGTH))
        && command.attachments === undefined
        && (command.steer === undefined || typeof command.steer === "boolean")
        && (command.worktree === undefined || typeof command.worktree === "boolean")
        && (command.worktreeId === undefined || isString(command.worktreeId));
    case "task.new":
      return (command.projectId === undefined || isString(command.projectId))
        && (command.worktreeId === undefined || isString(command.worktreeId));
    case "task.select":
    case "task.archive":
    case "task.restore":
    case "task.dismiss":
      return isString(command.taskId);
    case "task.dismiss-all":
      return true;
    case "task.rename":
      return isString(command.taskId) && isBlankable(command.title, MAX_TITLE_LENGTH);
    case "task.fork":
      return named && (command.worktree === undefined || typeof command.worktree === "boolean");
    case "task.set-policy":
      return named && isPolicy(command.policy);
    case "task.set-model":
      return named && isModel(command.model);
    case "task.set-effort":
      return named && isEffort(command.effort);
    case "task.steer-queued":
    case "task.drop-queued":
      return named && isString(command.messageId);
    case "run.cancel":
      return named;
    case "run.decide":
      return named && typeof command.allow === "boolean";
    case "run.stop-process":
      return named && isString(command.processId);
    default:
      return false;
  }
}

function isAnnotationCommand(command: Record<string, unknown>, named: boolean) {
  if (!named) return false;
  if (command.type === "annotation.add") {
    return isString(command.quote, MAX_QUOTE_LENGTH)
      && (command.note === undefined || isBlankable(command.note, MAX_QUOTE_LENGTH))
      && (command.anchor === undefined || isAnchor(command.anchor));
  }
  if (command.type === "annotation.note") return isString(command.annotationId) && isBlankable(command.note, MAX_QUOTE_LENGTH);
  if (command.type === "annotation.remove") return isString(command.annotationId);
  if (command.type === "annotation.recall") return isBoundedList(command.annotations, isAnnotation);
  return false;
}

function isPasteCommand(command: Record<string, unknown>, named: boolean) {
  if (!named) return false;
  if (command.type === "paste.add") return isString(command.text, MAX_PROMPT_LENGTH);
  if (command.type === "paste.remove") return isString(command.pasteId);
  if (command.type === "paste.recall") return isBoundedList(command.pastes, isPastedText);
  return false;
}

/** Why the server refused. The phone shows the message; the code decides whether it retries. */
export type MobileErrorCode =
  | "version"
  | "unauthorized"
  | "expired-code"
  | "rate-limited"
  | "unreadable"
  | "internal";

/** The phone trading its one-time pairing code for a device token of its own. */
export type MobilePairRequest = {
  kind: "pair";
  version: number;
  code: string;
  /** What the phone calls itself, which is how settings lists it. */
  deviceName: string;
};

/**
 * The phone coming back with the token it already holds. `lastSequence` is the newest message it
 * saw, so a session whose buffer still reaches that far resumes instead of reloading.
 */
export type MobileResumeRequest = {
  kind: "resume";
  version: number;
  token: string;
  /** The session it was last on. A session the server no longer holds starts a new one. */
  sessionId?: string;
  lastSequence: number;
};

/** One command on its way through the desktop's own reducer, answered by exactly one acknowledgement. */
export type MobileCommandRequest = {
  kind: "command";
  requestId: string;
  command: MobileCommand;
};

export type MobilePongMessage = { kind: "pong"; at: number };

export type MobileClientMessage = MobilePairRequest | MobileResumeRequest | MobileCommandRequest | MobilePongMessage;

/**
 * Every message the server sends carries a sequence, counting from one within a session and never
 * repeating, so a phone can say what it has and be given only what it missed.
 */
type Sequenced = { sequence: number };

export type MobilePairedMessage = Sequenced & {
  kind: "paired";
  deviceId: string;
  deviceName: string;
  /** The long-lived token. It is sent once, here, and the Mac keeps only a hash of it. */
  token: string;
};

export type MobileSnapshotMessage = Sequenced & {
  kind: "snapshot";
  sessionId: string;
  view: MobileView;
};

export type MobilePatchMessage = Sequenced & { kind: "patch"; patch: MobilePatch };

export type MobileAckMessage = Sequenced & { kind: "ack"; requestId: string } & ({ ok: true } | { ok: false; message: string });

export type MobileErrorMessage = Sequenced & { kind: "error"; code: MobileErrorCode; message: string };

export type MobilePingMessage = Sequenced & { kind: "ping"; at: number };

export type MobileServerMessage = MobilePairedMessage | MobileSnapshotMessage | MobilePatchMessage | MobileAckMessage | MobileErrorMessage | MobilePingMessage;

function isErrorCode(value: unknown): value is MobileErrorCode {
  return value === "version" || value === "unauthorized" || value === "expired-code"
    || value === "rate-limited" || value === "unreadable" || value === "internal";
}

/** What a phone sends is the security boundary, so every field of it is read defensively. */
export function isMobileClientMessage(value: unknown): value is MobileClientMessage {
  if (!isRecord(value)) return false;
  if (value.kind === "pair") return isCount(value.version) && isString(value.code, MAX_TOKEN_LENGTH) && isString(value.deviceName, MAX_DEVICE_NAME_LENGTH);
  if (value.kind === "resume") {
    return isCount(value.version)
      && isString(value.token, MAX_TOKEN_LENGTH)
      && (value.sessionId === undefined || isString(value.sessionId))
      && isCount(value.lastSequence);
  }
  if (value.kind === "command") return isString(value.requestId) && isMobileCommand(value.command);
  if (value.kind === "pong") return isCount(value.at);
  return false;
}

/**
 * What the phone reads back. The view and the patch are the Mac's own derivation rather than
 * anything a stranger composes, so only the envelope is checked: a page that renders a malformed
 * body shows the wrong thing, where a page that acts on a malformed command does the wrong thing.
 */
export function isMobileServerMessage(value: unknown): value is MobileServerMessage {
  if (!isRecord(value) || !isCount(value.sequence)) return false;
  if (value.kind === "paired") return isString(value.deviceId) && isString(value.deviceName, MAX_DEVICE_NAME_LENGTH) && isString(value.token, MAX_TOKEN_LENGTH);
  if (value.kind === "snapshot") return isString(value.sessionId) && isRecord(value.view);
  if (value.kind === "patch") return isRecord(value.patch);
  if (value.kind === "ack") {
    if (!isString(value.requestId)) return false;
    return value.ok === true || (value.ok === false && isBlankable(value.message, MAX_PROMPT_LENGTH));
  }
  if (value.kind === "error") return isErrorCode(value.code) && isBlankable(value.message, MAX_PROMPT_LENGTH);
  if (value.kind === "ping") return isCount(value.at);
  return false;
}

/**
 * A phone's message on its way to the window, which is the only process holding workspace state.
 * The server never answers one itself: it forwards, and the window says what happened.
 */
export type MobileRequest = {
  type: "mobile.request";
  requestId: string;
  sessionId: string;
} & (
  | { op: "snapshot" }
  | { op: "command"; command: MobileCommand }
);

export type MobileResponse = {
  type: "mobile.response";
  requestId: string;
} & ({ ok: true; result: unknown } | { ok: false; message: string });

export function isMobileRequest(value: unknown): value is MobileRequest {
  if (!isRecord(value)) return false;
  if (value.type !== "mobile.request" || !isString(value.requestId) || !isString(value.sessionId)) return false;
  if (value.op === "snapshot") return true;
  if (value.op === "command") return isMobileCommand(value.command);
  return false;
}

export function isMobileResponse(value: unknown): value is MobileResponse {
  if (!isRecord(value)) return false;
  if (value.type !== "mobile.response" || !isString(value.requestId)) return false;
  return value.ok === true || (value.ok === false && isBlankable(value.message, MAX_PROMPT_LENGTH));
}

/**
 * The window pushing what a phone should see. A snapshot answers a phone that has just arrived or
 * fallen too far behind; a patch is what every later change costs.
 */
export type MobileViewUpdate =
  | { kind: "snapshot"; view: MobileView }
  | { kind: "patch"; patch: MobilePatch };

/**
 * What the renderer calls and the main process implements, merged into `DesktopAPI`. Reading and
 * changing the bridge's settings are promises; the two subscriptions and the two pushes are not,
 * because a phone's traffic must never wait on the window's own turn.
 */
export type MobileDesktopAPI = {
  mobileState(): Promise<MobileServerState>;
  /** Turns the local server on or off. Off closes every live session. */
  setMobileEnabled(enabled: boolean): Promise<MobileServerState>;
  /** The opt-in second bind that anything on the same network can reach. Off by default. */
  setMobileLanExposed(exposed: boolean): Promise<MobileServerState>;
  /** Mints the code the QR carries. Minting a second one discards the first. */
  createMobilePairingCode(): Promise<MobilePairingOffer>;
  /** Forgets a phone's token, which drops its session with it. */
  revokeMobileDevice(deviceId: string): Promise<MobileServerState>;
  /** Puts Tailscale Serve in front of the local server, or takes it away. */
  setTailscaleServe(enabled: boolean): Promise<MobileServerState>;
  /** Asks Tailscale again whether it is installed, signed in, and what this machine is called. */
  refreshTailscale(): Promise<MobileServerState>;
  onMobileState(listener: (state: MobileServerState) => void): () => void;
  onMobileRequest(listener: (request: MobileRequest) => void): () => void;
  answerMobileRequest(response: MobileResponse): void;
  /** What every connected phone is shown, pushed as the window's own state moves. */
  publishMobileView(update: MobileViewUpdate): void;
};
