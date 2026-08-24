import type { AgentEffort, AgentModel, Continuation, ExecutionPolicy, Subagent } from "./run.js";
import { isWorktree, type Worktree } from "./worktree.js";

export const TASK_STORE_VERSION = 2 as const;

export type TaskMessageKind = "user" | "assistant" | "tool" | "system";

/** Where a drafted annotation's highlight lives: offsets into a message's rendered text. */
export type AnnotationAnchor = {
  messageId: string;
  start: number;
  end: number;
};

/** A piece of the assistant's output the user highlighted, with their note on it. */
export type Annotation = {
  id: string;
  quote: string;
  note: string;
  /** Only while drafted, and never on a reference handed to a side chat; sending drops it. */
  anchor?: AnnotationAnchor;
};

/** A block of text pasted into a composer, held aside as a pill instead of filling the prompt. */
export type PastedText = {
  id: string;
  text: string;
};

/** How many images one message may carry. */
export const MAX_ATTACHMENTS = 6;

/** How many files or folders one message may name. */
export const MAX_ATTACHED_FILES = 10;

/**
 * A file or folder the user dropped or pasted into a composer. The app never reads it: the message
 * names where it is, and the agent opens it from disk itself.
 */
export type AttachedFile = {
  id: string;
  path: string;
  name: string;
  /** Set when the path is a directory, so the chip and the prompt both say so. */
  folder?: true;
};

/** One before the composer gives it an id, which is what a drop and a paste both hand over. */
export type AttachedFileDraft = Omit<AttachedFile, "id">;

/** An image waiting in a composer, already written to the attachments directory. */
export type StagedImage = {
  id: string;
  path: string;
  /** What the image is of, such as the app whose window the desktop hotkey grabbed. */
  label: string;
  /** Where a dropped image came from. Two drops of the same file are one image; a paste has none. */
  source?: string;
};

export type TaskMessage = {
  id: string;
  kind: TaskMessageKind;
  text: string;
  detail?: string;
  /** A system message is a neutral notice unless it reports a failure. */
  tone?: "error";
  /** Absolute paths of images sent with this message. The agent reads them from disk; the timeline shows them inline. */
  attachments?: string[];
  /** Highlights of earlier output sent with this message. The agent gets them in the prompt; the timeline shows quote cards. */
  annotations?: Annotation[];
  /** Blocks pasted into the composer and sent with this message. The agent gets them in the prompt; the timeline shows pills. */
  pastes?: PastedText[];
  /** Files and folders named by this message. The agent opens them from disk; the timeline shows pills. */
  files?: AttachedFile[];
  /** Written by a tick that surfaced nothing. It stays in the thread and out of the thread's activity. */
  withdrawn?: true;
  at: number;
};

export type Project = {
  id: string;
  root: string;
  /** What the user chose to call the folder. Without one it goes by the folder's own name. */
  name?: string;
  workspaceId?: string;
  /** Sidebar position. Only the user moves it. */
  sortIndex?: number;
};

/**
 * Where a dragged task lands: a slot in a project's list, or in the project-less "recents" list.
 * `index` counts rows in that one list, so each list is its own.
 */
export type TaskDropTarget = {
  projectId: string | null;
  index: number;
};

export type RunAttachment = {
  path: string;
  /** Label per annotation, positional: index 0 is the box marked "1". Empty strings are unlabelled boxes. */
  labels: string[];
};

export type ChangeSnapshot = {
  files: string[];
  capturedAt: number;
};

export type ContinuationStatus = "none" | "available" | "invalid";

/** How the thread's newest settled run ended. Whether it is blocked on an approval lives in `activeRuns`. */
export type TaskOutcome = "finished" | "failed";

/**
 * Something a run said it found, on purpose. A verdict belongs to one run and is cleared by the next;
 * a finding outlives every run after it, so a tick at 3am is still there when the user wakes up.
 */
export type TaskFinding = {
  id: string;
  headline: string;
  detail?: string;
  /** What the finding is about, stable across runs, so the same one is not raised twice. */
  key?: string;
  at: number;
  read?: true;
};

/** How many findings a thread keeps. Past this the oldest is dropped. */
export const MAX_FINDINGS = 10;

/** Handled issues held per thread. Far more than a schedule reports at once, and still bounded. */
export const MAX_HANDLED_ISSUES = 50;
/** What one may carry: a line for the sidebar, a body for the thread, and a name to match it on. */
export const MAX_HEADLINE = 200;
export const MAX_DETAIL = 10_000;
export const MAX_FINDING_KEY = 200;

