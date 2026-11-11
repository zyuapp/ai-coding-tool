/** How a slice's reducer answers when it changes only the state it owns, which the compiler holds it to. */
import type { WorkspaceEffect, WorkspaceTransition } from "./types.js";
import type { DocksEdit } from "./dock-tabs.js";
import type { ComposerEdit } from "../composer-drafts.js";
import type { ToastsEdit } from "../toasts.js";
import type { ThreadsEdit } from "./thread-edits.js";
import type { RunsEdit } from "./run-edits.js";
import type { EnginesEdit } from "../engine-access.js";
import type { WorkspaceCommandResult } from "../../contracts/workspace-result.js";
import type { WorkspaceState } from "../workspace-state.js";
import type { SettingsSection } from "../../domain/settings-section.js";
import { viewPreferences } from "../view-preferences.js";

/** Fields of the slice's own state. Naming any other field of the workspace does not compile. */
export type OwnPatch<Own> = Partial<Own> & { [Field in Exclude<keyof WorkspaceState, keyof Own>]?: never };

/**
 * State another owner keeps, as that owner's own functions left it. Each is a value only its owner's
 * functions make, naming only that owner's fields, so a slice changes it through them or not at all.
 */
export type OwnerEdit<Facet = Record<never, never>> = DocksEdit | ComposerEdit | ToastsEdit | ThreadsEdit<Facet> | RunsEdit | EnginesEdit;

/** `Facet` is the fields the slice keeps on threads: the only ones its thread edits may patch directly. */
export type SliceTransition<Own, Facet = Record<never, never>> = {
  patch?: OwnPatch<Own>;
  /** Joined in after the patch, in this order. One that changes nothing leaves the state as it was. */
  edits?: OwnerEdit<Facet>[];
  effects?: WorkspaceEffect[];
  result?: WorkspaceCommandResult;
  /** Turns the input down, saying why where the window shows errors. */
  refusal?: string;
  /** Takes down the error the window shows, which belongs to no slice that asks. */
  clearsError?: true;
  /** Puts up, or takes down, the error the window shows and the settings page that clears it, without refusing the input. */
  error?: { message: string | null; page: SettingsSection | null };
  /** Closes whatever menu is open, which belongs to no slice that asks. */
  closesMenu?: true;
  /** Saves the window's preferences as they stand once the patch is in, after the slice's own effects. */
  persists?: true;
};

/**
 * What one owner's operation changes, which a slice that asks for it carries in its own answer as it
 * is: nothing it changes is a patch, so all of it rides as that owner's edits.
 */
export type Step<Facet = Record<never, never>> = Omit<SliceTransition<Record<never, never>, Facet>, "patch">;

/**
 * `first`, then what `next` makes of the state it leaves, as one answer: edits and effects in that
 * order, the later error and result standing. A refusal ends it there.
 */
export function andThen<Facet>(state: WorkspaceState, first: Step<Facet>, next: (state: WorkspaceState) => Step<Facet>): Step<Facet> {
  if (first.refusal !== undefined) return first;
  const second = next(afterward(state, first));
  const error = second.error ?? (second.clearsError && first.error ? { message: null, page: first.error.page } : second.clearsError ? undefined : first.error);
  const result = second.result ?? first.result;
  return {
    ...(error ? { error } : first.clearsError || second.clearsError ? { clearsError: true as const } : {}),
    edits: [...first.edits ?? [], ...second.edits ?? []],
    effects: [...first.effects ?? [], ...second.effects ?? []],
    ...(result ? { result } : {}),
    ...(second.refusal === undefined ? {} : { refusal: second.refusal }),
    ...(first.closesMenu || second.closesMenu ? { closesMenu: true as const } : {}),
    ...(first.persists || second.persists ? { persists: true as const } : {}),
  };
}

/** Whether a step turned its input down, refusing it or answering that it failed. */
export function failed(step: Step<unknown>): boolean {
  return step.refusal !== undefined || step.result?.ok === false;
}

/** The state a slice's answer leaves, for reading what its own effects describe. */
export function afterward<Own, Facet>(state: WorkspaceState, { patch, edits = [], clearsError, error, closesMenu }: Omit<SliceTransition<Own, Facet>, "effects" | "result" | "refusal" | "persists">): WorkspaceState {
  let next = patch || clearsError || error || closesMenu ? {
    ...state,
    ...patch,
    ...(clearsError ? { actionError: null } : {}),
    ...(error ? { actionError: error.message, actionErrorPage: error.page } : {}),
    ...(closesMenu ? { openMenu: null } : {}),
  } : state;
  for (const edit of edits) {
    if (Object.entries(edit.view).some(([field, value]) => next[field as keyof WorkspaceState] !== value)) next = { ...next, ...edit.view };
  }
  return next;
}

/** A slice's reducer run on the whole state, with its patch joined in. One that changed nothing leaves the state as it was. */
export function owned<Own, Facet, Input>(reducer: (state: WorkspaceState, input: Input) => SliceTransition<Own, Facet>): (state: WorkspaceState, input: Input) => WorkspaceTransition {
  return (state, input) => applied(state, reducer(state, input));
}

/** A slice's answer joined into the state it was given. */
export function applied<Own, Facet>(state: WorkspaceState, transition: SliceTransition<Own, Facet>): WorkspaceTransition {
  const { effects: own = [], refusal, persists } = transition;
  const changed = afterward(state, transition);
  const next = refusal === undefined ? changed : { ...changed, actionError: refusal };
  const effects = persists ? [...own, { type: "persist-preferences" as const, preferences: viewPreferences(next) }] : own;
  const result = refusal === undefined ? transition.result : { ok: false as const, message: refusal };
  return result ? { state: next, effects, result } : { state: next, effects };
}
