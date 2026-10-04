import type { AppCommand } from "./commands.js";
import { isTerminalDimension, MAX_TERMINAL_INPUT } from "./terminal.js";
import { isSnoozeHours } from "../domain/thread-snooze.js";
import { isThreadRole } from "../domain/thread-role.js";
import { isThreadBrief } from "../domain/coordination.js";
import type { WorkspaceEvent } from "../application/workspace-reducer.js";
import { isBrowserAction, isString, MAX_PROMPT_LENGTH } from "./ipc.js";
import type { ExternalCommand } from "./threads.js";
import { isAgentEffort, isAgentEngine, isAgentModel } from "../domain/agent-engine.js";
import { isAutomationDraft, isAutomationPatch, type AutomationDraft } from "../domain/automation.js";
import { isImportSite, isImportSourceId } from "../domain/browser-import.js";
import { isCaptureOptions } from "../domain/capture.js";
import { isScreenshotContext } from "../domain/screenshot-context.js";
import { MAX_ATTACHMENT_ENCODED_BYTES, type Annotation, type AnnotationAnchor, type AttachedFile, type AttachedFileDraft, type OutgoingAttachment, type PastedText, type RunAttachment } from "../domain/conversation.js";
import type { ImageAnnotation } from "../domain/image-annotation.js";
import { isDiffRange } from "../domain/diff.js";
import { isCommitHash, isImageSource } from "../domain/message-artifacts.js";
import type { FindTarget } from "../domain/find.js";
import { isReviewTarget } from "../domain/review.js";
import { isSubagentGroup } from "../domain/run.js";
import { isSettingsSection } from "../domain/settings-section.js";
import { isSidebarMode, isSidebarSection } from "../domain/sidebar.js";
import { isThemeMode } from "../domain/theme.js";
import type { WorktreeDestination } from "../domain/worktree.js";

type ViewEvent = Extract<WorkspaceEvent, { type: "action.failed" | "find.results" | "shortcut.captured" | "shortcut.unavailable" }>;
export type WorkspaceViewInput = AppCommand | ViewEvent;
type Validator<T> = (value: unknown) => value is T;
type Shape<T> = { [K in keyof T]-?: Validator<T[K]> };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const text: Validator<string> = (value): value is string => typeof value === "string" && value.length <= 16_000_000;
const pathText: Validator<string> = (value): value is string => typeof value === "string" && value.length <= 4096 && !value.includes("\0");
const deviceId: Validator<string> = (value): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;
const boolean: Validator<boolean> = (value): value is boolean => typeof value === "boolean";
const number: Validator<number> = (value): value is number => typeof value === "number" && Number.isFinite(value);

function optional<T>(check: Validator<T>): Validator<T | undefined> {
  return (value): value is T | undefined => value === undefined || check(value);
}

function nullable<T>(check: Validator<T>): Validator<T | null> {
  return (value): value is T | null => value === null || check(value);
}

function array<T>(check: Validator<T>): Validator<T[]> {
  return (value): value is T[] => {
    if (!Array.isArray(value) || value.length > 10_000) return false;
    for (const item of value) if (!check(item)) return false;
    return true;
  };
}

function literals<const T extends readonly (string | number | boolean)[]>(...choices: T): Validator<T[number]> {
  return (value): value is T[number] => choices.some((choice) => choice === value);
}

function hasFields(value: Record<string, unknown>, fields: Readonly<Record<string, Validator<unknown>>>): boolean {
  for (const [key, check] of Object.entries<Validator<unknown>>(fields)) {
    if (!check(value[key])) return false;
  }
  return true;
}

function object<T>(fields: Shape<T>): Validator<T> {
  return (value): value is T => record(value) && hasFields(value, fields);
}

