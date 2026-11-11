/** The review: which comparison a dock holds, and what Git answers about it. */
import { reduceDock } from "./dock.js";
import { browserEffectsForTab } from "./browser-tabs.js";
import { defaultBranchRange, diffRead, diffReadFrom } from "./diff-reads.js";
import { docksOf, editDiff, editDock, focusDockTabIn, showDockTabIn } from "./dock-tabs.js";
import { environmentFor, environmentReadIn, gitOf, refreshEnvironment, sameChangedFiles, subjectWorkspaceId } from "./environment.js";
import { now, sameStrings } from "./shared.js";
import { afterward, andThen, type SliceTransition, type Step } from "./slice.js";
import { editThread, threadsOf } from "./thread-edits.js";
import type { WorkspaceInput } from "./types.js";
import { threadWorkspaceId } from "../thread-location.js";
import { DIFF_PANEL, diffFor, diffMatches, dockFor, dockOwner, dockSubject, foldedOnLoad, retainedViews, type WorkspaceState } from "../workspace-state.js";
import type { RunThread } from "../../domain/thread-run.js";
import { fileFingerprint, modeForRange, rangeKey, UNCOMMITTED } from "../../domain/diff.js";
import { isCommitHash } from "../../domain/message-artifacts.js";
import type { ChangedFilesResult, DiffSummaryResult } from "../../contracts/ipc.js";
import type { DiffRange } from "../../domain/diff.js";

export const DIFF_INPUTS = [
  "view.refresh-environment", "diff.toggle", "diff.refresh", "diff.open-commit", "diff.set-range", "diff.set-collapsed", "diff.set-mode",
  "diff.set-viewed", "diff.set-split", "diff.set-ignore-whitespace", "diff.loaded", "environment.updated"
] as const;
type DiffInput = Extract<WorkspaceInput, { type: (typeof DIFF_INPUTS)[number] }>;

export type DiffEvent =
  | { type: "environment.updated"; workspaceId: string; taskId?: string; runId?: string; result: ChangedFilesResult }
  /** A comparison's file list, named by the dock that asked so a slow read cannot land in another. */
  | { type: "diff.loaded"; owner: string; workspaceId: string; range: DiffRange; result: DiffSummaryResult };

export type DiffEffect =
  | { type: "refresh-environment"; workspaceId: string; taskId?: string; runId?: string }
  | { type: "read-diff"; owner: string; workspaceId: string; range: DiffRange; ignoreWhitespace: boolean };

/** Diffs keep only the snapshot of what a thread's run changed on the thread itself. */
type Facet = Pick<RunThread, "lastChangeSnapshot">;

