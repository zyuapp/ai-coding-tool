import type { PendingQuestion } from "../domain/agent-question.js";
import type { AppCommand } from "./commands.js";
import { isPhonePush, type MobilePairingOffer, type MobileServerState, type PhonePush } from "../domain/mobile.js";
import type { AgentEngine, AgentModel, EngineAccess, EngineId } from "../domain/agent-engine.js";
import type { AgentEffort, ExecutionPolicy } from "../domain/run.js";
import { isDiffRange, type DiffRange } from "../domain/diff.js";
import { isDictationAudio } from "../domain/dictation.js";
import type { ThemeMode } from "../domain/theme.js";
import type { ThreadOutcome } from "../domain/thread-run.js";
import type { TaskMessageKind } from "./threads.js";
import type { ToolFamily } from "../domain/tool-call.js";
import type { DiffPatchResult, DiffSummaryResult } from "./ipc.js";
import type { ThreadRole } from "../domain/thread-role.js";
import { isBlankable, isCount, isRecord, isString, MAX_PATH_LENGTH, MAX_PROMPT_LENGTH } from "./phone-commands.js";
import { isPhoneCommand, type PhoneCommandType } from "./workspace-view-input.js";

/**
 * The commands a paired phone may dispatch. The phone is the user on a small screen, not an agent,
 * so it gets the whole conversation: starting, opening, sending, queueing, forking, renaming,
 * archiving and restoring threads, answering approvals, stopping work, changing what a thread runs
 * as, and where it runs: a checkout of its own, an existing one, or the project's. It updates the
 * computer's app and engines, which waits for running threads as it does on the desktop. It gets nothing
 * that only makes sense in front of the Mac — the terminal panel, the browser panel, handing a
 * checkout to another application, deleting a worktree, removing a project, window and shortcut
 * commands, and how the desktop is painted — because a phone cannot see the result and a mistyped
 * one would be felt on a machine nobody is watching. Changes are read through a query instead, so
 * a phone reviewing a diff moves nothing on the desktop.
 */
export type MobileCommand = Extract<AppCommand, { type: PhoneCommandType }>;

/** A whole number: a count, an index or a rounded share. The phone reads it as an integer where a plain `number` is a `Double`. */
export type Count = number;

/**
 * One piece of software on the computer, the app or an engine: what it runs, where a newer one
 * stands, and the command that moves it on, which the phone sends back as it came.
 */
export type MobileUpkeepItem = {
  key: string;
  label: string;
  version: string | null;
  state: { text: string; tone?: "live" | "quiet" | "progress" | "offer" | "error" };
  action: { label: string; command: MobileCommand } | null;
  /** On the app's row while the computer installs it, which restarts the computer's side of the line. */
  installing?: true;
};

/** A thread's state as one row: what it is doing outranks what it last did. */
export type MobileRunStatus = "idle" | "running" | "stopped" | "awaiting-approval";

export type MobileThreadEntry = {
  id: string;
  title: string;
  /** Which folder the thread is in, and what it is called, for a list that is not grouped by folder. Null in no project. */
  projectId: string | null;
  projectName: string | null;
  /** A coordinator's speaks for the threads under it too, which are reached through it: one waiting on an approval is its own. */
  status: MobileRunStatus;
  lastActivityAt: number;
  /** Whether the thread still carries the dot. */
  unread: boolean;
  /** The verdict its last run left, once it has settled. */
  outcome?: ThreadOutcome;
  /**
   * The row's second line, as the desktop's row says it: what waits on the user from it and the
   * threads under it, else the newest thing a run found that the user has not seen.
   */
  headline?: string;
  /** Set when something besides an approval waits on the user from it or a thread under it, which marks the row as one does. */
  waiting?: true;
  /** Whether Dismiss files anything away from the row, by the desktop's own rule. */
  attention: boolean;
  /** Set on a Priority row, which Snooze takes out of the list for a while. Absent from older desktops. */
  snoozable?: true;
  /** When a snoozed thread comes back, which Unsnooze brings forward. Absent from older desktops. */
  snoozedUntil?: number;
};

