import type { ProjectCommand, ViewCommand } from "../contracts/commands.js";
import { legacyProjectId, sameRoot } from "../domain/project.js";
import type { WorkspaceRecord } from "../domain/workspace.js";
import { moveProject as moveProjectInList, nameProject, nextProjectSortIndex } from "./project-order.js";
import type { WorkspaceState } from "./workspace-state.js";

/** What opening a folder answered with, which is the only thing that ever moves a project into one. */
export type ProjectEvent =
  | { type: "project.opened"; workspace: WorkspaceRecord }
  /** The folder a project was moved to, now open. The project keeps its id, so its threads move with it. */
  | { type: "project.registered"; projectId: string; workspace: WorkspaceRecord }
  | { type: "project.register-failed"; projectId: string; message: string };

/** Opens a folder the user named rather than picked, which is the only thing that checks it is one. */
export type RegisterProjectEffect = { type: "register-project"; projectId: string; root: string };

/** Everything that touches only the sidebar's folders: which there are, what they are called, where they point. */
export type ProjectInput =
  | Extract<ProjectCommand, { type: "project.edit" } | { type: "project.move" }>
  | Extract<ViewCommand, { type: "view.edit-project" } | { type: "view.toggle-project" }>
  | ProjectEvent;

type ProjectTransition = { state: WorkspaceState; effects: RegisterProjectEffect[] };

function settled(state: WorkspaceState, effects: RegisterProjectEffect[] = []): ProjectTransition {
  return { state, effects };
}

export function reduceProjects(state: WorkspaceState, input: ProjectInput): ProjectTransition {
  switch (input.type) {
    case "project.opened": {
      /** A project that was moved no longer goes by the id its folder makes, so its folder finds it. */
      const existing = state.projects.find((project) => project.id === legacyProjectId(input.workspace.root) || sameRoot(project.root, input.workspace.root));
      const id = existing?.id ?? legacyProjectId(input.workspace.root);
      const projects = existing
        ? state.projects.map((project) => project.id === id ? { ...project, root: input.workspace.root, workspaceId: input.workspace.id } : project)
        : [{ id, root: input.workspace.root, workspaceId: input.workspace.id, sortIndex: nextProjectSortIndex(state.projects) }, ...state.projects];
      return settled({
        ...state,
        projects,
        currentId: null,
        draftProjectId: id,
        lastFolder: input.workspace.root,
        actionError: null,
        expandedProjects: new Set(state.expandedProjects).add(id),
      });
    }

    case "project.edit": {
      const project = state.projects.find((item) => item.id === input.projectId);
      if (!project) return settled(state);
      const root = input.root?.trim();
      /** Only a folder that differs from the one the project already has is worth opening again. */
      if (!root || sameRoot(root, project.root)) {
        return settled({ ...state, projects: nameProject(state.projects, project.id, input.name), projectEdit: null, openMenu: null, actionError: null });
      }
      return settled(
        { ...state, projectEdit: { projectId: project.id, ...(input.name === undefined ? {} : { name: input.name }), saving: true, error: null } },
        [{ type: "register-project", projectId: project.id, root }],
      );
    }

    case "project.registered": {
      const project = state.projects.find((item) => item.id === input.projectId);
      if (!project) return settled({ ...state, projectEdit: null });
      const moved = state.projects.map((item) => item.id === project.id ? { ...item, root: input.workspace.root, workspaceId: input.workspace.id } : item);
      /** A name typed beside the folder lands with it, so a directory that cannot be opened keeps both. */
      const pendingName = state.projectEdit?.projectId === project.id ? state.projectEdit.name : undefined;
      return settled({
        ...state,
        projects: nameProject(moved, project.id, pendingName),
        projectEdit: null,
        lastFolder: state.lastFolder && sameRoot(state.lastFolder, project.root) ? input.workspace.root : state.lastFolder,
        openMenu: null,
        actionError: null,
      });
    }

    case "project.register-failed":
      if (state.projectEdit?.projectId !== input.projectId) return settled({ ...state, actionError: input.message });
      return settled({ ...state, projectEdit: { ...state.projectEdit, saving: false, error: input.message } });

    case "project.move": {
      const projects = moveProjectInList(state.projects, input.projectId, input.index);
      if (projects === state.projects) return settled(state);
      return settled({ ...state, projects, openMenu: null });
    }

    case "view.edit-project": {
      if (!input.projectId) return settled({ ...state, projectEdit: null });
      if (!state.projects.some((project) => project.id === input.projectId)) return settled(state);
      return settled({ ...state, projectEdit: { projectId: input.projectId, saving: false, error: null }, openMenu: null });
    }

    case "view.toggle-project": {
      const expandedProjects = new Set(state.expandedProjects);
      if (expandedProjects.has(input.projectId)) expandedProjects.delete(input.projectId);
      else expandedProjects.add(input.projectId);
      return settled({ ...state, expandedProjects });
    }
  }
}
