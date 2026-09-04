import type { ManagedWorktree } from "../domain/worktree.js";
import { projectName } from "../domain/project.js";
import type { WorkspaceState } from "./workspace-state.js";

export type WorktreeSettingsState = {
  project: string | null;
  confirming: string | null;
  missingOpen: boolean | null;
  expandedThreads: string[];
};

export type WorktreeSettingsView = ManagedWorktree & {
  name: string;
  title: string;
  project: string;
  projectKey: string;
  available: boolean;
  recorded: boolean;
  threads: Array<{ id: string; title: string; archived: boolean }>;
  busy: boolean;
  /** The checkout is on its way out, whether Settings or its own thread asked, so the row only waits. */
  deleting: boolean;
};

export type WorktreeSettingsPage = {
  loading: boolean;
  total: number;
  project: string | null;
  projects: Array<{ key: string; name: string; count: number }>;
  available: WorktreeSettingsView[];
  missing: WorktreeSettingsView[];
  missingOpen: boolean;
  expandedThreads: string[];
  confirmation: WorktreeSettingsView | null;
};

export function worktreeSettingsViews(state: WorkspaceState, busy: Set<string>): WorktreeSettingsView[] | null {
  if (state.managedWorktrees === null) return null;
  const onDisk = new Map(state.managedWorktrees.map((worktree) => [worktree.root, worktree]));
  const projectsById = new Map(state.projects.map((project) => [project.id, project]));
  const projectsByRoot = new Map(state.projects.map((project) => [project.root, project]));
  const recordsByRoot = new Map(state.worktrees.map((worktree) => [worktree.root, worktree]));
  const recordsById = new Map(state.worktrees.map((worktree) => [worktree.id, worktree]));
  const threadsByWorktree = new Map<string, WorktreeSettingsView["threads"]>();
  for (const thread of state.threads) {
    if (!thread.worktreeId) continue;
    const threads = threadsByWorktree.get(thread.worktreeId) ?? [];
    threads.push({ id: thread.id, title: thread.title, archived: thread.archivedAt !== undefined });
    threadsByWorktree.set(thread.worktreeId, threads);
  }
  const directories = [
    ...state.managedWorktrees,
    ...state.worktrees.flatMap((worktree): ManagedWorktree[] => onDisk.has(worktree.root) ? [] : [{
      id: worktree.id,
      root: worktree.root,
      repository: projectsById.get(worktree.projectId)?.root ?? null,
      branch: null,
      status: { changedFiles: null, comparison: null },
    }]),
  ];
  const deleting = new Set(state.deletingWorktrees);
  const releasing = new Set(state.releasingWorktrees);
  return directories.map((directory): WorktreeSettingsView => {
    const record = recordsByRoot.get(directory.root) ?? recordsById.get(directory.id);
    const threads = threadsByWorktree.get(record?.id ?? directory.id) ?? [];
    const project = record ? projectsById.get(record.projectId) : projectsByRoot.get(directory.repository ?? "");
    const name = directory.root.split("/").filter(Boolean).at(-1) ?? directory.id;
    return {
      ...directory,
      name,
      title: record?.name ?? directory.branch ?? threads[0]?.title ?? name,
      project: project ? projectName(project) : directory.repository?.split("/").filter(Boolean).at(-1) ?? "Unknown project",
      projectKey: project?.id ?? directory.repository ?? "unknown",
      available: onDisk.has(directory.root),
      recorded: Boolean(record),
      threads,
      busy: threads.some((thread) => busy.has(thread.id)),
      deleting: deleting.has(directory.root) || threads.some((thread) => releasing.has(thread.id)),
    };
  }).sort((left, right) => left.project.localeCompare(right.project) || left.title.localeCompare(right.title) || left.root.localeCompare(right.root));
}

export function worktreeSettingsPage(state: WorkspaceState, worktrees: WorktreeSettingsView[] | null): WorktreeSettingsPage {
  const { project, confirming, missingOpen, expandedThreads } = state.worktreeSettings;
  const projects = new Map(state.projects.map((item) => [item.id, { key: item.id, name: projectName(item), count: 0 }]));
  for (const worktree of worktrees ?? []) {
    const option = projects.get(worktree.projectKey) ?? { key: worktree.projectKey, name: worktree.project, count: 0 };
    option.count++;
    projects.set(option.key, option);
  }
  const selected = project && projects.has(project) ? project : null;
  const visible = (worktrees ?? []).filter((worktree) => selected === null || worktree.projectKey === selected);
  const available = visible.filter((worktree) => worktree.available);
  const missing = visible.filter((worktree) => !worktree.available);
  const confirmation = visible.find((worktree) => worktree.root === confirming && !worktree.deleting) ?? null;
  return {
    loading: state.worktreeManagementLoading,
    total: worktrees?.length ?? 0,
    project: selected,
    projects: [...projects.values()].sort((left, right) => left.name.localeCompare(right.name)),
    available,
    missing,
    missingOpen: missingOpen ?? (!available.length && missing.length > 0),
    expandedThreads,
    confirmation,
  };
}
