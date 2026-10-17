/** What a coordinator's Overview, cards and Needs-you card show of it and its threads, each object held while nothing it shows moves. */
import type { WorkspaceState } from "./workspace-state.js";
import type { ApprovalView } from "./thread-run-state.js";
import { ledStartRefusal, threadHostOf, type PairedComputer, type ThreadHost } from "./computers.js";
import { checkoutAnswer, coordinatedThreadStatus, coordinationMembers, GROUP_OF, memberActivity, nextSteps, ownPullRequest, type CoordinatedThreadStanding, type CoordinationMember, type OwnPullRequest } from "./coordination.js";
import { coordinationDecisions, coordinatorOf, isCoordinator, openDecisions, remoteLeadOf, threadModelOf, type Decision, type MemoryNote, type NextStep, type OverviewGroup, type ThreadBrief, type ThreadModelChoice, type ThreadProposal } from "../domain/coordination.js";
import { threadCreatedAt, type Thread } from "../domain/thread.js";
import { currentModel } from "../domain/agent-engine.js";
import type { Project } from "../domain/project.js";

/** One thread under a coordinator as its Overview row and its card in the coordinator's conversation show it. */
export type CoordinatedThreadView = CoordinatedThreadStanding & {
  pullRequest: OwnPullRequest | null;
  steps: readonly NextStep[];
  /** When a thread the coordinator started began; null for one moved under it by hand or started by another of its threads. */
  startedAt: number | null;
  /** The paired computer holding the thread, or null for one of this computer's own. */
  host: ThreadHost | null;
  /** Working as the computer holding it last said, that computer being out of reach now. */
  lastHeard: boolean;
};

/** A thread the coordinator started, and when, which is where its card sits in the coordinator's conversation. */
export type ThreadStart = { id: string; at: number };

export type CoordinationDecisionView = {
  thread: Thread;
  decision: Decision;
};

export type CoordinationApprovalView = {
  thread: Thread;
  approval: ApprovalView;
};

/**
 * Where a thread asked for on a paired computer would run: that computer, the projects it holds to
 * start the thread in, and why it cannot take one right now, or null when it can.
 */
export type ElsewhereView = { computer: ThreadHost; projects: readonly Project[]; project: string | null; refusal: string | null };

/**
 * A thread the coordinator suggested or asked for on another computer, whether the user's start of
 * it is on its way, and for one elsewhere, where it would run.
 */
export type ProposalView = { proposal: ThreadProposal; starting: boolean; elsewhere: ElsewhereView | null };

/** What a coordinator keeps, as its Overview shows it. */
export type CoordinatorMemoryView = {
  purpose: string | null;
  notes: readonly MemoryNote[];
};

/** What a coordinator and the threads under it have spent, most first, and how much of it was its own. */
export type CoordinationUsage = {
  total: number;
  coordinator: number;
  /** Each spend under the name its model now goes by; a thread on a paired computer may name one this build does not know. */
  byModel: readonly { model: string; tokens: number }[];
  /** The threads under it that spent anything; the coordinator's own share is `coordinator`. */
  byThread: readonly { thread: Thread; computer: PairedComputer | null; tokens: number }[];
};

/**
 * What a coordinator and every thread under it spent, resolved ones too, or null before any of them
 * has spent anything. Threads archived out from under it no longer count.
 */
export function coordinationUsage(members: readonly CoordinationMember[], lead: Thread): CoordinationUsage | null {
  const byModel = new Map<string, number>();
  const spent = (thread: Thread) => {
    let tokens = 0;
    for (const [recorded, count] of Object.entries(thread.usage ?? {}) as [string, number][]) {
      const model = currentModel(recorded) as string;
      byModel.set(model, (byModel.get(model) ?? 0) + count);
      tokens += count;
    }
    return tokens;
  };
  const coordinator = spent(lead);
  const byThread = members.flatMap(({ thread, computer }) => {
    const tokens = spent(thread);
    return tokens ? [{ thread, computer, tokens }] : [];
  });
  const total = byThread.reduce((sum, { tokens }) => sum + tokens, coordinator);
  if (!total) return null;
  return { total, coordinator, byModel: mostFirst([...byModel].flatMap(([model, tokens]) => tokens ? [{ model, tokens }] : [])), byThread: mostFirst(byThread) };
}

function mostFirst<Entry extends { tokens: number }>(entries: Entry[]): Entry[] {
  return entries.sort((left, right) => right.tokens - left.tokens);
}

/**
 * The usage held before while every count, and every thread's name, is the same, so its section draws
 * nothing anew. The threads it holds may be older objects, which is fine: it reads only their id and title.
 */