export function createTaskMessage(kind: TaskMessage["kind"], text: string, detail?: string, attachments?: string[], annotations?: Annotation[], pastes?: PastedText[], files?: AttachedFile[]): TaskMessage {
  return {
    id: crypto.randomUUID(),
    kind,
    text,
    ...(detail === undefined ? {} : { detail }),
    ...(attachments?.length ? { attachments } : {}),
    ...(annotations?.length ? { annotations } : {}),
    ...(pastes?.length ? { pastes } : {}),
    ...(files?.length ? { files } : {}),
    at: Date.now(),
  };
}

export function createFailureMessage(text: string): TaskMessage {
  return { ...createTaskMessage("system", text), tone: "error" };
}

const TITLE_LIMIT = 52;

/** One length for every thread title, whoever wrote it: the user, the first message, or the model. */
export function clampTitle(text: string) {
  const trimmed = text.trim();
  return trimmed.length > TITLE_LIMIT ? `${trimmed.slice(0, TITLE_LIMIT - 3)}…` : trimmed;
}

const FORK_SUFFIX = /\s*\((?:fork|fork \d+)\)$/;

/**
 * What a copy of a thread is called: the copied thread's own name, numbered past every name already
 * taken. The suffix is stripped before it is added again, so a copy of a copy never stacks them.
 */
export function forkTitle(title: string, taken: Iterable<string>): string {
  const base = title.replace(FORK_SUFFIX, "").trim() || title.trim();
  const names = new Set(taken);
  for (let number = 1; ; number += 1) {
    const suffix = number === 1 ? " (fork)" : ` (fork ${number})`;
    const room = TITLE_LIMIT - suffix.length;
    const candidate = `${base.length > room ? `${base.slice(0, room - 1)}…` : base}${suffix}`.trim();
    if (!names.has(candidate)) return candidate;
  }
}

/** How a folder names itself: its last path segment. */
export function folderName(root: string) {
  let end = root.length;
  while (end > 0 && root[end - 1] === "/") end -= 1;
  return end === 0 ? root : root.slice(root.lastIndexOf("/", end - 1) + 1, end);
}

/** What a project is called everywhere in the UI: the name the user gave it, else its folder's. */
export function projectName(project: Pick<Project, "name" | "root">) {
  return project.name ?? folderName(project.root);
}

/**
 * What the composer offers back on ↑: prompts the user sent themselves, oldest first. A user message
 * carries a detail only when an automation tick wrote it, so a labelled one was never typed.
 */
/** A message the composer can put back: what was typed, and what rode along with it. */
export type RecalledMessage = {
  text: string;
  annotations: Annotation[];
  pastes: PastedText[];
  files: AttachedFile[];
  /** Images this message carried, by where the app keeps them. */
  attachments: string[];
};

const sentPromptCache = new WeakMap<TaskMessage[], RecalledMessage[]>();

export function sentPrompts(messages: TaskMessage[]): RecalledMessage[] {
  const cached = sentPromptCache.get(messages);
  if (cached) return cached;
  const prompts: RecalledMessage[] = [];
  for (const message of messages) {
    if (message.kind === "user" && message.detail === undefined) {
      prompts.push({ text: message.text, annotations: message.annotations ?? [], pastes: message.pastes ?? [], files: message.files ?? [], attachments: message.attachments ?? [] });
    }
  }
  sentPromptCache.set(messages, prompts);
  return prompts;
}

export function threadCreatedAt(task: Task): number {
  return task.createdAt ?? task.messages[0]?.at ?? task.updatedAt;
}

/**
 * When the thread last did something. `updatedAt` moves on any write, so it cannot answer this.
 * A tick that surfaced nothing withdrew the messages it wrote and put `runEndedAt` back, so it counts
 * for nothing here: four such schedules must not reshuffle the list two hundred times a day.
 */
export function threadActivityAt(task: Task): number {
  return Math.max(threadCreatedAt(task), lastAudibleAt(task), task.runEndedAt ?? 0);
}

function lastAudibleAt(task: Task): number {
  for (let index = task.messages.length - 1; index >= 0; index -= 1) {
    const message = task.messages[index]!;
    if (!message.withdrawn) return message.at;
  }
  return 0;
}

export const ARCHIVE_RETENTION_MS = 5 * 24 * 60 * 60 * 1000;

/** Archiving keeps a task recoverable for {@link ARCHIVE_RETENTION_MS}; the next launch drops what outlived that. */
export function retainedTasks(tasks: Task[], at: number): Task[] {
  let retained: Task[] | null = null;
  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index]!;
    if (task.archivedAt !== undefined && at - task.archivedAt >= ARCHIVE_RETENTION_MS) {
      retained ??= tasks.slice(0, index);
    } else {
      retained?.push(task);
    }
  }
  return retained ?? tasks;
}

