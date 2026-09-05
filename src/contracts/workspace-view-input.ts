import type { AppCommand } from "./commands.js";
import type { WorkspaceEvent } from "../application/workspace-reducer.js";
import { isBrowserAction } from "./ipc.js";
import { isAgentEffort, isAgentEngine, isAgentModel } from "../domain/agent-engine.js";
import { isAutomationDraft, isAutomationPatch, type AutomationDraft } from "../domain/automation.js";
import { isCaptureOptions } from "../domain/capture.js";
import type { Annotation, AnnotationAnchor, AttachedFile, AttachedFileDraft, PastedText, RunAttachment } from "../domain/conversation.js";
import { isDiffRange } from "../domain/diff.js";
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
type InputShapes = { [Type in WorkspaceViewInput["type"]]: Shape<Omit<Extract<WorkspaceViewInput, { type: Type }>, "type">> };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const text: Validator<string> = (value): value is string => typeof value === "string" && value.length <= 16_000_000;
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

function object<T>(fields: Shape<T>): Validator<T> {
  return (value): value is T => {
    if (!record(value)) return false;
    for (const [key, check] of Object.entries<Validator<unknown>>(fields)) {
      if (!check(value[key])) return false;
    }
    return true;
  };
}

const policy = literals("confirm", "plan", "allow-edits", "autonomous", "bypass");
const optionalText = optional(text);
const optionalBoolean = optional(boolean);
const nullableText = nullable(text);
const step = literals(-1, 1);
const readingPoint = nullable(object({ anchor: text, depth: number }));
const dropTarget = object({ projectId: nullableText, index: number });
const runAttachment = object<RunAttachment>({ path: text, labels: array(text) });
const pastedText = object<PastedText>({ id: text, text });
const attachedFileDraft = object<AttachedFileDraft>({ path: text, name: text, folder: optional(literals(true)) });
const attachedFile = object<AttachedFile>({ id: text, path: text, name: text, folder: optional(literals(true)) });
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

/** Every input field is checked before a visible view can reach the application reducer. */
export function isWorkspaceViewInput(value: unknown): value is WorkspaceViewInput {
  if (!record(value) || typeof value.type !== "string" || !Object.hasOwn(shapes, value.type)) return false;
  const fields = shapes[value.type as keyof typeof shapes];
  for (const [key, check] of Object.entries<Validator<unknown>>(fields)) {
    if (!check(value[key])) return false;
  }
  return true;
}

