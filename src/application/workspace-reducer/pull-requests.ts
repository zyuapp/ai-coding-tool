/** The pull request the checkout in front belongs to, those a coordinator's threads work on, and which ask each answer belongs to. */
import { currentWorkspaceId } from "./environment.js";
import { threadWorkspaceId } from "../thread-location.js";
import { now, settled } from "./shared.js";
import type { WorkspaceEffect, WorkspaceInput, WorkspaceTransition } from "./types.js";
import { ownPullRequest } from "../coordination.js";
import { awaitsPullRequest, branchOf, memberCheckouts } from "../pull-request-view.js";
import type { WorkspaceState } from "../workspace-state.js";
import { dismissed } from "../../domain/attention.js";
import { coordinatorOf, isCoordinator } from "../../domain/coordination.js";
import { linkMatches, linkOf, NO_PULL_REQUEST, samePullRequest, type PullRequestAnswer, type PullRequestRead } from "../../domain/pull-request.js";
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
      /** Only checkouts an answer could still move a thread in are asked about; the answer is recorded on every thread in them. */
      const ours = lead && isCoordinator(lead) ? memberCheckouts(state, lead.id, awaitsPullRequest) : new Map<string, Thread[]>();
      const everyone = everyMemberCheckout(state);
      /**
       * Merged, never replaced, so another coordinator's read still in flight keeps its place. Only a
       * checkout no coordinator's thread works in any more is let go, and stops being drawn.
       */
      const kept = Object.keys(state.memberPullRequests).every((workspaceId) => everyone.has(workspaceId))
        ? state.memberPullRequests
        : Object.fromEntries(Object.entries(state.memberPullRequests).filter(([workspaceId]) => everyone.has(workspaceId)));
      let next = kept === state.memberPullRequests ? state : { ...state, memberPullRequests: kept };
      const effects: WorkspaceEffect[] = [];
      for (const workspaceId of ours.keys()) {
        const read = checkoutRead(next, workspaceId, everyone.get(workspaceId) ?? []);
        next = read.state;
        effects.push(read.effect);
      }
      return settled(next, effects);
    }
    case "pull-request.answered": {
      /** Answers to asks older than the latest are dropped, whichever order they arrive in. */
      const held = state.pullRequest;
      const answersHeld = !input.members && held && held.read === input.read && held.workspaceId === input.workspaceId && held.branch === input.branch;
      const member = state.memberPullRequests[input.workspaceId];
      const answersMember = input.members && member && member.read === input.read && member.branch === input.branch;
      if (!answersHeld && !answersMember) return settled(state);
      const current = answersHeld && !samePullRequest(held.answer, input.answer);
      /** A checkout's first answer is news even when it says none, since none is now GitHub's word. */
      const changedMember = answersMember && (!member.answered || !samePullRequest(member.answer, input.answer));
      const next = linked(state, answersHeld ? held.threadIds : member?.threadIds, input.answer);
      if (!current && !changedMember) return settled(next);
      return settled({
        ...next,
        ...(current ? { pullRequest: { ...held, answer: input.answer } } : {}),
        ...(changedMember ? { memberPullRequests: { ...state.memberPullRequests, [input.workspaceId]: { ...member, answer: input.answer, answered: true } } } : {}),
      });
    }
  }
}

/**
 * Asks again about the pull request of the checkout a thread under a coordinator works in, on behalf
 * of every such thread in it. A thread's branch rarely moves, so the answer stands until the next one
 * replaces it.
 */
export function memberPullRequestRead(state: WorkspaceState, thread: Thread): { state: WorkspaceState; effect: WorkspaceEffect } | null {
  const workspaceId = threadWorkspaceId(state, thread);
  if (!workspaceId) return null;
  return checkoutRead(state, workspaceId, everyMemberCheckout(state).get(workspaceId) ?? [thread]);
}

function checkoutRead(state: WorkspaceState, workspaceId: string, threads: Thread[]): { state: WorkspaceState; effect: WorkspaceEffect } {
  const held = state.memberPullRequests[workspaceId];
  const branch = branchOf(state.environments[workspaceId] ?? null);
  /** What GitHub said of another branch says nothing of this one, so the checkout waits for its answer again. */
  const kept = held?.branch === branch ? held : undefined;
  const read: PullRequestRead = {
    workspaceId,
    branch,
    read: (held?.read ?? 0) + 1,
    answer: kept?.answer ?? NO_PULL_REQUEST,
    threadIds: threads.map((thread) => thread.id),
    ...(kept?.answered ? { answered: true as const } : {}),
  };
  return {
    state: { ...state, memberPullRequests: { ...state.memberPullRequests, [workspaceId]: read } },
    effect: { type: "read-pull-request", workspaceId, branch: read.branch, read: read.read, members: true },
  };
}

/** Every checkout a thread under any live coordinator works in, each with those threads. */
function everyMemberCheckout(state: WorkspaceState): Map<string, Thread[]> {
  const checkouts = new Map<string, Thread[]>();
  for (const lead of state.threads) {
    if (!isCoordinator(lead)) continue;
    for (const [workspaceId, threads] of memberCheckouts(state, lead.id)) checkouts.set(workspaceId, [...checkouts.get(workspaceId) ?? [], ...threads]);
  }
  return checkouts;
}

/**
 * Records a found pull request, and how it stands, on the threads it answers for, so a search can
 * find them by it and a coordinator sees what each still needs. A thread under a coordinator whose
 * own pull request has just merged has nothing left to do, so it resolves; one the user reopened
 * after it merged was told nothing new and stays open.
 */
function linked(state: WorkspaceState, threadIds: string[] | undefined, answer: PullRequestAnswer): WorkspaceState {
  if (answer.status !== "found" || !threadIds?.length) return state;
  const { pullRequest } = answer;
  const ids = new Set(threadIds);
  const resolving = new Set<string>();
  let changed = false;
  const threads = state.threads.map((thread) => {
    if (!ids.has(thread.id) || linkMatches(thread.pullRequest, pullRequest)) return thread;
    changed = true;
    const recorded: Thread = { ...thread, pullRequest: linkOf(pullRequest) };
    const merged = thread.pullRequest?.state !== "merged" && ownPullRequest(recorded)?.state === "merged";
    if (!merged || recorded.resolvedAt !== undefined || recorded.archivedAt !== undefined || !coordinatorOf(state.threads, recorded)) return recorded;
    resolving.add(thread.id);
    return { ...recorded, resolvedAt: now() };
  });
  if (!changed) return state;
  return { ...state, threads: resolving.size ? dismissed(threads, resolving) : threads };
}