export type ContextUsage = {
  tokens: number;
  limit: number;
  model: string;
};

export type Task = {
  id: string;
  title: string;
  /** Set once the user names the thread themselves, so a suggested title never replaces it. */
  titleByUser?: boolean;
  projectId?: string;
  executionPolicy: ExecutionPolicy;
  model?: AgentModel;
  effort?: AgentEffort;
  contextUsage?: ContextUsage;
  messages: TaskMessage[];
  subagents?: Subagent[];
  continuation?: Continuation;
  continuationStatus: ContinuationStatus;
  lastChangeSnapshot: ChangeSnapshot;
  /** Sidebar position. Only the user moves it; run activity never does. */
  sortIndex?: number;
  /** The verdict of the newest settled run, until a dismissal or the next run supersedes it. */
  outcome?: TaskOutcome;
  /** Set while the user has yet to see that verdict. It marks the thread, the verdict ranks it. */
  outcomeUnread?: true;
  /** What runs on this thread found, newest last. Cleared by a dismissal, never by the next run. */
  findings?: TaskFinding[];
  /**
   * Keys of findings the user has filed away. A dismissal means the issue is handled, so the same one
   * is held back while the runs keep reporting it, and only surfaces again once a run stops finding it.
   */
  handledIssues?: string[];
  /** When a run on this thread last found something. A dismissal files the findings away, not this. */
  lastFindingAt?: number;
  /** What the last scheduled run to say it found nothing looked at, which is a silent schedule's proof of life. */
  lastChecked?: { at: number; note: string };
  /** When this task's newest run settled. A turn the run left unfinished ends there. */
  runEndedAt?: number;
  /**
   * The checkout this thread's runs happen in, named by id because other threads may work in the
   * same one. Absent while the thread runs in the project itself.
   */
  worktreeId?: string;
  /**
   * When this thread's session forked into that checkout, set by its own first run there. Threads
   * sharing a checkout fork independently, so a thread that has yet to run in one has no fork.
   */
  worktreeEnteredAt?: number;
  /**
   * Set on a thread copied from another, which inherits that thread's session. Its runs fork that
   * session instead of continuing it until one reports a session of its own, which clears this, so
   * a run that dies before it names a session never leaves the two threads writing to one.
   */
  inheritedContinuation?: true;
  /** Absent on tasks written before threads were timestamped; {@link threadCreatedAt} fills those in. */
  createdAt?: number;
  updatedAt: number;
  archivedAt?: number;
};

export type TaskStoreData = {
  version: typeof TASK_STORE_VERSION;
  tasks: Task[];
  projects: Project[];
  worktrees: Worktree[];
  lastFolder: string | null;
};

export type StorageValues = {
  tasks: string | null;
  projects: string | null;
  /** Absent in everything written before a checkout could hold more than one thread. */
  worktrees: string | null;
  lastFolder: string | null;
};

export type TaskStoreParseResult =
  | {
      ok: true;
      data: TaskStoreData;
      sourceVersion: 0 | 1 | 2;
      preservedV1: StorageValues | null;
    }
  | {
      ok: false;
      canWrite: false;
      sourceVersion: 0 | 1 | 2;
      errorKind: "corrupt" | "storage";
      errors: string[];
      preservedV1: StorageValues | null;
      raw: StorageValues;
    };

const LEGACY_MODES = {
  default: "confirm",
  plan: "plan",
  acceptEdits: "allow-edits",
  auto: "autonomous",
} as const satisfies Record<string, ExecutionPolicy>;

type LegacyMode = keyof typeof LEGACY_MODES;

type VersionedValue<T> = {
  version: typeof TASK_STORE_VERSION;
  value: T;
};

type DecodedTaskStore = {
  tasks: unknown;
  projects: unknown;
  worktrees: unknown;
  lastFolder: unknown;
};

type TaskStoreValidationResult =
  | { ok: true; data: TaskStoreData }
  | { ok: false; errors: string[] };

export type SerializedTaskStore = StorageValues;

export function legacyProjectId(root: string) {
  return `legacy-project-${encodeURIComponent(normalizeRoot(root))}`;
}

/**
 * A project as something outside the app may name it: its folder name, its path, or its id.
 * An id is never asked for, so a reference that matches nothing answers with what is open.
 */
