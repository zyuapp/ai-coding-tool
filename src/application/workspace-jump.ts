/**
 * The jump panel's list: every thread it can offer, and the ones a name matches. Names only, never
 * message text, so a keystroke stays cheap however long the list grows.
 */
import { rankThreadJumps, type ThreadJumpOption } from "../domain/thread-jump.js";
import { projectName, threadActivityAt, type Project, type Task } from "../domain/task.js";
import type { WorkspaceState } from "./workspace-state.js";

/** A row of the jump panel: the thread, plus whether it is working right now. */
export type ThreadJumpRow = ThreadJumpOption & { running: boolean };

export type JumpView = { query: string; index: number; options: ThreadJumpRow[] };

const jumpCache = new WeakMap<Task[], { projects: Project[]; options: ThreadJumpOption[] }>();

/** Every thread the panel can offer, newest first. Rebuilt only when the threads or the folders change. */
function threadJumpOptions(state: WorkspaceState): ThreadJumpOption[] {
  const cached = jumpCache.get(state.tasks);
  if (cached && cached.projects === state.projects) return cached.options;
  const forked = new Set(state.sideChats.map((chat) => chat.id));
  const names = new Map(state.projects.map((project) => [project.id, projectName(project)]));
  const options = state.tasks
    .filter((task) => task.archivedAt === undefined && !forked.has(task.id))
    .map((task): ThreadJumpOption => ({
      id: task.id,
      title: task.title,
      project: task.projectId ? names.get(task.projectId) ?? null : null,
      engine: task.engine,
      lastActivityAt: threadActivityAt(task),
    }))
    .sort((left, right) => right.lastActivityAt - left.lastActivityAt);
  jumpCache.set(state.tasks, { projects: state.projects, options });
  return options;
}

/** The jump panel as it is drawn: the threads its name matches, and which row is picked. */
export function jumpView(state: WorkspaceState, busy: Set<string>): JumpView | null {
  const jump = state.jump;
  if (!jump) return null;
  const matched = rankThreadJumps(threadJumpOptions(state), jump.query);
  return {
    query: jump.query,
    index: matched.length ? Math.min(jump.index, matched.length - 1) : 0,
    options: matched.map((option) => ({ ...option, running: busy.has(option.id) })),
  };
}