const shapes = {
  "view.mounted": {},
  "diff.toggle": {  },
  "diff.refresh": {  },
  "diff.set-range": { range: isDiffRange },
  "diff.set-collapsed": { path: text, collapsed: boolean },
  "diff.set-viewed": { path: text, viewed: boolean },
  "diff.set-split": { split: boolean },
  "diff.set-ignore-whitespace": { ignore: boolean },
  "task.new": { projectId: optionalText, worktreeId: optionalText },
  "task.select": { taskId: text },
  "task.archive": { taskId: text },
  "task.restore": { taskId: text },
  "task.clear-archive": {  },
  "task.rename": { taskId: text, title: text },
  "task.dismiss": { taskId: text },
  "task.dismiss-all": {  },
  "task.move": { taskId: text, target: dropTarget },
  "task.fork": { taskId: optionalText, worktree: optionalBoolean },
  "task.set-policy": { taskId: optionalText, policy: policy },
  "task.set-model": { taskId: optionalText, engine: isAgentEngine, model: isAgentModel },
  "task.set-effort": { taskId: optionalText, engine: isAgentEngine, effort: isAgentEffort },
  "task.set-worktree": { taskId: optionalText, worktree: boolean },
  "task.move-worktree": { taskId: optionalText, destination: isWorktreeDestination },
  "task.set-branch": { branch: nullableText, create: optionalBoolean },
  "task.checkout-branch": { taskId: optionalText, branch: text, create: optionalBoolean },
  "task.send": { taskId: optionalText, project: optionalText, text: optionalText, attachments: optional(array(runAttachment)), steer: optionalBoolean, worktree: optionalBoolean, worktreeId: optionalText, model: optional(isAgentModel), effort: optional(isAgentEffort) },
  "task.steer-queued": { taskId: optionalText, messageId: text },
  "task.drop-queued": { taskId: optionalText, messageId: text },
  "annotation.add": { taskId: optionalText, quote: text, note: optionalText, anchor: optional(isAnnotationAnchor) },
  "annotation.note": { taskId: optionalText, annotationId: text, note: text },
  "annotation.remove": { taskId: optionalText, annotationId: text },
  "annotation.recall": { taskId: optionalText, annotations: array(annotation) },
  "paste.add": { taskId: optionalText, text: text },
  "paste.remove": { taskId: optionalText, pasteId: text },
  "paste.recall": { taskId: optionalText, pastes: array(pastedText) },
  "image.add": { taskId: optionalText, path: text, label: text, source: optionalText },
  "image.remove": { taskId: optionalText, imageId: text },
  "image.recall": { taskId: optionalText, paths: array(text) },
  "project.open": {  },
  "project.move": { projectId: text, index: number },
  "project.edit": { projectId: text, name: optional(nullableText), root: optionalText },
  "project.remove": { projectId: text },
  "worktree.menu-open": { list: literals("threads", "destinations") },
  "worktree.menu-search": { list: literals("threads", "destinations"), query: text },
  "worktree.refresh": {  },
  "worktree.filter-project": { project: nullableText },
  "worktree.confirm-delete": { root: nullableText },
  "worktree.set-missing-open": { open: boolean },
  "worktree.set-threads-open": { root: text, open: boolean },
  "worktree.open-thread": { taskId: text },
  "worktree.reveal": { root: text },
  "worktree.delete": { taskId: optionalText, root: optionalText, missingOnly: optionalBoolean },
  "run.cancel": { taskId: optionalText },
  "run.compact": { taskId: optionalText },
  "question.reply-mode": { taskId: text, runId: text, replying: boolean },
  "question.answer": { taskId: text, runId: text, requestId: text, questionId: text, text: optionalText, attachments: optional(array(runAttachment)) },
  "run.decide": { allow: boolean, taskId: optionalText },
  "run.stop-process": { taskId: optionalText, processId: text },
  "review.open": { taskId: optionalText },
  "review.close": {  },
  "review.set-step": { step: literals("targets", "base", "commit", "custom") },
  "review.start": { taskId: optionalText, target: isReviewTarget },
  "side-chat.open": { chatId: text },
  "side-chat.close": { chatId: text },
  "automation.notify": { taskId: text, headline: text, detail: optionalText, key: optionalText },
  "automation.nothing-to-report": { taskId: text, checked: text },
  "automation.save": { taskId: optionalText, draft: isScheduleDraft },
  "automation.update": { taskId: optionalText, patch: isAutomationPatch },
  "automation.delete": { taskId: optionalText },
  "automation.run-now": { taskId: optionalText },
  "browser.open": { taskId: optionalText, url: text, tabId: optionalText, newTab: optionalBoolean },
  "browser.new-tab": {  },
  "browser.close-tab": { taskId: optionalText, tabId: text },
  "browser.select-tab": { taskId: optionalText, tabId: text },
  "browser.go": { taskId: optionalText, tabId: optionalText, delta: step },
  "browser.reload": { taskId: optionalText, tabId: optionalText },
  "browser.act": { taskId: optionalText, tabId: optionalText, action: isBrowserAction },
  "browser.decide": { allow: boolean },
  "browser.clear-data": {  },
  "file.open": { taskId: optionalText, path: text, line: optional(number) },
  "file.attach": { taskId: optionalText, files: array(attachedFileDraft) },
  "file.detach": { taskId: optionalText, fileId: text },
  "file.recall": { taskId: optionalText, files: array(attachedFile) },
  "app.open-folder": { appId: text },
  "app.check-for-updates": {  },
  "app.open-source-licenses": {  },
  "terminal.open": { cwd: optionalText },
  "terminal.select": { terminalId: text },
  "terminal.close": { terminalId: text },
  "terminal.input": { terminalId: text, data: text },
  "terminal.resize": { terminalId: text, cols: number, rows: number },
  "remote.set-enabled": { enabled: boolean },
  "remote.create-pairing-code": {  },
  "remote.revoke-device": { deviceId: text },
  "remote.refresh": {  },
  "engine.read": { refresh: optionalBoolean },
  "engine.sign-in": { engine: isAgentEngine },
  "view.set-prompt": { taskId: optionalText, prompt: text },
  "view.reading-point": { taskId: text, point: readingPoint },
  "view.dismiss-action-error": {  },
  "view.dismiss-hidden-tasks": {  },
  "view.toggle-project": { projectId: text },
  "view.edit-project": { projectId: nullableText },
  "view.move-worktree": { worktree: nullable(boolean) },
  "view.set-section-open": { section: isSidebarSection, open: boolean },
  "view.set-subagent-group": { group: isSubagentGroup, open: boolean },
  "view.set-model-favorite": { model: isAgentModel, favorite: boolean },
  "view.set-theme": { theme: text },
  "view.set-theme-family": { family: text, systemDark: boolean },
  "view.set-theme-mode": { mode: isThemeMode, systemDark: boolean },
  "view.system-scheme": { dark: boolean },
  "view.set-ui-font": { font: text },
  "view.set-mono-font": { font: text },
  "view.set-reading-size": { size: number },
  "view.set-terminal-size": { size: number },
  "view.set-sidebar-mode": { mode: isSidebarMode },
  "view.set-sidebar-open": { open: boolean },
  "view.set-session-panel-open": { open: boolean },
  "view.set-capture-options": { options: isCaptureOptions },
  "view.set-chrome-browser": { enabled: boolean },
  "view.set-concise-replies": { enabled: boolean },
  "view.set-computer-use": { enabled: boolean },
  "view.set-browser-tools": { enabled: boolean },
  "view.set-notifications": { enabled: boolean },
  "view.inspect-subagent": { taskId: optionalText, subagentId: text },
  "view.set-settings-open": { open: boolean, section: optional(isSettingsSection), settingId: optionalText },
  "view.close-tab": {  },
  "view.new-tab": {  },
  "view.set-dock-open": { open: boolean },
  "view.set-dock-expanded": { expanded: boolean },
  "view.open-dock-panel": { panel: text },
  "view.close-dock-panel": { panel: text },
  "view.open-workflow": { workflowId: text },
  "view.select-dock-tab": { tab: text },
  "view.select-dock-index": { index: number },
  "view.set-menu": { menu: nullableText },
  "view.go-back": {  },
  "view.go-forward": {  },
  "view.set-focused": { focused: boolean },
  "view.focus-composer": {  },
  "view.shortcut": { action: text, surface: literals("any", "browser", "desktop") },
  "view.escape": {  },
  "view.set-shortcut": { action: text, binding: nullableText },
  "view.reset-shortcuts": {  },
  "view.capture-shortcut": { action: nullableText },
  "view.dismiss-computer-use-setup": {  },
  "view.refresh-environment": {  },
  "view.dock-keys": { tab: nullableText },
  "view.find-open": { target: optional(isFindTarget) },
  "view.find-query": { query: text },
  "view.find-step": { delta: step },
  "view.find-close": {  },
  "view.jump-open": {  },
  "view.jump-query": { query: text },
  "view.jump-step": { delta: step },
  "view.jump-choose": { taskId: text },
  "view.jump-choose-setting": { section: isSettingsSection, settingId: optionalText },
  "view.jump-close": {  },
  "action.failed": { message: text },
  "find.results": { target: isFindTarget, results: object({ matches: number, index: optional(number), counting: optionalBoolean }) },
  "shortcut.captured": { binding: nullableText },
  "shortcut.unavailable": { refusal: object({ reason: literals("unsupported"), binding: text, message: text }) },
} satisfies InputShapes;
