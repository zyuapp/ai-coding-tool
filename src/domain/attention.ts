/**
 * What a thread has to say for itself: the verdict its last run left, and what its runs found. A
 * verdict belongs to one run and the next run supersedes it; a finding outlives every run after it,
 * because the tick that raised it may have been at 3am. Both rank a thread in Priority, both are
 * marked read by landing on the thread, and both are retired by the same dismissal.
 *
 * A function belongs here when a thread, or a list of threads, is all it needs.
 */
import { createTaskMessage, MAX_FINDINGS, MAX_SILENCED_KEYS, type Task, type TaskFinding } from "./task.js";

export function unreadFindings(task: Task): TaskFinding[] {
  return (task.findings ?? []).filter((finding) => !finding.read);
}

/** The headline a row shows: the newest thing the user has not seen. */
export function newestUnreadFinding(task: Task): TaskFinding | undefined {
  return unreadFindings(task).at(-1);
}

export function hasFindings(task: Task): boolean {
  return (task.findings ?? []).length > 0;
}

function findingKeys(task: Task): string[] {
  return (task.findings ?? []).flatMap((finding) => finding.key ?? []);
}

function handledKeys(task: Task): string[] {
  return task.silencedKeys ?? [];
}

/**
 * Where a keyed issue stands with the thread: one it carries a finding for, one the user has filed
 * away, or one it has never been told about. An unkeyed report is always unknown.
 */
export function issueState(task: Task, key?: string): "unknown" | "carried" | "handled" {
  if (key === undefined) return "unknown";
  if (findingKeys(task).includes(key)) return "carried";
  return handledKeys(task).includes(key) ? "handled" : "unknown";
}

/** Only an issue the thread has never heard of is news; carried and filed away are the same one. */
export function isNews(task: Task, key?: string): boolean {
  return issueState(task, key) === "unknown";
}

/**
 * Records the finding, oldest dropped once the thread is at its fill, and says it in the thread so
 * the transcript still carries it once the finding itself is filed away. A duplicate changes nothing.
 */
export function withFinding(task: Task, report: { headline: string; detail?: string; key?: string }, at: number, seen = false): Task {
  if (!isNews(task, report.key)) return task;
  const finding: TaskFinding = {
    id: crypto.randomUUID(),
    headline: report.headline,
    ...(report.detail ? { detail: report.detail } : {}),
    ...(report.key ? { key: report.key } : {}),
    at,
    ...(seen ? { read: true as const } : {}),
  };
  return {
    ...task,
    findings: [...task.findings ?? [], finding].slice(-MAX_FINDINGS),
    /** Outlives the finding itself, so a schedule that found something at 3am can still prove it. */
    lastFindingAt: at,
    messages: [...task.messages, createTaskMessage("system", report.headline, report.detail)],
    updatedAt: at,
  };
}

/** Landing on the thread takes the marks off. The findings stay, the way a verdict stays. */
export function withReadFindings(task: Task): Task {
  if (!unreadFindings(task).length) return task;
  return { ...task, findings: task.findings!.map((finding) => finding.read ? finding : { ...finding, read: true as const }) };
}

/** Filing the thread away is what retires what it found. */
export function withoutFindings(task: Task): Task {
  if (!task.findings) return task;
  const { findings: _filed, ...rest } = task;
  return rest;
}

/**
 * Landing on a thread takes its marks off. The verdict and what its runs found both stay, so the
 * thread keeps its place in Priority until the user files it away.
 */
export function readAttention<T extends { tasks: Task[] }>(state: T, taskId: string | null): T {
  const seen = taskId ? state.tasks.find((task) => task.id === taskId) : undefined;
  if (!seen || (!seen.outcomeUnread && !unreadFindings(seen).length)) return state;
  const { outcomeUnread: _read, ...rest } = seen;
  return { ...state, tasks: state.tasks.map((task) => task === seen ? withReadFindings(rest) : task) };
}

/** Retires the named threads' verdicts, leaving the list alone when none of them carry one. */
export function withoutOutcome(tasks: Task[], dismissing: Set<string>): Task[] {
  if (!tasks.some((task) => dismissing.has(task.id) && task.outcome)) return tasks;
  return tasks.map((task) => {
    if (!dismissing.has(task.id) || !task.outcome) return task;
    const { outcome: _gone, outcomeUnread: _read, ...rest } = task;
    return rest;
  });
}

/**
 * Filing a thread away retires what its runs found along with the verdict of the last one. The keys
 * go with it rather than being forgotten: a dismissal says the finding is handled, not that the user
 * wants telling again on the next tick.
 */
export function dismissed(tasks: Task[], dismissing: Set<string>): Task[] {
  const filed = withoutOutcome(tasks, dismissing);
  if (!filed.some((task) => dismissing.has(task.id) && task.findings)) return filed;
  return filed.map((task) => dismissing.has(task.id) ? withoutFindings(silenceKeys(task)) : task);
}

function silenceKeys(task: Task): Task {
  const keys = findingKeys(task);
  if (!keys.length) return task;
  const silenced = [...handledKeys(task).filter((key) => issueState(task, key) !== "carried"), ...keys];
  return { ...task, silencedKeys: silenced.slice(-MAX_SILENCED_KEYS) };
}

/**
 * What a run that has finished looking says about the keys it did not report: the thing it was
 * filed away for is over, so the next sighting is news again.
 */
export function withLiftedSilences(task: Task, reportedKeys: string[]): Task {
  const held = handledKeys(task);
  const still = held.filter((key) => reportedKeys.includes(key));
  if (still.length === held.length) return task;
  if (!still.length) {
    const { silencedKeys: _lifted, ...rest } = task;
    return rest;
  }
  return { ...task, silencedKeys: still };
}

/** Which threads a "dismiss everything" reaches: the ones carrying anything to file away. */
export function dismissableTasks(tasks: Task[]): Task[] {
  return tasks.filter((task) => task.outcome || hasFindings(task));
}
