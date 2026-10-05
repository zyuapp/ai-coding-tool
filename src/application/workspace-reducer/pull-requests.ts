/** The pull request the checkout in front belongs to, those a coordinator's threads work on, and which ask each answer belongs to. */
import { retargetReviews } from "./diff-reads.js";
import { currentWorkspaceId } from "./environment.js";
import { threadWorkspaceId } from "../thread-location.js";
import { settled } from "./shared.js";
import type { WorkspaceInput, WorkspaceTransition } from "./types.js";
import { branchOf, memberCheckouts } from "../pull-request-view.js";
import type { WorkspaceState } from "../workspace-state.js";
import { isCoordinator } from "../../domain/coordination.js";
import { NO_PULL_REQUEST, samePullRequest, type PullRequestAnswer, type PullRequestRead } from "../../domain/pull-request.js";
import type { Thread } from "../../domain/thread.js";

type PullRequestInput = Extract<WorkspaceInput, { type: "pull-request.read" | "pull-request.read-members" | "pull-request.answered" }>;

export function reducePullRequests(state: WorkspaceState, input: PullRequestInput): WorkspaceTransition {
  switch (input.type) {
    case "pull-request.read": {
      const threadId = input.taskId ?? state.currentId;
      const workspaceId = input.taskId ? threadWorkspaceId(state, state.threads.find((thread) => thread.id === input.taskId)) : currentWorkspaceId(state);
      /** Nothing to ask about leaves nothing to draw, so the answer the last checkout gave goes too. */
      if (!workspaceId) return settled(state.pullRequest === null ? state : { ...state, pullRequest: null });
      const branch = branchOf(state.environments[workspaceId] ?? null);
      const held = state.pullRequest;
      /** Only another checkout or another branch can have a different answer, so only those blank the row. */
      const kept = held && held.workspaceId === workspaceId && held.branch === branch ? held.answer : NO_PULL_REQUEST;
      const read = (held?.read ?? 0) + 1;
      return settled(
        { ...state, pullRequest: { workspaceId, branch, read, answer: kept, ...(threadId ? { threadIds: [threadId] } : {}) } },
        [{ type: "read-pull-request", workspaceId, branch, read }],
      );
    }
    case "pull-request.read-members": {
      const lead = state.threads.find((thread) => thread.id === (input.taskId ?? state.currentId));
      const checkouts = lead && isCoordinator(lead) ? memberCheckouts(state, lead.id) : new Map<string, Thread[]>();
      if (!checkouts.size && !Object.keys(state.memberPullRequests).length) return settled(state);
      /** Only the checkouts still under the coordinator are kept, so one that left stops being drawn. */
      const memberPullRequests: Record<string, PullRequestRead> = {};
      for (const [workspaceId, threads] of checkouts) {
        const held = state.memberPullRequests[workspaceId];
        /** A thread's branch rarely moves, so the answer stands until the next one replaces it. */
        memberPullRequests[workspaceId] = {
          workspaceId,
          branch: branchOf(state.environments[workspaceId] ?? null),
          read: (held?.read ?? 0) + 1,
          answer: held?.answer ?? NO_PULL_REQUEST,
          threadIds: threads.map((thread) => thread.id),
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
      const answersHeld = !input.members && held && held.read === input.read && held.workspaceId === input.workspaceId && held.branch === input.branch;
      const member = state.memberPullRequests[input.workspaceId];
      const answersMember = input.members && member && member.read === input.read && member.branch === input.branch;
      if (!answersHeld && !answersMember) return settled(state);
      const current = answersHeld && !samePullRequest(held.answer, input.answer);
      const changedMember = answersMember && !samePullRequest(member.answer, input.answer);
      const next = linked(state, answersHeld ? held.threadIds : member?.threadIds, input.answer);
      if (!current && !changedMember) return settled(next);
      return retargetReviews({
        ...next,
        ...(current ? { pullRequest: { ...held, answer: input.answer } } : {}),
        ...(changedMember ? { memberPullRequests: { ...state.memberPullRequests, [input.workspaceId]: { ...member, answer: input.answer } } } : {}),
      }, input.workspaceId);
    }
  }
}

/** Records a found pull request on the threads it answers for, so a search can find them by it. */
function linked(state: WorkspaceState, threadIds: string[] | undefined, answer: PullRequestAnswer): WorkspaceState {
  if (answer.status !== "found" || !threadIds?.length) return state;
  const { number, url } = answer.pullRequest;
  const ids = new Set(threadIds);
  let changed = false;
  const threads = state.threads.map((thread) => {
    if (!ids.has(thread.id) || thread.pullRequest?.number === number && thread.pullRequest.url === url) return thread;
    changed = true;
    return { ...thread, pullRequest: { number, url } };
  });
  return changed ? { ...state, threads } : state;
}
