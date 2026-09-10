/** The review: which comparison a dock holds, and what Git answers about it. */
import { reduceDock } from "./dock.js";
import { DIFF_PANEL, environmentFor, now, readDiff, readDiffFrom, refreshEnvironment, retainedEnvironments, sameChangedFiles, sameStrings, settled, rejected, focusDockTab, showDockTab, browserEffectsForTab } from "./shared.js";
import type { WorkspaceInput, WorkspaceTransition } from "./types.js";
import { updateThread } from "../thread-run-state.js";
import { threadWorkspaceId } from "../thread-location.js";
import { diffFor, diffMatches, dockFor, dockOwner, foldedOnLoad, retainedViews, withDiff, withDock, type WorkspaceState } from "../workspace-state.js";
import { fileFingerprint, modeForRange, rangeKey } from "../../domain/diff.js";
import { readCommits } from "./diff-commits.js";
import { isCommitHash } from "../../domain/message-artifacts.js";

type DiffInput = Extract<WorkspaceInput, {
  type: "view.refresh-environment" | "diff.toggle" | "diff.refresh" | "diff.open-commit" | "diff.set-range" | "diff.set-collapsed"
    | "diff.set-viewed" | "diff.set-split" | "diff.set-ignore-whitespace" | "diff.loaded" | "environment.updated";
}>;

export function reduceDiffs(state: WorkspaceState, input: DiffInput): WorkspaceTransition {
  switch (input.type) {
    case "diff.open-commit": {
      if (!isCommitHash(input.commit)) return rejected(state, "Invalid commit hash.");
      const thread = state.threads.find((item) => item.id === (input.taskId ?? state.currentId));
      const workspaceId = threadWorkspaceId(state, thread);
      if (!workspaceId) return rejected(state, "Open this thread's project to inspect the commit.");
      const owner = dockOwner(state);
      const dock = dockFor(state, owner);
      const opened = withDock(state, owner, { panels: dock.panels.includes(DIFF_PANEL) ? dock.panels : [...dock.panels, DIFF_PANEL] });
      const shown = focusDockTab(showDockTab(opened, owner, DIFF_PANEL), owner, DIFF_PANEL);
      const read = readDiffFrom(shown.state, owner, workspaceId, { kind: "commit", commit: input.commit }, { mode: "commits", result: null, collapsed: [], viewed: {} });
      return { ...read, effects: [...shown.effects, ...browserEffectsForTab(read.state, owner, DIFF_PANEL), ...read.effects] };
    }
    /** A thread with no checkout has nothing to read; what other checkouts said is still theirs. */
    case "view.refresh-environment":
      return settled(state, refreshEnvironment(state));

    case "diff.toggle": {
      const dock = dockFor(state, dockOwner(state));
      const showing = dock.open && dock.tab === DIFF_PANEL;
      return reduceDock(state, showing
        ? { type: "view.close-dock-panel", panel: DIFF_PANEL }
        : { type: "view.open-dock-panel", panel: DIFF_PANEL });
    }

    case "diff.refresh": {
      const owner = dockOwner(state);
      const diff = diffFor(state, owner);
      if (diff.mode === "commits" && diff.range.kind !== "commit") return readCommits(state, owner, { query: "", offset: 0 });
      return readDiff(state, owner, diffFor(state, owner).range);
    }

    case "diff.set-range": {
      const owner = dockOwner(state);
      const diff = diffFor(state, owner);
      if (diff.mode === modeForRange(input.range) && rangeKey(diff.range) === rangeKey(input.range)) return settled(state);
      /** A different comparison is a different set of files, so nothing carries over but the layout. */
      return readDiff(state, owner, input.range, { mode: modeForRange(input.range), result: null, collapsed: [], viewed: {} });
    }

    case "diff.set-collapsed": {
      const owner = dockOwner(state);
      const collapsed = diffFor(state, owner).collapsed;
      return settled(withDiff(state, owner, {
        collapsed: input.collapsed
          ? (collapsed.includes(input.path) ? collapsed : [...collapsed, input.path])
          : collapsed.filter((path) => path !== input.path),
      }));
    }

    case "diff.set-viewed": {
      const owner = dockOwner(state);
      const diff = diffFor(state, owner);
      const file = diff.result?.status === "available" ? diff.result.files.find((item) => item.path === input.path) : undefined;
      if (!file) return settled(state);
      const { [input.path]: _cleared, ...rest } = diff.viewed;
      return settled(withDiff(state, owner, {
        viewed: input.viewed ? { ...rest, [input.path]: fileFingerprint(file) } : rest,
        /** Ticking a file off folds it away, which is what makes working down the list one click. */
        collapsed: input.viewed
          ? (diff.collapsed.includes(input.path) ? diff.collapsed : [...diff.collapsed, input.path])
          : diff.collapsed.filter((path) => path !== input.path),
      }));
    }

    case "diff.set-split":
      return settled(withDiff(state, dockOwner(state), { split: input.split }));

    /** The same comparison counted a different way, so the list is read again and the review stays put. */
    case "diff.set-ignore-whitespace": {
      const owner = dockOwner(state);
      const diff = diffFor(state, owner);
      if (diff.ignoreWhitespace === input.ignore) return settled(state);
      return readDiff(state, owner, diff.range, { ignoreWhitespace: input.ignore });
    }

    case "diff.loaded": {
      const diff = diffFor(state, input.owner);
      if (!diffMatches(diff, input.workspaceId, input.range)) return settled(state);
      /** A list counted the other way was read before the toggle, so it no longer answers anything. */
      if (input.result.status === "available" && input.result.ignoreWhitespace !== diff.ignoreWhitespace) return settled(state);
      const viewed = retainedViews(diff.viewed, input.result, diff.result);
      const listed = input.result.status === "available" ? input.result.files : null;
      return settled(withDiff(state, input.owner, {
        result: input.result,
        loading: false,
        viewed,
        ...(listed ? { collapsed: foldedOnLoad(diff, listed, input.result) } : {}),
      }), [], input.result.status === "error" ? { ok: false, message: input.result.message } : undefined);
    }

    case "environment.updated": {
      const previous = environmentFor(state, input.workspaceId);
      const next: WorkspaceState = sameChangedFiles(previous, input.result)
        ? state
        : { ...state, environments: retainedEnvironments(state, input.workspaceId, input.result) };
      if (input.result.status === "error") return settled(next, [], { ok: false, message: input.result.message });
      /** The checkout is worth recording whoever asked; only the thread's own snapshot is the run's. */
      if (input.runId && input.taskId && state.lastRunIds[input.taskId] !== input.runId) return settled(next);
      if (!input.taskId || input.result.status !== "available") return settled(next);
      const files = input.result.files;
      const thread = state.threads.find((item) => item.id === input.taskId);
      if (!thread || sameStrings(thread.lastChangeSnapshot.files, files)) return settled(next);
      const workspaceId = threadWorkspaceId(state, thread);
      if (workspaceId && workspaceId !== input.workspaceId) return settled(next);
      return settled(updateThread(next, input.taskId, (currentThread) => ({ ...currentThread, lastChangeSnapshot: { files, capturedAt: now() }, updatedAt: now() })));
    }
  }
}
