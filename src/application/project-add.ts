import type { AppCommand } from "../contracts/commands.js";
import { sameRoot } from "../domain/project.js";
import type { WorkspaceRecord } from "../domain/workspace.js";
import { computersOf, routeInput, shownIn } from "./computers.js";
import { openedIn, projectOpened, projectsOf } from "./project-commands.js";
import { andThen, type SliceTransition, type Step } from "./workspace-reducer/slice.js";
import { newThread } from "./workspace-reducer/thread-commands.js";
import { folderOpenedIn, navigationOf } from "./workspace-reducer/thread-select.js";
import type { WorkspaceState } from "./workspace-state.js";

/** The add dialog belongs to this window even when it is asking another host to open a folder. */
export type ProjectAddState = {
  request: number;
  computerId: string;
  root: string;
  suggestions: string[];
  selected: number;
  saving: boolean;
  error: string | null;
  /** Asked for to start a thread in, which opens a draft there instead of only listing the folder. */
  start: boolean;
};
export type ProjectAddWorkspaceState = { projectAdd: ProjectAddState | null; projectAddSequence: number };
export const NO_PROJECT_ADD: ProjectAddWorkspaceState = { projectAdd: null, projectAddSequence: 0 };

export type ProjectAddEvent =
  | { type: "project.added"; workspace: WorkspaceRecord; request?: number; start?: true }
  | { type: "project.add-finished"; request?: number; error?: string }
  | { type: "project.directories"; request: number; directories: string[]; error?: string }
  | { type: "project.path-picked"; request: number; root?: string; error?: string };
export type ProjectAddEffect =
  | { type: "add-project"; root: string; request?: number; start?: true }
  | { type: "project-add.directories"; prefix: string; computerId: string; request: number }
  | { type: "project-add.pick"; request: number };
export const PROJECT_ADD_INPUTS = [
  "project.open", "project.add", "project.added", "project.add-finished", "project.directories", "project.path-picked",
  "view.add-project-close", "view.add-project-device", "view.add-project-path", "view.add-project-pick", "view.add-project-submit",
  "view.add-project-key", "view.add-project-accept"
] as const;
type Input = Extract<AppCommand, { type: (typeof PROJECT_ADD_INPUTS)[number] }> | ProjectAddEvent;

type Own = ProjectAddWorkspaceState;

function changed(state: WorkspaceState, add: ProjectAddState, query = true): SliceTransition<Own> {
  const request = state.projectAddSequence + 1;
  const next = { ...add, request, suggestions: [], selected: -1, error: null };
  return {
    patch: { projectAddSequence: request, projectAdd: next },
    ...(query && next.root ? { effects: [{ type: "project-add.directories", prefix: next.root, computerId: next.computerId, request }] } : {}),
  };
}

function submit(state: WorkspaceState): SliceTransition<Own> {
  const add = state.projectAdd;
  if (!add || add.saving || !add.root.trim()) return {};
  const start = add.start ? { start: true as const } : {};
  const route = routeInput(state, { type: "project.add", root: add.root.trim(), computerId: add.computerId, ...start });
  if (route.kind === "refuse") return { patch: { projectAdd: { ...add, error: route.message } } };
  const request = state.projectAddSequence + 1;
  return {
    patch: { projectAddSequence: request, projectAdd: { ...add, request, saving: true, error: null, suggestions: [], selected: -1 } },
    effects: route.kind === "computer"
      ? [{ type: "computer.forward", id: route.computer.id, inputs: route.inputs, projectAddRequest: request }]
      : [{ type: "add-project", root: add.root.trim(), request, ...start }],
  };
}

/** A folder opened to start in lands on a fresh draft there, listed in the sidebar only once a thread starts. */
function startIn(state: WorkspaceState, workspace: WorkspaceRecord): Step {
  return andThen(state, projectOpened(state, workspace, true), (opened) => newThread(opened, opened.draftProjectId ?? undefined));
}

/** A paired computer that opened a folder to start in is put on screen, where its draft now waits. */
function showComputer(state: WorkspaceState, id: string): Step {
  const left = state.computers.active;
  return {
    edits: [shownIn(computersOf(state), id)],
    ...(left && left !== id ? { effects: [{ type: "computer.forward", id: left, inputs: [{ type: "view.set-focused", focused: false }] }] } : {}),
  };
}

