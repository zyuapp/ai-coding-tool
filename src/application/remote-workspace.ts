import { emptyWorkspaceState, type SideChat, type WorkspaceState } from "./workspace-state.js";
import { EMPTY_DOCK } from "./workspace-dock.js";
import { applyWorkspacePatches } from "./workspace-patches.js";
import type { ComputerWorkspaceUpdate } from "../contracts/computers.js";
import type { Thread } from "../domain/thread.js";
import type { Project } from "../domain/project.js";

const REQUIRED_TEXT = Symbol("required text");
type RecordDefaults<T> = { [K in keyof T as {} extends Pick<T, K> ? never : K]: T[K] | typeof REQUIRED_TEXT };

/** Required identity cannot be invented. Other required fields must declare an older-host default;
 * adding a required field to these records fails type checking until that decision is made here. */
const THREAD_DEFAULTS = {
  id: REQUIRED_TEXT, title: "Untitled thread", executionPolicy: "confirm", engine: REQUIRED_TEXT,
  messages: [], continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 0 }, updatedAt: 0,
} satisfies RecordDefaults<Thread>;
const PROJECT_DEFAULTS = { id: REQUIRED_TEXT, root: REQUIRED_TEXT } satisfies RecordDefaults<Project>;
const SIDE_CHAT_DEFAULTS = { id: REQUIRED_TEXT, sourceThreadId: REQUIRED_TEXT, error: null } satisfies RecordDefaults<SideChat>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Set);
}

/** Keeps wire revisions separate from the normalized view. A missing revision asks for a snapshot;
 * incompatible snapshot data throws so the connection can report a useful error instead of looping. */
export function createRemoteWorkspaceReplica() {
  const read = createRemoteWorkspaceReader();
  let wire: unknown = null;
  let revision = -1;
  return (update: ComputerWorkspaceUpdate): WorkspaceState | "resync" | null => {
    if ("state" in update) wire = update.state;
    else if (wire && update.revision === revision + 1) {
      try { wire = applyWorkspacePatches(wire, update.patches); }
      catch { return "resync"; }
    } else if (update.revision <= revision) return null;
    else return "resync";
    const state = read(wire);
    revision = update.revision;
    return state;
  };
}

/** One reader per connection. Defaults live with the state they describe, so a new state field
 * automatically has a value when an older host omits it. Renamed fields need a translation here.
 * The socket keeps its original replica: defaults must never change where wire patches apply. */
export function createRemoteWorkspaceReader() {
  const defaults = emptyWorkspaceState();
  const normalized = new WeakMap<object, Map<object, object>>();

  function remember(value: object, template: object, result: object) {
    let variants = normalized.get(value);
    if (!variants) { variants = new Map(); normalized.set(value, variants); }
    variants.set(template, result);
  }

  function fill(value: unknown, template: unknown): unknown {
    if (template === REQUIRED_TEXT) {
      if (typeof value !== "string" || !value) throw new Error("Missing remote workspace identity.");
      return value;
    }
    if (value === undefined) return template;
    if (template === null || template === undefined) return value;
    if (Array.isArray(template)) {
      if (!Array.isArray(value)) throw new Error("Invalid remote workspace collection.");
      return value;
    }
    if (template instanceof Set) {
      if (!(value instanceof Set)) throw new Error("Invalid remote workspace set.");
      return value;
    }
    if (!record(template)) {
      if (typeof value !== typeof template) throw new Error("Invalid remote workspace field.");
      return value;
    }
    if (!record(value)) throw new Error("Invalid remote workspace record.");
    const cached = normalized.get(value)?.get(template);
    if (cached) return cached;
    let result = value;
    for (const [key, fallback] of Object.entries(template)) {
      const next = fill(value[key], fallback);
      if (next === value[key]) continue;
      if (result === value) result = { ...value };
      result[key] = next;
    }
    remember(value, template, result);
    return result;
  }

  function items<T>(values: T[], template: object): T[] {
    const cached = normalized.get(values)?.get(template);
    if (cached) return cached as T[];
    let result = values;
    for (let index = 0; index < values.length; index++) {
      if (!record(values[index])) throw new Error("Invalid remote workspace item.");
      const next = fill(values[index], template) as T;
      if (next === values[index]) continue;
      if (result === values) result = values.slice();
      result[index] = next;
    }
    remember(values, template, result);
    return result;
  }

  const docks = new WeakMap<object, WorkspaceState["docks"]>();
  const views = new WeakMap<object, WorkspaceState>();
  return (wire: unknown): WorkspaceState => {
    if (!record(wire)) throw new Error("Invalid remote workspace.");
    const cached = views.get(wire);
    if (cached) return cached;
    const state = fill(wire, defaults) as WorkspaceState;
    let nextDocks = docks.get(state.docks);
    if (!nextDocks) {
      nextDocks = state.docks;
      for (const [id, dock] of Object.entries(state.docks)) {
        const next = fill(dock, EMPTY_DOCK) as typeof dock;
        if (next === dock) continue;
        if (nextDocks === state.docks) nextDocks = { ...state.docks };
        nextDocks[id] = next;
      }
      docks.set(state.docks, nextDocks);
    }
    const threads = items(state.threads, THREAD_DEFAULTS);
    const projects = items(state.projects, PROJECT_DEFAULTS);
    const sideChats = items(state.sideChats, SIDE_CHAT_DEFAULTS);
    const result = nextDocks === state.docks && threads === state.threads && projects === state.projects && sideChats === state.sideChats
      ? state : { ...state, docks: nextDocks, threads, projects, sideChats };
    views.set(wire, result);
    return result;
  };
}
