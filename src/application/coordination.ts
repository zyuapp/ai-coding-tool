/** Who works under a coordinator and where each stands as its roster, what Stop all reaches, and how the sidebar groups them. */
import type { PendingRun, WorkspaceState } from "./workspace-state.js";
import type { PairedComputer } from "./state/computers.js";
import { doingWork, threadActivity, unstoppedSessionWork, type ThreadActivity } from "./thread-activity.js";
import { activitySections, type ActivitySections } from "./thread-order.js";
import { caughtStartComputer } from "./outstanding-stops.js";
import { remotelyLedThreads } from "./state/threads.js";
import { coordinatorOf, coordinatedThreadIds, coordinatedThreads, isCoordinator, isWaitingOnUser, leadIdOf, remoteLeadOf, waitingOnUser, withCoordinated, type ThreadProposal, type WaitingOnUser } from "../domain/coordination.js";
import type { Thread } from "../domain/thread.js";
import { newestUnreadFinding, wantsAttention } from "../domain/attention.js";
import { supportsComputerCommand } from "../contracts/computer-capabilities.js";

/**
 * Which kind of run the agent process starts, which decides the tools and instructions it gets. A
 * thread a coordinator on another computer started is a member here, where its reports are recorded.
 */
export function coordinationRole(threads: readonly Thread[], thread: Thread): "coordinator" | "member" | undefined {
  if (isCoordinator(thread)) return "coordinator";
  return coordinatorOf(threads, thread) || remoteLeadOf(thread) ? "member" : undefined;
}

/**
 * A thread working under a coordinator: one of this computer's own, or one a paired computer holds,
 * read in the state that computer last published.
 */
export type CoordinationMember =
  | { thread: Thread; computer: null }
  | { thread: Thread; computer: PairedComputer; holder: WorkspaceState };

const NO_MEMBERS: readonly CoordinationMember[] = [];

/** Held per list of threads and of paired computers, so every view of one coordinator reads the same members. */
const members = new WeakMap<readonly Thread[], { paired: readonly PairedComputer[]; byLead: Map<string, readonly CoordinationMember[]> }>();

/** Each list's threads that work under a coordinator on another computer, and those whose one there is away, gathered once per list. */
/**
 * Every thread working under a live coordinator: this computer's, in the order the list holds them,
 * then each paired computer's that names it as their coordinator. This is the one set its views, its
 * roster and its wake read.
 */
export function coordinationMembers(state: Pick<WorkspaceState, "threads" | "computers">, leadId: string): readonly CoordinationMember[] {
  let held = members.get(state.threads);
  if (!held || held.paired !== state.computers.paired) {
    held = { paired: state.computers.paired, byLead: new Map() };
    members.set(state.threads, held);
  }
  let found = held.byLead.get(leadId);
  if (!found) {
    const live = isCoordinator(state.threads.find((thread) => thread.id === leadId));
    const own: CoordinationMember[] = live ? coordinatedThreads(state.threads, leadId).map((thread) => ({ thread, computer: null })) : [];
    const elsewhere: CoordinationMember[] = live ? state.computers.paired.flatMap((computer) => {
      const holder = computer.state;
      return holder ? remotelyLedThreads(holder.threads).flatMap((thread) => thread.remoteLead!.threadId === leadId ? [{ thread, computer, holder }] : []) : [];
    }) : [];
    found = own.length || elsewhere.length ? [...own, ...elsewhere] : NO_MEMBERS;
    held.byLead.set(leadId, found);
  }
  return found;
}

/**
 * Which threads are working and which wait on an approval, as the computer holding a thread under a
 * coordinator last said; this computer's own read `working` and `blocked`.
 */
export function memberActivity(member: CoordinationMember, working: ReadonlySet<string>, blocked: ReadonlySet<string>): { working: ReadonlySet<string>; blocked: ReadonlySet<string> } {
  return member.computer ? threadActivity(member.holder) : { working, blocked };
}

/** Which of this computer's threads have work going, wait on an approval, and rank as running. */
export type RosterActivity = { working: ReadonlySet<string>; blocked: ReadonlySet<string>; ranked: ReadonlySet<string> };

/**
 * A thread under a coordinator as the computer holding it last said it stands: doing work, which one
 * waiting on the user's approval is not, waiting on an approval, and ranked as running.
 */
export type RosterMember = CoordinationMember & { working: boolean; blocked: boolean; ranked: boolean };

