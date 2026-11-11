/** The project folders the app is open on. */
import { retireAutomations } from "./automations.js";
import { PROJECT_WORKTREES_ERROR, RUNNING_PROJECT_ERROR } from "./errors.js";
import { now } from "./shared.js";
import type { SliceTransition } from "./slice.js";
import { projectRemovedIn, threadsOf } from "./thread-edits.js";
import { navigationOf, projectLeftIn } from "./thread-select.js";
import type { WorkspaceInput } from "./types.js";
import type { ProjectsState } from "../state/projects.js";
import { reduceProjects } from "../project-commands.js";
import type { WorkspaceState } from "../workspace-state.js";

export const PROJECT_INPUTS = [
  "project.opened", "project.edit", "project.registered", "project.register-failed", "view.edit-project",
  "project.remove"
] as const;
type ProjectInput = Extract<WorkspaceInput, { type: (typeof PROJECT_INPUTS)[number] }>;

export function reduceProjectCommands(state: WorkspaceState, input: ProjectInput): SliceTransition<ProjectsState> {
  switch (input.type) {
    case "project.opened":
    case "project.edit":
    case "project.registered":
    case "project.register-failed":
    case "view.edit-project":
      return reduceProjects(state, input);

    case "project.remove": {
      /** Projects are removed from Settings, so the refusal is shown on that page. */
      const refused = (message: string): SliceTransition<ProjectsState> => ({ error: { message, page: "projects" }, refusal: message });
      if (state.threads.some((thread) => thread.projectId === input.projectId && state.activeRuns[thread.id])) return refused(RUNNING_PROJECT_ERROR);
      if (state.worktrees.some((worktree) => worktree.projectId === input.projectId)) return refused(PROJECT_WORKTREES_ERROR);
      const leaving = state.threads.filter((thread) => thread.projectId === input.projectId);
      const effects = retireAutomations(state, leaving.map((thread) => thread.id));
      const project = state.projects.find((item) => item.id === input.projectId);
      const onScreen = state.threads.find((thread) => thread.id === state.currentId)?.projectId === input.projectId;
      return {
        patch: {
          projects: state.projects.filter((item) => item.id !== input.projectId),
          projectEdit: state.projectEdit?.projectId === input.projectId ? null : state.projectEdit,
        },
        edits: [projectRemovedIn(threadsOf(state), input.projectId, now), projectLeftIn(navigationOf(state), input.projectId, project?.root, onScreen)],
        effects,
        closesMenu: true,
        error: { message: null, page: null },
      };
    }
  }
}