/** The list ranked by what wants the user, as the desktop's activity sidebar ranks it. */
export type MobileActivity = {
  priority: MobileThreadEntry[];
  running: MobileThreadEntry[];
  threads: MobileThreadEntry[];
  snoozed: MobileThreadEntry[];
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
  origin?: string;
  at: number;
  /** What a tool call did, in one line, as the desktop's transcript reads it. Tool messages only. */
  call?: MobileToolCall;
  /** How many images the message carried. */
  images?: Count;
  /** Set on a reply that may link images, which the phone asks for by this ID with an "image" query. */
  id?: string;
};

/** A tool call as a row reads it: its label, the argument that tells it from the next, and its family's glyph. */
export type MobileToolCall = { family: ToolFamily; label: string; argument: string; sigil?: string; verb?: true };

/**
 * A thread working under the open coordinator. One on another computer names it in `computer`, and
 * `online` says whether that computer's line is up, which is when the phone may open it. `online` is
 * absent from older desktops, which open no thread on another computer.
 */
export type MobileMember = { id: string; title: string; status: MobileRunStatus; computer?: string; online?: boolean };

/**
 * Work the open thread's session keeps going beside its conversation: a subagent, a shell or
 * monitor, or a workflow. `live` is whether it is still going; `stoppable` whether Stop applies,
 * which sends `run.stop-process` with its id.
 */
export type MobileBackgroundItem = {
  id: string;
  kind: "agent" | "shell" | "monitor" | "workflow";
  title: string;
  /** What it is doing now, or how it ended. */
  detail: string;
  status: "working" | "idle" | "completed" | "failed" | "stopped";
  live: boolean;
  stoppable: boolean;
  stopping?: true;
};

/**
 * The question a run is stopped on, with enough of its input to answer it. A coordinator's view
 * carries one a thread under it is stopped on when it has none of its own, as its Needs-you card
 * does, naming that thread in `from`.
 */
export type MobileApproval = {
  /** The thread whose run is stopped, which the answer goes to. */
  taskId: string;
  from?: string;
  approvalId: string;
  runId: string;
  title: string;
  description: string;
  toolName: string;
  detail: string;
};

/**
 * A choice a thread raised for the user, which `decision.answer` settles with an option's label or
 * the user's own words. A coordinator's view carries those of the threads under it, naming the
 * thread that asks in `from`.
 */
export type MobileDecision = {
  taskId: string;
  from?: string;
  id: string;
  question: string;
  context?: string;
  options: Array<{ label: string; description?: string; recommended?: true }>;
};

/** What a coordinator handed a suggested thread, as its brief reads it. `delivers` is already a label. */
export type MobileBrief = { intent: string; doneWhen: string; delivers: string };

/**
 * A thread the open coordinator suggested here, which `proposal.start` starts with its id. Its prompt
 * is cut to length, since the phone shows it only on request. `starting` is set while its start is on its way.
 */
export type MobileSuggestion = {
  id: string;
  title: string;
  brief?: MobileBrief;
  prompt: string;
  starting?: true;
  /** Why the user's last start of it failed. */
  error?: string;
};

/**
 * The open thread waiting out its account's usage limit. A session limit resumes on its own once it
 * lifts, which `limit.cancel` stops; a weekly one waits for `limit.resume`. `position` is its place in
 * its engine's line, counting from one.
 */
export type MobileLimitPause = { resetsAt: number; window: "session" | "weekly"; position: Count | null };

/** An archived thread as the phone's Archived list reads it, which `task.restore` puts back. */
export type MobileArchivedThread = { id: string; title: string; projectName: string | null; archivedAt: number; deletesAt: number };

export type MobileQueuedMessage = {
  id: string;
  text: string;
  origin?: string;
  /** Set while the message is on its way into the run, which takes its controls away. */
  steering?: boolean;
  /** Set on the user's own words alone, which `task.edit-queued` takes back to the phone. Absent from older desktops. */
  editable?: true;
};

