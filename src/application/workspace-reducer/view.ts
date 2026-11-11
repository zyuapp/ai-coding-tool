/** Where the user is looking: history, focus, and the find bar. */
import { computerUseOf, setupShownIn } from "./computer-use.js";
import { desktopOf, focusedIn } from "./desktop.js";
import { TAKE_KEYS, docksOf, keyboardTabIn } from "./dock-tabs.js";
import { refreshEnvironment } from "./environment.js";
import { searchEffects, stopSearchEffects } from "./find.js";
import { followUps } from "./shared.js";
import type { WorkspaceEffect, WorkspaceInput } from "./types.js";
import { captureStoppedIn, settingsOf, settingsShown, stopCapture } from "./settings.js";
import type { SliceTransition } from "./slice.js";
import { rowReadIn, threadsOf } from "./thread-edits.js";
import { selected, visited } from "./thread-select.js";
import { selectedComputer } from "../state/computers.js";
import type { FindBarState } from "../state/find.js";
import { dialogsOf, menuIn } from "../workspace-dialogs.js";
import { dockHoldsTab, reachableVisit, type FindState, type WorkspaceState } from "../workspace-state.js";
import { findTargetFor } from "../workspace-find.js";
import { jumpView } from "../workspace-jump.js";
import { zenAllowed } from "../workspace-zen.js";
import { composerOf, focusComposerIn } from "../composer-drafts.js";
import { threadActivity } from "../thread-activity.js";
import { enginesOf, refreshedEnginesIn } from "../engine-access.js";
import { memoizedFindHits, sameFindTarget, searchesItself, stepMatch, type FindResults } from "../../domain/find.js";

/** Whether a report says anything new, so a second pass folding in a patch that changes nothing is free. */
function sameFindResults(held: FindResults | null, reported: FindResults): boolean {
  return held !== null && held.matches === reported.matches && held.index === reported.index && held.counting === reported.counting;
}

export const VIEW_INPUTS = [
  "view.set-menu", "view.go-back", "view.go-forward", "view.set-focused", "view.dock-keys", "view.find-open", "view.find-query", "view.find-step",
  "view.find-close", "find.results", "view.jump-open", "view.jump-query", "view.jump-step", "view.jump-choose", "view.jump-choose-setting",
  "view.jump-close", "view.set-zen", "view.dismiss-computer-use-setup"
] as const;
type ViewInput = Extract<WorkspaceInput, { type: (typeof VIEW_INPUTS)[number] }>;