function sameUsage(before: CoordinationUsage | null | undefined, next: CoordinationUsage | null): CoordinationUsage | null {
  if (!before || !next) return next;
  const same = before.total === next.total && before.coordinator === next.coordinator
    && before.byModel.length === next.byModel.length && before.byModel.every((entry, index) => entry.model === next.byModel[index]!.model && entry.tokens === next.byModel[index]!.tokens)
    && before.byThread.length === next.byThread.length && before.byThread.every((entry, index) => {
      const other = next.byThread[index]!;
      return entry.thread.id === other.thread.id && entry.thread.title === other.thread.title && entry.computer === other.computer && entry.tokens === other.tokens;
    });
  return same ? before : next;
}

/**
 * What the open thread shows: a coordinator its threads, their approvals and open decisions, what
 * they run on and its memory; a thread its coordinator and brief.
 */
export type CoordinationView = CoordinationParts & (
  | { coordinator: true; threadModel: ThreadModelChoice; memory: CoordinatorMemoryView }
  | { coordinator: false; threadModel: null; memory: null }
);

type CoordinationParts = {
  members: readonly CoordinatedThreadView[];
  /** The threads it started, oldest first. */
  starts: readonly ThreadStart[];
  /** Tool approvals it and its threads are waiting on, answered beside its decisions. */
  approvals: CoordinationApprovalView[];
  decisions: CoordinationDecisionView[];
  /** Threads it suggested that wait for the user to start or dismiss them. */
  proposals: readonly ProposalView[];
  /** On a coordinator, what it and its threads have spent; null before anything was counted, and on any other thread. */
  usage: CoordinationUsage | null;
  lead: Thread | null;
  /**
   * The coordinator on another computer the thread works under, as that computer named it, with its
   * id when a paired computer here holds it to go to; null on any other thread.
   */
  remoteLead: { title: string; computer: string; threadId: string | null } | null;
  brief: ThreadBrief | null;
  /** A thread under a coordinator with a decision of its own waiting on the user. */
  asking: boolean;
};

const NO_COORDINATION: CoordinationView = { coordinator: false, threadModel: null, memory: null, members: [], starts: [], approvals: [], decisions: [], proposals: [], usage: null, lead: null, remoteLead: null, brief: null, asking: false };

const NO_NOTES: readonly MemoryNote[] = [];

const NO_PROPOSALS: readonly ProposalView[] = [];

/**
 * What the open thread shows. `previous` is the view last made, whose objects are handed back for
 * every thread under the coordinator whose view is unchanged, so its row and card draw nothing anew.
 * A thread on a paired computer stands, and waits on approvals, as that computer last said.
 */
export function coordinationView(
  state: Pick<WorkspaceState, "threads" | "computers" | "projects" | "worktrees" | "memberPullRequests" | "startingProposals">,
  thread: Thread | undefined,
  busy: Set<string>,
  blocked: Set<string>,
  approvalOf: (threadId: string) => ApprovalView | undefined = () => undefined,
  previous?: CoordinationView,
): CoordinationView {
  const { threads } = state;
  if (!thread) return NO_COORDINATION;
  if (isCoordinator(thread)) {
    const held = new Map(previous?.members.map((view) => [view.thread.id, view]));
    const coordinated = coordinationMembers(state, thread.id);
    const members = sameItems(previous?.members, coordinated.map((member) => memberView(state, member, busy, blocked, held.get(member.thread.id))));
    const starts = sameStarts(previous?.starts, members.flatMap(({ thread: member, startedAt }) => startedAt === null ? [] : [{ id: member.id, at: startedAt }]).sort((left, right) => left.at - right.at));
    const own = approvalOf(thread.id);
    const approvals = [
      ...(own ? [{ thread, approval: own }] : []),
      ...members.flatMap(({ thread: member, status }, index) => {
        const approval = status === "approval" ? memberApproval(coordinated[index]!, approvalOf) : undefined;
        return approval ? [{ thread: member, approval }] : [];
      }),
    ];
    const decisions = coordinationDecisions(thread, coordinated.map((member) => member.thread));
    const memory = { purpose: thread.memory?.purpose ?? null, notes: thread.memory?.notes ?? NO_NOTES };
    const proposals = proposalViews(previous?.proposals, thread.proposals ?? [], state.startingProposals, state.computers.paired);
    const usage = sameUsage(previous?.usage, coordinationUsage(coordinated, thread));
    return { ...NO_COORDINATION, coordinator: true, threadModel: threadModelOf(thread), memory, members, starts, approvals, decisions, proposals, usage, brief: thread.brief ?? null };
  }
  const lead = coordinatorOf(threads, thread) ?? null;
  const remote = lead ? undefined : remoteLeadOf(thread);
  /** A thread that left its coordinator with a decision still open is where that decision is answered now. */
  const decisions = lead || remote ? [] : openDecisions(thread).map((decision) => ({ thread, decision }));
  if (!lead && !remote && !thread.brief && !decisions.length) return NO_COORDINATION;
  const remoteLead = remote ? { title: remote.title, computer: remote.computer, threadId: state.computers.paired.some((computer) => computer.state?.threads.some((item) => item.id === remote.threadId)) ? remote.threadId : null } : null;
  return { ...NO_COORDINATION, lead, remoteLead, decisions, brief: thread.brief ?? null, asking: Boolean((lead || remote) && openDecisions(thread).length) };
}

