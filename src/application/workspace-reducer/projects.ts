/** The project folders the app is open on. */
import { PROJECT_WORKTREES_ERROR, RUNNING_PROJECT_ERROR, now, retireAutomations, settled, rejected } from "./shared.js";
import type { WorkspaceInput, WorkspaceTransition } from "./types.js";
import { reduceProjects } from "../project-commands.js";
import type { WorkspaceState } from "../workspace-state.js";

type ProjectInput = Extract<WorkspaceInput, {
  type: "project.open" | "project.opened" | "project.edit" | "project.registered" | "project.register-failed"
    | "project.move" | "view.edit-project" | "view.toggle-project" | "project.remove";
}>;

export function reduceProjectCommands(state: WorkspaceState, input: ProjectInput): WorkspaceTransition {
  switch (input.type) {
    case "project.open":
      return settled(state, [{ type: "pick-project" }]);

    case "project.opened":
    case "project.edit":
    case "project.registered":
    case "project.register-failed":
    case "project.move":
    case "view.edit-project":
    case "view.toggle-project":
      return reduceProjects(state, input);

    case "project.remove": {
      if (state.threads.some((thread) => thread.projectId === input.projectId && state.activeRuns[thread.id])) {
        return rejected(state, RUNNING_PROJECT_ERROR);
      }
      if (state.worktrees.some((worktree) => worktree.projectId === input.projectId)) {
        return rejected(state, PROJECT_WORKTREES_ERROR);
      }
      const leaving = state.threads.filter((thread) => thread.projectId === input.projectId);
      const effects = retireAutomations(state, leaving.map((thread) => thread.id));
      const project = state.projects.find((item) => item.id === input.projectId);
      const expandedProjects = new Set(state.expandedProjects);
      expandedProjects.delete(input.projectId);
      return settled({
        ...state,
        projects: state.projects.filter((item) => item.id !== input.projectId),
        threads: state.threads.map((thread) => {
          if (thread.projectId !== input.projectId) return thread;
          const { projectId: _removed, ...projectlessThread } = thread;
          return thread.archivedAt === undefined ? { ...projectlessThread, archivedAt: now() } : projectlessThread;
        }),
        currentId: state.threads.find((thread) => thread.id === state.currentId)?.projectId === input.projectId ? null : state.currentId,
        draftProjectId: state.draftProjectId === input.projectId ? null : state.draftProjectId,
        lastFolder: project?.root === state.lastFolder ? null : state.lastFolder,
        expandedProjects,
        projectEdit: state.projectEdit?.projectId === input.projectId ? null : state.projectEdit,
        openMenu: null,
        actionError: null,
      }, effects);
    }
  }
}
