import type { ChangedFilesResult } from "../contracts/ipc.js";
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