const policy = literals("confirm", "plan", "allow-edits", "autonomous", "bypass");
const optionalText = optional(text);
const optionalBoolean = optional(boolean);
const nullableText = nullable(text);
const step = literals(-1, 1);
const readingPoint = nullable(object({ anchor: text, depth: number }));
const dropTarget = object({ projectId: nullableText, index: number });
const runAttachment = object<RunAttachment>({ path: text, labels: array(text), context: optional(isScreenshotContext) });
const pastedText = object<PastedText>({ id: text, text });
const attachedFileDraft = object<AttachedFileDraft>({ path: text, name: text, folder: optional(literals(true)) });
const attachedFile = object<AttachedFile>({ id: text, path: text, name: text, folder: optional(literals(true)) });
const imageAnnotation = object<ImageAnnotation>({ kind: literals("box", "arrow"), x: number, y: number, width: number, height: number, text });
/** Image data URLs need the encoded byte budget plus room for their MIME prefix. */
const attachmentSource: Validator<string> = (value): value is string => typeof value === "string" && value.length <= MAX_ATTACHMENT_ENCODED_BYTES + 256;
const outgoingAttachment = object<OutgoingAttachment>({ id: text, source: attachmentSource, annotations: array(imageAnnotation), path: optionalText, context: optional(isScreenshotContext) });
const annotation = object<Annotation>({ id: text, quote: text, note: text, anchor: optional(isAnnotationAnchor) });

function isAnnotationAnchor(value: unknown): value is AnnotationAnchor {
  if (!record(value)) return false;
  if (value.kind === "message") return text(value.messageId) && number(value.start) && number(value.end);
  if (value.kind === "diff") return text(value.comparison) && text(value.path) && text(value.start) && text(value.end) && (value.side === "old" || value.side === "new");
  return false;
}

function isWorktreeDestination(value: unknown): value is WorktreeDestination {
  if (!record(value)) return false;
  if (value.kind === "local" || value.kind === "new") return true;
  return value.kind === "worktree" && text(value.id);
}

function isFindTarget(value: unknown): value is FindTarget {
  if (!record(value)) return false;
  switch (value.kind) {
    case "thread": return nullableText(value.taskId);
    case "browser": return text(value.tabId);
    case "terminal": return text(value.terminalId);
    case "review": return text(value.owner);
    case "panel": return text(value.owner) && text(value.panel);
    default: return false;
  }
}

function isScheduleDraft(value: unknown): value is Omit<AutomationDraft, "taskId"> {
  return record(value) && isAutomationDraft({ ...value, taskId: "view" });
}

/** Agents name what they act on by a non-empty id. */
function agentId(value: string | undefined): boolean {
  return value === undefined || isString(value);
}

function agentThread(command: { taskId?: string }): boolean {
  return agentId(command.taskId);
}

/** An agent acts on the thread it names, never on whichever one is on screen. */
function namesThread(command: { taskId?: string }): boolean {
  return isString(command.taskId);
}

function agentSend(command: Extract<AppCommand, { type: "task.send" }>): boolean {
  return agentId(command.taskId) && agentId(command.project)
    && isString(command.text, MAX_PROMPT_LENGTH)
    && command.attachments === undefined
    /** An id, never a path: the reducer resolves it against the checkouts the app itself made. */
    && agentId(command.worktreeId)
    /** Only the window says which coordinator a thread works under, and which thread a message came from. */
    && command.coordinatorId === undefined && command.from === undefined
    /** Agent selection, the role and the brief belong to a thread being created, never one that already exists. */
    && (command.taskId === undefined || command.model === undefined && command.effort === undefined && command.role === undefined && command.brief === undefined);
}

/** An id, never a path or the thread on screen, and never the folder-is-gone shortcut. */
function deletesWorktreeById(command: Extract<AppCommand, { type: "worktree.delete" }>): boolean {
  return isString(command.worktreeId) && command.taskId === undefined && command.root === undefined && command.missingOnly === undefined;
}

const MAX_URL_LENGTH = 8_192;

/** A run drives the browser as itself, so every browser command names the thread that asked. */
function drivesBrowser(command: { taskId?: string; tabId?: string; url?: string }): boolean {
  return isString(command.taskId) && agentId(command.tabId) && (command.url === undefined || isString(command.url, MAX_URL_LENGTH));
}

/**
 * Where a command is carried out once another computer is paired. `local` stays with this window
 * and computer whatever is on screen. `thread` goes to the computer holding the thread it names,
 * else to the one showing the thread on screen; `panel` goes the same way, but only this computer's
 * own panels can carry it out. `project` and `terminal` go to the computer holding the project or
 * shell they name. `select` puts the computer holding the thread it names on screen. `own` follows
 * a rule of its own.
 */
export type CommandPlacement = "local" | "thread" | "panel" | "project" | "terminal" | "select" | "own";

/** Only a command that names a project, a shell or a thread can be placed by it. */
type PlacementOf<C> = "local" | "thread" | "panel" | "own"
  | (C extends { projectId: string } ? "project" : never)
  | (C extends { terminalId: string } ? "terminal" : never)
  | (C extends { taskId: string } ? "select" : never);

