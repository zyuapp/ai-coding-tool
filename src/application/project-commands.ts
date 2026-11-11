import type { ProjectCommand, ViewCommand } from "../contracts/commands.js";
import { legacyProjectId, sameRoot } from "../domain/project.js";
import type { WorkspaceRecord } from "../domain/workspace.js";
import { nameProject, nextProjectSortIndex } from "./project-order.js";
import type { WorkspaceState } from "./workspace-state.js";
import type { WorkspaceCommandResult } from "../contracts/workspace-result.js";
import type { ProjectsState } from "./state/projects.js";
import { ownFields, type SliceTransition, type Step } from "./workspace-reducer/slice.js";
import { folderMovedIn, navigationOf, projectOpenedIn } from "./workspace-reducer/thread-select.js";

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
  | Extract<ProjectCommand, { type: "project.edit" }>
  | Extract<ViewCommand, { type: "view.edit-project" }>
  | ProjectEvent;

/** The sidebar's folders as one input leaves them. Only the functions here make one. */
class ProjectsChange {
  private declare readonly owned: never;
  constructor(readonly view: ProjectsState) {}
}

export type ProjectsEdit = ProjectsChange;

export function projectsOf(state: ProjectsState): ProjectsEdit {
  return new ProjectsChange(ownFields<ProjectsState>(state, { projects: true, projectEdit: true }));
}

/**
 * A folder just opened, listed under the project it already is or a new one. A project that was moved
 * no longer goes by the id its folder makes, so its folder finds it. Opening a folder outright lists it;
 * opening it only to start a thread leaves a listed one listed.
 */
export function openedIn(edit: ProjectsEdit, workspace: WorkspaceRecord, unlisted?: true): { projects: ProjectsEdit; id: string } {
  const listed = edit.view.projects;
  const existing = listed.find((project) => project.id === legacyProjectId(workspace.root) || sameRoot(project.root, workspace.root));
  const id = existing?.id ?? legacyProjectId(workspace.root);
  const projects = existing
    ? listed.map((project) => {
      if (project.id !== id) return project;
      const { unlisted: _unlisted, ...opened } = { ...project, root: workspace.root, workspaceId: workspace.id };
      return unlisted && project.unlisted ? { ...opened, unlisted: true as const } : opened;
    })
    : [{ id, root: workspace.root, workspaceId: workspace.id, sortIndex: nextProjectSortIndex(listed), ...(unlisted ? { unlisted: true as const } : {}) }, ...listed];
  return { projects: new ProjectsChange({ ...edit.view, projects }), id };
}

/** A project with no workspace of its own, adopting the one just opened for its folder. */
export function adoptedIn(edit: ProjectsEdit, projectId: string, workspaceId: string): ProjectsEdit {
  return new ProjectsChange({ ...edit.view, projects: edit.view.projects.map((item) => item.id === projectId ? { ...item, workspaceId } : item) });
}

/** A folder opened, with the window on a fresh draft there. */
export function projectOpened(state: WorkspaceState, workspace: WorkspaceRecord, unlisted?: true): Step {
  const opened = openedIn(projectsOf(state), workspace, unlisted);
  return { edits: [opened.projects, projectOpenedIn(navigationOf(state), opened.id, workspace.root)], clearsError: true };
}

export function reduceProjects(state: WorkspaceState, input: ProjectInput): SliceTransition<ProjectsState> {
  switch (input.type) {
    case "project.opened":
      return projectOpened(state, input.workspace, input.unlisted);

    case "project.edit": {
      const project = state.projects.find((item) => item.id === input.projectId);
      if (!project) return {};
      const root = input.root?.trim();
      /** Only a folder that differs from the one the project already has is worth opening again. */
      if (!root || sameRoot(root, project.root)) {
        return { patch: { projects: nameProject(state.projects, project.id, input.name), projectEdit: null }, closesMenu: true, clearsError: true };
      }
      return {
        patch: { projectEdit: { projectId: project.id, ...(input.name === undefined ? {} : { name: input.name }), saving: true, error: null } },
        effects: [{ type: "register-project", projectId: project.id, root }],
      };
    }

    case "project.registered": {
      const project = state.projects.find((item) => item.id === input.projectId);
      if (!project) return { patch: { projectEdit: null } };
      const moved = state.projects.map((item) => item.id === project.id ? { ...item, root: input.workspace.root, workspaceId: input.workspace.id } : item);
      /** A name typed beside the folder lands with it, so a directory that cannot be opened keeps both. */
      const pendingName = state.projectEdit?.projectId === project.id ? state.projectEdit.name : undefined;
      const followed = state.lastFolder && sameRoot(state.lastFolder, project.root);
      return {
        patch: { projects: nameProject(moved, project.id, pendingName), projectEdit: null },
        ...(followed ? { edits: [folderMovedIn(navigationOf(state), input.workspace.root)] } : {}),
        closesMenu: true,
        clearsError: true,
      };
    }

    case "project.register-failed": {
      const result: WorkspaceCommandResult = { ok: false, message: input.message };
      if (state.projectEdit?.projectId !== input.projectId) return { refusal: input.message };
      return { patch: { projectEdit: { ...state.projectEdit, saving: false, error: input.message } }, result };
    }

    case "view.edit-project": {
      if (!input.projectId) return { patch: { projectEdit: null } };
      if (!state.projects.some((project) => project.id === input.projectId)) return {};
      return { patch: { projectEdit: { projectId: input.projectId, saving: false, error: null } }, closesMenu: true };
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
  return { ...state, projects, lastFolder };
}
