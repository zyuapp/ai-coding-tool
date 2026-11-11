/** How a slice's reducer answers when it changes only the state it owns, which the compiler holds it to. */
import type { WorkspaceEffect, WorkspaceTransition } from "./types.js";
import type { DocksEdit } from "./dock-tabs.js";
import type { ComposerEdit } from "../composer-drafts.js";
import type { ToastsEdit } from "../toasts.js";
import type { ThreadsEdit } from "./thread-edits.js";
import type { RunsEdit } from "./run-edits.js";
import type { EnginesEdit } from "../engine-access.js";
import type { WorktreesEdit } from "./worktree-claims.js";
import type { NavigationEdit } from "./thread-select.js";
import type { DialogsEdit } from "../workspace-dialogs.js";
import type { ProjectsEdit } from "../project-commands.js";
import type { ComputersEdit } from "../computers.js";
import type { SettingsEdit } from "./settings.js";
import type { ComputerUseEdit } from "./computer-use.js";
import type { DesktopEdit } from "./desktop.js";
import type { GitEdit } from "./environment.js";
import type { SideChatsEdit } from "./side-chat-edits.js";
import type { AutomationsEdit } from "./automation-edits.js";
import type { BrowserEdit } from "./browser-tabs.js";
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
export type OwnerEdit<Facet = Record<never, never>> =
  | DocksEdit | ComposerEdit | ToastsEdit | ThreadsEdit<Facet> | RunsEdit | EnginesEdit | WorktreesEdit | NavigationEdit | DialogsEdit
  | ProjectsEdit | ComputersEdit | SettingsEdit | ComputerUseEdit | DesktopEdit | GitEdit
  | SideChatsEdit | AutomationsEdit | BrowserEdit;

/**
 * Every field of an owner's state, taken from `state`: what that owner's edit starts from. Naming one
 * field too few or too many does not compile.
 */
export function ownFields<View>(state: View, fields: { readonly [Field in keyof View]-?: true }): View {
  const view: Partial<View> = {};
  for (const field of Object.keys(fields) as (keyof View)[]) view[field] = state[field];
  return view as View;
}

/** `Facet` is the fields the slice keeps on threads: the only ones its thread edits may patch directly. */
export type SliceTransition<Own, Facet = Record<never, never>> = {
  patch?: OwnPatch<Own>;
  /** Joined in after the patch, in this order. One that changes nothing leaves the state as it was. */
  edits?: OwnerEdit<Facet>[];
  /** An owner function's own answer is no slice's answer: the edit it holds goes in `edits`. */
  docks?: never;
  toasts?: never;
  engines?: never;
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
  /** A slice never hands back a whole state. */
  state?: never;
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
  return inTurn(state, first, [next]);
}

/** {@link andThen} for any number of steps, each made on the state the ones before it leave. */
export function inTurn<Facet>(state: WorkspaceState, first: Step<Facet>, next: Iterable<(state: WorkspaceState) => Step<Facet>>): Step<Facet> {
  let current = state;
  let last = first;
  let joined = first;
  for (const step of next) {
    if (joined.refusal !== undefined) return joined;
    current = afterward(current, last);
    last = step(current);
    joined = followed(joined, last);
  }
  return joined;
}

function followed<Facet>(first: Step<Facet>, second: Step<Facet>): Step<Facet> {
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