export function reduceDiffs(state: WorkspaceState, input: DiffInput): SliceTransition<Record<never, never>, Facet> {
  switch (input.type) {
    case "diff.open-commit": {
      if (!isCommitHash(input.commit)) return { refusal: "Invalid commit hash." };
      const thread = state.threads.find((item) => item.id === (input.taskId ?? state.currentId));
      const workspaceId = threadWorkspaceId(state, thread);
      if (!workspaceId) return { refusal: "Open this thread's project to inspect the commit." };
      const owner = dockOwner(state);
      const dock = dockFor(state, owner);
      const opened = editDock(docksOf(state), owner, { panels: dock.panels.includes(DIFF_PANEL) ? dock.panels : [...dock.panels, DIFF_PANEL] });
      const shown = focusDockTabIn(showDockTabIn(opened, owner, DIFF_PANEL), owner, DIFF_PANEL);
      return andThen(state, { edits: [shown.docks], effects: shown.effects }, (next) => {
        const read = diffReadFrom(next, owner, workspaceId, { kind: "commit", commit: input.commit }, { mode: "commit", result: null, collapsed: [], viewed: {} });
        return { ...read, effects: [...browserEffectsForTab(afterward(next, read), owner, DIFF_PANEL), ...read.effects ?? []] };
      });
    }
    /** A thread with no checkout has nothing to read; what other checkouts said is still theirs. */
    case "view.refresh-environment":
      return { effects: refreshEnvironment(state) };

    case "diff.toggle": {
      const owner = dockOwner(state);
      const dock = dockFor(state, owner);
      const showing = dock.open && dock.tab === DIFF_PANEL && dockSubject(state, owner, DIFF_PANEL) === (input.taskId ?? null);
      return reduceDock(state, showing
        ? { type: "view.close-dock-panel", panel: DIFF_PANEL }
        : { type: "view.open-dock-panel", panel: DIFF_PANEL, ...(input.taskId ? { taskId: input.taskId } : {}) });
    }

    case "diff.refresh": {
      const owner = dockOwner(state);
      return diffRead(state, owner, diffFor(state, owner).range);
    }

    case "diff.set-mode": {
      const owner = dockOwner(state);
      const diff = diffFor(state, owner);
      if (diff.mode === input.mode) return { closesMenu: true };
      const range = input.mode === "uncommitted" ? UNCOMMITTED
        : (diff.workspaceId === subjectWorkspaceId(state, owner) ? diff.branchRange : undefined) ?? defaultBranchRange(state, owner);
      return { closesMenu: true, ...diffRead(state, owner, range, { mode: input.mode, result: null, collapsed: [], viewed: {} }) };
    }

    case "diff.set-range": {
      const owner = dockOwner(state);
      const diff = diffFor(state, owner);
      if (diff.mode === modeForRange(input.range) && rangeKey(diff.range) === rangeKey(input.range)) return {};
      /** A different comparison is a different set of files, so nothing carries over but the layout. */
      return diffRead(state, owner, input.range, { mode: modeForRange(input.range), result: null, collapsed: [], viewed: {} });
    }

    case "diff.set-collapsed": {
      const owner = dockOwner(state);
      const collapsed = diffFor(state, owner).collapsed;
      return { edits: [editDiff(docksOf(state), owner, {
        collapsed: input.collapsed
          ? (collapsed.includes(input.path) ? collapsed : [...collapsed, input.path])
          : collapsed.filter((path) => path !== input.path),
      })] };
    }

    case "diff.set-viewed": {
      const owner = dockOwner(state);
      const diff = diffFor(state, owner);
      const file = diff.result?.status === "available" ? diff.result.files.find((item) => item.path === input.path) : undefined;
      if (!file) return {};
      const { [input.path]: _cleared, ...rest } = diff.viewed;
      return { edits: [editDiff(docksOf(state), owner, {
        viewed: input.viewed ? { ...rest, [input.path]: fileFingerprint(file) } : rest,
        /** Ticking a file off folds it away, which is what makes working down the list one click. */
        collapsed: input.viewed
          ? (diff.collapsed.includes(input.path) ? diff.collapsed : [...diff.collapsed, input.path])
          : diff.collapsed.filter((path) => path !== input.path),
      })] };
    }

    case "diff.set-split":
      return { edits: [editDiff(docksOf(state), dockOwner(state), { split: input.split })] };

    /** The same comparison counted a different way, so the list is read again and the review stays put. */
    case "diff.set-ignore-whitespace": {
      const owner = dockOwner(state);
      const diff = diffFor(state, owner);
      if (diff.ignoreWhitespace === input.ignore) return {};
      return diffRead(state, owner, diff.range, { ignoreWhitespace: input.ignore });
    }

    case "diff.loaded": {
      const diff = diffFor(state, input.owner);
      if (!diffMatches(diff, input.workspaceId, input.range)) return {};
      /** A list counted the other way was read before the toggle, so it no longer answers anything. */
      if (input.result.status === "available" && input.result.ignoreWhitespace !== diff.ignoreWhitespace) return {};
      const viewed = retainedViews(diff.viewed, input.result, diff.result);
      const listed = input.result.status === "available" ? input.result.files : null;
      return {
        edits: [editDiff(docksOf(state), input.owner, {
          result: input.result,
          loading: false,
          viewed,
          ...(listed ? { collapsed: foldedOnLoad(diff, listed, input.result) } : {}),
        })],
        ...(input.result.status === "error" ? { result: { ok: false, message: input.result.message } } : {}),
      };
    }

    case "environment.updated": {
      const previous = environmentFor(state, input.workspaceId);
      const read: Step<Facet> = sameChangedFiles(previous, input.result) ? {} : { edits: [environmentReadIn(gitOf(state), state, input.workspaceId, input.result)] };
      if (input.result.status === "error") return { ...read, result: { ok: false, message: input.result.message } };
      /** The checkout is worth recording whoever asked; only the thread's own snapshot is the run's. */
      if (input.runId && input.taskId && state.lastRunIds[input.taskId] !== input.runId) return read;
      if (!input.taskId || input.result.status !== "available") return read;
      const files = input.result.files;
      const thread = state.threads.find((item) => item.id === input.taskId);
      if (!thread || sameStrings(thread.lastChangeSnapshot.files, files)) return read;
      const workspaceId = threadWorkspaceId(state, thread);
      if (workspaceId && workspaceId !== input.workspaceId) return read;
      const snapshot = editThread(threadsOf<Facet>(state), input.taskId, () => ({ lastChangeSnapshot: { files, capturedAt: now() }, updatedAt: now() }));
      return { edits: [...read.edits ?? [], snapshot] };
    }
  }
}