type Declaration<C extends AppCommand> = {
  fields: Shape<Omit<C, "type">>;
  at: PlacementOf<C>;
  /** Moves this window to one of its own threads, which takes a paired computer's thread off screen. */
  leaves?: true;
  /** What an agent's command must also satisfy. A command without one is the window's alone. */
  agent?: (command: C) => boolean;
};

type Declarations = { [Type in AppCommand["type"]]: Declaration<Extract<AppCommand, { type: Type }>> };
type EventShapes = { [Type in ViewEvent["type"]]: Shape<Omit<Extract<ViewEvent, { type: Type }>, "type">> };
type Declared = { fields: Record<string, Validator<unknown>>; at: CommandPlacement; leaves?: true; agent?: (command: never) => boolean };
type Commands = typeof commands;
type PlacedType<At extends CommandPlacement> = { [Type in keyof Commands]: Commands[Type]["at"] extends At ? Type : never }[keyof Commands];

/** The commands declared at a placement. */
export type PlacedCommand<At extends CommandPlacement> = Extract<AppCommand, { type: PlacedType<At> }>;
export type AgentCommandType = { [Type in keyof Commands]: Commands[Type] extends { agent: unknown } ? Type : never }[keyof Commands];

/** Whether an input is a command rather than something that happened, which is what may be carried to another computer. */
export function isAppCommandType(type: string): type is AppCommand["type"] {
  return Object.hasOwn(commands, type);
}

export function commandPlacement(type: AppCommand["type"]): CommandPlacement {
  return declarations[type].at;
}

export function commandLeaves(type: AppCommand["type"]): boolean {
  return declarations[type].leaves === true;
}

/** The wire advertises the same actions and fields this validator accepts. New optional fields
 * become capabilities automatically; a changed meaning needs a new field or command name. */
export function workspaceCommandDefinitions(): ReadonlyArray<{ type: AppCommand["type"]; fields: readonly string[] }> {
  return Object.entries(declarations).map(([type, { fields }]) => ({ type: type as AppCommand["type"], fields: Object.keys(fields) }));
}

/** Every input field is checked before a visible view can reach the application reducer. */
export function isWorkspaceViewInput(value: unknown): value is WorkspaceViewInput {
  if (!record(value) || typeof value.type !== "string") return false;
  if (isAppCommandType(value.type)) return hasFields(value, declarations[value.type].fields);
  return Object.hasOwn(events, value.type) && hasFields(value, events[value.type as ViewEvent["type"]]);
}

/**
 * The command surface open to callers outside the window: the commands that declare an agent rule,
 * passing the window's own checks and then that rule. Everything else is the user's alone.
 */
export function isExternalCommand(value: unknown): value is ExternalCommand {
  if (!isWorkspaceViewInput(value) || !isAppCommandType(value.type)) return false;
  const agent = declarations[value.type].agent;
  return agent !== undefined && agent(value as never);
}

