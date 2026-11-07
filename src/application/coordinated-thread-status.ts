/** Where a thread under a coordinator stands, what its own pull request says, and what the user can tell it to do next. */
import type { WorkspaceState } from "./workspace-state.js";
import { threadWorkspaceId } from "./thread-location.js";
import { lastReply } from "./coordination-messages.js";
import { replyLine } from "./reply-line.js";
import { MAX_SUMMARY, openDecisions, stuckVerdict, type NextStep, type OverviewGroup } from "../domain/coordination.js";
import { lastRunOutcome, type Thread } from "../domain/thread.js";
import type { PullRequestAnswer, PullRequestChecks, PullRequestLink, PullRequestRef, PullRequestState } from "../domain/pull-request.js";

/** Where a thread under a coordinator stands, in the words its card shows. */
export type CoordinatedThreadStatus = "approval" | "asking" | "working" | "resolved" | "blocked" | "failed" | "needs-work" | "review" | "done" | "idle";

/** A pull request that is a thread's own work, as last read: its state and title are known. */
export type OwnPullRequest = PullRequestLink & Pick<PullRequestRef, "state" | "title">;

/**
 * The pull request that is a thread's own work, if it has one. A thread whose brief delivers a pull
 * request owns the one its checkout is on, and so does a thread with no brief working in a worktree.
 * Any other thread shares the project's checkout with the user, whose own branch's pull request is
 * not its work. A link read before its state was kept says too little to count.
 */
export function ownPullRequest(member: Thread): OwnPullRequest | null {
  const link = member.pullRequest;
  if (!link?.state || link.title === undefined) return null;
  return ownsPullRequest(member) ? link as OwnPullRequest : null;
}

/** Whether the pull request a thread's checkout is on would be its own work. */
export function ownsPullRequest(member: Thread): boolean {
  return member.brief ? member.brief.delivers === "pull-request" : member.worktreeId !== undefined;
}

const CHECKS_LINE: Record<PullRequestChecks, string> = { failing: "Checks failing", passing: "Checks passing", pending: "Checks pending" };

const STATE_LINE: Record<Exclude<PullRequestState, "open">, string> = { draft: "Draft", merged: "Merged", closed: "Closed" };

/**
 * A thread's own pull request in a few words: how it stands unless it is simply open, then, while it
 * can still move, its conflicts, where its checks stand, and any changes its review asks for.
 */
export function pullRequestLine({ number, state, conflicts, checks, review }: OwnPullRequest): string {
  const parts = [`#${number}`];
  if (state !== "open") parts.push(STATE_LINE[state]);
  if (state === "open" || state === "draft") {
    if (conflicts) parts.push("Merge conflicts");
    if (checks) parts.push(CHECKS_LINE[checks]);
    if (review === "changes-requested") parts.push("Changes requested");
  }
  return parts.join(" · ");
}

/**
 * What a thread's own open or draft pull request needs fixed before anyone can review or merge it,
 * most pressing first. One that needs nothing fixed is what a reviewer can read as it is.
 */
function pullRequestFixes({ state, conflicts, checks, review }: OwnPullRequest): NextStep[] {
  if (state !== "open" && state !== "draft") return [];
  const fixes: NextStep[] = [];
  if (conflicts) fixes.push("resolve-conflicts");
  if (checks === "failing") fixes.push("fix-ci");
  if (review === "changes-requested") fixes.push("address-comments");
  return fixes;
}

/** Statuses the user cannot resolve a thread from: it is working or waiting on them, or already resolved. */
const UNRESOLVABLE: readonly CoordinatedThreadStatus[] = ["approval", "asking", "working", "resolved"];

/** Whether the user can file a thread away under Resolved as it stands now. */
export function canResolve(status: CoordinatedThreadStatus): boolean {
  return !UNRESOLVABLE.includes(status);
}

/**
 * What GitHub last said of the pull request of the checkout a thread works in, or null before it has
 * said anything, as while the first read is on its way or when nothing has asked yet.
 */
