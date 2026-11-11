/** The pull request the checkout in front belongs to, those a coordinator's threads work on, and which ask each answer belongs to. */
import { currentWorkspaceId } from "./environment.js";
import { threadWorkspaceId } from "../thread-location.js";
import { now } from "./shared.js";
import type { SliceTransition } from "./slice.js";
import { editThreads, resolvedIn, threadsOf, type ThreadsEdit } from "./thread-edits.js";
import type { WorkspaceEffect, WorkspaceInput } from "./types.js";
import { coordinationMembers } from "../coordination.js";
import { remotelyLedThreads } from "../state/threads.js";
import { ownPullRequest } from "../coordinated-thread-status.js";
import { awaitsPullRequest, branchOf, memberCheckouts } from "../pull-request-view.js";
import type { WorkspaceState } from "../workspace-state.js";
import type { GitState } from "../state/pull-requests.js";
import { supportsComputerCommand } from "../../contracts/computer-capabilities.js";
import type { AppCommand } from "../../contracts/commands.js";
import { isCoordinator, stuckVerdict, worksUnderCoordinator } from "../../domain/coordination.js";
import { linkMatches, linkOf, NO_PULL_REQUEST, samePullRequest, type PullRequestAnswer, type PullRequestLink, type PullRequestRead, type PullRequestRef, type PullRequestThread } from "../../domain/pull-request.js";
import type { Thread } from "../../domain/thread.js";

export const PULL_REQUEST_INPUTS = ["pull-request.read", "pull-request.read-members", "pull-request.read-member", "pull-request.answered"] as const;
type PullRequestInput = Extract<WorkspaceInput, { type: (typeof PULL_REQUEST_INPUTS)[number] }>;

/** What GitHub says about a checkout, named by the ask it answers so an overtaken one is dropped. */
export type PullRequestEvent = { type: "pull-request.answered"; workspaceId: string; branch: string | null; read: number; members?: true; answer: PullRequestAnswer };

/** `members` marks an ask for a coordinator's threads, which counts its reads apart from the checkout in front. */
export type PullRequestEffect = { type: "read-pull-request"; workspaceId: string; branch: string | null; read: number; members?: true };

export function reducePullRequests(state: WorkspaceState, input: PullRequestInput): SliceTransition<GitState, PullRequestThread> {
  switch (input.type) {
    case "pull-request.read": {
      const threadId = input.taskId ?? state.currentId;
      const workspaceId = input.taskId ? threadWorkspaceId(state, state.threads.find((thread) => thread.id === input.taskId)) : currentWorkspaceId(state);
      /** Nothing to ask about leaves nothing to draw, so the answer the last checkout gave goes too. */
      if (!workspaceId) return state.pullRequest === null ? {} : { patch: { pullRequest: null } };
      const branch = branchOf(state.environments[workspaceId] ?? null);
      const held = state.pullRequest;
      /** Only another checkout or another branch can have a different answer, so only those blank the row. */
      const kept = held && held.workspaceId === workspaceId && held.branch === branch ? held.answer : NO_PULL_REQUEST;
      const read = (held?.read ?? 0) + 1;
      return {
        patch: { pullRequest: { workspaceId, branch, read, answer: kept, ...(threadId ? { threadIds: [threadId] } : {}) } },
        effects: [{ type: "read-pull-request", workspaceId, branch, read }],
      };
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
      let memberPullRequests = Object.keys(state.memberPullRequests).every((workspaceId) => everyone.has(workspaceId))
        ? state.memberPullRequests
        : Object.fromEntries(Object.entries(state.memberPullRequests).filter(([workspaceId]) => everyone.has(workspaceId)));
      const effects: WorkspaceEffect[] = [];
      for (const workspaceId of ours.keys()) {
        const read = checkoutRead(state, memberPullRequests, workspaceId, everyone.get(workspaceId) ?? []);
        memberPullRequests = read.memberPullRequests;
        effects.push(read.effect);
      }
      return {
        ...(memberPullRequests === state.memberPullRequests ? {} : { patch: { memberPullRequests } }),
        effects: [...effects, ...(lead && isCoordinator(lead) ? remoteReads(state, lead.id) : [])],
      };
    }
    /** One thread's checkout, asked for by the coordinator it works under on another computer, which reads the answer off this computer's state. */
    case "pull-request.read-member": {
      const thread = state.threads.find((item) => item.id === input.taskId);
      const read = thread && thread.archivedAt === undefined && worksUnderCoordinator(state.threads, thread) && awaitsPullRequest(thread) ? memberRead(state, thread) : null;
      return read ? { patch: { memberPullRequests: read.memberPullRequests }, effects: [read.effect] } : {};
    }
    case "pull-request.answered": {
      /** Answers to asks older than the latest are dropped, whichever order they arrive in. */
      const held = state.pullRequest;
      const answersHeld = !input.members && held && held.read === input.read && held.workspaceId === input.workspaceId && held.branch === input.branch;
      const member = state.memberPullRequests[input.workspaceId];
      const answersMember = input.members && member && member.read === input.read && member.branch === input.branch;
      if (!answersHeld && !answersMember) return {};
      const current = answersHeld && !samePullRequest(held.answer, input.answer);
      /** A checkout's first answer is news even when it says none, since none is now GitHub's word. */
      const changedMember = answersMember && (!member.answered || !samePullRequest(member.answer, input.answer));
      const threads = linked(state, answersHeld ? held.threadIds : member?.threadIds, input.answer);
      const edits = threads ? [threads] : [];
      if (!current && !changedMember) return { edits };
      return {
        patch: {
          ...(current ? { pullRequest: { ...held, answer: input.answer } } : {}),
          ...(changedMember ? { memberPullRequests: { ...state.memberPullRequests, [input.workspaceId]: { ...member, answer: input.answer, answered: true } } } : {}),
        },
        edits,
      };
    }
  }
}

