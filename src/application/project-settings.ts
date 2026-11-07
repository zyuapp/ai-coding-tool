import { threadHostOf, type ThreadHost } from "./computers.js";
import { projectName, type Project } from "../domain/project.js";
import type { Thread } from "../domain/thread.js";
import type { WorkspaceState } from "./workspace-state.js";

/** A row on the Projects page: the project, the paired computer holding it, and how many threads removing it archives. */
export type ProjectSettingsRow = { project: Project; host?: ThreadHost; threads: number };

function rowsOf(projects: readonly Project[], threads: readonly Thread[], host?: ThreadHost): ProjectSettingsRow[] {
  const counts = new Map<string, number>();
  for (const thread of threads) {
    if (thread.projectId && thread.archivedAt === undefined) counts.set(thread.projectId, (counts.get(thread.projectId) ?? 0) + 1);
  }
  return projects
    .filter((project) => !project.unlisted)
    .map((project) => ({ project, ...(host ? { host } : {}), threads: counts.get(project.id) ?? 0 }))
    .sort((a, b) => projectName(a.project).localeCompare(projectName(b.project)) || a.project.root.localeCompare(b.project.root));
}

/**
 * Every computer's listed projects, whatever the sidebar is narrowed to: this computer's first, then
 * each paired computer's by name. A side chat counts, since removing its project archives it too.
 */
export function projectSettingsRows(state: Pick<WorkspaceState, "projects" | "threads" | "computers">): ProjectSettingsRow[] {
  const paired = [...state.computers.paired].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return [
    ...rowsOf(state.projects, state.threads),
    ...paired.flatMap((computer) => computer.state ? rowsOf(computer.state.projects, computer.state.threads, threadHostOf(computer)) : []),
  ];
}