/** Where a coordinator's threads stand, which its row, its wake, and what Dismiss files away read. */
export type CoordinatorRoster = {
  members: readonly RosterMember[];
  threads: readonly Thread[];
  /** What waits on the user from the coordinator and its threads. */
  waiting: WaitingOnUser;
  /** Whether a thread under it waits on an approval. */
  blocked: boolean;
  /** Whether a thread under it is doing work. */
  running: boolean;
  /** The threads under it that Dismiss on its row files away with it: none waiting on an approval. */
  filed: readonly RosterMember[];
  /** Whether Dismiss on its row files anything away. */
  dismissable: boolean;
};

/**
 * Where the threads under a coordinator stand: this computer's as `here` says, each paired computer's
 * as that computer last said. Only the paired computers `on` count, every one when it is left out.
 */
export function coordinatorRoster(state: Pick<WorkspaceState, "threads" | "computers" | "startingProposals">, lead: Thread, here: RosterActivity, on?: readonly PairedComputer[]): CoordinatorRoster {
  const members = (isCoordinator(lead) ? coordinationMembers(state, lead.id) : NO_MEMBERS).flatMap((member): RosterMember[] => {
    if (member.computer && on && !on.some((computer) => computer.id === member.computer!.id)) return [];
    const there = member.computer ? threadActivity(member.holder) : here;
    const id = member.thread.id;
    return [{ ...member, working: doingWork(there, id), blocked: there.blocked.has(id), ranked: there.ranked.has(id) }];
  });
  const threads = members.map((member) => member.thread);
  const filed = members.filter((member) => !member.blocked);
  return {
    members,
    threads,
    waiting: waitingOnUser(lead, threads, state.startingProposals),
    blocked: members.some((member) => member.blocked),
    running: members.some((member) => member.working),
    filed,
    dismissable: canDismiss(lead, filed.map((member) => member.thread), here.blocked),
  };
}

/**
 * The threads under a coordinator that a paired computer last said were working, which that computer
 * has said nothing of since this app started: its line, or the list of computers, has yet to come
 * in. They hold its news as a working thread does, since silence is not their work ending.
 */
export function unheardWork(state: Pick<WorkspaceState, "computers">, lead: Thread): { threadId: string; title: string; computer: PairedComputer | undefined }[] {
  const working = lead.remoteWorking;
  if (!working) return [];
  return Object.entries(working).flatMap(([threadId, { computer: id, title }]) => {
    const computer = state.computers.paired.find((item) => item.id === id);
    return computer?.state ? [] : [{ threadId, title, computer }];
  });
}

/**
 * A thread under a coordinator on a paired computer whose line is up, and the run, usage-limit wait,
 * and workflows and subagents that computer can stop, it has going there.
 */
export type RemoteWork = { thread: Thread; computer: PairedComputer; runId?: string; processIds: string[] };

/** A thread's workflows and subagents that keep working once its run is stopped, so are stopped one by one. */
export type SessionWork = { taskId: string; processIds: string[] };

/** The work Stop all stops under a coordinator, its own included. */
export type CoordinatorWork = {
  /** The coordinator and each thread under it on this computer. */
  threads: readonly Thread[];
  /**
   * The runs on their way it drops: the coordinator's wake, each start of a new thread under it, and
   * each run carrying what was queued for one of those threads, which goes back to its composer.
   */
  starts: PendingRun[];
  /** What those threads' sessions keep working on past their runs. */
  sessionWork: readonly SessionWork[];
  /** Each thread under it on a paired computer with a run, a usage limit to wait out, or session work going there. */
  elsewhere: readonly RemoteWork[];
  /** Each thread the user allowed on a paired computer whose start is still on its way there, and not yet caught by a stop. */
  landing: readonly ThreadProposal[];
};

/**
 * What Stop all would stop under a coordinator, read the same way by the stop and by what offers it.
 * A message on its way to a thread that exists already, as the user's or a decision's answer, is left
 * to arrive: only a run that has started is stopped.
 */