export function findProject(projects: Project[], reference: string): { project: Project } | { error: string } {
  const wanted = reference.trim();
  const exact = projects.find((project) => project.id === wanted || sameRoot(project.root, wanted));
  if (exact) return { project: exact };
  /** Either name finds it: the one the user gave it, and the folder's own, which outside callers still know. */
  const named = projects.filter((project) => [projectName(project), folderName(project.root)].some((label) => label.toLowerCase() === wanted.toLowerCase()));
  if (named.length === 1) return { project: named[0] };
  const open = projects.map((project) => `${projectName(project)} (${project.root})`).join(", ") || "none";
  if (named.length > 1) return { error: `More than one open project is named "${reference}": ${named.map((project) => project.root).join(", ")}. Name the folder path instead.` };
  return { error: `No project matches "${reference}". Open projects: ${open}.` };
}

export function parseTaskStore(raw: StorageValues): TaskStoreParseResult {
  if (isEmpty(raw)) {
    return {
      ok: true,
      data: { version: TASK_STORE_VERSION, tasks: [], projects: [], worktrees: [], lastFolder: null },
      sourceVersion: 0,
      preservedV1: null,
    };
  }
  const decoded = decodeV2(raw);
  if (decoded.kind === "v2") {
    const validated = validateTaskStoreData(decoded.values);
    return validated.ok
      ? { ...validated, sourceVersion: 2, preservedV1: null }
      : corrupt(2, validated.errors, raw);
  }
  if (decoded.kind === "corrupt") {
    return {
      ok: false,
      canWrite: false,
      sourceVersion: 2,
      errorKind: "corrupt",
      errors: decoded.errors,
      preservedV1: null,
      raw,
    };
  }
  return migrateV1ToV2(raw);
}

export function migrateV1ToV2(raw: StorageValues): TaskStoreParseResult {
  const errors: string[] = [];
  const tasksValue = parseJson(raw.tasks, "tasks", errors);
  const projectsValue = parseJson(raw.projects, "projects", errors);
  const lastFolder = parseLegacyLastFolder(raw.lastFolder, errors);
  if (errors.length) return corrupt(1, errors, raw);

  if (tasksValue !== null && !Array.isArray(tasksValue)) errors.push("tasks must be an array");
  if (projectsValue !== null && !Array.isArray(projectsValue)) errors.push("projects must be an array");
  if (errors.length) return corrupt(1, errors, raw);

  const legacyProjectsValue = Array.isArray(projectsValue) ? projectsValue : [];
  const legacyProjects = legacyProjectsValue.filter((value): value is string => typeof value === "string" && value.length > 0);
  if (legacyProjectsValue.some((value) => typeof value !== "string")) errors.push("projects must contain only strings");
  if (errors.length) return corrupt(1, errors, raw);
  const legacyTasks = Array.isArray(tasksValue) ? tasksValue : [];
  const roots = new Set(legacyProjects.map(normalizeRoot));
  for (const value of legacyTasks) {
    if (!isRecord(value)) {
      errors.push("tasks contains a non-object value");
      continue;
    }
    if (typeof value.folder === "string" && value.folder) roots.add(normalizeRoot(value.folder));
  }

  const projects = [...roots].map((root) => ({ id: legacyProjectId(root), root }));
  const projectByRoot = new Map(projects.map((project) => [project.root, project.id]));
  const tasks: Task[] = [];
  for (const [index, value] of legacyTasks.entries()) {
    const task = migrateLegacyTask(value, index, projectByRoot, errors);
    if (task) tasks.push(task);
  }
  if (errors.length) return corrupt(1, errors, raw);

  return {
    ok: true,
    data: { version: TASK_STORE_VERSION, tasks, projects, worktrees: [], lastFolder },
    sourceVersion: 1,
    preservedV1: raw,
  };
}

export function serializeTaskStore(data: TaskStoreData): SerializedTaskStore {
  return {
    tasks: JSON.stringify(versioned(data.tasks)),
    projects: JSON.stringify(versioned(data.projects)),
    worktrees: JSON.stringify(versioned(data.worktrees)),
    lastFolder: JSON.stringify(versioned(data.lastFolder)),
  };
}