/** Every command, declared once: the fields it carries, where it is carried out, and whether an agent may send it. */
const commands = {
  "view.mounted": { fields: {}, at: "local" },
  "diff.toggle": { fields: { taskId: optionalText }, at: "thread" },
  "diff.refresh": { fields: {}, at: "thread" },
  "diff.set-range": { fields: { range: isDiffRange }, at: "thread" },
  "diff.set-mode": { fields: { mode: literals("uncommitted", "branch") }, at: "thread" },
  "diff.set-collapsed": { fields: { path: text, collapsed: boolean }, at: "thread" },
  "diff.set-viewed": { fields: { path: text, viewed: boolean }, at: "thread" },
  "diff.set-split": { fields: { split: boolean }, at: "thread" },
  "diff.set-ignore-whitespace": { fields: { ignore: boolean }, at: "thread" },
  "task.new": { fields: { projectId: optionalText, worktreeId: optionalText }, at: "own", leaves: true },
  "task.select": { fields: { taskId: text }, at: "select", leaves: true },
  "task.archive": { fields: { taskId: text }, at: "thread", agent: namesThread },
  "task.restore": { fields: { taskId: text }, at: "thread" },
  "task.clear-archive": { fields: {}, at: "thread" },
  "task.rename": { fields: { taskId: text, title: text }, at: "thread" },
  "task.set-role": { fields: { taskId: optionalText, role: nullable(isThreadRole) }, at: "thread", agent: namesThread },
  "task.set-coordinator": { fields: { taskId: text, coordinatorId: nullableText }, at: "thread" },
  "decision.answer": { fields: { taskId: text, decisionId: text, answer: text }, at: "thread" },
  "task.dismiss": { fields: { taskId: text }, at: "thread" },
  "task.snooze": { fields: { taskId: text, hours: isSnoozeHours }, at: "thread" },
  /** The reducer itself carries this to the computers shown in the sidebar. */
  "task.dismiss-all": { fields: { localOnly: optionalBoolean }, at: "local" },
  "task.move": { fields: { taskId: text, target: dropTarget }, at: "thread" },
  "task.fork": { fields: { taskId: optionalText, worktree: optionalBoolean }, at: "thread" },
  "task.set-policy": { fields: { taskId: optionalText, policy: policy }, at: "thread" },
  "task.set-model": { fields: { taskId: optionalText, engine: isAgentEngine, model: isAgentModel }, at: "thread" },
  "task.set-fast-mode": { fields: { taskId: optionalText, fastMode: boolean }, at: "thread" },
  "task.set-effort": { fields: { taskId: optionalText, engine: isAgentEngine, effort: isAgentEffort }, at: "thread" },
  "task.set-worktree": { fields: { taskId: optionalText, worktree: boolean }, at: "thread" },
  "task.move-worktree": { fields: { taskId: optionalText, destination: isWorktreeDestination }, at: "thread" },
  "task.set-branch": { fields: { branch: nullableText, create: optionalBoolean }, at: "thread" },
  "task.checkout-branch": { fields: { taskId: optionalText, branch: text, create: optionalBoolean }, at: "thread" },
  "attachments.send": { fields: { taskId: optionalText, steer: optionalBoolean, attachments: array(outgoingAttachment) }, at: "own" },
  "attachments.notice": { fields: { taskId: optionalText, message: nullableText }, at: "local" },
  "task.send": { fields: { taskId: optionalText, project: optionalText, text: optionalText, attachments: optional(array(runAttachment)), steer: optionalBoolean, worktree: optionalBoolean, worktreeId: optionalText, model: optional(isAgentModel), effort: optional(isAgentEffort), role: optional(isThreadRole), coordinatorId: optionalText, brief: optional(isThreadBrief), from: optionalText }, at: "own", agent: agentSend },
  "task.steer-queued": { fields: { taskId: optionalText, messageId: text }, at: "thread" },
  "task.drop-queued": { fields: { taskId: optionalText, messageId: text }, at: "thread" },
  "annotation.add": { fields: { taskId: optionalText, quote: text, note: optionalText, anchor: optional(isAnnotationAnchor) }, at: "local" },
  "annotation.note": { fields: { taskId: optionalText, annotationId: text, note: text }, at: "local" },
  "annotation.remove": { fields: { taskId: optionalText, annotationId: text }, at: "local" },
  "annotation.recall": { fields: { taskId: optionalText, annotations: array(annotation) }, at: "local" },
  "paste.add": { fields: { taskId: optionalText, text: text }, at: "local" },
  "paste.remove": { fields: { taskId: optionalText, pasteId: text }, at: "local" },
  "paste.recall": { fields: { taskId: optionalText, pastes: array(pastedText) }, at: "local" },
  "image.add": { fields: { taskId: optionalText, path: text, label: text, source: optionalText }, at: "local" },
  "image.remove": { fields: { taskId: optionalText, imageId: text }, at: "local" },
  "image.recall": { fields: { taskId: optionalText, paths: array(text) }, at: "local" },
  "project.open": { fields: { start: optional(literals(true)) }, at: "local" },
  "project.add": { fields: { root: (value): value is string => pathText(value) && value.trim().length > 0, computerId: optional(deviceId), start: optional(literals(true)) }, at: "own" },
  "view.add-project-close": { fields: {}, at: "local" },
  "view.add-project-device": { fields: { computerId: deviceId }, at: "local" },
  "view.add-project-path": { fields: { root: pathText }, at: "local" },
  "view.add-project-pick": { fields: {}, at: "local" },
  "view.add-project-submit": { fields: {}, at: "local" },
  "view.add-project-key": { fields: { key: literals("ArrowUp", "ArrowDown", "Tab", "Enter", "Escape") }, at: "local" },
  "view.add-project-accept": { fields: { index: (value): value is number => number(value) && Number.isInteger(value) && value >= 0 && value < 20 }, at: "local" },
  "project.move": { fields: { projectId: text, index: number }, at: "project" },
  "project.edit": { fields: { projectId: text, name: optional(nullableText), root: optionalText }, at: "project" },
  "project.remove": { fields: { projectId: text }, at: "project" },
  "worktree.menu-open": { fields: { list: literals("threads", "destinations") }, at: "own" },
  "worktree.menu-search": { fields: { list: literals("threads", "destinations"), query: text }, at: "local" },
  "worktree.refresh": { fields: {}, at: "local" },
  "worktree.filter-project": { fields: { project: nullableText }, at: "local" },
  "worktree.confirm-delete": { fields: { root: nullableText }, at: "own" },
  "worktree.set-missing-open": { fields: { open: boolean }, at: "local" },
  "worktree.set-threads-open": { fields: { root: text, open: boolean }, at: "local" },
  "worktree.open-thread": { fields: { taskId: text }, at: "select", leaves: true },
  "worktree.reveal": { fields: { root: text }, at: "own" },
  "worktree.delete": { fields: { taskId: optionalText, root: optionalText, worktreeId: optionalText, missingOnly: optionalBoolean }, at: "own", agent: deletesWorktreeById },
  "run.cancel": { fields: { taskId: optionalText }, at: "thread", agent: agentThread },
  "run.compact": { fields: { taskId: optionalText }, at: "thread" },
  "question.set-answer": { fields: { taskId: text, runId: text, requestId: text, questionId: text, text }, at: "thread" },
  "question.answer": { fields: { taskId: text, runId: text, requestId: text, questionId: text, text: optionalText }, at: "thread" },
  "run.decide": { fields: { allow: boolean, taskId: text, runId: text, approvalId: text }, at: "thread" },
  "run.stop-process": { fields: { taskId: optionalText, processId: text }, at: "thread" },
  "limit.resume": { fields: { taskId: text }, at: "thread" },
  "limit.cancel": { fields: { taskId: text }, at: "thread" },
  "review.open": { fields: { taskId: optionalText }, at: "thread" },
  "review.close": { fields: {}, at: "thread" },
  "review.set-step": { fields: { step: literals("targets", "base", "commit", "custom") }, at: "thread" },
  "review.start": { fields: { taskId: optionalText, target: isReviewTarget }, at: "thread" },
  "side-chat.open": { fields: { chatId: text }, at: "thread" },
  "side-chat.close": { fields: { chatId: text }, at: "thread" },
  "automation.notify": { fields: { taskId: text, headline: text, detail: optionalText, key: optionalText }, at: "thread" },
  "automation.nothing-to-report": { fields: { taskId: text, checked: text }, at: "thread" },
  "automation.save": { fields: { taskId: optionalText, draft: isScheduleDraft }, at: "thread" },
  "automation.update": { fields: { taskId: optionalText, patch: isAutomationPatch }, at: "thread" },
  "automation.delete": { fields: { taskId: optionalText }, at: "thread" },
  "automation.run-now": { fields: { taskId: optionalText }, at: "thread" },
  "browser.open": { fields: { taskId: optionalText, url: text, tabId: optionalText, newTab: optionalBoolean }, at: "panel", agent: drivesBrowser },
  "browser.new-tab": { fields: {}, at: "panel" },
  "browser.close-tab": { fields: { taskId: optionalText, tabId: text }, at: "panel", agent: drivesBrowser },
  "browser.select-tab": { fields: { taskId: optionalText, tabId: text }, at: "panel", agent: drivesBrowser },
  "browser.go": { fields: { taskId: optionalText, tabId: optionalText, delta: step }, at: "panel", agent: drivesBrowser },
  "browser.reload": { fields: { taskId: optionalText, tabId: optionalText }, at: "panel", agent: drivesBrowser },
  "browser.act": { fields: { taskId: optionalText, tabId: optionalText, action: isBrowserAction }, at: "panel", agent: drivesBrowser },
  "browser.decide": { fields: { allow: boolean, approvalId: text }, at: "panel" },
  "browser.clear-data": { fields: {}, at: "panel" },
  "browser-import.read": { fields: {}, at: "local" },
  "browser-import.choose": { fields: { sourceId: nullable(isImportSourceId) }, at: "local" },
  "browser-import.toggle": { fields: { site: isImportSite }, at: "local" },
  "browser-import.filter": { fields: { text: (value): value is string => typeof value === "string" && value.length <= 256 }, at: "local" },
  "browser-import.run": { fields: {}, at: "local" },
  "browser-import.again": { fields: {}, at: "local" },
  "file.open": { fields: { taskId: optionalText, path: text, line: optional(number) }, at: "own" },
  "image.open": { fields: { source: isImageSource }, at: "local" },
  "image.close": { fields: {}, at: "local" },
  "image.download": { fields: {}, at: "local" },
  "diff.open-commit": { fields: { commit: isCommitHash, taskId: optionalText }, at: "thread" },
  "file.attach": { fields: { taskId: optionalText, files: array(attachedFileDraft) }, at: "local" },
  "file.detach": { fields: { taskId: optionalText, fileId: text }, at: "local" },
  "file.recall": { fields: { taskId: optionalText, files: array(attachedFile) }, at: "local" },
  "app.open-folder": { fields: { appId: text }, at: "own" },
  "app.check-for-updates": { fields: {}, at: "local" },
  "app.download-update": { fields: {}, at: "local" },
  "app.install-update": { fields: {}, at: "local" },
  "app.open-source-licenses": { fields: {}, at: "local" },
  "terminal.open": { fields: { cwd: optionalText }, at: "thread" },
  "terminal.select": { fields: { terminalId: text }, at: "terminal" },
  "terminal.close": { fields: { terminalId: text }, at: "terminal" },
  "terminal.input": { fields: { terminalId: text, data: (value): value is string => typeof value === "string" && value.length <= MAX_TERMINAL_INPUT }, at: "terminal" },
  "terminal.resize": { fields: { terminalId: text, cols: isTerminalDimension, rows: isTerminalDimension }, at: "terminal" },
  "remote.set-enabled": { fields: { enabled: boolean }, at: "local" },
  "remote.create-pairing-code": { fields: {}, at: "local" },
  "remote.revoke-device": { fields: { deviceId: text }, at: "local" },
  "remote.refresh": { fields: {}, at: "local" },
  "computers.discover": { fields: {}, at: "local" },
  "computers.pair": { fields: { host: text, name: text, code: text }, at: "local" },
  "computers.cancel-pairing": { fields: {}, at: "local" },
  "computers.forget": { fields: { id: text }, at: "local" },
  "computers.rename": { fields: { name: text }, at: "local" },
  "computers.label": { fields: { id: text, name: text }, at: "local" },
  "computers.filter": { fields: { filter: text }, at: "local" },
  "engine.read": { fields: { refresh: optionalBoolean }, at: "local" },
  "engine.reload-settings": { fields: {}, at: "local" },
  "engine.sign-in": { fields: { engine: isAgentEngine }, at: "local" },
  "engine.update": { fields: { engine: isAgentEngine }, at: "local" },
  "view.set-prompt": { fields: { taskId: optionalText, prompt: text }, at: "local" },
  "view.reading-point": { fields: { taskId: text, point: readingPoint }, at: "local" },
  "view.dismiss-action-error": { fields: {}, at: "local" },
  "view.dismiss-hidden-tasks": { fields: {}, at: "local" },
  "view.toggle-project": { fields: { projectId: text }, at: "local" },
  "view.edit-project": { fields: { projectId: nullableText }, at: "local" },
  "view.move-worktree": { fields: { worktree: nullable(boolean) }, at: "local" },
  "view.set-section-open": { fields: { section: isSidebarSection, open: boolean }, at: "local" },
  "view.set-subagent-group": { fields: { group: isSubagentGroup, open: boolean }, at: "local" },
  "view.set-model-favorite": { fields: { model: isAgentModel, favorite: boolean }, at: "local" },
  "view.set-theme": { fields: { theme: text }, at: "local" },
  "view.set-theme-family": { fields: { family: text, systemDark: boolean }, at: "local" },
  "view.set-theme-mode": { fields: { mode: isThemeMode, systemDark: boolean }, at: "local" },
  "view.system-scheme": { fields: { dark: boolean }, at: "local" },
  "view.set-ui-font": { fields: { font: text }, at: "local" },
  "view.set-mono-font": { fields: { font: text }, at: "local" },
  "view.set-reading-size": { fields: { size: number }, at: "local" },
  "view.set-terminal-size": { fields: { size: number }, at: "local" },
  "view.set-sidebar-mode": { fields: { mode: isSidebarMode }, at: "local" },
  "view.set-sidebar-open": { fields: { open: boolean }, at: "local" },
  "view.set-session-panel-open": { fields: { open: boolean }, at: "local" },
  "view.set-capture-options": { fields: { options: isCaptureOptions }, at: "local" },
  "view.set-chrome-browser": { fields: { enabled: boolean }, at: "local" },
  "view.set-concise-replies": { fields: { enabled: boolean }, at: "local" },
  "view.set-computer-use": { fields: { enabled: boolean }, at: "local" },
  "view.set-browser-tools": { fields: { enabled: boolean }, at: "local" },
  "view.set-notifications": { fields: { enabled: boolean }, at: "local" },
  "view.inspect-subagent": { fields: { taskId: optionalText, subagentId: text }, at: "thread" },
  "view.set-settings-open": { fields: { open: boolean, section: optional(isSettingsSection), settingId: optionalText }, at: "local" },
  "view.close-tab": { fields: {}, at: "thread" },
  "view.new-tab": { fields: {}, at: "thread" },
  "view.set-dock-open": { fields: { open: boolean }, at: "thread" },
  "view.set-dock-expanded": { fields: { expanded: boolean }, at: "thread" },
  "view.open-dock-panel": { fields: { panel: text, taskId: optionalText }, at: "thread" },
  "view.close-dock-panel": { fields: { panel: text }, at: "thread" },
  "view.close-thread-tab": { fields: { taskId: text }, at: "thread" },
  "view.open-workflow": { fields: { workflowId: text }, at: "thread" },
  "view.select-dock-tab": { fields: { tab: text }, at: "thread" },
  "view.select-dock-index": { fields: { index: number }, at: "thread" },
  "view.set-menu": { fields: { menu: nullableText }, at: "local" },
  "view.go-back": { fields: {}, at: "local", leaves: true },
  "view.go-forward": { fields: {}, at: "local", leaves: true },
  "view.set-focused": { fields: { focused: boolean }, at: "own" },
  "view.focus-composer": { fields: {}, at: "local" },
  "view.shortcut": { fields: { action: text, surface: literals("any", "browser", "desktop") }, at: "thread" },
  "view.escape": { fields: {}, at: "thread" },
  "view.set-shortcut": { fields: { action: text, binding: nullableText }, at: "local" },
  "view.reset-shortcuts": { fields: {}, at: "local" },
  "view.capture-shortcut": { fields: { action: nullableText }, at: "local" },
  "view.dismiss-computer-use-setup": { fields: {}, at: "local" },
  "view.refresh-environment": { fields: {}, at: "local" },
  "pull-request.read": { fields: { taskId: optionalText }, at: "thread" },
  "pull-request.read-members": { fields: { taskId: optionalText }, at: "thread" },
  "app.list": { fields: {}, at: "local" },
  "usage.read": { fields: {}, at: "local" },
  "computer-use.read": { fields: {}, at: "local" },
  "computer-use.enable": { fields: { permission: literals("accessibility", "screenRecording") }, at: "local" },
  "computer-use.restart": { fields: {}, at: "local" },
  "cli.read": { fields: {}, at: "local" },
  "cli.install": { fields: {}, at: "local" },
  "cli.uninstall": { fields: {}, at: "local" },
  "view.dock-keys": { fields: { tab: nullableText }, at: "thread" },
  "view.find-open": { fields: { target: optional(isFindTarget) }, at: "local" },
  "view.find-query": { fields: { query: text }, at: "local" },
  "view.find-step": { fields: { delta: step }, at: "local" },
  "view.find-close": { fields: {}, at: "local" },
  "view.jump-open": { fields: {}, at: "local" },
  "view.jump-query": { fields: { query: text }, at: "local" },
  "view.jump-step": { fields: { delta: step }, at: "local" },
  "view.jump-choose": { fields: { taskId: text }, at: "select", leaves: true },
  "view.jump-choose-setting": { fields: { section: isSettingsSection, settingId: optionalText }, at: "local" },
  "view.jump-close": { fields: {}, at: "local" },
} satisfies Declarations;

const declarations: Readonly<Record<AppCommand["type"], Declared>> = commands;

const events = {
  "action.failed": { message: text },
  "find.results": { target: isFindTarget, results: object({ matches: number, index: optional(number), counting: optionalBoolean }) },
  "shortcut.captured": { binding: nullableText },
  "shortcut.unavailable": { refusal: object({ reason: literals("unsupported"), binding: text, message: text }) },
} satisfies EventShapes;
