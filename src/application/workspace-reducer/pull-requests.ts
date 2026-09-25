/** The pull request the checkout in front belongs to, and which ask each answer belongs to. */
import { currentWorkspaceId } from "./environment.js";
import { settled } from "./shared.js";
import type { WorkspaceInput, WorkspaceTransition } from "./types.js";
import { branchOf } from "../pull-request-view.js";
import type { WorkspaceState } from "../workspace-state.js";
import { NO_PULL_REQUEST, samePullRequest } from "../../domain/pull-request.js";

type PullRequestInput = Extract<WorkspaceInput, { type: "pull-request.read" | "pull-request.answered" }>;

export function reducePullRequests(state: WorkspaceState, input: PullRequestInput): WorkspaceTransition {
  switch (input.type) {
    case "pull-request.read": {
      const workspaceId = currentWorkspaceId(state);
      /** Nothing to ask about leaves nothing to draw, so the answer the last checkout gave goes too. */
      if (!workspaceId) return settled(state.pullRequest === null ? state : { ...state, pullRequest: null });
      const branch = branchOf(state.environments[workspaceId] ?? null);
      const held = state.pullRequest;
      /** Only another checkout or another branch can have a different answer, so only those blank the row. */
      const kept = held && held.workspaceId === workspaceId && held.branch === branch ? held.answer : NO_PULL_REQUEST;
      const read = (held?.read ?? 0) + 1;
      return settled(
        { ...state, pullRequest: { workspaceId, branch, read, answer: kept } },
        [{ type: "read-pull-request", workspaceId, branch, read }],
      );
    }
    case "pull-request.answered": {
      const held = state.pullRequest;
      /** Answers to asks older than the latest are dropped, whichever order they arrive in. */
      if (!held || held.read !== input.read || held.workspaceId !== input.workspaceId || held.branch !== input.branch) return settled(state);
      if (samePullRequest(held.answer, input.answer)) return settled(state);
      return settled({ ...state, pullRequest: { ...held, answer: input.answer } });
    }
  }
}
