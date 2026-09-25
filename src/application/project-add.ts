import type { AppCommand } from "../contracts/commands.js";
import type { WorkspaceRecord } from "../domain/workspace.js";
import { routeInput } from "./computers.js";
import { reduceProjects } from "./project-commands.js";
import type { WorkspaceState } from "./workspace-state.js";
import { settled, rejected } from "./workspace-reducer/shared.js";
import type { WorkspaceTransition } from "./workspace-reducer/types.js";

/** The add dialog belongs to this window even when it is asking another host to open a folder. */
export type ProjectAddState = {
  request: number;
  computerId: string;
  root: string;
  suggestions: string[];
  selected: number;
  saving: boolean;
  error: string | null;
};
export type ProjectAddWorkspaceState = { projectAdd: ProjectAddState | null; projectAddSequence: number };
export const NO_PROJECT_ADD: ProjectAddWorkspaceState = { projectAdd: null, projectAddSequence: 0 };

export type ProjectAddEvent =
  | { type: "project.added"; workspace: WorkspaceRecord; request?: number }
  | { type: "project.add-finished"; request?: number; error?: string }
  | { type: "project.directories"; request: number; directories: string[]; error?: string }
  | { type: "project.path-picked"; request: number; root?: string; error?: string };
export type ProjectAddEffect =
  | { type: "add-project"; root: string; request?: number }
  | { type: "project-add.directories"; prefix: string; computerId: string; request: number }
  | { type: "project-add.pick"; request: number };
type Input = Extract<AppCommand, { type: "project.open" | "project.add" | `view.add-project-${string}` }> | ProjectAddEvent;

function changed(state: WorkspaceState, add: ProjectAddState, query = true): WorkspaceTransition {
  const request = state.projectAddSequence + 1;
  const next = { ...add, request, suggestions: [], selected: -1, error: null };
  return settled({ ...state, projectAddSequence: request, projectAdd: next }, query && next.root
    ? [{ type: "project-add.directories", prefix: next.root, computerId: next.computerId, request }]
    : []);
}

function submit(state: WorkspaceState): WorkspaceTransition {
  const add = state.projectAdd;
  if (!add || add.saving || !add.root.trim()) return settled(state);
  const route = routeInput(state, { type: "project.add", root: add.root.trim(), computerId: add.computerId });
  if (route.kind === "refuse") return settled({ ...state, projectAdd: { ...add, error: route.message } });
  const request = state.projectAddSequence + 1;
  const next = { ...state, projectAddSequence: request, projectAdd: { ...add, request, saving: true, error: null, suggestions: [], selected: -1 } };
  return settled(next, route.kind === "computer"
    ? [{ type: "computer.forward", id: route.computer.id, inputs: route.inputs, projectAddRequest: request }]
    : [{ type: "add-project", root: add.root.trim(), request }]);
}

export function reduceProjectAdd(state: WorkspaceState, input: Input): WorkspaceTransition {
  const add = state.projectAdd;
  switch (input.type) {
    case "project.open":
      if ((state.computers.filter === "all" || state.computers.filter === "this") && !state.computers.paired.some((computer) => computer.status === "connected")) {
        return settled(state, [{ type: "pick-project" }]);
      }
      return changed(state, { request: 0, computerId: state.computers.filter === "all" ? "this" : state.computers.filter, root: "", suggestions: [], selected: -1, saving: false, error: null }, false);
    case "project.add":
      return settled(state, [{ type: "add-project", root: input.root }]);
    case "project.added": {
      const opened = reduceProjects(state, { type: "project.opened", workspace: input.workspace }).state;
      // Registering a folder on a served host must not move its own window away from a thread.
      const next = { ...opened, currentId: state.currentId, draftProjectId: state.draftProjectId };
      return settled(input.request !== undefined && add?.request === input.request ? { ...next, projectAdd: null } : next);
    }
    case "project.add-finished": {
      if (input.request === undefined) return input.error ? rejected(state, input.error) : settled(state);
      if (add?.request !== input.request) return { state, effects: [], result: input.error ? { ok: false, message: input.error } : { ok: true } };
      const next = { ...state, projectAdd: input.error ? { ...add, saving: false, error: input.error } : null };
      return { state: next, effects: [], result: input.error ? { ok: false, message: input.error } : { ok: true } };
    }
    case "view.add-project-close":
      return settled({ ...state, projectAdd: null });
    case "view.add-project-device":
      if (!add || add.saving) return settled(state);
      if (input.computerId !== "this" && !state.computers.paired.some((computer) => computer.id === input.computerId && computer.status === "connected")) return settled(state);
      return changed(state, { ...add, computerId: input.computerId, root: "" }, false);
    case "view.add-project-path":
      return !add || add.saving ? settled(state) : changed(state, { ...add, root: input.root });
    case "view.add-project-pick":
      return !add || add.saving || add.computerId !== "this" ? settled(state) : settled(state, [{ type: "project-add.pick", request: add.request }]);
    case "project.path-picked":
      if (!add || add.request !== input.request || add.saving) return settled(state);
      if (input.error) return settled({ ...state, projectAdd: { ...add, error: input.error } });
      return input.root === undefined ? settled(state) : changed(state, { ...add, root: input.root }, false);
    case "project.directories":
      if (!add || add.request !== input.request || add.saving) return settled(state);
      return settled({ ...state, projectAdd: { ...add, suggestions: input.directories, selected: -1, error: input.error ?? null } });
    case "view.add-project-submit":
      return submit(state);
    case "view.add-project-accept": {
      const root = add?.suggestions[input.index];
      return !add || add.saving || root === undefined ? settled(state) : changed(state, { ...add, root }, false);
    }
    case "view.add-project-key": {
      if (!add) return settled(state);
      if (input.key === "Escape") return add.suggestions.length ? changed(state, add, false) : settled({ ...state, projectAdd: null });
      if (add.saving) return settled(state);
      if (input.key === "ArrowDown" || input.key === "ArrowUp") {
        const length = add.suggestions.length;
        if (!length) return settled(state);
        const selected = add.selected < 0 ? (input.key === "ArrowDown" ? 0 : length - 1) : (add.selected + (input.key === "ArrowDown" ? 1 : length - 1)) % length;
        return settled({ ...state, projectAdd: { ...add, selected } });
      }
      if (add.suggestions.length) return reduceProjectAdd(state, { type: "view.add-project-accept", index: Math.max(0, add.selected) });
      return input.key === "Enter" ? submit(state) : settled(state);
    }
  }
}