function migrateLegacyTask(
  value: unknown,
  index: number,
  projectByRoot: Map<string, string>,
  errors: string[],
): Task | null {
  if (!isRecord(value)) {
    errors.push(`tasks[${index}] must be an object`);
    return null;
  }
  if (typeof value.id !== "string" || !value.id) errors.push(`tasks[${index}].id must be a non-empty string`);
  if (typeof value.title !== "string") errors.push(`tasks[${index}].title must be a string`);
  if (typeof value.folder !== "string") errors.push(`tasks[${index}].folder must be a string`);
  if (!isLegacyMode(value.mode)) errors.push(`tasks[${index}].mode is invalid`);
  if (!Array.isArray(value.messages)) errors.push(`tasks[${index}].messages must be an array`);
  if (!Array.isArray(value.changedFiles) || value.changedFiles.some((file) => typeof file !== "string")) {
    errors.push(`tasks[${index}].changedFiles must be an array of strings`);
  }
  if (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) errors.push(`tasks[${index}].updatedAt must be a number`);
  const messages = migrateMessages(value.messages, index, errors);
  if (
    typeof value.id !== "string" || !value.id ||
    typeof value.title !== "string" ||
    typeof value.folder !== "string" ||
    !isLegacyMode(value.mode) ||
    !Array.isArray(value.changedFiles) ||
    typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt) ||
    !messages
  ) return null;

  const continuationStatus = continuationStatusFor(value.sessionId);
  const continuation = continuationStatus === "available" ? toContinuation(value.sessionId) : undefined;
  return {
    id: value.id,
    title: value.title,
    ...(value.folder ? { projectId: projectByRoot.get(normalizeRoot(value.folder)) ?? legacyProjectId(value.folder) } : {}),
    executionPolicy: LEGACY_MODES[value.mode],
    messages,
    ...(continuation ? { continuation } : {}),
    continuationStatus,
    lastChangeSnapshot: { files: value.changedFiles, capturedAt: value.updatedAt },
    updatedAt: value.updatedAt,
  };
}

function migrateMessages(value: unknown, taskIndex: number, errors: string[]) {
  if (!Array.isArray(value)) return null;
  const messages: TaskMessage[] = [];
  for (const [index, message] of value.entries()) {
    if (!isRecord(message) || typeof message.id !== "string" || typeof message.kind !== "string" || !isMessageKind(message.kind) || typeof message.text !== "string" || typeof message.at !== "number" || !Number.isFinite(message.at) || (message.detail !== undefined && typeof message.detail !== "string")) {
      errors.push(`tasks[${taskIndex}].messages[${index}] is invalid`);
      continue;
    }
    messages.push({ id: message.id, kind: message.kind, text: message.text, ...(message.detail === undefined ? {} : { detail: message.detail }), at: message.at });
  }
  return messages;
}

function decodeV2(raw: StorageValues):
  | { kind: "none" }
  | { kind: "v2"; values: DecodedTaskStore }
  | { kind: "corrupt"; errors: string[] } {
  if (isEmpty(raw)) return { kind: "none" };
  const errors: string[] = [];
  const tasks = parseJson(raw.tasks, "tasks", errors);
  const projects = parseJson(raw.projects, "projects", errors);
  const worktrees = parseJson(raw.worktrees, "worktrees", errors);
  const lastFolder = parseJson(raw.lastFolder, "lastFolder", errors);
  const hasV2Marker = [tasks, projects, lastFolder].some((value) => isRecord(value) && value.version === TASK_STORE_VERSION);
  if (!hasV2Marker) return { kind: "none" };
  if (errors.length) return { kind: "corrupt", errors };
  if (![tasks, projects, lastFolder].every((value) => isRecord(value) && value.version === TASK_STORE_VERSION && "value" in value)) {
    return { kind: "corrupt", errors: ["version 2 storage must contain all three versioned values"] };
  }
  /** Storage written before checkouts had records of their own has none; the tasks still carry them. */
  if (worktrees !== null && !(isRecord(worktrees) && worktrees.version === TASK_STORE_VERSION && "value" in worktrees)) {
    return { kind: "corrupt", errors: ["version 2 worktrees is not a versioned value"] };
  }
  return {
    kind: "v2",
    values: {
      tasks: (tasks as { value: unknown }).value,
      projects: (projects as { value: unknown }).value,
      worktrees: worktrees === null ? null : (worktrees as { value: unknown }).value,
      lastFolder: (lastFolder as { value: unknown }).value,
    },
  };
}

