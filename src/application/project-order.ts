import type { Project } from "../domain/task.js";

/**
 * Sidebar order. `sortIndex` wins so folders never move on their own; projects stored before
 * sortIndex existed keep the order they were stored in until {@link backfillProjectSortIndex}
 * pins them down.
 */
export function orderProjects(projects: Project[]): Project[] {
  return [...projects].sort((left, right) => {
    if (left.sortIndex !== undefined && right.sortIndex !== undefined) return left.sortIndex - right.sortIndex;
    if (left.sortIndex !== undefined) return -1;
    if (right.sortIndex !== undefined) return 1;
    return 0;
  });
}

/** Freezes the order projects loaded in, so a first launch after upgrading keeps the list the user last saw. */
export function backfillProjectSortIndex(projects: Project[]): Project[] {
  if (projects.every((project) => project.sortIndex !== undefined)) return projects;
  const positions = new Map(orderProjects(projects).map((project, index) => [project.id, index]));
  return projects.map((project) => project.sortIndex === undefined ? { ...project, sortIndex: positions.get(project.id)! } : project);
}

export function nextProjectSortIndex(projects: Project[]): number {
  return Math.min(0, ...projects.map((project) => project.sortIndex ?? 0)) - 1;
}

/**
 * Moves one project to `index` and renumbers the list. `index` counts rows with the moved project
 * already taken out, matching what a drop reports.
 */
export function moveProject(projects: Project[], projectId: string, index: number): Project[] {
  const ordered = orderProjects(projects);
  const from = ordered.findIndex((project) => project.id === projectId);
  if (from === -1) return projects;
  const [moving] = ordered.splice(from, 1);
  ordered.splice(Math.max(0, Math.min(index, ordered.length)), 0, moving!);

  const positions = new Map(ordered.map((project, position) => [project.id, position]));
  const next = projects.map((project) => project.sortIndex === positions.get(project.id)
    ? project
    : { ...project, sortIndex: positions.get(project.id)! });
  return next.some((project, position) => project !== projects[position]) ? next : projects;
}
