import type { ManagedWorktree } from "../domain/worktree.js";
import { projectName } from "../domain/task.js";
import type { WorkspaceState } from "./workspace-state.js";

export type WorktreeSettingsView = ManagedWorktree & {
  name: string;
  project: string | null;
  available: boolean;
  recorded: boolean;
  threads: Array<{ id: string; title: string; archived: boolean }>;
  busy: boolean;
  /** The checkout is on its way out, whether Settings or its own thread asked, so the row only waits. */
  deleting: boolean;
};

export function worktreeSettingsViews(state: WorkspaceState, busy: Set<string>): WorktreeSettingsView[] | null {
  if (state.managedWorktrees === null) return null;
  const onDisk = new Map(state.managedWorktrees.map((worktree) => [worktree.root, worktree]));
  const directories = [
    ...state.managedWorktrees,
    ...state.worktrees.flatMap((worktree): ManagedWorktree[] => onDisk.has(worktree.root) ? [] : [{
      id: worktree.id,
      root: worktree.root,
      repository: state.projects.find((project) => project.id === worktree.projectId)?.root ?? null,
      branch: null,
    }]),
  ];
  return directories.map((directory): WorktreeSettingsView => {
    const record = state.worktrees.find((worktree) => worktree.root === directory.root || worktree.id === directory.id);
    const threads = state.tasks
      .filter((task) => task.worktreeId === (record?.id ?? directory.id))
      .map((task) => ({ id: task.id, title: task.title, archived: task.archivedAt !== undefined }));
    const project = record
      ? state.projects.find((item) => item.id === record.projectId)
      : state.projects.find((item) => item.root === directory.repository);
    return {
      ...directory,
      name: directory.root.split("/").filter(Boolean).at(-1) ?? directory.id,
      project: project ? projectName(project) : null,
      available: onDisk.has(directory.root),
      recorded: Boolean(record),
      threads,
      busy: threads.some((task) => busy.has(task.id)),
      deleting: state.deletingWorktrees.includes(directory.root)
        || threads.some((task) => state.releasingWorktrees.includes(task.id)),
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
}