/** Where a thread's runs happen, as the phone names it. */
export type MobileLocation =
  | { kind: "local" }
  | { kind: "creating" }
  | { kind: "releasing" }
  | { kind: "worktree"; name: string; threads: Count };

/** One of the project's other checkouts, which a thread can move into or a draft start in. */
export type MobileWorktreeChoice = {
  id: string;
  name: string;
  branch: string | null;
};

/** What the checkout holds against its baseline, as the desktop's session panel counts it. */
export type MobileChanges = {
  branch: string | null;
  files: Count;
  additions: Count;
  deletions: Count;
};

/** What the open thread is set to run as, which the phone can change like any other command. */
export type MobileThreadSettings = {
  /** A thread on a paired computer may run on an engine only a newer build knows. */
  engine: EngineId;
  /** Absent while the thread's engine has yet to name the model it runs on. */
  model?: AgentModel;
  effort: AgentEffort;
  /** Absent when connected to an older desktop. */
  fastMode?: boolean;
  policy: ExecutionPolicy;
  /** A coordinator, whose effort menu offers no effort that hands work to the engine's agents. */
  coordinating?: true;
};

/** A model an engine on the computer names for itself, carrying only what a phone's picker reads. */
export type MobileModel = { id: AgentModel; label: string; description: string; provider?: string; efforts: AgentEffort[] };

/**
 * What a phone knows of an engine on the computer: whether it runs, which models its installed
 * command runs, and the models it names for itself. An engine left out is ready on the models this
 * build ships knowing, which the vocabulary in its snapshot names.
 */
export type MobileEngine = { access: EngineAccess; models?: AgentModel[]; catalog?: MobileModel[] };

export type MobileEngines = Partial<Record<AgentEngine, MobileEngine>>;

export type MobileThreadView = {
  loading?: boolean;
  id: string;
  title: string;
  projectId: string | null;
  /** What the thread's folder is called, or null when it belongs to no project. */
  projectName: string | null;
  /** The checkout the thread works in, when it has one of its own. */
  worktreeId: string | null;
  messages: MobileMessage[];
  /** How many older messages the limit left out. */
  omitted: Count;
  /** The unfinished end of a streaming reply, which is not a message yet. */
  streamingTail: string | null;
  status: MobileRunStatus;
  approval: MobileApproval | null;
  question?: PendingQuestion | null;
  queued: MobileQueuedMessage[];
  settings: MobileThreadSettings;
  location: MobileLocation;
  /** The project's other checkouts, most recently used first. */
  worktrees: MobileWorktreeChoice[];
  /** Whether the thread may be moved now: it has a repository, and nothing is running in it. */
  canMove: boolean;
  /** Null while the checkout has not been read, or the thread has none. */
  changes: MobileChanges | null;
  /** Whether the thread works in a registered checkout, which is what a review is read from. */
  reviewable: boolean;
  /** The threads working under it, when the open thread is a coordinator; empty otherwise. Absent from older desktops. */
  members?: MobileMember[];
  /** The part it plays beside other threads, null for none. Absent from older desktops. */
  role?: ThreadRole | null;
  /** Its workflows, processes and subagents, live ones first, a hundred at most. Absent from older desktops. */
  background?: MobileBackgroundItem[];
  /** The branch comparison the desktop has this thread's review on. */
  branchRange: Extract<DiffRange, { kind: "branches" }>;
  /** Decisions waiting on the user from it and, for a coordinator, the threads under it, oldest first. Absent from older desktops. */
  decisions?: MobileDecision[];
  /** The threads a coordinator suggested here and the user has yet to start. Absent from older desktops. */
  suggestions?: MobileSuggestion[];
  /** Null unless it waits out a usage limit. Absent from older desktops. */
  limit?: MobileLimitPause | null;
  /** The paired computer holding it, when it is a thread under a coordinator here that runs there. */
  computer?: string;
  /** On a coordinator, whether `coordination.stop-all` has anything to stop. Absent from older desktops. */
  stoppable?: boolean;
};

