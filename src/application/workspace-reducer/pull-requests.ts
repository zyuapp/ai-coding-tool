/** The pull request the checkout in front belongs to, those a coordinator's threads work on, and which ask each answer belongs to. */
import { currentWorkspaceId } from "./environment.js";
import { threadWorkspaceId } from "../thread-location.js";
import { settled } from "./shared.js";
import type { WorkspaceInput, WorkspaceTransition } from "./types.js";
import { branchOf, memberCheckouts } from "../pull-request-view.js";
import type { WorkspaceState } from "../workspace-state.js";
import { isCoordinator } from "../../domain/coordination.js";
import { NO_PULL_REQUEST, samePullRequest, type PullRequestRead } from "../../domain/pull-request.js";

type PullRequestInput = Extract<WorkspaceInput, { type: "pull-request.read" | "pull-request.read-members" | "pull-request.answered" }>;

export function reducePullRequests(state: WorkspaceState, input: PullRequestInput): WorkspaceTransition {
  switch (input.type) {
    case "pull-request.read": {
      const workspaceId = input.taskId ? threadWorkspaceId(state, state.threads.find((thread) => thread.id === input.taskId)) : currentWorkspaceId(state);
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
    case "pull-request.read-members": {
      const lead = state.threads.find((thread) => thread.id === (input.taskId ?? state.currentId));
      const checkouts = lead && isCoordinator(lead) ? [...memberCheckouts(state, lead.id).keys()] : [];
      if (!checkouts.length && !Object.keys(state.memberPullRequests).length) return settled(state);
      /** Only the checkouts still under the coordinator are kept, so one that left stops being drawn. */
      const memberPullRequests: Record<string, PullRequestRead> = {};
      for (const workspaceId of checkouts) {
        const held = state.memberPullRequests[workspaceId];
        /** A thread's branch rarely moves, so the answer stands until the next one replaces it. */
        memberPullRequests[workspaceId] = {
          workspaceId,
          branch: branchOf(state.environments[workspaceId] ?? null),
          read: (held?.read ?? 0) + 1,
          answer: held?.answer ?? NO_PULL_REQUEST,
        };
      }
      return settled(
        { ...state, memberPullRequests },
        Object.values(memberPullRequests).map(({ workspaceId, branch, read }) => ({ type: "read-pull-request" as const, workspaceId, branch, read, members: true as const })),
      );
    }
    case "pull-request.answered": {
      /** Answers to asks older than the latest are dropped, whichever order they arrive in. */
      const held = state.pullRequest;
      const current = !input.members && held && held.read === input.read && held.workspaceId === input.workspaceId && held.branch === input.branch && !samePullRequest(held.answer, input.answer);
      const member = state.memberPullRequests[input.workspaceId];
      const answersMember = input.members && member && member.read === input.read && member.branch === input.branch && !samePullRequest(member.answer, input.answer);
      if (!current && !answersMember) return settled(state);
      return settled({
        ...state,
        ...(current ? { pullRequest: { ...held, answer: input.answer } } : {}),
        ...(answersMember ? { memberPullRequests: { ...state.memberPullRequests, [input.workspaceId]: { ...member, answer: input.answer } } } : {}),
      });
    }
  }
}