/** Validates v2 values that have already been decoded from their storage transport. */
export function validateTaskStoreData(values: DecodedTaskStore): TaskStoreValidationResult {
  const errors: string[] = [];
  if (!Array.isArray(values.tasks)) errors.push("v2 tasks must be an array");
  if (!Array.isArray(values.projects)) errors.push("v2 projects must be an array");
  if (values.worktrees !== null && !Array.isArray(values.worktrees)) errors.push("v2 worktrees must be an array");
  if (values.lastFolder !== null && typeof values.lastFolder !== "string") errors.push("v2 lastFolder must be a string or null");
  const projects = Array.isArray(values.projects) ? values.projects.filter(isProject) : [];
  const stored = Array.isArray(values.worktrees) ? values.worktrees.filter(isWorktree) : [];
  if (Array.isArray(values.worktrees) && stored.length !== values.worktrees.length) errors.push("v2 worktrees contains an invalid value");
  const lifted: Worktree[] = [];
  const tasks = Array.isArray(values.tasks) ? values.tasks.map((value) => sanitizeV2Task(value, errors, lifted)).filter((task): task is Task => task !== null) : [];
  if (Array.isArray(values.projects) && projects.length !== values.projects.length) errors.push("v2 projects contains an invalid value");
  const projectIds = new Set(projects.map((project) => project.id));
  for (const task of tasks) {
    if (task.projectId && !projectIds.has(task.projectId)) errors.push(`v2 task ${task.id} references an unknown project`);
  }
  if (errors.length) return { ok: false, errors };
  const worktreesById = new Map<string, Worktree>();
  for (const worktree of stored) {
    if (!worktreesById.has(worktree.id)) worktreesById.set(worktree.id, worktree);
  }
  for (const worktree of lifted) {
    if (!worktreesById.has(worktree.id)) worktreesById.set(worktree.id, worktree);
  }
  const worktrees = [...worktreesById.values()].filter((worktree) => projectIds.has(worktree.projectId));
  const worktreeIds = new Set(worktrees.map((worktree) => worktree.id));
  return {
    ok: true,
    data: { version: TASK_STORE_VERSION, tasks: tasks.map((task) => claiming(task, worktreeIds)), projects, worktrees, lastFolder: values.lastFolder as string | null },
  };
}

/**
 * A reference to a checkout that is not there is dropped rather than refusing the whole store: a
 * reconcile removes a checkout the moment nothing claims it, and a crash in that window would
 * otherwise leave the user unable to write anything at all.
 */
function claiming(task: Task, worktreeIds: Set<string>): Task {
  if (!task.worktreeId || worktreeIds.has(task.worktreeId)) return task;
  const { worktreeId: _gone, worktreeEnteredAt: _forked, ...local } = task;
  return local;
}

/**
 * Tasks written while a checkout belonged to exactly one thread carry it inside themselves. Lifting
 * one out gives it a record of its own; the fork the thread had already made stays with the thread.
 * A checkout on a thread with no project has nowhere to be listed, so it is left to be reaped.
 */
function liftEmbeddedWorktree(value: Record<string, any>, lifted: Worktree[]) {
  if (!isRecord(value.worktree)) return value;
  const { worktree, ...task } = value;
  const { enteredAt, ...record } = worktree;
  const candidate = { ...record, projectId: task.projectId };
  if (!isWorktree(candidate)) return task;
  lifted.push(candidate);
  return { ...task, worktreeId: candidate.id, ...(finiteNumber(enteredAt) ? { worktreeEnteredAt: enteredAt } : {}) };
}

function parseJson(value: string | null, label: string, errors: string[]): unknown | null {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    errors.push(`${label} is not valid JSON`);
    return null;
  }
}

function parseLegacyLastFolder(value: string | null, errors: string[]) {
  if (value === null || typeof value === "string") return value;
  errors.push("lastFolder must be a string or null");
  return null;
}

function corrupt(sourceVersion: 1 | 2, errors: string[], raw: StorageValues): TaskStoreParseResult {
  return { ok: false, canWrite: false, sourceVersion, errorKind: "corrupt", errors, preservedV1: sourceVersion === 1 ? raw : null, raw };
}

function versioned<T>(value: T): VersionedValue<T> {
  return { version: TASK_STORE_VERSION, value };
}

function continuationStatusFor(value: unknown): ContinuationStatus {
  if (value === undefined) return "none";
  return typeof value === "string" && value.trim() ? "available" : "invalid";
}

function toContinuation(value: unknown): Continuation {
  return { provider: "claude", value: String(value) };
}

function isLegacyMode(value: unknown): value is LegacyMode {
  return typeof value === "string" && value in LEGACY_MODES;
}

function isMessageKind(value: string): value is TaskMessageKind {
  return value === "user" || value === "assistant" || value === "tool" || value === "system";
}

export function isProject(value: unknown): value is Project {
  return isRecord(value) && nonEmptyString(value.id) && nonEmptyString(value.root) && (value.name === undefined || nonEmptyString(value.name)) && (value.workspaceId === undefined || nonEmptyString(value.workspaceId)) && (value.sortIndex === undefined || finiteNumber(value.sortIndex));
}