/**
 * The thread the desktop is about to start: an empty composer pointed at a project. A thread exists
 * only once its first message is sent, so this is what stands in the open thread's place until then.
 */
export type MobileDraftView = {
  projectId: string | null;
  /** The folder the thread would start in, or null when it would belong to no project. */
  projectName: string | null;
  settings: MobileThreadSettings;
  /** Whether the first message makes the thread a checkout of its own. */
  worktree: boolean;
  /** The existing checkout the thread starts in, when the user picked one. */
  worktreeName: string | null;
  /** The project's checkouts a draft may start in. */
  worktrees: MobileWorktreeChoice[];
  /** Whether the project has a repository, which is what a checkout is cut from. */
  canWorktree: boolean;
};

/**
 * The desktop's theme as a phone can wear it: the family's dark and light faces, and which of them
 * the desktop is on. On "auto" the phone reads its own appearance, since it is on its own ground.
 */
export type MobileTheme = {
  dark: string;
  light: string;
  mode: ThemeMode;
};

/** One plan window as a phone draws it, its share already rounded. */
export type MobileUsageWindow = { id: string; label: string; share: Count | null; resetsAt: string | null };

/** An engine's plan as the Usage sheet lists it: its windows, or why the computer could not read them. */
export type MobileEngineUsage = { engine: AgentEngine; label: string; plan: string | null; windows: MobileUsageWindow[]; message?: string };

/** The windows the composer's model spends, and the warning over the composer once one runs low. */
export type MobileComposerUsage = {
  /** The fullest window's share. */
  share: Count;
  /** What the desktop composer's meter reads: the session and fullest week, or the fullest window alone. */
  meter: { span: string; share: Count }[];
  /** The windows the model spends, by id. */
  spends: string[];
  /** Null once dismissed, below the warning line, or while the thread waits out a limit. */
  warning: { key: string; share: Count; window: string; resetsAt: string | null } | null;
};

export type MobileUsage = { engines: MobileEngineUsage[]; composer: MobileComposerUsage | null };

/**
 * What a phone sees: the thread list grouped by project, and the one conversation it has open. It is
 * the desktop's own derivation narrowed to a small screen, so the two can never disagree.
 */
export type MobileView = {
  groups: MobileProjectGroup[];
  activity: MobileActivity;
  theme: MobileTheme;
  /** The computer's engines, which say the models a thread or draft may pick. */
  engines: MobileEngines;
  /** The computer's app, then its engines. */
  upkeep: MobileUpkeepItem[];
  /** Whether this computer can turn a held recording into words now. */
  dictation: boolean;
  /** The plan limits of this computer's accounts. */
  usage: MobileUsage;
  /** How many threads are archived, which an "archived" query lists. Absent from older desktops. */
  archived?: Count;
  /** The thread the phone has open, which is the thread the desktop has open. */
  thread: MobileThreadView | null;
  /** Where the desktop stands with no thread open. Null whenever `thread` is not. */
  draft: MobileDraftView | null;
  /**
   * What went wrong, as the desktop is also showing it. A phone is acknowledged the moment the
   * reducer decides, so a failure raised by the work that decision described arrives only here.
   */
  error: string | null;
};

/** Everything about the open thread but which thread it is, so a change can name only what moved. */
export type MobileThreadDelta = Partial<Omit<MobileThreadView, "id" | "messages">> & {
  /**
   * The transcript's end, when only its end moved: `dropped` messages leave the front as the window
   * slides, the first `kept` of the rest stay, and `messages` follow them. A message growing, a
   * message arriving and the oldest falling out of the window all cost only what is new.
   */
  spliced?: { dropped: Count; kept: Count; messages: MobileMessage[] };
  /** The whole transcript, when it did not simply move at its end. */
  messages?: MobileMessage[];
  /**
   * What a streaming reply added: everything past the first `from` characters of the tail the phone
   * holds. A tail that did not simply grow travels whole, as `streamingTail`.
   */
  tail?: { from: Count; text: string };
};

