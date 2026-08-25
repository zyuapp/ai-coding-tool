/** Where the user is looking: history, focus, and the find bar. */
import { searchEffects, settled, stopCapture, stopSearchEffects } from "./shared.js";
import type { WorkspaceEffect, WorkspaceInput, WorkspaceTransition } from "./types.js";
import { findTargetFor, projectFor, reachableVisit, type FindState, type WorkspaceState } from "../workspace-state.js";
import { readAttention } from "../../domain/attention.js";
import { memoizedFindHits, sameFindTarget, stepMatch } from "../../domain/find.js";

type ViewInput = Extract<WorkspaceInput, {
  type: "view.set-menu" | "view.go-back" | "view.go-forward" | "view.set-focused" | "view.find-open"
    | "view.find-query" | "view.find-step" | "view.find-close" | "find.results" | "view.dismiss-computer-use-setup";
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

    case "view.set-focused":
      return input.focused
        ? settled(readAttention({ ...state, focused: true }, state.currentId))
        : settled({ ...state, focused: false, capturingShortcut: null }, stopCapture(state));

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
      if (find.target.kind !== "transcript") return settled(state, searchEffects(find, { findNext: true, forward: input.delta === 1 }));
      const task = state.tasks.find((item) => item.id === state.currentId);
      const matches = memoizedFindHits(task?.messages ?? [], find.query).length;
      return settled({ ...state, find: { ...find, index: stepMatch(find.index, input.delta, matches) } });
    }

    case "view.find-close": {
      const focus: WorkspaceEffect[] = state.find?.target.kind === "browser" ? [{ type: "focus-browser", tabId: state.find.target.tabId }] : [];
      return settled({ ...state, find: null, findResults: null }, [...stopSearchEffects(state.find), ...focus]);
    }

    case "find.results": {
      const find = state.find;
      if (!find || !sameFindTarget(find.target, input.target)) return settled(state);
      return settled({ ...state, findResults: input.results });
    }

    case "view.dismiss-computer-use-setup":
      return settled({ ...state, computerUseSetup: false });
  }
}