function isTaskBase(value: unknown): value is Task {
  return isRecord(value) &&
    nonEmptyString(value.id) &&
    nonEmptyString(value.title) &&
    (value.titleByUser === undefined || typeof value.titleByUser === "boolean") &&
    (value.projectId === undefined || nonEmptyString(value.projectId)) &&
    isExecutionPolicy(value.executionPolicy) &&
    (value.model === undefined || isAgentModel(value.model)) &&
    (value.effort === undefined || isAgentEffort(value.effort)) &&
    (value.contextUsage === undefined || isContextUsage(value.contextUsage)) &&
    Array.isArray(value.messages) &&
    value.messages.every(isTaskMessage) &&
    (value.subagents === undefined || Array.isArray(value.subagents) && value.subagents.every(isSubagent)) &&
    isRecord(value.lastChangeSnapshot) && Array.isArray(value.lastChangeSnapshot.files) && value.lastChangeSnapshot.files.every((file) => typeof file === "string") && finiteNumber(value.lastChangeSnapshot.capturedAt) &&
    (value.sortIndex === undefined || finiteNumber(value.sortIndex)) &&
    (value.outcome === undefined || isTaskOutcome(value.outcome)) &&
    (value.outcomeUnread === undefined || value.outcomeUnread === true) &&
    (value.findings === undefined || Array.isArray(value.findings) && value.findings.every(isTaskFinding)) &&
    (value.lastFindingAt === undefined || finiteNumber(value.lastFindingAt)) &&
    (value.handledIssues === undefined || Array.isArray(value.handledIssues) && value.handledIssues.every((key: unknown) => nonEmptyString(key))) &&
    (value.lastChecked === undefined || (isRecord(value.lastChecked) && finiteNumber(value.lastChecked.at) && nonEmptyString(value.lastChecked.note))) &&
    (value.worktreeId === undefined || nonEmptyString(value.worktreeId)) &&
    (value.worktreeEnteredAt === undefined || finiteNumber(value.worktreeEnteredAt)) &&
    (value.inheritedContinuation === undefined || value.inheritedContinuation === true) &&
    (value.runEndedAt === undefined || finiteNumber(value.runEndedAt)) &&
    (value.createdAt === undefined || finiteNumber(value.createdAt)) &&
    finiteNumber(value.updatedAt) &&
    (value.archivedAt === undefined || finiteNumber(value.archivedAt));
}

function isTaskFinding(value: unknown): value is TaskFinding {
  return isRecord(value) &&
    nonEmptyString(value.id) &&
    nonEmptyString(value.headline) &&
    (value.detail === undefined || typeof value.detail === "string") &&
    (value.key === undefined || nonEmptyString(value.key)) &&
    finiteNumber(value.at) &&
    (value.read === undefined || value.read === true);
}