export function coordinatorWork(state: Pick<WorkspaceState, "threads" | "computers" | "pendingRuns" | "startingProposals" | "workflows" | "subagents">, lead: Thread): CoordinatorWork {
  const coordinated = coordinationMembers(state, lead.id);
  const threads = [lead, ...coordinated.flatMap((member) => member.computer ? [] : [member.thread])];
  const ids = new Set(threads.map((thread) => thread.id));
  const starts = Object.values(state.pendingRuns).filter((pending) => pending.origin === "composer" && (pending.taskId
    ? pending.taskId === lead.id && pending.coordination?.notes !== undefined || ids.has(pending.taskId) && pending.queuedIds !== undefined
    : pending.coordination?.coordinatorId === lead.id));
  const sessionWork = threads.flatMap((thread): SessionWork[] => {
    const processIds = unstoppedSessionWork(state, thread.id);
    return processIds.length ? [{ taskId: thread.id, processIds }] : [];
  });
  const elsewhere = coordinated.flatMap((member): RemoteWork[] => {
    if (!member.computer || member.computer.status !== "connected") return [];
    const { thread, computer, holder } = member;
    const run = holder.activeRuns[thread.id];
    /** Only what that computer's build can stop counts, so Stop all is never offered for work it cannot reach. */
    const processIds = unstoppedSessionWork(holder, thread.id)
      .filter((processId) => supportsComputerCommand(computer.capabilities, { type: "run.stop-process", taskId: thread.id, processId }));
    return run || thread.limitPause || processIds.length ? [{ thread, computer, ...(run ? { runId: run.runId } : {}), processIds }] : [];
  });
  const landing = (lead.proposals ?? []).filter((proposal) => proposal.place.computer && state.startingProposals.includes(proposal.id) && caughtStartComputer(lead, proposal.id) === undefined);
  return { threads, starts, sessionWork, elsewhere, landing };
}

/**
 * Each live coordinator with a run going, a wait on a usage limit, a workflow or subagent working, or
 * a run or a start on its way under it.
 */
export function stoppableCoordinators(state: Pick<WorkspaceState, "threads" | "computers" | "pendingRuns" | "activeRuns" | "startingProposals" | "workflows" | "subagents">): Set<string> {
  const stoppable = new Set<string>();
  for (const lead of state.threads) {
    if (!isCoordinator(lead)) continue;
    const { threads, starts, sessionWork, elsewhere, landing } = coordinatorWork(state, lead);
    if (starts.length || sessionWork.length || elsewhere.length || landing.length || threads.some((thread) => state.activeRuns[thread.id] || thread.limitPause)) stoppable.add(lead.id);
  }
  return stoppable;
}

const NO_STARTS: readonly string[] = [];

/** Whether a finished thread under a coordinator is waiting behind it. A resolved thread is filed away, so whatever a later run left on it is no reason to lead. */
export function membersWantAttention(members: readonly Thread[]): boolean {
  return members.some((thread) => thread.resolvedAt === undefined && wantsAttention(thread));
}

function counted(count: number, one: string, many: string): string | null {
  return count === 1 ? one : count ? `${count} ${many}` : null;
}

/**
 * What a row says waits on the user, or null when nothing does, worded as its Needs-you card asks:
 * a request names the computer it would run on, as the card's "Run on Studio?" does.
 */
export function waitingLine(waiting: WaitingOnUser, owedBy = "you"): string | null {
  const { decisions, suggestions, requests, blocked, failed } = waiting;
  const computers = new Set(requests);
  const where = computers.size === 1 ? `on ${requests[0]}` : "on other computers";
  const parts = [
    counted(decisions, "a decision", "decisions"),
    counted(requests.length, `a request to run a thread ${where}`, `requests to run threads ${where}`),
    counted(suggestions, "a suggested thread", "suggested threads"),
    counted(blocked, "a blocked thread", "blocked threads"),
    counted(failed, "a failed thread", "failed threads"),
  ].filter((part) => part !== null);
  if (!parts.length) return null;
  const said = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0]!;
  return `${said[0]!.toUpperCase()}${said.slice(1)} ${decisions + suggestions + requests.length + blocked + failed === 1 ? "is" : "are"} waiting on ${owedBy}`;
}

/**
 * A row's second line once nothing under it waits on an approval: what waits on the user, else the
 * newest thing a run found that they have not seen. The desktop's row and the phone's say the same.
 */
export function rowHeadline(thread: Thread, waiting: string | null): string | null {
  return waiting ?? newestUnreadFinding(thread)?.headline ?? null;
}

/**
 * Whether Dismiss on a row files anything away: a verdict or a finding on its thread or, on a
 * coordinator's, on a thread under it, which it is dismissed with. A thread waiting on an approval,
 * the row's own or one under it, has nothing to dismiss until that is answered, and what waits on the
 * user is answered, never dismissed.
 */
export function canDismiss(thread: Thread, members: readonly Thread[], blocked: ReadonlySet<string>): boolean {
  return !blocked.has(thread.id) && (wantsAttention(thread) || membersWantAttention(members.filter((member) => !blocked.has(member.id))));
}

/** What a Dismiss of the rows `ids` files away, by the rule `canDismiss` reads: those rows and a coordinator's threads with it, none waiting on an approval. */
export function dismissedWith(threads: readonly Thread[], ids: ReadonlySet<string>, blocked: ReadonlySet<string>): Set<string> {
  return new Set([...withCoordinated(threads, new Set(ids))].filter((id) => !blocked.has(id)));
}