/** How the open thread moved: it went away, it is a thread the phone has never seen, or it changed. */
export type MobileThreadPatch =
  | { kind: "closed" }
  | { kind: "opened"; thread: MobileThreadView }
  | { kind: "changed"; id: string; delta: MobileThreadDelta };

/**
 * What changed between two views. The open thread is described three ways because they mean three
 * different things to a phone: it went away, it is a thread the phone has never seen, or it moved.
 */
export type MobilePatch = {
  groups?: MobileProjectGroup[];
  activity?: MobileActivity;
  theme?: MobileTheme;
  engines?: MobileEngines;
  upkeep?: MobileUpkeepItem[];
  dictation?: boolean;
  usage?: MobileUsage;
  archived?: Count;
  thread?: MobileThreadPatch;
  /** Present only when it moved, and null when a thread took its place. */
  draft?: MobileDraftView | null;
  /** Present only when it moved, because null is a value here rather than an absence. */
  error?: string | null;
};

/** Bumped when either side needs to know the other has a change, such as a field it now relies on. */
export const MOBILE_PROTOCOL_VERSION = 8;

/**
 * The oldest phone app this computer serves. Raised only when an older app would misread what the
 * computer now sends, or would send what it no longer reads: one turned away is told to update,
 * where one left running is wrong in silence.
 */
export const OLDEST_PHONE_PROTOCOL_VERSION = 8;

const MAX_DEVICE_NAME_LENGTH = 128;
const MAX_TOKEN_LENGTH = 512;

/**
 * What a phone reads that is content rather than state: a review's file list and one file's patch.
 * The thread names the checkout, so a phone never says which directory to read.
 */
export type MobileQuery =
  | { kind: "diff-summary"; taskId: string; range: DiffRange }
  | { kind: "diff-patch"; taskId: string; range: DiffRange; path: string; previousPath?: string }
  /** The folders on the computer whose paths start with `prefix`, for picking a project to add. */
  | { kind: "directories"; prefix: string }
  /** A thread's transcript without opening it, for one working under the open coordinator. */
  | { kind: "thread"; taskId: string }
  /** The page of a thread's messages just before index `before`, answered as {@link MobileThreadHistory}. */
  | { kind: "history"; taskId: string; before: Count }
  /** A held recording, base64 WAV, turned into words by this computer's speech model. Answers `{ text }`. */
  | { kind: "transcribe"; audio: string }
  /**
   * An image a reply links, named by the link's destination as written. Answers {@link MobileImageRead}:
   * the desktop's preview when `preview` is set, else the original.
   */
  | { kind: "image"; taskId: string; messageId: string; href: string; preview?: boolean }
  /** The archived threads, newest first, as {@link MobileArchivedThread} rows. */
  | { kind: "archived" }
  /**
   * What the "/" menu offers a thread, or the new thread's draft when `taskId` is absent: its engine's
   * slash commands and enabled skills in its checkout, read on the computer holding it. Answers a
   * `CommandDiscoveryResult`.
   */
  | { kind: "commands"; taskId?: string };

export type MobileImageRead = { data: string; contentType: string };

/** What a {@link MobileQuery} of kind "diff-summary" answers. */
export type MobileDiffSummary = DiffSummaryResult;

/** What a {@link MobileQuery} of kind "diff-patch" answers. */
export type MobileDiffPatch = DiffPatchResult;

/** What a {@link MobileQuery} of kind "thread" answers: the thread as its own screen would read it. */
export type MobileThreadRead = { title: string; status: MobileRunStatus; messages: MobileMessage[]; omitted: Count; streamingTail: string | null };

/** What a {@link MobileQuery} of kind "history" answers: the messages from index `start` on, oldest first. */
export type MobileThreadHistory = { start: Count; messages: MobileMessage[] };