export function checkoutAnswer(state: Pick<WorkspaceState, "projects" | "worktrees" | "memberPullRequests">, member: Thread): PullRequestAnswer | null {
  const workspaceId = threadWorkspaceId(state, member);
  const read = workspaceId ? state.memberPullRequests[workspaceId] : undefined;
  return read?.answered ? read.answer : null;
}

/**
 * What the user can tell a thread under a coordinator to do next about its own pull request, most
 * pressing first. A thread that is working, waiting on the user, or filed away is offered nothing.
 * Opening a pull request waits until GitHub has said the thread's checkout has none, so it never
 * shows before the first answer, nor when gh is missing and nothing can be asked.
 */
export function nextSteps(member: Thread, status: CoordinatedThreadStatus, checkout: PullRequestAnswer | null): NextStep[] {
  if (!canResolve(status)) return [];
  const pullRequest = ownPullRequest(member);
  if (!pullRequest) return member.brief?.delivers === "pull-request" && checkout?.status === "none" ? ["create-pull-request"] : [];
  const steps = pullRequestFixes(pullRequest);
  const { checks, review } = pullRequest;
  const mergeable = pullRequest.state === "open" && !steps.length && checks !== "pending" && (review === undefined || review === "approved");
  return mergeable ? ["merge"] : steps;
}

/** Where a thread under a coordinator stands, as its status says it. */
export type CoordinatedThreadStanding = {
  thread: Thread;
  status: CoordinatedThreadStatus;
  summary: string | null;
};

/**
 * Where a thread under a coordinator stands, most pressing first: waiting on the user, working,
 * filed away as resolved, stuck, its own pull request needing work, that pull request open for
 * review, then done in some way. Work going or a question waiting outranks resolution, since either
 * needs the user to see it again. A thread left stuck once it was resolved is open again, so being
 * stuck is only outranked by a resolution that filed it away. Only a pull request with nothing to fix
 * is ready for review.
 */
export function coordinatedThreadStatus(thread: Thread, busy: ReadonlySet<string>, blocked: ReadonlySet<string>): CoordinatedThreadStanding {
  const question = openDecisions(thread)[0]?.question;
  if (blocked.has(thread.id)) return { thread, status: "approval", summary: null };
  if (question) return { thread, status: "asking", summary: question };
  if (busy.has(thread.id)) return { thread, status: "working", summary: thread.report?.state === "working" ? thread.report.summary : null };
  if (thread.resolvedAt !== undefined) return { thread, status: "resolved", summary: null };
  const stuck = stuckVerdict(thread);
  if (stuck) return { thread, status: stuck.state, summary: stuck.summary };
  const report = thread.report && thread.report.state !== "working" ? thread.report : undefined;
  /** Read by how its turn ended rather than by its verdict, which the user filing it away takes off. */
  const ended = lastRunOutcome(thread);
  const pullRequest = ownPullRequest(thread);
  if (pullRequest && pullRequestFixes(pullRequest).length) return { thread, status: "needs-work", summary: pullRequestLine(pullRequest) };
  if (pullRequest?.state === "open") return { thread, status: "review", summary: pullRequestLine(pullRequest) };
  if (report) return { thread, status: "done", summary: report.summary };
  /**
   * A thread that ended its turn without reporting, and left nothing waiting on the user, said where
   * it stands in its reply, which reads as its report: whatever engine it runs on, it is done.
   */
  if (ended === "finished") return { thread, status: "done", summary: closingLine(thread) };
  return { thread, status: "idle", summary: null };
}

/** The first line of what a thread last said that says something, in plain words, as a report's summary would be. */
function closingLine(thread: Thread): string | null {
  const reply = lastReply(thread);
  return (reply && replyLine(reply, MAX_SUMMARY)) ?? null;
}

/** The Overview group each status files a thread under, which the coordinator's roster reads too. */
export const GROUP_OF: Record<CoordinatedThreadStatus, OverviewGroup> = {
  approval: "needs",
  asking: "needs",
  blocked: "needs",
  failed: "needs",
  "needs-work": "needs",
  review: "review",
  working: "working",
  done: "done",
  idle: "done",
  resolved: "resolved",
};