/** The rows of a list Dismiss would file anything away from, which are what Dismiss all files away. */
export function dismissableRows(rows: readonly Thread[], threadsByCoordinator: ReadonlyMap<string, readonly Thread[]>, blocked: ReadonlySet<string>): Thread[] {
  return rows.filter((row) => canDismiss(row, threadsByCoordinator.get(row.id) ?? [], blocked));
}

/**
 * The activity lists with each coordinator standing for its threads: they are drawn under it rather
 * than in a list of their own, and it ranks by whichever of them wants the user most. A suggestion
 * already `starting` waits on no one.
 */
export function coordinationSections(threads: Thread[], busy: Set<string>, blocked: Set<string>, starting = NO_STARTS): ActivitySections {
  const members = coordinatedThreadIds(threads);
  if (!members.size && !threads.some((thread) => thread.decisions?.length || thread.proposals?.length)) return activitySections(threads, busy, blocked);
  const leads = threads.filter((thread) => isCoordinator(thread));
  const ranked = new Set(busy);
  const asking = new Set(blocked);
  const attention = new Set<string>();
  for (const lead of leads) {
    const led = coordinatedThreads(threads, lead.id);
    const coordination = [lead, ...led];
    if (coordination.some((thread) => blocked.has(thread.id)) || isWaitingOnUser(waitingOnUser(lead, led, starting))) asking.add(lead.id);
    if (coordination.some((thread) => busy.has(thread.id))) ranked.add(lead.id);
    if (membersWantAttention(led)) attention.add(lead.id);
  }
  for (const thread of threads) if (!members.has(thread.id) && thread.role !== "coordinator" && isWaitingOnUser(waitingOnUser(thread, [], starting))) asking.add(thread.id);
  const listed = threads.filter((thread) => !members.has(thread.id));
  const sections = activitySections(listed, ranked, asking);
  if (!attention.size) return sections;
  /** A coordinator a finished thread is waiting behind leads as that thread would have. */
  const promoted = sections.threads.filter((thread) => attention.has(thread.id));
  if (!promoted.length) return sections;
  const moved = new Set(promoted.map((thread) => thread.id));
  return {
    priority: [...sections.priority, ...promoted],
    running: sections.running,
    threads: sections.threads.filter((thread) => !moved.has(thread.id)),
    snoozed: sections.snoozed,
  };
}

/**
 * A computer's own threads ranked as its sidebar ranks them: each coordinator here stands for its
 * threads on the paired `computers` too, as each of those computers last said they stand. What
 * Dismiss all files away reads it over the computers the sidebar shows, and the phone over every one.
 * The threads it ranked come with it, for narrowing them to one project.
 */
export function ownCoordinationSections(state: Pick<WorkspaceState, "threads" | "computers" | "startingProposals">, own: Thread[], here: Pick<ThreadActivity, "working" | "blocked" | "ranked">, computers: readonly PairedComputer[]): { sections: ActivitySections; threads: Thread[] } {
  const elsewhere = own.filter(isCoordinator).flatMap((lead) => coordinatorRoster(state, lead, here, computers).members.filter((member) => member.computer));
  if (!elsewhere.length) return { sections: coordinationSections(own, here.ranked, here.blocked, state.startingProposals), threads: own };
  const where = (held: (member: RosterMember) => boolean, ids: Set<string>) => new Set([...ids, ...elsewhere.flatMap((member) => held(member) ? [member.thread.id] : [])]);
  const threads = [...own, ...elsewhere.map(({ thread }) => thread)];
  return { sections: coordinationSections(threads, where((member) => member.ranked, here.ranked), where((member) => member.blocked, here.blocked), state.startingProposals), threads };
}

/**
 * The activity lists narrowed to one project. A coordinator's row stays while any thread under it
 * works there, since its row is where those threads are drawn.
 */
export function projectActivity(sections: ActivitySections, threads: Thread[], projectId: string): ActivitySections {
  const members = coordinatedThreadIds(threads);
  const leads = new Set<string>();
  for (const thread of threads) if (members.has(thread.id) && thread.projectId === projectId) leads.add(leadIdOf(thread)!);
  const keep = (thread: Thread) => thread.projectId === projectId || leads.has(thread.id);
  return {
    priority: sections.priority.filter(keep),
    running: sections.running.filter(keep),
    threads: sections.threads.filter(keep),
    snoozed: sections.snoozed.filter(keep),
  };
}
