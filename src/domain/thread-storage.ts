import { engineHasEffort, engineHasModel, isAgentEffort, isAgentEngine, isAgentModel, type AgentEngine, type AgentModel } from "./agent-engine.js";
import type { Annotation, AttachedFile, ConversationMessage, ConversationMessageKind, PastedText } from "./conversation.js";
import type { AutomationFinding } from "./finding.js";
import { isProject, legacyProjectId, normalizeProjectRoot, type Project } from "./project.js";
import type { AgentEffort, Continuation, ExecutionPolicy, Subagent } from "./run.js";
import type { ContextUsage, ContinuationStatus, ThreadOutcome } from "./thread-run.js";
import type { Thread } from "./thread.js";
import { isWorktree, type Worktree } from "./worktree.js";

export const THREAD_STORE_VERSION = 2 as const;

/** Every thread written before the engine was recorded ran on Claude. */
const UNRECORDED_ENGINE: AgentEngine = "claude";

/**
 * A thread as the store holds it. The helper agents it delegated to are saved beside it and travel
 * with it on the way in; the workspace lifts them into a feed of their own once it has them.
 */
export type StoredThread = Thread & { subagents?: Subagent[] };

export type ThreadStoreData = {
  version: typeof THREAD_STORE_VERSION;
  tasks: StoredThread[];
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

export type ThreadStoreParseResult =
  | {
      ok: true;
      data: ThreadStoreData;
      /** Threads this build cannot read, which stay on disk untouched. */
      hiddenTasks: number;
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
  version: typeof THREAD_STORE_VERSION;
  value: T;
};

type DecodedThreadStore = {
  tasks: unknown;
  projects: unknown;
  worktrees: unknown;
  lastFolder: unknown;
};

type ThreadStoreValidationResult =
  | { ok: true; data: ThreadStoreData; hiddenTasks: number }
  | { ok: false; errors: string[] };

export type SerializedThreadStore = StorageValues;

export function parseThreadStore(raw: StorageValues): ThreadStoreParseResult {
  if (isEmpty(raw)) {
    return {
      ok: true,
      data: { version: THREAD_STORE_VERSION, tasks: [], projects: [], worktrees: [], lastFolder: null },
      hiddenTasks: 0,
      sourceVersion: 0,
      preservedV1: null,
    };
  }
  const decoded = decodeV2(raw);
  if (decoded.kind === "v2") {
    const validated = validateThreadStoreData(decoded.values);
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

export function migrateV1ToV2(raw: StorageValues): ThreadStoreParseResult {
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
  const roots = new Set(legacyProjects.map(normalizeProjectRoot));
  for (const value of legacyTasks) {
    if (!isRecord(value)) {
      errors.push("tasks contains a non-object value");
      continue;
    }
    if (typeof value.folder === "string" && value.folder) roots.add(normalizeProjectRoot(value.folder));
  }

  const projects = [...roots].map((root) => ({ id: legacyProjectId(root), root }));
  const projectByRoot = new Map(projects.map((project) => [project.root, project.id]));
  const tasks: Thread[] = [];
  for (const [index, value] of legacyTasks.entries()) {
    const task = migrateLegacyThread(value, index, projectByRoot, errors);
    if (task) tasks.push(task);
  }
  if (errors.length) return corrupt(1, errors, raw);

  return {
    ok: true,
    data: { version: THREAD_STORE_VERSION, tasks, projects, worktrees: [], lastFolder },
    hiddenTasks: 0,
    sourceVersion: 1,
    preservedV1: raw,
  };
}

export function serializeThreadStore(data: ThreadStoreData): SerializedThreadStore {
  return {
    tasks: JSON.stringify(versioned(data.tasks)),
    projects: JSON.stringify(versioned(data.projects)),
    worktrees: JSON.stringify(versioned(data.worktrees)),
    lastFolder: JSON.stringify(versioned(data.lastFolder)),
  };
}

function migrateLegacyThread(
  value: unknown,
  index: number,
  projectByRoot: Map<string, string>,
  errors: string[],
): Thread | null {
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
  const continuation = continuationStatus === "available" ? toContinuation(UNRECORDED_ENGINE, value.sessionId) : undefined;
  return {
    id: value.id,
    title: value.title,
    ...(value.folder ? { projectId: projectByRoot.get(normalizeProjectRoot(value.folder)) ?? legacyProjectId(value.folder) } : {}),
    executionPolicy: LEGACY_MODES[value.mode],
    engine: UNRECORDED_ENGINE,
    messages,
    ...(continuation ? { continuation } : {}),
    continuationStatus,
    lastChangeSnapshot: { files: value.changedFiles, capturedAt: value.updatedAt },
    updatedAt: value.updatedAt,
  };
}

function migrateMessages(value: unknown, taskIndex: number, errors: string[]) {
  if (!Array.isArray(value)) return null;
  const messages: ConversationMessage[] = [];
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
  | { kind: "v2"; values: DecodedThreadStore }
  | { kind: "corrupt"; errors: string[] } {
  if (isEmpty(raw)) return { kind: "none" };
  const errors: string[] = [];
  const tasks = parseJson(raw.tasks, "tasks", errors);
  const projects = parseJson(raw.projects, "projects", errors);
  const worktrees = parseJson(raw.worktrees, "worktrees", errors);
  const lastFolder = parseJson(raw.lastFolder, "lastFolder", errors);
  const hasV2Marker = [tasks, projects, lastFolder].some((value) => isRecord(value) && value.version === THREAD_STORE_VERSION);
  if (!hasV2Marker) return { kind: "none" };
  if (errors.length) return { kind: "corrupt", errors };
  if (![tasks, projects, lastFolder].every((value) => isRecord(value) && value.version === THREAD_STORE_VERSION && "value" in value)) {
    return { kind: "corrupt", errors: ["version 2 storage must contain all three versioned values"] };
  }
  /** Storage written before checkouts had records of their own has none; the tasks still carry them. */
  if (worktrees !== null && !(isRecord(worktrees) && worktrees.version === THREAD_STORE_VERSION && "value" in worktrees)) {
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

/**
 * Validates v2 values that have already been decoded from their storage transport. A thread this
 * build cannot read is counted and left out rather than failing the store: its record stays on disk
 * for the build that wrote it, and the threads around it still open.
 */
export function validateThreadStoreData(values: DecodedThreadStore): ThreadStoreValidationResult {
  const errors: string[] = [];
  let hiddenTasks = 0;
  if (!Array.isArray(values.tasks)) errors.push("v2 tasks must be an array");
  if (!Array.isArray(values.projects)) errors.push("v2 projects must be an array");
  if (values.worktrees !== null && !Array.isArray(values.worktrees)) errors.push("v2 worktrees must be an array");
  if (values.lastFolder !== null && typeof values.lastFolder !== "string") errors.push("v2 lastFolder must be a string or null");
  const projects = Array.isArray(values.projects) ? values.projects.filter(isProject) : [];
  const stored = Array.isArray(values.worktrees) ? values.worktrees.filter(isWorktree) : [];
  if (Array.isArray(values.worktrees) && stored.length !== values.worktrees.length) errors.push("v2 worktrees contains an invalid value");
  const lifted: Worktree[] = [];
  const readable = Array.isArray(values.tasks) ? values.tasks.map((value) => sanitizeV2Thread(value, lifted)) : [];
  const tasks = readable.filter((task): task is StoredThread => task !== null);
  hiddenTasks += readable.length - tasks.length;
  if (Array.isArray(values.projects) && projects.length !== values.projects.length) errors.push("v2 projects contains an invalid value");
  const projectIds = new Set(projects.map((project) => project.id));
  const placed = tasks.filter((task) => !task.projectId || projectIds.has(task.projectId));
  hiddenTasks += tasks.length - placed.length;
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
    hiddenTasks,
    data: { version: THREAD_STORE_VERSION, tasks: placed.map((task) => claiming(task, worktreeIds)), projects, worktrees, lastFolder: values.lastFolder as string | null },
  };
}

/**
 * A reference to a checkout that is not there is dropped rather than refusing the whole store: a
 * reconcile removes a checkout the moment nothing claims it, and a crash in that window would
 * otherwise leave the user unable to write anything at all.
 */
function claiming(task: Thread, worktreeIds: Set<string>): Thread {
  if (!task.worktreeId || worktreeIds.has(task.worktreeId)) return task;
  const { worktreeId: _gone, worktreeEnteredAt: _forked, ...local } = task;
  return local;
}

/**
 * Threads written while a checkout belonged to exactly one thread carry it inside themselves. Lifting
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

function corrupt(sourceVersion: 1 | 2, errors: string[], raw: StorageValues): ThreadStoreParseResult {
  return { ok: false, canWrite: false, sourceVersion, errorKind: "corrupt", errors, preservedV1: sourceVersion === 1 ? raw : null, raw };
}

function versioned<T>(value: T): VersionedValue<T> {
  return { version: THREAD_STORE_VERSION, value };
}

function continuationStatusFor(value: unknown): ContinuationStatus {
  if (value === undefined) return "none";
  return typeof value === "string" && value.trim() ? "available" : "invalid";
}

function toContinuation(engine: AgentEngine, value: unknown): Continuation {
  return { provider: engine, value: String(value) };
}

function isLegacyMode(value: unknown): value is LegacyMode {
  return typeof value === "string" && value in LEGACY_MODES;
}

function isMessageKind(value: string): value is ConversationMessageKind {
  return value === "user" || value === "assistant" || value === "tool" || value === "system";
}

function isThreadBase(value: unknown): value is StoredThread {
  return isRecord(value) &&
    nonEmptyString(value.id) &&
    nonEmptyString(value.title) &&
    (value.titleByUser === undefined || typeof value.titleByUser === "boolean") &&
    (value.projectId === undefined || nonEmptyString(value.projectId)) &&
    isExecutionPolicy(value.executionPolicy) &&
    isAgentEngine(value.engine) &&
    (value.model === undefined || isAgentModel(value.model) && engineHasModel(value.engine, value.model)) &&
    (value.effort === undefined || isAgentEffort(value.effort) && engineHasEffort(value.engine, value.effort)) &&
    (value.contextUsage === undefined || isContextUsage(value.contextUsage)) &&
    Array.isArray(value.messages) &&
    value.messages.every(isConversationMessage) &&
    (value.subagents === undefined || Array.isArray(value.subagents) && value.subagents.every(isSubagent)) &&
    isRecord(value.lastChangeSnapshot) && Array.isArray(value.lastChangeSnapshot.files) && value.lastChangeSnapshot.files.every((file) => typeof file === "string") && finiteNumber(value.lastChangeSnapshot.capturedAt) &&
    (value.sortIndex === undefined || finiteNumber(value.sortIndex)) &&
    (value.outcome === undefined || isThreadOutcome(value.outcome)) &&
    (value.outcomeUnread === undefined || value.outcomeUnread === true) &&
    (value.findings === undefined || Array.isArray(value.findings) && value.findings.every(isAutomationFinding)) &&
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

function isAutomationFinding(value: unknown): value is AutomationFinding {
  return isRecord(value) &&
    nonEmptyString(value.id) &&
    nonEmptyString(value.headline) &&
    (value.detail === undefined || typeof value.detail === "string") &&
    (value.key === undefined || nonEmptyString(value.key)) &&
    finiteNumber(value.at) &&
    (value.read === undefined || value.read === true);
}

function isThreadOutcome(value: unknown): value is ThreadOutcome {
  return value === "finished" || value === "failed" || value === "stopped";
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * Threads written before the picker dropped "default" and the context window; both fall back to the
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
 * Threads written while a withdrawn message was called `quiet` and a handled issue a `silencedKeys` entry.
 * Whatever the thread already carries under the current name wins.
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

/** A conversation loaded separately uses the same migrations and validation as a complete store. */
export function parseStoredConversationMessages(values: unknown[]): ConversationMessage[] {
  return values.map((value, index) => {
    const message = renamedMessageFields(value);
    if (!isConversationMessage(message)) throw new Error(`Stored message ${index + 1} is unreadable.`);
    return message;
  });
}

function recordedEngine(value: unknown) {
  if (!isRecord(value) || value.engine !== undefined) return value;
  return { ...value, engine: UNRECORDED_ENGINE };
}

/** Null for a thread this build cannot read, which the caller counts and leaves out. */
function sanitizeV2Thread(raw: unknown, lifted: Worktree[]): StoredThread | null {
  const retired = renamedFields(dropRetiredSettings(recordedEngine(raw)));
  const value = isRecord(retired) ? liftEmbeddedWorktree(retired, lifted) : retired;
  if (!isThreadBase(value)) return null;

  const continuation = value.continuation;
  if (continuation !== undefined && !isContinuation(continuation)) {
    const { continuation: _discarded, ...withoutContinuation } = value;
    return settleStoredSubagents({ ...withoutContinuation, continuationStatus: "invalid" });
  }
  if (continuation && value.continuationStatus !== "available") return null;
  if (!continuation && value.continuationStatus !== "none" && value.continuationStatus !== "invalid") return null;
  return settleStoredSubagents(value);
}

/** No provider session survives an app restart, so work saved mid-turn cannot still be working. */
function settleStoredSubagents(task: StoredThread): StoredThread {
  if (!task.subagents?.some((subagent) => subagent.status === "working")) return task;
  return {
    ...task,
    subagents: task.subagents.map((subagent) => subagent.status === "working"
      ? { ...subagent, status: "stopped" as const, finishedAt: subagent.finishedAt ?? task.updatedAt }
      : subagent),
  };
}

function isConversationMessage(value: unknown): value is ConversationMessage {
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
  return value === "confirm" || value === "plan" || value === "allow-edits" || value === "autonomous" || value === "bypass";
}

function isContextUsage(value: unknown): value is ContextUsage {
  return isRecord(value) && finiteNumber(value.tokens) && value.tokens >= 0 && finiteNumber(value.limit) && value.limit > 0 && nonEmptyString(value.model);
}

function isSubagent(value: unknown): value is Subagent {
  return isRecord(value) &&
    nonEmptyString(value.id) &&
    typeof value.description === "string" &&
    (value.agentType === undefined || typeof value.agentType === "string") &&
    (value.sessionScoped === undefined || value.sessionScoped === true) &&
    (value.status === "working" || value.status === "idle" || value.status === "completed" || value.status === "failed" || value.status === "stopped") &&
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
