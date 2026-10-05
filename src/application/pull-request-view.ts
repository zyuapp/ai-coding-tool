import type { ChangedFilesResult } from "../contracts/ipc.js";
import type { DiffRange } from "../domain/diff.js";
import { coordinatedThreads } from "../domain/coordination.js";
import { NO_PULL_REQUEST, pullRequestSettled, type PullRequestAnswer, type PullRequestRead, type PullRequestRef } from "../domain/pull-request.js";
import type { Project } from "../domain/project.js";
import type { Thread } from "../domain/thread.js";
import type { Worktree } from "../domain/worktree.js";
import { threadWorkspaceId } from "./thread-location.js";

/** The branch a checkout sits on, or null while Git has not said or could not. */
export function branchOf(environment: ChangedFilesResult | null) {
  return environment?.status === "available" ? environment.branch : null;
}

/** The answer held for a checkout, kept only while that checkout and branch are the ones on screen. */
export function pullRequestFor(held: PullRequestRead | null, workspaceId: string | undefined, environment: ChangedFilesResult | null): PullRequestAnswer {
  if (!held || held.workspaceId !== workspaceId || held.branch !== branchOf(environment)) return NO_PULL_REQUEST;
  return held.answer;
}

type CheckoutState = {
  pullRequest: PullRequestRead | null;
  memberPullRequests: Record<string, PullRequestRead>;
  environments: Record<string, ChangedFilesResult>;
};

/** A checkout's pull request, from whichever read last answered for its branch: the one in front, or a coordinator's thread. */
export function checkoutPullRequest(state: CheckoutState, workspaceId: string | undefined): PullRequestAnswer {
  if (!workspaceId) return NO_PULL_REQUEST;
  const environment = state.environments[workspaceId] ?? null;
  const held = pullRequestFor(state.pullRequest, workspaceId, environment);
  return held.status === "found" ? held : pullRequestFor(state.memberPullRequests[workspaceId] ?? null, workspaceId, environment);
}

/** Where a review of the pull request compares from, while it is still open to review and the checkout keeps its base. */
export function pullRequestBase(answer: PullRequestAnswer) {
  if (answer.status !== "found" || pullRequestSettled(answer)) return null;
  return answer.review?.baseRef ?? null;
}

/**
 * The pull request a review is reading, which it is while it compares the working tree with that
 * pull request's base: what the panel names, and what it shows that GitHub has not been sent.
 */
export type ReviewedPullRequest = { pullRequest: PullRequestRef; unpushed: number; uncommitted: boolean };

export function reviewedPullRequest(state: CheckoutState, { range, workspaceId }: { range: DiffRange; workspaceId: string | null }): ReviewedPullRequest | null {
  if (range.kind !== "branches" || range.compare !== null || !workspaceId) return null;
  const answer = checkoutPullRequest(state, workspaceId);
  if (answer.status !== "found" || pullRequestBase(answer) !== range.base) return null;
  const environment = state.environments[workspaceId];
  return {
    pullRequest: answer.pullRequest,
    unpushed: answer.review?.unpushed ?? 0,
    uncommitted: environment?.status === "available" && environment.files.length > 0,
  };
}

/** What one thread's panel asks about: changes with the checkout, its branch, or the thread reading it. */
export function threadAsking(workspaceId: string | undefined, environment: ChangedFilesResult | null, threadId: string | undefined) {
  return [workspaceId ?? "", branchOf(environment) ?? "", threadId ?? ""].join("\0");
}

type MemberState = {
  threads: Thread[];
  projects: Project[];
  worktrees: Worktree[];
  environments: Record<string, ChangedFilesResult>;
  memberPullRequests: Record<string, PullRequestRead>;
};

/** The checkouts a coordinator's threads work in, each with the threads in it, in the order the list holds them. */
export function memberCheckouts(state: Omit<MemberState, "environments" | "memberPullRequests">, leadId: string): Map<string, Thread[]> {
  const checkouts = new Map<string, Thread[]>();
  for (const thread of coordinatedThreads(state.threads, leadId)) {
    const workspaceId = threadWorkspaceId(state, thread);
    if (workspaceId) checkouts.set(workspaceId, [...checkouts.get(workspaceId) ?? [], thread]);
  }
  return checkouts;
}

/** A pull request one or more of a coordinator's threads work on. */
export type MemberPullRequest = { pullRequest: PullRequestRef; threads: Thread[] };

export type MemberPullRequestsView = {
  /** Changes whenever a checkout joins, leaves, or moves branch, which is when to ask again. */
  asking: string;
  /** True once no checkout's answer can change again, past which polling is only cost. */
  settled: boolean;
  found: MemberPullRequest[];
};

const NO_MEMBER_PULL_REQUESTS: MemberPullRequestsView = { asking: "", settled: true, found: [] };

export function memberPullRequestsView(state: MemberState, lead: Thread | undefined): MemberPullRequestsView {
  if (!lead) return NO_MEMBER_PULL_REQUESTS;
  const checkouts = memberCheckouts(state, lead.id);
  if (!checkouts.size) return NO_MEMBER_PULL_REQUESTS;
  const found = new Map<string, MemberPullRequest>();
  const asking: string[] = [];
  let settled = true;
  for (const [workspaceId, threads] of checkouts) {
    asking.push(`${workspaceId}\0${branchOf(state.environments[workspaceId] ?? null) ?? ""}`);
    const answer = state.memberPullRequests[workspaceId]?.answer ?? NO_PULL_REQUEST;
    if (!pullRequestSettled(answer)) settled = false;
    if (answer.status !== "found") continue;
    const known = found.get(answer.pullRequest.url);
    found.set(answer.pullRequest.url, { pullRequest: answer.pullRequest, threads: [...known?.threads ?? [], ...threads] });
  }
  return { asking: asking.join("\n"), settled, found: [...found.values()] };
}