export function isMobileQuery(value: unknown): value is MobileQuery {
  if (isRecord(value) && value.kind === "history") return isString(value.taskId) && Number.isSafeInteger(value.before) && (value.before as number) >= 0;
  if (isRecord(value) && value.kind === "directories") return typeof value.prefix === "string" && value.prefix.length <= MAX_PATH_LENGTH && !value.prefix.includes("\0");
  if (isRecord(value) && value.kind === "thread") return isString(value.taskId);
  if (isRecord(value) && value.kind === "archived") return true;
  if (isRecord(value) && value.kind === "commands") return value.taskId === undefined || isString(value.taskId);
  if (isRecord(value) && value.kind === "transcribe") return isDictationAudio(value.audio);
  if (isRecord(value) && value.kind === "image") return isString(value.taskId) && isString(value.messageId) && isString(value.href, MAX_PATH_LENGTH)
    && (value.preview === undefined || typeof value.preview === "boolean");
  if (!isRecord(value) || !isString(value.taskId) || !isDiffRange(value.range)) return false;
  if (value.kind === "diff-summary") return true;
  return value.kind === "diff-patch" && isString(value.path, MAX_PATH_LENGTH) && (value.previousPath === undefined || isString(value.previousPath, MAX_PATH_LENGTH));
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
  /** The oldest computer the phone reads. Absent from apps that predate it. */
  oldestComputer?: number;
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
  /** The oldest computer the phone reads. Absent from apps that predate it. */
  oldestComputer?: number;
  token: string;
  /** The session it was last on. A session the server no longer holds starts a new one. */
  sessionId?: string;
  lastSequence: Count;
};

/** One command on its way through the desktop's own reducer, answered by exactly one acknowledgement. */
export type MobileCommandRequest = {
  kind: "command";
  requestId: string;
  command: MobileCommand;
};

/** One read, answered by exactly one {@link MobileAnswerMessage}. Never resent: a read that was lost is simply asked again. */
export type MobileQueryRequest = {
  kind: "query";
  requestId: string;
  query: MobileQuery;
};

export type MobilePongMessage = { kind: "pong"; at: number };

/**
 * The phone asking whether the line still carries anything, which the Mac answers with a ping of
 * its own. A phone back from sleep cannot tell a live socket from a dead one any other way.
 */
export type MobileProbeMessage = { kind: "ping"; at: number };

/**
 * Where this phone takes notices while the app is closed, or null once it no longer does. Sent only
 * to a computer whose snapshot says it takes one.
 */
export type MobilePushTokenMessage = { kind: "push-token"; push: PhonePush | null };

export type MobileClientMessage = MobilePairRequest | MobileResumeRequest | MobileCommandRequest | MobileQueryRequest | MobilePongMessage | MobileProbeMessage | MobilePushTokenMessage;

/**
 * Every message the server sends carries a sequence, counting from one within a session and never
 * repeating, so a phone can say what it has and be given only what it missed.
 */
type Sequenced = { sequence: Count };

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
  /** Which running server this is. A new one has forgotten what it ran, so what was sent before is not sent again. */
  instance?: string;
  /** What this build calls its engines, modes, models and efforts, for a phone app not built beside it. Absent from older desktops. */
  vocabulary?: MobileVocabulary;
  /** What this computer calls itself, which a phone paired with several tells them apart by. */
  computer?: string;
  /** That this computer takes the phone's push token. Absent from older desktops. */
  push?: true;
};

/** One effort as a picker names it. `delegates` is an effort a coordinator never takes. */
export type MobileEffortTerm = { id: AgentEffort; label: string; description?: string; delegates?: true };

/**
 * One engine as this build names it: the modes a picker offers, in order, whether it has a fast
 * mode, and the models it ships knowing, which stand for its catalogue wherever `engines` sends none.
 */
export type MobileEngineTerms = {
  id: AgentEngine;
  label: string;
  fastMode: boolean;
  policies: MobilePolicyTerm[];
  models: MobileModel[];
};

