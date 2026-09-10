/** Selecting a review mode and reading bounded pages of commit history. */
import { currentWorkspaceId, defaultBranchRange, readDiff, readDiffFrom, settled, rejected } from "./shared.js";
import { diffFor, dockOwner, withDiff, type WorkspaceState } from "../workspace-state.js";
import { DIFF_COMMITS_MENU, requestDiffCommits } from "../workspace-diff.js";
import { UNCOMMITTED } from "../../domain/diff.js";
import { COMMIT_PAGE_SIZE, isCommitQuery, type CommitHistoryRequest } from "../../domain/commit-history.js";
import type { WorkspaceInput, WorkspaceTransition } from "./types.js";

type CommitInput = Extract<WorkspaceInput, {
  type: "diff.set-mode" | "diff.open-commits" | "diff.search-commits" | "diff.page-commits" | "diff.select-commit" | "diff.commits-loaded";
}>;

export function readCommits(state: WorkspaceState, owner: string, request: CommitHistoryRequest, debounce = false): WorkspaceTransition {
  const diff = diffFor(state, owner);
  const workspaceId = diff.workspaceId ?? currentWorkspaceId(state);
  if (!workspaceId) return rejected(state, "Open a project to browse its commits.");
  return requestDiffCommits(state, owner, workspaceId, request, debounce);
}

export function reduceDiffCommits(state: WorkspaceState, input: CommitInput): WorkspaceTransition {
  switch (input.type) {
    case "diff.set-mode": {
      const owner = dockOwner(state);
      const diff = diffFor(state, owner);
      const closed = { ...state, openMenu: null };
      if (input.mode === "commits") {
        if (!(diff.workspaceId ?? currentWorkspaceId(state))) return rejected(state, "Open a project to browse its commits.");
        const selected = diff.range.kind === "commit" ? diff.range : diff.commitRange;
        const next = withDiff({ ...state, openMenu: DIFF_COMMITS_MENU }, owner, {
          mode: "commits", result: selected && diff.range.kind === "commit" ? diff.result : null, loading: diff.range.kind === "commit" && diff.loading,
        });
        const read = selected && (diff.mode !== "commits" || diff.range.kind !== "commit")
          ? readDiff(next, owner, selected, { mode: "commits", result: null, collapsed: [], viewed: {} })
          : settled(next);
        const history = readCommits(read.state, owner, { query: "", offset: 0 });
        return { ...history, effects: [...read.effects, ...history.effects] };
      }
      if (diff.mode === input.mode) return settled(closed);
      const range = input.mode === "uncommitted" ? UNCOMMITTED
        : (diff.workspaceId === currentWorkspaceId(state) ? diff.branchRange : undefined) ?? defaultBranchRange(state);
      return readDiff(closed, owner, range, { mode: input.mode, result: null, collapsed: [], viewed: {} });
    }

    case "diff.open-commits": {
      const owner = dockOwner(state);
      if (diffFor(state, owner).mode !== "commits") return settled(state);
      return readCommits({ ...state, openMenu: DIFF_COMMITS_MENU }, owner, { query: "", offset: 0 });
    }

    case "diff.search-commits": {
      if (!isCommitQuery(input.query)) return rejected(state, "Invalid commit search.");
      const owner = dockOwner(state);
      if (diffFor(state, owner).mode !== "commits") return settled(state);
      return readCommits(state, owner, { query: input.query, offset: 0 }, true);
    }

    case "diff.page-commits": {
      const owner = dockOwner(state);
      const diff = diffFor(state, owner);
      const history = diff.history;
      if (diff.mode !== "commits" || !history || history.loading || history.result?.status !== "available") return settled(state);
      const page = history.result;
      if (!page.head || (input.direction === 1 ? !page.hasMore : page.offset === 0)) return settled(state);
      return readCommits(state, owner, { query: history.request.query, head: page.head, offset: Math.max(0, page.offset + input.direction * COMMIT_PAGE_SIZE) });
    }

    case "diff.select-commit": {
      const owner = dockOwner(state);
      const diff = diffFor(state, owner);
      const history = diff.history;
      if (diff.mode !== "commits" || history?.loading || history?.result?.status !== "available") return settled(state);
      const commit = history.result.commits.find((entry) => entry.sha === input.commit);
      if (!commit) return rejected(state, "Choose a commit from the current search results.");
      const next = { ...state, openMenu: null };
      if (diff.range.kind === "commit" && diff.range.commit === commit.sha) return settled(withDiff(next, owner, { commitSummary: commit }));
      return readDiff(next, owner, { kind: "commit", commit: commit.sha }, { mode: "commits", commitSummary: commit, result: null, collapsed: [], viewed: {} });
    }

    case "diff.commits-loaded": {
      const diff = state.diffs[input.owner];
      const history = diff?.history;
      if (!diff || diff.mode !== "commits" || diff.workspaceId !== input.workspaceId || history?.workspaceId !== input.workspaceId || history.requestId !== input.requestId) return settled(state);
      const next = withDiff(state, input.owner, { history: { ...history, result: input.result, loading: false } });
      /** The first visit starts on the latest commit; a search or a later page never moves the selection. */
      const latest = input.result.status === "available" && !history.request.query && history.request.offset === 0 ? input.result.commits[0] : undefined;
      if (diff.range.kind !== "commit" && latest) {
        return readDiffFrom(next, input.owner, input.workspaceId, { kind: "commit", commit: latest.sha }, { mode: "commits", commitSummary: latest, result: null, collapsed: [], viewed: {} });
      }
      return settled(next);
    }

  }
}