export function reduceView(state: WorkspaceState, input: ViewInput): SliceTransition<FindBarState> {
  switch (input.type) {
    case "view.set-menu":
      return { edits: [menuIn(dialogsOf(state), input.menu)] };

    case "view.go-back":
    case "view.go-forward": {
      const index = reachableVisit(state, input.type === "view.go-back" ? -1 : 1);
      return index === null ? {} : visited(state, index);
    }

    /**
     * Git moves while the window is away — in a terminal, an editor, another checkout — so coming back
     * reads it. So does an engine the user has just gone off and installed.
     */
    case "view.set-focused": {
      if (!input.focused) return { edits: [focusedIn(desktopOf(state), false), captureStoppedIn(settingsOf(state))], effects: stopCapture(state) };
      const asked = refreshedEnginesIn(enginesOf(state));
      /** With a paired computer's thread on screen, none of this computer's own has been looked at. */
      return {
        edits: [focusedIn(desktopOf(state), true), asked.engines, rowReadIn(threadsOf(state), selectedComputer(state) ? null : state.currentId)],
        effects: [...followUps(refreshEnvironment(state)), ...asked.effects],
      };
    }

    /** A tab the dock in front is not holding is nobody holding the keyboard, which the picker reports too. */
    case "view.dock-keys": {
      const tab = input.tab && dockHoldsTab(state, input.tab) ? input.tab : null;
      return state.keyboardTab === tab ? {} : { edits: [keyboardTabIn(docksOf(state), tab)] };
    }

    case "view.find-open": {
      const target = input.target ?? state.find?.target ?? findTargetFor(state, "any");
      const previous = state.find;
      const same = previous && sameFindTarget(previous.target, target);
      const find: FindState = {
        target,
        query: previous?.query ?? "",
        index: same ? previous.index : 0,
        focus: (previous?.focus ?? 0) + 1,
      };
      /** A page in the panel holds the keyboard, and the bar is no use without it. */
      const takeKeys: WorkspaceEffect[] = target.kind === "browser" ? [{ type: "focus-window" }] : [];
      return {
        patch: { find, ...(same ? {} : { findResults: null }) },
        effects: [
          ...(same ? [] : stopSearchEffects(previous)),
          ...takeKeys,
          ...(same ? [] : searchEffects(find, { findNext: false, forward: true })),
        ],
      };
    }

    case "view.find-query": {
      if (!state.find) return {};
      const find: FindState = { ...state.find, query: input.query, index: 0 };
      /** An emptied box is no longer searching, so whatever it lit up stops being lit. */
      const effects = find.query.trim() ? searchEffects(find, { findNext: false, forward: true }) : stopSearchEffects(find);
      return { patch: { find, findResults: null }, effects };
    }

    case "view.find-step": {
      const find = state.find;
      if (!find) return {};
      /** A page and a shell keep their own place, so stepping is asked of them. */
      if (searchesItself(find.target)) return { effects: searchEffects(find, { findNext: true, forward: input.delta === 1 }) };
      const target = find.target;
      const matches = target.kind === "thread"
        ? memoizedFindHits(state.threads.find((item) => item.id === target.taskId)?.messages ?? [], find.query).length
        : state.findResults?.matches ?? 0;
      return { patch: { find: { ...find, index: stepMatch(find.index, input.delta, matches) } } };
    }

    case "view.find-close": {
      const focus: WorkspaceEffect[] = state.find?.target.kind === "browser" ? [{ type: "focus-browser", tabId: state.find.target.tabId }] : [];
      return { patch: { find: null, findResults: null }, effects: [...stopSearchEffects(state.find), ...focus] };
    }

    case "find.results": {
      const find = state.find;
      if (!find || !sameFindTarget(find.target, input.target)) return {};
      /**
       * A view the reducer steps may say where the match being read has moved to, because a patch
       * arriving late inserts matches above it; nothing else may move the user's place.
       */
      const moved = !searchesItself(find.target) && input.results.index !== undefined && input.results.index !== find.index
        ? input.results.index
        : null;
      if (moved === null && sameFindResults(state.findResults, input.results)) return {};
      return { patch: { findResults: input.results, ...(moved === null ? {} : { find: { ...find, index: moved } }) } };
    }

    /**
     * The panel opens on an empty box and the most recent threads, never on the last search. A page
     * in the panel may be holding the keyboard, and the box is no use without it.
     */
    case "view.jump-open":
      return { patch: { jump: { query: "", index: 0 } }, closesMenu: true, effects: TAKE_KEYS };

    case "view.jump-query":
      return state.jump ? { patch: { jump: { query: input.query, index: 0 } } } : {};

    case "view.jump-step": {
      const jump = jumpView(state, threadActivity(state).working);
      if (!jump) return {};
      return { patch: { jump: { query: jump.query, index: stepMatch(jump.index, input.delta, jump.options.length) } } };
    }

    case "view.jump-choose":
      return { patch: { jump: null }, ...selected(state, input.taskId) };

    case "view.jump-choose-setting":
      return { patch: { jump: null }, ...settingsShown(state, true, input.section, input.settingId) };

    case "view.jump-close":
      return { patch: { jump: null } };

    /** The caret comes along, since the composer is all zen mode leaves to type in. */
    case "view.set-zen": {
      if (input.zen && !zenAllowed(state)) return {};
      if (state.zen === input.zen) return {};
      return { patch: { zen: input.zen }, edits: [keyboardTabIn(docksOf(state), null), focusComposerIn(composerOf(state))], effects: TAKE_KEYS };
    }

    case "view.dismiss-computer-use-setup":
      return { edits: [setupShownIn(computerUseOf(state), false)] };
  }
}
