/** The review: which comparison a dock holds, and what Git answers about it. */
import { reduceDock } from "./dock.js";
import { DIFF_PANEL, environmentFor, now, readDiff, refreshEnvironment, retainedEnvironments, sameChangedFiles, sameStrings, settled } from "./shared.js";
import type { WorkspaceInput, WorkspaceTransition } from "./types.js";
import { applyTask } from "../task-workspace.js";
import { diffFor, diffMatches, dockFor, dockOwner, retainedViews, withDiff, type WorkspaceState } from "../workspace-state.js";
import { fileFingerprint, rangeKey } from "../../domain/diff.js";

type DiffInput = Extract<WorkspaceInput, {
  type: "view.refresh-environment" | "diff.toggle" | "diff.refresh" | "diff.set-range" | "diff.set-collapsed"
    | "diff.set-viewed" | "diff.set-split" | "diff.loaded" | "environment.updated";
}>;

export function reduceDiffs(state: WorkspaceState, input: DiffInput): WorkspaceTransition {
  switch (input.type) {
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
      return readDiff(state, owner, diffFor(state, owner).range);
    }

    case "diff.set-range": {
      const owner = dockOwner(state);
      if (rangeKey(diffFor(state, owner).range) === rangeKey(input.range)) return settled(state);
      /** A different comparison is a different set of files, so nothing carries over but the layout. */
      return readDiff(state, owner, input.range, { result: null, collapsed: [], viewed: {} });
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

    case "diff.loaded": {
      const diff = diffFor(state, input.owner);
      if (!diffMatches(diff, input.workspaceId, input.range)) return settled(state);
      const viewed = retainedViews(diff.viewed, input.result);
      const present = input.result.status === "available" ? new Set(input.result.files.map((file) => file.path)) : null;
      return settled(withDiff(state, input.owner, {
        result: input.result,
        loading: false,
        viewed,
        /** A file whose tick was dropped changed under the user, so it comes back open to be read again. */
        ...(present ? { collapsed: diff.collapsed.filter((path) => present.has(path) && !(diff.viewed[path] && !viewed[path])) } : {}),
      }));
    }

    case "environment.updated": {
      const previous = environmentFor(state, input.workspaceId);
      const next: WorkspaceState = sameChangedFiles(previous, input.result)
        ? state
        : { ...state, environments: retainedEnvironments(state, input.workspaceId, input.result) };
      /** The checkout is worth recording whoever asked; only the thread's own snapshot is the run's. */
      if (input.runId && input.taskId && state.lastRunIds[input.taskId] !== input.runId) return settled(next);
      if (!input.taskId || input.result.status !== "available") return settled(next);
      const files = input.result.files;
      const task = state.tasks.find((item) => item.id === input.taskId);
      if (!task || sameStrings(task.lastChangeSnapshot.files, files)) return settled(next);
      return settled(applyTask(next, input.taskId, (task) => ({ ...task, lastChangeSnapshot: { files, capturedAt: now() }, updatedAt: now() })));
    }
  }
}