/** The approval a thread under a coordinator waits on, read on the computer that holds it. */
function memberApproval(member: CoordinationMember, approvalOf: (threadId: string) => ApprovalView | undefined): ApprovalView | undefined {
  if (!member.computer) return approvalOf(member.thread.id);
  const run = member.holder.activeRuns[member.thread.id];
  return run?.status === "awaiting-approval" ? member.holder.approvals[run.runId] : undefined;
}

/** A thread's view, or the one held for it when nothing it shows has changed. */
function memberView(state: Pick<WorkspaceState, "projects" | "worktrees" | "memberPullRequests">, member: CoordinationMember, busy: Set<string>, blocked: Set<string>, held: CoordinatedThreadView | undefined): CoordinatedThreadView {
  const { thread } = member;
  const activity = memberActivity(member, busy, blocked);
  const { status, summary } = coordinatedThreadStatus(thread, activity.working, activity.blocked);
  /** What GitHub said of its checkout is known where the checkout is. */
  const steps = nextSteps(thread, status, checkoutAnswer(member.computer ? member.holder : state, thread));
  const host = member.computer ? threadHostOf(member.computer) : null;
  /** The pull request and the start are read off the thread, so the same thread has the same ones. */
  if (held?.thread === thread && held.status === status && held.summary === summary && sameItems(held.steps, steps) === held.steps && sameHost(held.host, host)) return held;
  return { thread, status, summary, pullRequest: ownPullRequest(thread), steps, startedAt: thread.brief ? threadCreatedAt(thread) : null, host, lastHeard: status === "working" && Boolean(host?.offline) };
}

function sameHost(before: ThreadHost | null, next: ThreadHost | null): boolean {
  return before === next || Boolean(before && next && before.id === next.id && before.name === next.name && before.offline === next.offline && before.reconnecting === next.reconnecting);
}

/**
 * Each suggestion's view, the one held before while neither it, whether it is starting, nor for one
 * elsewhere what that computer can take changed.
 */
function proposalViews(before: readonly ProposalView[] | undefined, proposals: readonly ThreadProposal[], starting: readonly string[], paired: readonly PairedComputer[]): readonly ProposalView[] {
  if (!proposals.length) return NO_PROPOSALS;
  const held = new Map(before?.map((view) => [view.proposal, view]));
  return sameItems(before, proposals.map((proposal) => {
    const view = held.get(proposal);
    const isStarting = starting.includes(proposal.id);
    const elsewhere = elsewhereView(proposal, paired);
    return view && view.starting === isStarting && sameElsewhere(view.elsewhere, elsewhere) ? view : { proposal, starting: isStarting, elsewhere };
  }));
}

/**
 * Where a thread asked for on another computer would run, as that computer now stands: the folder
 * asked for while it is still there, else the first one there is.
 */
function elsewhereView(proposal: ThreadProposal, paired: readonly PairedComputer[]): ElsewhereView | null {
  const place = proposal.place.computer;
  if (!place) return null;
  const computer = paired.find((item) => item.id === place.id);
  const projects = computer?.state?.projects.filter((project) => !project.unlisted || project.id === proposal.place.project) ?? [];
  const project = (projects.find((item) => item.id === proposal.place.project) ?? projects[0])?.id ?? null;
  const refusal = ledStartRefusal(computer) ?? (project ? null : `That folder is no longer on ${computer!.name}.`);
  return { computer: threadHostOf(computer ?? { id: place.id, name: place.name, status: "offline" }), projects, project, refusal };
}

function sameElsewhere(before: ElsewhereView | null, next: ElsewhereView | null): boolean {
  if (!before || !next) return before === next;
  return sameHost(before.computer, next.computer) && before.project === next.project && before.refusal === next.refusal
    && before.projects.length === next.projects.length && before.projects.every((project, index) => project === next.projects[index]);
}

/** The list held before when it holds the same items in the same order, else the new one. */
function sameItems<Item>(before: readonly Item[] | undefined, next: readonly Item[]): readonly Item[] {
  return before && before.length === next.length && before.every((item, index) => item === next[index]) ? before : next;
}

function sameStarts(before: readonly ThreadStart[] | undefined, next: ThreadStart[]): readonly ThreadStart[] {
  return before && before.length === next.length && before.every((start, index) => start.id === next[index]!.id && start.at === next[index]!.at) ? before : next;
}

export function overviewGroups(members: readonly CoordinatedThreadView[]): Record<OverviewGroup, CoordinatedThreadView[]> {
  const groups: Record<OverviewGroup, CoordinatedThreadView[]> = { needs: [], review: [], working: [], done: [], resolved: [] };
  for (const member of members) groups[GROUP_OF[member.status]].push(member);
  return groups;
}
