import { orderProjects } from "./project-order.js";
import { orderThreads, slotThreadIds } from "./thread-order.js";
import { coordinationSections, projectActivity, waitingLine } from "./coordination.js";
import { coordinatedThreadIds, threadsByCoordinator as threadsOfCoordinators, waitingOnUser } from "../domain/coordination.js";
import { SLOT_COUNT } from "../domain/shortcuts.js";
import type { Project } from "../domain/project.js";
import type { SidebarMode, SidebarSections } from "../domain/sidebar.js";
import { threadActivityAt, type Thread } from "../domain/thread.js";
import type { ThreadHost } from "./computers.js";

/** Each computer owns its project order. Keep this computer first and paired computers together. */
function orderSidebarProjects(projects: Project[], hosts?: ReadonlyMap<string, ThreadHost>): Project[] {
  if (!hosts?.size) return orderProjects(projects);
  const groups = new Map<string | undefined, Project[]>([[undefined, []]]);
  for (const project of projects) {
    const computer = hosts.get(project.id)?.id;
    groups.get(computer)?.push(project) ?? groups.set(computer, [project]);
  }
  return [...groups.values()].flatMap(orderProjects);
}

/** What the sidebar draws with: the shape it is in, and which of its lists are folded open. */
export type SidebarPreferences = {
  sidebarMode: SidebarMode;
  sections: SidebarSections;
  expandedProjects: Set<string>;
  /** The one project the activity lists are narrowed to, or null for every project. */
  activityProject: string | null;
  /** The suggestions already starting, which wait on no one. */
  startingProposals: readonly string[];
};

/** Every list the sidebar draws, in the order it draws them. */
export function sidebarLists(
  preferences: SidebarPreferences,
  projects: Project[],
  visibleThreads: Thread[],
  busy: Set<string>,
  blocked: Set<string>,
  projectHosts?: ReadonlyMap<string, ThreadHost>,
) {
  const orderedThreads = orderThreads(visibleThreads);
  /**
   * A thread working under a coordinator is drawn under that coordinator's row, in no list of its own,
   * as is a paired computer's thread a coordinator here started.
   */
  const members = coordinatedThreadIds(visibleThreads);
  const threadsByCoordinator = threadsOfCoordinators(orderedThreads);
  const threadsByProject = new Map<string, Thread[]>();
  for (const thread of orderedThreads) {
    if (!members.has(thread.id) && thread.projectId) threadsByProject.get(thread.projectId)?.push(thread) ?? threadsByProject.set(thread.projectId, [thread]);
  }
  const ordered = orderSidebarProjects(projects.filter((project) => !project.unlisted), projectHosts);
  /** A project no longer listed narrows nothing, so a removed or unreachable one never empties the lists. */
  const activityProject = preferences.activityProject !== null && ordered.some((project) => project.id === preferences.activityProject) ? preferences.activityProject : null;
  /** The same threads ranked by what wants the user, which is the sidebar's other shape. */
  const ranked = coordinationSections(visibleThreads, busy, blocked, preferences.startingProposals);
  /** What each row says waits on the user: a coordinator's for its threads as well as itself, and a thread drawn under one for itself. */
  const waitingLines = new Map<string, string>();
  for (const thread of visibleThreads) {
    const line = waitingLine(waitingOnUser(thread, members.has(thread.id) ? [] : threadsByCoordinator.get(thread.id) ?? [], preferences.startingProposals));
    if (line) waitingLines.set(thread.id, line);
  }
  const activityThreads = activityProject ? projectActivity(ranked, visibleThreads, activityProject) : ranked;
  /** Ranked and stamped by when each chat last did something, so a tick that surfaced nothing moves none of them. */
  const recentThreads = visibleThreads.filter((thread) => !thread.projectId && !members.has(thread.id)).sort((a, b) => threadActivityAt(b) - threadActivityAt(a));
  return {
    projects: ordered,
    orderedThreads,
    threadsByProject,
    threadsByCoordinator,
    waitingLines,
    activityThreads,
    activityProject,
    recentThreads,
    /** The threads ⌘1 through ⌘9 reach, in the order they are drawn. */
    threadSlots: slotThreadIds({
      mode: preferences.sidebarMode,
      sections: preferences.sections,
      projects: ordered.map((project) => ({
        expanded: preferences.expandedProjects.has(project.id),
        threads: threadsByProject.get(project.id) ?? [],
      })),
      recentThreads,
      activityThreads,
    }, SLOT_COUNT),
  };
}
