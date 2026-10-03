import type { ProjectCommand, ViewCommand } from "../contracts/commands.js";
import { legacyProjectId, sameRoot } from "../domain/project.js";
import type { WorkspaceRecord } from "../domain/workspace.js";
import { moveProject as moveProjectInList, nameProject, nextProjectSortIndex } from "./project-order.js";
import type { WorkspaceState } from "./workspace-state.js";
import type { WorkspaceCommandResult } from "./workspace-reducer/types.js";

/** What opening a folder answered with, which is the only thing that ever moves a project into one. */
export type ProjectEvent =
  | { type: "project.opened"; workspace: WorkspaceRecord; unlisted?: true }
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

type ProjectTransition = { state: WorkspaceState; effects: RegisterProjectEffect[]; result?: WorkspaceCommandResult };

function settled(state: WorkspaceState, effects: RegisterProjectEffect[] = []): ProjectTransition {
  return { state, effects };
}

export function reduceProjects(state: WorkspaceState, input: ProjectInput): ProjectTransition {
  switch (input.type) {
    case "project.opened": {
      /** A project that was moved no longer goes by the id its folder makes, so its folder finds it. */
      const existing = state.projects.find((project) => project.id === legacyProjectId(input.workspace.root) || sameRoot(project.root, input.workspace.root));
      const id = existing?.id ?? legacyProjectId(input.workspace.root);
      /** Opening a folder outright lists it; opening it only to start a thread leaves a listed one listed. */
      const projects = existing
        ? state.projects.map((project) => {
          if (project.id !== id) return project;
          const { unlisted: _unlisted, ...opened } = { ...project, root: input.workspace.root, workspaceId: input.workspace.id };
          return input.unlisted && project.unlisted ? { ...opened, unlisted: true as const } : opened;
        })
        : [{ id, root: input.workspace.root, workspaceId: input.workspace.id, sortIndex: nextProjectSortIndex(state.projects), ...(input.unlisted ? { unlisted: true as const } : {}) }, ...state.projects];
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

    case "project.register-failed": {
      const result: WorkspaceCommandResult = { ok: false, message: input.message };
      if (state.projectEdit?.projectId !== input.projectId) return { state: { ...state, actionError: input.message }, effects: [], result };
      return { state: { ...state, projectEdit: { ...state.projectEdit, saving: false, error: input.message } }, effects: [], result };
    }

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

/**
 * A project opened only to start a thread joins the sidebar once a thread starts there, and is let
 * go once the draft moves elsewhere without one.
 */
export function settledUnlisted(before: WorkspaceState, state: WorkspaceState): WorkspaceState {
  if (before.threads === state.threads && before.projects === state.projects && before.draftProjectId === state.draftProjectId) return state;
  const unlisted = state.projects.filter((project) => project.unlisted);
  if (!unlisted.length) return state;
  const listed = new Set(unlisted.filter((project) => state.threads.some((thread) => thread.projectId === project.id)).map((project) => project.id));
  const dropped = new Set(unlisted.filter((project) => !listed.has(project.id) && project.id !== state.draftProjectId).map((project) => project.id));
  if (!listed.size && !dropped.size) return state;
  const projects = state.projects.flatMap((project) => {
    if (dropped.has(project.id)) return [];
    if (!listed.has(project.id)) return [project];
    const { unlisted: _unlisted, ...kept } = project;
    return [kept];
  });
  if (!dropped.size) return { ...state, projects };
  /** The last folder comes back listed on launch, so one let go stops being it. */
  const lastFolder = state.projects.some((project) => dropped.has(project.id) && state.lastFolder !== null && sameRoot(project.root, state.lastFolder)) ? null : state.lastFolder;
  return { ...state, projects, lastFolder, expandedProjects: new Set([...state.expandedProjects].filter((id) => !dropped.has(id))) };
}