/** A mode a picker offers, as this build names it. */
export type MobilePolicyTerm = { id: ExecutionPolicy; label: string; description: string };

/** A role a thread may take, as this build names it. */
export type MobileRoleTerm = { id: ThreadRole; label: string };

/** Everything a phone app reads by name from the build it is connected to. */
export type MobileVocabulary = {
  engines: MobileEngineTerms[];
  /** Every effort, deepest first. */
  efforts: MobileEffortTerm[];
  /** Every role a thread may take, in menu order. Absent from older desktops. */
  roles?: MobileRoleTerm[];
};

export type MobilePatchMessage = Sequenced & { kind: "patch"; patch: MobilePatch };

export type MobileAckMessage = Sequenced & { kind: "ack"; requestId: string } & ({ ok: true } | { ok: false; message: string });

export type MobileAnswerMessage = Sequenced & { kind: "answer"; requestId: string } & ({ ok: true; result: unknown } | { ok: false; message: string });

export type MobileErrorMessage = Sequenced & { kind: "error"; code: MobileErrorCode; message: string };

export type MobilePingMessage = Sequenced & { kind: "ping"; at: number };

export type MobileServerMessage = MobilePairedMessage | MobileSnapshotMessage | MobilePatchMessage | MobileAckMessage | MobileAnswerMessage | MobileErrorMessage | MobilePingMessage;

/** What a phone sends is the security boundary, so every field of it is read defensively. */
export function isMobileClientMessage(value: unknown): value is MobileClientMessage {
  if (!isRecord(value)) return false;
  if (value.kind === "pair") {
    return isCount(value.version)
      && (value.oldestComputer === undefined || isCount(value.oldestComputer))
      && isString(value.code, MAX_TOKEN_LENGTH)
      && isString(value.deviceName, MAX_DEVICE_NAME_LENGTH);
  }
  if (value.kind === "resume") {
    return isCount(value.version)
      && (value.oldestComputer === undefined || isCount(value.oldestComputer))
      && isString(value.token, MAX_TOKEN_LENGTH)
      && (value.sessionId === undefined || isString(value.sessionId))
      && isCount(value.lastSequence);
  }
  if (value.kind === "command") return isString(value.requestId) && isPhoneCommand(value.command);
  if (value.kind === "query") return isString(value.requestId) && isMobileQuery(value.query);
  if (value.kind === "pong" || value.kind === "ping") return isCount(value.at);
  if (value.kind === "push-token") return value.push === null || isPhonePush(value.push);
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
  | { op: "query"; query: MobileQuery }
);

export type MobileResponse = {
  type: "mobile.response";
  requestId: string;
} & ({ ok: true; result: unknown } | { ok: false; message: string });

export function isMobileRequest(value: unknown): value is MobileRequest {
  if (!isRecord(value)) return false;
  if (value.type !== "mobile.request" || !isString(value.requestId) || !isString(value.sessionId)) return false;
  if (value.op === "snapshot") return true;
  if (value.op === "command") return isPhoneCommand(value.command);
  if (value.op === "query") return isMobileQuery(value.query);
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
  /** Mints the code the QR carries. Minting a second one discards the first. */
  createMobilePairingCode(): Promise<MobilePairingOffer>;
  /** Forgets a phone's token, which drops its session with it. */
  revokeMobileDevice(deviceId: string): Promise<MobileServerState>;
  /** Asks Tailscale again whether it is installed, signed in and issuing certificates, and serves the bridge once it is. */
  refreshTailscale(): Promise<MobileServerState>;
  onMobileState(listener: (state: MobileServerState) => void): () => void;
  onMobileRequest(listener: (request: MobileRequest) => void): () => void;
  answerMobileRequest(response: MobileResponse): void;
  /** What every connected phone is shown, pushed as the window's own state moves. */
  publishMobileView(update: MobileViewUpdate): void;
};
