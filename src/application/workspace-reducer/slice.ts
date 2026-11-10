/** How a slice's reducer answers when it changes only the state it owns, which the compiler holds it to. */
import type { WorkspaceEffect, WorkspaceTransition } from "./types.js";
import type { DocksEdit } from "./dock-tabs.js";
import type { ComposerEdit } from "../composer-drafts.js";
import type { ToastsEdit } from "../toasts.js";
import type { WorkspaceCommandResult } from "../../contracts/workspace-result.js";
import type { WorkspaceState } from "../workspace-state.js";
import type { SettingsSection } from "../../domain/settings-section.js";
import { viewPreferences } from "../view-preferences.js";

/** Fields of the slice's own state. Naming any other field of the workspace does not compile. */
export type OwnPatch<Own> = Partial<Own> & { [Field in Exclude<keyof WorkspaceState, keyof Own>]?: never };

export type SliceTransition<Own> = {
  patch?: OwnPatch<Own>;
  /** The docks as the dock's own functions left them, for a slice whose pages, shells or panels live in one. */
  docks?: DocksEdit;
  /** The composers as their own functions left them. */
  composer?: ComposerEdit;
  /** The toasts as their own functions left them. */
  toasts?: ToastsEdit;
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

/** The state a slice's answer leaves, for reading what its own effects describe. */
export function afterward<Own>(state: WorkspaceState, { patch, docks, composer, toasts, clearsError, error, closesMenu }: Omit<SliceTransition<Own>, "effects" | "result" | "refusal" | "persists">): WorkspaceState {
  let next = patch || clearsError || error || closesMenu ? {
    ...state,
    ...patch,
    ...(clearsError ? { actionError: null } : {}),
    ...(error ? { actionError: error.message, actionErrorPage: error.page } : {}),
    ...(closesMenu ? { openMenu: null } : {}),
  } : state;
  for (const edit of [docks, composer, toasts]) {
    if (edit && Object.entries(edit.view).some(([field, value]) => next[field as keyof WorkspaceState] !== value)) next = { ...next, ...edit.view };
  }
  return next;
}

/** A slice's reducer run on the whole state, with its patch joined in. One that changed nothing leaves the state as it was. */
export function owned<Own, Input>(reducer: (state: WorkspaceState, input: Input) => SliceTransition<Own>): (state: WorkspaceState, input: Input) => WorkspaceTransition {
  return (state, input) => applied(state, reducer(state, input));
}

/** A slice's answer joined into the state it was given. */
export function applied<Own>(state: WorkspaceState, transition: SliceTransition<Own>): WorkspaceTransition {
  const { effects: own = [], refusal, persists } = transition;
  const changed = afterward(state, transition);
  const next = refusal === undefined ? changed : { ...changed, actionError: refusal };
  const effects = persists ? [...own, { type: "persist-preferences" as const, preferences: viewPreferences(next) }] : own;
  const result = refusal === undefined ? transition.result : { ok: false as const, message: refusal };
  return result ? { state: next, effects, result } : { state: next, effects };
}
