import type { AppCommand } from "./commands.js";
import type { TaskMessageKind } from "../domain/task.js";

/** Which threads a query covers: everything, one project, or the threads that belong to no project. */
export type ProjectScope =
  | { kind: "all" }
  | { kind: "project"; projectId: string }
  | { kind: "projectless" };

export type ThreadFilter = {
  scope: ProjectScope;
  /** Archived threads are excluded unless this asks for them. */
  archived?: boolean;
  /** Keeps only threads that have done nothing for at least this long. */
  idleForMs?: number;
  /** Case-insensitive match against the title and the message text. */
  search?: string;
  limit?: number;
};

export type ThreadSummary = {
  id: string;
  title: string;
  projectId?: string;
  projectRoot?: string;
  status: "idle" | "running" | "stopped";
  archived: boolean;
  createdAt: number;
  lastActivityAt: number;
  messageCount: number;
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
 * The commands anything outside the window may dispatch. Reading and writing a thread is allowed;
 * moving the user around the app, removing projects, and answering approvals are not.
 */
export type ExternalCommand = Extract<
  AppCommand,
  { type: "task.send" | "task.archive" | "task.restore" | "task.rename" | "task.set-policy" | "task.set-model" | "task.set-effort" | "run.cancel" }
>;

/** Thread tool calls travel from the agent process to the window and back. */
export type ThreadRequest = {
  type: "thread.request";
  requestId: string;
  /** The thread the calling run belongs to, which is what "this project" resolves against. */
  taskId: string;
} & (
  | { op: "list"; project?: string; archived?: boolean; idleForMs?: number; search?: string; limit?: number }
  | { op: "read"; threadId: string; limit?: number }
  | { op: "command"; command: ExternalCommand }
);

export type ThreadResponse = {
  type: "thread.response";
  requestId: string;
} & ({ ok: true; result: unknown } | { ok: false; message: string });

/** What a dispatched command did, so the caller can name the thread it just acted on. */
export type ThreadCommandResult = {
  thread: ThreadSummary | null;
};
