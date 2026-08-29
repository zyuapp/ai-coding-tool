/** Where the user is looking: history, focus, and the find bar. */
import { refreshEnvironment, searchEffects, settled, stopCapture, stopSearchEffects, TAKE_KEYS } from "./shared.js";
import type { WorkspaceEffect, WorkspaceInput, WorkspaceTransition } from "./types.js";
import { reduceSettings } from "./settings.js";
import { reduceTasks } from "./tasks.js";
import { projectFor } from "../thread-location.js";
import { busyTaskIds, dockHoldsTab, findTargetFor, reachableVisit, type FindState, type WorkspaceState } from "../workspace-state.js";
import { jumpView } from "../workspace-jump.js";
import { refreshEngines } from "../engine-access.js";
import { readAttention } from "../../domain/attention.js";
import { memoizedFindHits, sameFindTarget, searchesItself, stepMatch, type FindResults } from "../../domain/find.js";

/** Whether a report says anything new, so a second pass folding in a patch that changes nothing is free. */
function sameFindResults(held: FindResults | null, reported: FindResults): boolean {
  return held !== null && held.matches === reported.matches && held.index === reported.index && held.counting === reported.counting;
}

type ViewInput = Extract<WorkspaceInput, {
  type: "view.set-menu" | "view.go-back" | "view.go-forward" | "view.set-focused" | "view.dock-keys"
    | "view.find-open" | "view.find-query" | "view.find-step" | "view.find-close" | "find.results"
    | "view.jump-open" | "view.jump-query" | "view.jump-step" | "view.jump-choose"
    | "view.jump-choose-setting" | "view.jump-close"
    | "view.dismiss-computer-use-setup";
}>;

export function reduceView(state: WorkspaceState, input: ViewInput): WorkspaceTransition {
  switch (input.type) {
    case "view.set-menu":
      return settled({ ...state, openMenu: input.menu });

    case "view.go-back":
    case "view.go-forward": {
      const index = reachableVisit(state, input.type === "view.go-back" ? -1 : 1);
      if (index === null) return settled(state);
      const taskId = state.history[index];
      const task = state.tasks.find((item) => item.id === taskId);
      return settled(readAttention({
        ...state,
        historyIndex: index,
        currentId: taskId,
        draftProjectId: task?.projectId ?? null,
        lastFolder: projectFor(state, task)?.root ?? state.lastFolder,
        actionError: null,
      }, taskId));
    }

    /**
     * Git moves while the window is away — in a terminal, an editor, another checkout — so coming back
     * reads it. So does an engine the user has just gone off and installed.
     */
    case "view.set-focused": {
      if (!input.focused) return settled({ ...state, focused: false, capturingShortcut: null }, stopCapture(state));
      const asked = refreshEngines({ ...state, focused: true });
      return settled(readAttention(asked.state, state.currentId), [...refreshEnvironment(state), ...asked.effects]);
    }

    /** A tab the dock in front is not holding is nobody holding the keyboard, which the picker reports too. */
    case "view.dock-keys": {
      const tab = input.tab && dockHoldsTab(state, input.tab) ? input.tab : null;
      return settled(state.keyboardTab === tab ? state : { ...state, keyboardTab: tab });
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
      return settled({ ...state, find, ...(same ? {} : { findResults: null }) }, [
        ...(same ? [] : stopSearchEffects(previous)),
        ...takeKeys,
        ...(same ? [] : searchEffects(find, { findNext: false, forward: true })),
      ]);
    }

    case "view.find-query": {
      if (!state.find) return settled(state);
      const find: FindState = { ...state.find, query: input.query, index: 0 };
      /** An emptied box is no longer searching, so whatever it lit up stops being lit. */
      const effects = find.query.trim() ? searchEffects(find, { findNext: false, forward: true }) : stopSearchEffects(find);
      return settled({ ...state, find, findResults: null }, effects);
    }

    case "view.find-step": {
      const find = state.find;
      if (!find) return settled(state);
      /** A page and a shell keep their own place, so stepping is asked of them. */
      if (searchesItself(find.target)) return settled(state, searchEffects(find, { findNext: true, forward: input.delta === 1 }));
      const target = find.target;
      const matches = target.kind === "thread"
        ? memoizedFindHits(state.tasks.find((item) => item.id === target.taskId)?.messages ?? [], find.query).length
        : state.findResults?.matches ?? 0;
      return settled({ ...state, find: { ...find, index: stepMatch(find.index, input.delta, matches) } });
    }

    case "view.find-close": {
      const focus: WorkspaceEffect[] = state.find?.target.kind === "browser" ? [{ type: "focus-browser", tabId: state.find.target.tabId }] : [];
      return settled({ ...state, find: null, findResults: null }, [...stopSearchEffects(state.find), ...focus]);
    }

    case "find.results": {
      const find = state.find;
      if (!find || !sameFindTarget(find.target, input.target)) return settled(state);
      /**
       * A view the reducer steps may say where the match being read has moved to, because a patch
       * arriving late inserts matches above it; nothing else may move the user's place.
       */
      const moved = !searchesItself(find.target) && input.results.index !== undefined && input.results.index !== find.index
        ? input.results.index
        : null;
      if (moved === null && sameFindResults(state.findResults, input.results)) return settled(state);
      return settled({ ...state, findResults: input.results, ...(moved === null ? {} : { find: { ...find, index: moved } }) });
    }

    /**
     * The panel opens on an empty box and the most recent threads, never on the last search. A page
     * in the panel may be holding the keyboard, and the box is no use without it.
     */
    case "view.jump-open":
      return settled({ ...state, jump: { query: "", index: 0 }, openMenu: null }, TAKE_KEYS);

    case "view.jump-query":
      return settled(state.jump ? { ...state, jump: { query: input.query, index: 0 } } : state);

    case "view.jump-step": {
      const jump = jumpView(state, busyTaskIds(state));
      if (!jump) return settled(state);
      return settled({ ...state, jump: { query: jump.query, index: stepMatch(jump.index, input.delta, jump.options.length) } });
    }

    case "view.jump-choose":
      return reduceTasks({ ...state, jump: null }, { type: "task.select", taskId: input.taskId });

    case "view.jump-choose-setting":
      return reduceSettings({ ...state, jump: null }, { type: "view.set-settings-open", open: true, section: input.section, ...(input.settingId ? { settingId: input.settingId } : {}) });

    case "view.jump-close":
      return settled({ ...state, jump: null });

    case "view.dismiss-computer-use-setup":
      return settled({ ...state, computerUseSetup: false });
  }
}