/**
 * Asks again about the pull request of the checkout a thread under a coordinator works in, on behalf
 * of every such thread in it. A thread's branch rarely moves, so the answer stands until the next one
 * replaces it.
 */
export function memberPullRequestRead(state: WorkspaceState, thread: Thread): { state: WorkspaceState; effect: WorkspaceEffect } | null {
  const read = memberRead(state, thread);
  return read && { state: { ...state, memberPullRequests: read.memberPullRequests }, effect: read.effect };
}

function memberRead(state: WorkspaceState, thread: Thread): MemberRead | null {
  const workspaceId = threadWorkspaceId(state, thread);
  if (!workspaceId) return null;
  return checkoutRead(state, state.memberPullRequests, workspaceId, everyMemberCheckout(state).get(workspaceId) ?? [thread]);
}

type MemberRead = { memberPullRequests: GitState["memberPullRequests"]; effect: WorkspaceEffect };

function checkoutRead(state: WorkspaceState, reads: GitState["memberPullRequests"], workspaceId: string, threads: Thread[]): MemberRead {
  const held = reads[workspaceId];
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
    memberPullRequests: { ...reads, [workspaceId]: read },
    effect: { type: "read-pull-request", workspaceId, branch: read.branch, read: read.read, members: true },
  };
}

/**
 * What a coordinator's threads on paired computers need read: each computer that can take it is asked
 * to read the checkout of each such thread there that an answer could still move, and the answer is
 * recorded on the thread there, which is where this computer reads it. Like a read of a plan's limits,
 * one the line drops is asked again on the next poll.
 */
function remoteReads(state: WorkspaceState, leadId: string): WorkspaceEffect[] {
  const asks = new Map<string, AppCommand[]>();
  for (const member of coordinationMembers(state, leadId)) {
    if (!member.computer || member.computer.status !== "connected" || !awaitsPullRequest(member.thread)) continue;
    const read: AppCommand = { type: "pull-request.read-member", taskId: member.thread.id };
    if (supportsComputerCommand(member.computer.capabilities, read)) asks.set(member.computer.id, [...asks.get(member.computer.id) ?? [], read]);
  }
  return [...asks].map(([id, inputs]) => ({ type: "computer.forward", id, inputs }));
}

/**
 * Every checkout a thread under any live coordinator works in, each with those threads, and every
 * one a thread under a coordinator on another computer works in here.
 */
function everyMemberCheckout(state: WorkspaceState): Map<string, Thread[]> {
  const checkouts = new Map<string, Thread[]>();
  for (const lead of state.threads) {
    if (!isCoordinator(lead)) continue;
    for (const [workspaceId, threads] of memberCheckouts(state, lead.id)) checkouts.set(workspaceId, [...checkouts.get(workspaceId) ?? [], ...threads]);
  }
  for (const thread of remotelyLedThreads(state.threads)) {
    const workspaceId = threadWorkspaceId(state, thread);
    if (workspaceId) checkouts.set(workspaceId, [...checkouts.get(workspaceId) ?? [], thread]);
  }
  return checkouts;
}

/**
 * Records a found pull request, and how it stands, on the threads it answers for, so a search can
 * find them by it and a coordinator sees what each still needs. A thread under a coordinator whose
 * own pull request has just merged has nothing left to do, so it resolves, unless its turn left it
 * stuck, which still needs the user. One the user reopened after that pull request merged was told
 * nothing new and stays open, though a different pull request of its own merging is news.
 */
function linked(state: WorkspaceState, threadIds: string[] | undefined, answer: PullRequestAnswer): ThreadsEdit<PullRequestThread> | null {
  if (answer.status !== "found" || !threadIds?.length) return null;
  const { pullRequest } = answer;
  const ids = new Set(threadIds);
  const resolving = new Set<string>();
  const recorded = editThreads(threadsOf<PullRequestThread>(state), (thread) => {
    if (!ids.has(thread.id) || linkMatches(thread.pullRequest, pullRequest)) return null;
    const link = linkOf(pullRequest);
    const after: Thread = { ...thread, pullRequest: link };
    const merged = !mergedAlready(thread.pullRequest, pullRequest) && ownPullRequest(after)?.state === "merged";
    if (merged && after.resolvedAt === undefined && after.archivedAt === undefined && !stuckVerdict(after) && worksUnderCoordinator(state.threads, after)) resolving.add(thread.id);
    return { pullRequest: link };
  });
  if (recorded.view.threads === state.threads) return null;
  return resolving.size ? resolvedIn(recorded, resolving, now()) : recorded;
}

/** Whether a thread's link already said the pull request found for it had merged. */
function mergedAlready(link: PullRequestLink | undefined, pullRequest: PullRequestRef): boolean {
  return link?.state === "merged" && link.number === pullRequest.number && link.url === pullRequest.url;
}