function isTaskOutcome(value: unknown): value is TaskOutcome {
  return value === "finished" || value === "failed";
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * Tasks written before the picker dropped "default" and the context window; both fall back to the
 * current defaults. The attention dot they may also carry is ephemeral, so it is retired unread.
 */
function dropRetiredSettings(value: unknown) {
  if (!isRecord(value)) return value;
  if (value.contextWindow === undefined && value.attention === undefined && value.attentionRead === undefined && value.model !== "default") return value;
  const { contextWindow: _retired, attention: _dot, attentionRead: _read, ...task } = value;
  if (task.model === "default") delete task.model;
  return task;
}

/**
 * Tasks written while a withdrawn message was called `quiet` and a handled issue a `silencedKeys` entry.
 * Whatever the task already carries under the current name wins.
 */
function renamedFields(value: unknown) {
  if (!isRecord(value)) return value;
  let task = value;
  if (value.silencedKeys !== undefined) {
    const { silencedKeys: handled, ...renamed } = value;
    if (renamed.handledIssues === undefined) renamed.handledIssues = handled;
    task = renamed;
  }
  if (Array.isArray(task.messages)) {
    let messages: unknown[] | null = null;
    for (let index = 0; index < task.messages.length; index += 1) {
      const message = task.messages[index];
      const renamed = renamedMessageFields(message);
      if (renamed !== message) messages ??= task.messages.slice(0, index);
      messages?.push(renamed);
    }
    if (messages) task = { ...task, messages };
  }
  return task;
}

function renamedMessageFields(value: unknown) {
  if (!isRecord(value) || value.quiet === undefined) return value;
  const { quiet: withdrawn, ...message } = value;
  return message.withdrawn === undefined ? { ...message, withdrawn } : message;
}

function sanitizeV2Task(raw: unknown, errors: string[], lifted: Worktree[]): Task | null {
  const retired = renamedFields(dropRetiredSettings(raw));
  const value = isRecord(retired) ? liftEmbeddedWorktree(retired, lifted) : retired;
  if (!isTaskBase(value)) {
    errors.push("v2 tasks contains an invalid value");
    return null;
  }

  const continuation = value.continuation;
  if (continuation !== undefined && !isContinuation(continuation)) {
    const { continuation: _discarded, ...withoutContinuation } = value;
    return { ...withoutContinuation, continuationStatus: "invalid" };
  }
  if (continuation && value.continuationStatus !== "available") {
    errors.push(`v2 task ${value.id} has an inconsistent continuation status`);
    return null;
  }
  if (!continuation && value.continuationStatus !== "none" && value.continuationStatus !== "invalid") {
    errors.push(`v2 task ${value.id} has an inconsistent continuation status`);
    return null;
  }
  return value;
}

function isTaskMessage(value: unknown): value is TaskMessage {
  return isRecord(value) &&
    nonEmptyString(value.id) &&
    typeof value.kind === "string" && isMessageKind(value.kind) &&
    typeof value.text === "string" &&
    (value.detail === undefined || typeof value.detail === "string") &&
    (value.tone === undefined || value.tone === "error") &&
    (value.attachments === undefined || (Array.isArray(value.attachments) && value.attachments.every(nonEmptyString))) &&
    (value.annotations === undefined || (Array.isArray(value.annotations) && value.annotations.every(isAnnotation))) &&
    (value.pastes === undefined || (Array.isArray(value.pastes) && value.pastes.every(isPastedText))) &&
    (value.files === undefined || (Array.isArray(value.files) && value.files.every(isAttachedFile))) &&
    (value.withdrawn === undefined || value.withdrawn === true) &&
    finiteNumber(value.at);
}

function isAnnotation(value: unknown): value is Annotation {
  return isRecord(value) && nonEmptyString(value.id) && nonEmptyString(value.quote) && typeof value.note === "string";
}

function isPastedText(value: unknown): value is PastedText {
  return isRecord(value) && nonEmptyString(value.id) && typeof value.text === "string";
}

function isAttachedFile(value: unknown): value is AttachedFile {
  return isRecord(value) && nonEmptyString(value.id) && nonEmptyString(value.path) && nonEmptyString(value.name)
    && (value.folder === undefined || value.folder === true);
}

function isContinuation(value: unknown): value is Continuation {
  return isRecord(value) && nonEmptyString(value.provider) && nonEmptyString(value.value);
}

function isExecutionPolicy(value: unknown): value is ExecutionPolicy {
  return value === "confirm" || value === "plan" || value === "allow-edits" || value === "autonomous";
}

function isAgentModel(value: unknown): value is AgentModel {
  return value === "fable" || value === "opus" || value === "sonnet" || value === "haiku";
}

function isAgentEffort(value: unknown): value is AgentEffort {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}

function isContextUsage(value: unknown): value is ContextUsage {
  return isRecord(value) && finiteNumber(value.tokens) && value.tokens >= 0 && finiteNumber(value.limit) && value.limit > 0 && nonEmptyString(value.model);
}

function isSubagent(value: unknown): value is Subagent {
  return isRecord(value) &&
    nonEmptyString(value.id) &&
    typeof value.description === "string" &&
    (value.agentType === undefined || typeof value.agentType === "string") &&
    (value.status === "working" || value.status === "completed" || value.status === "failed" || value.status === "stopped") &&
    (value.lastToolName === undefined || typeof value.lastToolName === "string") &&
    (value.summary === undefined || typeof value.summary === "string") &&
    (value.totalTokens === undefined || finiteNumber(value.totalTokens) && value.totalTokens >= 0) &&
    finiteNumber(value.startedAt) &&
    (value.finishedAt === undefined || finiteNumber(value.finishedAt)) &&
    Array.isArray(value.activity) &&
    value.activity.every((item) => isRecord(item) && nonEmptyString(item.id) && (item.kind === "text" || item.kind === "tool") && (item.title === undefined || typeof item.title === "string") && typeof item.text === "string" && finiteNumber(item.at));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Storage written before checkouts had records of their own carries no worktrees value at all. */
function isEmpty(raw: StorageValues) {
  return raw.tasks === null && raw.projects === null && (raw.worktrees ?? null) === null && raw.lastFolder === null;
}

/** Whether two paths name the same folder, whatever trailing separators they were written with. */
export function sameRoot(left: string, right: string) {
  return normalizeRoot(left) === normalizeRoot(right);
}

function normalizeRoot(root: string) {
  const normalized = root.replace(/[\\/]+$/, "");
  return normalized || root;
}