export function reduceProjectAdd(state: WorkspaceState, input: Input): SliceTransition<Own> {
  const add = state.projectAdd;
  switch (input.type) {
    case "project.open":
      if (!input.start && (state.computers.filter === "all" || state.computers.filter === "this") && !state.computers.paired.some((computer) => computer.status === "connected")) {
        return { effects: [{ type: "pick-project" }] };
      }
      return changed(state, { request: 0, computerId: state.computers.filter === "all" ? "this" : state.computers.filter, root: "", suggestions: [], selected: -1, saving: false, error: null, start: Boolean(input.start) }, false);
    case "project.add":
      return { effects: [{ type: "add-project", root: input.root, ...(input.start ? { start: true as const } : {}) }] };
    case "project.added": {
      if (input.start) {
        if (input.request === undefined) return startIn(state, input.workspace);
        return add?.request === input.request ? { patch: { projectAdd: null }, ...startIn(state, input.workspace) } : {};
      }
      /** A folder this window's dialog added lands on a draft there, as one picked from the folder panel does. */
      if (input.request !== undefined && add?.request === input.request) return { patch: { projectAdd: null }, ...projectOpened(state, input.workspace) };
      /** Registering a folder on a served host must not move its own window away from a thread. */
      const opened = openedIn(projectsOf(state), input.workspace);
      return { edits: [opened.projects, folderOpenedIn(navigationOf(state), input.workspace.root)], clearsError: true };
    }
    case "project.add-finished": {
      if (input.request === undefined) return input.error ? { refusal: input.error } : {};
      if (add?.request !== input.request) return { result: input.error ? { ok: false, message: input.error } : { ok: true } };
      if (input.error) return { patch: { projectAdd: { ...add, saving: false, error: input.error } }, result: { ok: false, message: input.error } };
      return { patch: { projectAdd: null }, ...(add.start && add.computerId !== "this" ? showComputer(state, add.computerId) : {}), result: { ok: true } };
    }
    case "view.add-project-close":
      return { patch: { projectAdd: null } };
    case "view.add-project-device":
      if (!add || add.saving) return {};
      if (input.computerId !== "this" && !state.computers.paired.some((computer) => computer.id === input.computerId && computer.status === "connected")) return {};
      return changed(state, { ...add, computerId: input.computerId, root: "" }, false);
    case "view.add-project-path":
      return !add || add.saving ? {} : changed(state, { ...add, root: input.root });
    case "view.add-project-pick":
      return !add || add.saving || add.computerId !== "this" ? {} : { effects: [{ type: "project-add.pick", request: add.request }] };
    case "project.path-picked":
      if (!add || add.request !== input.request || add.saving) return {};
      if (input.error) return { patch: { projectAdd: { ...add, error: input.error } } };
      return input.root === undefined ? {} : changed(state, { ...add, root: input.root }, false);
    case "project.directories":
      if (!add || add.request !== input.request || add.saving) return {};
      return { patch: { projectAdd: { ...add, suggestions: input.directories, selected: -1, error: input.error ?? null } } };
    case "view.add-project-submit":
      return submit(state);
    case "view.add-project-accept": {
      const root = add?.suggestions[input.index];
      return !add || add.saving || root === undefined ? {} : changed(state, { ...add, root }, false);
    }
    case "view.add-project-key": {
      if (!add) return {};
      if (input.key === "Escape") return add.suggestions.length ? changed(state, add, false) : { patch: { projectAdd: null } };
      if (add.saving) return {};
      if (input.key === "ArrowDown" || input.key === "ArrowUp") {
        const length = add.suggestions.length;
        if (!length) return {};
        const selected = add.selected < 0 ? (input.key === "ArrowDown" ? 0 : length - 1) : (add.selected + (input.key === "ArrowDown" ? 1 : length - 1)) % length;
        return { patch: { projectAdd: { ...add, selected } } };
      }
      /** A path typed out in full is submitted rather than completed to itself. */
      const typed = input.key === "Enter" && add.selected < 0 && add.suggestions.some((root) => sameRoot(root, add.root));
      if (add.suggestions.length && !typed) return reduceProjectAdd(state, { type: "view.add-project-accept", index: Math.max(0, add.selected) });
      return input.key === "Enter" ? submit(state) : {};
    }
  }
}
