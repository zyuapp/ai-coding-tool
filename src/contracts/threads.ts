import type { AppCommand } from "./commands.js";
import type { BrowserShot, BrowserSnapshot, BrowserTab } from "../domain/browser.js";
import type { TerminalSession, TerminalSnapshot } from "../domain/terminal.js";
import type { TaskMessageKind } from "../domain/task.js";

/** Which threads a query covers: everything, one project, or the threads that belong to no project. */
export type ProjectScope =
  | { kind: "all" }
  | { kind: "project"; projectId: string }
  | { kind: "projectless" };

/** What a caller may narrow a listing by. `project` is resolved against the caller's own thread. */
export type ThreadListQuery = {
  project?: string;
  archived?: boolean;
  idleForMs?: number;
  search?: string;
  attachments?: boolean;
  limit?: number;
};

export type ThreadFilter = {
  scope: ProjectScope;
  /** Archived threads are excluded unless this asks for them. */
  archived?: boolean;
  /** Keeps only threads that have done nothing for at least this long. */
  idleForMs?: number;
  /** Case-insensitive match against the title and the message text. */
  search?: string;
  /** Keeps only threads where at least one message carries an image. */
  attachments?: boolean;
  limit?: number;
};

export type ThreadSummary = {
  id: string;
  title: string;
  projectId?: string;
  projectRoot?: string;
  /** The checkout the thread works in, when it works in one. Its id is what starts a thread there. */
  worktreeId?: string;
  worktreeRoot?: string;
  status: "idle" | "running" | "stopped";
  archived: boolean;
  createdAt: number;
  lastActivityAt: number;
  messageCount: number;
  /** How many of those messages carry images. */
  attachmentCount: number;
};

export type ThreadMessage = {
  kind: TaskMessageKind;
  text: string;
  at: number;
};

export type ThreadTranscript = {
  thread: ThreadSummary;
  /** The newest messages, oldest first. `omitted` counts the older ones the limit left out. */
  messages: ThreadMessage[];
  omitted: number;
};

/**
 * The commands anything outside the window may dispatch. Starting a thread (in the project checkout,
 * in a worktree of its own, or in one the project already has), continuing, archiving and stopping
 * one is allowed, as is driving the browser panel; moving the user around the app, changing how much
 * a thread is allowed to do, moving a thread between checkouts once it exists, removing projects,
 * clearing the browser session, and answering approvals — the browser's own included — are not.
 */
export type ExternalCommand = Extract<AppCommand, {
  type: "task.send" | "task.archive" | "run.cancel" | "browser.open" | "browser.close-tab" | "browser.select-tab" | "browser.go" | "browser.reload" | "browser.act";
}>;

/** A run drives the browser as the thread it is, so the channel names the thread, not the caller. */
type WithoutTask<T> = T extends unknown ? Omit<T, "taskId"> : never;
export type BrowserWrite = WithoutTask<Extract<ExternalCommand, { type: `browser.${string}` }>>;

/** What a caller may read about the browser panel. A snapshot waits for the tab to settle first. */
export type BrowserRead =
  | { op: "tabs" }
  | { op: "snapshot"; tabId?: string; textLimit?: number; timeoutMs: number }
  | { op: "screenshot"; tabId?: string; fullPage?: boolean; timeoutMs: number };

/** A snapshot of the tab, or the navigation the user has yet to answer instead. */
export type BrowserReadResult =
  | { kind: "tabs"; tabs: BrowserTab[] }
  | { kind: "snapshot"; snapshot: BrowserSnapshot }
  | { kind: "shot"; shot: BrowserShot }
  | { kind: "awaiting-approval"; url: string }
  | { kind: "no-tab" };

/**
 * What a caller may read about the terminal panel. There is no write to match it: the panel holds the
 * user's own shell, and a run that wants to run something has Bash of its own.
 */
export type TerminalRead =
  | { op: "terminals" }
  | { op: "snapshot"; terminalId?: string; lines?: number; match?: string };

export type TerminalReadResult =
  | { kind: "terminals"; terminals: TerminalSession[] }
  | { kind: "snapshot"; snapshot: TerminalSnapshot }
  | { kind: "no-terminal" };

/** Thread tool calls travel from the agent process to the window and back. */
export type ThreadRequest = {
  type: "thread.request";
  requestId: string;
  /** The thread the calling run belongs to, which is what "this project" resolves against. */
  taskId: string;
} & (
  | ({ op: "list" } & ThreadListQuery)
  | { op: "read"; threadId: string; limit?: number }
  | { op: "wait"; threadId: string; timeoutMs: number }
  | { op: "command"; command: ExternalCommand }
  | { op: "browser"; read: BrowserRead }
  | { op: "terminal"; read: TerminalRead }
  | { op: "notify"; report: FindingReport }
  | { op: "nothing-to-report"; checked: string }
);

/** What a scheduled run says it found. The window keeps it; the run only reports it. */
export type FindingReport = {
  headline: string;
  detail?: string;
  /** What the finding is about, stable across runs, so the same one is not raised twice. */
  key?: string;
};

/** What the window did with a run's report, in the words the tool answers with. */
export type FindingResult = {
  /** False when nothing was written: an unscheduled turn, or an issue the thread already knows. */
  recorded: boolean;
  note: string;
};

export type ThreadResponse = {
  type: "thread.response";
  requestId: string;
} & ({ ok: true; result: unknown } | { ok: false; message: string });

/** How a thread stood when the wait ended, and what it last said. */
export type ThreadWaitResult = {
  thread: ThreadSummary;
  /** True when the wait ran out with the thread still working. */
  timedOut: boolean;
  reply: string | null;
};

/** What a dispatched command did, so the caller can name the thread it just acted on. */
export type ThreadCommandResult = {
  thread: ThreadSummary | null;
};
