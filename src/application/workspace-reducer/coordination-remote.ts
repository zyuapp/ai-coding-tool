/** What a coordinator here hears of the threads it started on paired computers, and how they are let go once it is gone. */
import { proposalLanded } from "./proposals.js";
import { now, settled } from "./shared.js";
import type { WorkspaceEffect, WorkspaceTransition } from "./types.js";
import { coordinationMembers, coordinationNote, decisionHeadline, decisionNote, leadAwayThreads, remotelyLedThreads, reportHeadline, reportNote, turnNote } from "../coordination.js";
import type { ThreadChange } from "../thread-activity.js";
import { announced, waitingHeadline } from "../notices.js";
import { settledHeadline } from "../run-testimony.js";
import { updateThread } from "../thread-run-state.js";
import { lastWorkingIds, MAX_DISCARDED_LEADS, type PairedComputer } from "../computers.js";
import { viewPreferences } from "../view-preferences.js";
import type { WorkspaceState } from "../workspace-state.js";
import { supportsComputerCommand } from "../../contracts/computer-capabilities.js";
import type { AppCommand } from "../../contracts/commands.js";
import { isCoordinator, mayLeadElsewhere, openDecisions, withCoordinationNote, withRemoteHeard, type CoordinationNote } from "../../domain/coordination.js";
import { lastRunOutcome, threadCreatedAt, type HeardWork, type Thread } from "../../domain/thread.js";
import { resumesOnItsOwn } from "../../domain/usage-limit.js";

/** What a coordinator here hears of its threads on paired computers, and the coordinators that may now be due a wake. */
export type RemoteNews = { state: WorkspaceState; effects: WorkspaceEffect[]; leads: Set<string> };

/**
 * What paired computers' states say of the threads coordinators here started there, read against
 * how far each coordinator has heard each thread, so news from while a line was down is caught up
 * once it is back rather than lost. Only a computer whose threads, runs or line moved is read, and
 * of its threads only those a coordinator elsewhere started. A thread whose work stopped or started
 * there may free or hold its coordinator's wake, so that coordinator is looked at again too.
 */
export function remoteNews(previous: WorkspaceState, next: WorkspaceState): RemoteNews {
  const news: RemoteNews = { state: next, effects: [], leads: new Set() };
  if (previous.computers.paired === next.computers.paired) return news;
  const before = new Map(previous.computers.paired.map((computer) => [computer.id, computer]));
  for (const computer of next.computers.paired) {
    const was = before.get(computer.id);
    before.delete(computer.id);
    const holder = computer.state;
    const prior = was?.state ?? null;
    if (!holder || prior && was!.status === computer.status && prior.threads === holder.threads && prior.activeRuns === holder.activeRuns) continue;
    const members = remotelyLedThreads(holder.threads);
    const earlier = prior ? remotelyLedThreads(prior.threads) : [];
    if (!members.length && !earlier.length) continue;
    const working = lastWorkingIds(holder);
    const workedBefore = prior ? lastWorkingIds(prior) : new Set<string>();
    const kept = new Set(members.map((thread) => thread.id));
    /** A thread that left, or stopped being one of a coordinator's, may have been what held its coordinator's news. */
    for (const thread of earlier) if (!kept.has(thread.id) && workedBefore.has(thread.id)) news.leads.add(thread.remoteLead!.threadId);
    for (const member of members) {
      const lead = news.state.threads.find((thread) => thread.id === member.remoteLead!.threadId);
      if (!lead || !isCoordinator(lead)) continue;
      if (working.has(member.id) !== workedBefore.has(member.id)) news.leads.add(lead.id);
      const heard = memberNews(news.state, lead, member, computer, holder, prior);
      if (heard.state !== news.state) news.leads.add(lead.id);
      /** A thread the user allowed there settles its card as it shows up, even when that computer's answer was lost. */
      const proposalId = member.remoteLead!.proposalId;
      const landed = proposalId ? proposalLanded(heard.state, lead.id, proposalId, member.id, computer) : settled(heard.state);
      news.state = landed.state;
      news.effects.push(...heard.effects, ...landed.effects);
    }
  }
  /** A computer no longer paired takes its threads' work with it. */
  for (const gone of before.values()) {
    if (!gone.state) continue;
    const working = lastWorkingIds(gone.state);
    for (const thread of remotelyLedThreads(gone.state.threads)) if (working.has(thread.id)) news.leads.add(thread.remoteLead!.threadId);
  }
  return keptWork(previous, news);
}

/**
 * Each coordinator here keeps which of its threads each paired computer last said was working, and
 * their titles, so a restart here, after which a computer says nothing until its line is back, does
 * not take that silence for their work ending. What a computer says anew replaces what it said before, and one no
 * longer paired keeps nothing. A coordinator whose kept work changed is looked at again.
 */
function keptWork(previous: WorkspaceState, news: RemoteNews): RemoteNews {
  const before = new Map(previous.computers.paired.map((computer) => [computer.id, computer.state]));
  const paired = new Set<string>();
  const fresh = new Set<string>();
  const said = new Map<string, [string, HeardWork][]>();
  for (const computer of news.state.computers.paired) {
    paired.add(computer.id);
    const holder = computer.state;
    if (!holder || holder === before.get(computer.id)) continue;
    fresh.add(computer.id);
    const working = lastWorkingIds(holder);
    for (const thread of remotelyLedThreads(holder.threads)) {
      if (!working.has(thread.id)) continue;
      const leadId = thread.remoteLead!.threadId;
      const work: [string, HeardWork] = [thread.id, { computer: computer.id, title: thread.title }];
      const heard = said.get(leadId);
      if (heard) heard.push(work);
      else said.set(leadId, [work]);
    }
  }
  let state = news.state;
  const leads = new Set(news.leads);
  for (const lead of news.state.threads) {
    if (!lead.remoteWorking && !said.has(lead.id)) continue;
    const kept = Object.entries(lead.remoteWorking ?? {}).filter(([, work]) => paired.has(work.computer) && !fresh.has(work.computer));
    const working = [...kept, ...isCoordinator(lead) ? said.get(lead.id) ?? [] : []];
    const held = lead.remoteWorking ?? {};
    if (working.length === Object.keys(held).length && working.every(([threadId, work]) => held[threadId]?.computer === work.computer && held[threadId].title === work.title)) continue;
    state = updateThread(state, lead.id, ({ remoteWorking: _said, ...thread }) => working.length ? { ...thread, remoteWorking: Object.fromEntries(working) } : thread);
    leads.add(lead.id);
  }
  return state === news.state ? news : { ...news, state, leads };
}

/**
 * What a coordinator hears of one of its threads on a paired computer since it last heard of it, on
 * that computer's clock: that it showed up there, quietly, then each decision it raised, the report
 * it made, and its turn ending, as a thread here would have been heard. What the user would have been
 * told of a thread here is told of it here, under the coordinator's notices, and what that computer
 * carries of the same is dropped: what its scheduled runs found, and its turns ending and waiting on
 * the user as a thread here is heard, for a run someone started. A run Stop all asked to end is heard
 * quietly.
 */
function memberNews(state: WorkspaceState, lead: Thread, member: Thread, computer: PairedComputer, holder: WorkspaceState, prior: WorkspaceState | null): { state: WorkspaceState; effects: WorkspaceEffect[] } {
  const heard = lead.remoteHeard?.[member.id];
  /** What it did while its coordinator was away is none of that coordinator's news, as for a thread here. */
  const back = member.remoteLead!.backAt;
  const since = Math.max(heard ?? 0, back ?? 0);
  const at = now();
  const notes: CoordinationNote[] = [];
  const effects: WorkspaceEffect[] = [];
  let newest = Math.max(heard ?? threadCreatedAt(member), back ?? 0);
  let { quietStops, stoppedStarts, quietPauses } = state;
  const run = holder.activeRuns[member.id];
  const ran = prior?.activeRuns[member.id];
  if (heard === undefined && back === undefined) notes.push(coordinationNote(member.id, `"${member.title}" started on ${computer.name}.`, at, { quiet: true }));
  for (const decision of openDecisions(member)) {
    if (decision.raisedAt <= since) continue;
    notes.push(decisionNote(member, decision, at, run?.runId));
    effects.push(...announced(state, lead, decisionHeadline(decision), "decision"));
    newest = Math.max(newest, decision.raisedAt);
  }
  const report = member.report;
  if (report && report.at > since && report.state !== "working") {
    notes.push(reportNote(member, report, at, run?.runId));
    if (report.state !== "done") effects.push(...announced(state, member, reportHeadline(report), "blocked"));
    newest = Math.max(newest, report.at);
  }
  for (const finding of member.findings ?? []) {
    if (finding.at <= since) continue;
    effects.push(...announced(state, member, finding.headline, "finding"));
    newest = Math.max(newest, finding.at);
  }
  const endedAt = member.runEndedAt !== undefined && member.runEndedAt > since ? member.runEndedAt : undefined;
  /**
   * A run that computer last said was going and that is gone with no word of its end, as one an older
   * build there lost to quitting, ended its turn all the same. Only a quiet scheduled run that found
   * nothing puts its thread back as if it never ran.
   */
  const lost = ran !== undefined && !ran.quiet && endedAt === undefined;
  /** A thread waiting out a session limit carries on by itself, so its turn has not ended. */
  const ended = (endedAt !== undefined || lost) && !run && !(member.limitPause && resumesOnItsOwn(member.limitPause));
  /** A wait Stop all ended that the thread carried on from before the stop landed is no longer its to quiet. */
  if (run && quietPauses.includes(member.id)) quietPauses = quietPauses.filter((threadId) => threadId !== member.id);
  if (ended) {
    /** So is one a start Stop all caught on its way stopped as it landed. */
    const caught = stoppedStarts.some((start) => start.threadId === member.id);
    if (caught) stoppedStarts = stoppedStarts.filter((start) => start.threadId !== member.id);
    const stopped = ran !== undefined && quietStops.includes(ran.runId);
    if (stopped) quietStops = quietStops.filter((runId) => runId !== ran.runId);
    /** And one whose wait on a usage limit Stop all ended. */
    const lifted = quietPauses.includes(member.id);
    if (lifted) quietPauses = quietPauses.filter((threadId) => threadId !== member.id);
    const quiet = stopped || caught || lifted;
    const ending = lastRunOutcome(member);
    const status = quiet || ending === "stopped" ? "cancelled" : ending === "failed" ? "failed" : "succeeded";
    notes.push(turnNote(member, status, at, { quiet }));
    /**
     * Said as a run here would say it: a failure in the words that computer left on the thread, and a
     * finish only for a run someone started, so one this computer never saw go speaks only if it failed.
     * One lost without a word has no finish to tell.
     */
    const surfacing = status === "failed" ? "failed" : status === "succeeded" && ran && ran.origin !== "automation" && !lost ? "attended" : null;
    const failure = member.messages.at(-1);
    const headline = settledHeadline(surfacing, failure?.kind === "system" && failure.tone === "error" ? failure.text : undefined);
    if (headline) effects.push(...announced(state, member, headline, surfacing === "failed" ? "failed" : "finished"));
    newest = Math.max(newest, endedAt ?? newest);
  }
  /** Waiting on the user is said as it starts, as it is of a thread here. */
  if (run?.origin === "composer" && computer.status === "connected") {
    const approval = run.status === "awaiting-approval" ? holder.approvals[run.runId] : undefined;
    if (approval && (ran?.runId !== run.runId || ran.status !== "awaiting-approval")) effects.push(...announced(state, member, waitingHeadline(approval), "waiting"));
    const question = run.questions?.[0];
    if (question && !(ran?.runId === run.runId && ran.questions?.length)) effects.push(...announced(state, member, waitingHeadline(question), "waiting"));
  }
  const stops = quietStops === state.quietStops && stoppedStarts === state.stoppedStarts && quietPauses === state.quietPauses ? state : { ...state, quietStops, stoppedStarts, quietPauses };
  if (!notes.length && newest === heard) return { state: stops, effects };
  const led = new Set(coordinationMembers(state, lead.id).flatMap(({ thread, computer: there }) => there ? [thread.id] : []));
  const told = notes.reduce(withCoordinationNote, withRemoteHeard(lead, member.id, newest, led));
  return { state: updateThread(stops, lead.id, () => told), effects };
}

/**
 * Each thread on a paired computer working under a thread here that is no longer a live coordinator
 * is told its coordinator is away, so it stands on its own as this computer's own threads do once
 * theirs goes, and is told it is back once it is a coordinator again, as this computer's own are back
 * under it. One under a coordinator gone from here is let go for good. It is read off what each
 * computer says it holds, so one that was away, or whose state comes in only after its line is back,
 * is told once it says so, and what could not be carried is tried again the next time its threads move.
 */
export function released(previous: WorkspaceState, state: WorkspaceState, threads: readonly ThreadChange[]): WorkspaceEffect[] {
  const changed = threads.some(({ before, after }) => isCoordinator(before) !== isCoordinator(after));
  if (!changed && previous.computers.paired === state.computers.paired) return [];
  const before = new Map(previous.computers.paired.map((computer) => [computer.id, computer]));
  const effects: WorkspaceEffect[] = [];
  for (const computer of state.computers.paired) {
    if (computer.status !== "connected" || !computer.state) continue;
    const was = before.get(computer.id);
    if (!changed && was?.status === "connected" && was.state?.threads === computer.state.threads) continue;
    const held = computer.state.threads;
    const inputs = [...remotelyLedThreads(held), ...leadAwayThreads(held)].flatMap((thread) => leadChange(state, thread, computer));
    if (inputs.length) effects.push({ type: "computer.forward", id: computer.id, inputs, silent: true });
  }
  return effects;
}

/**
 * What a thread on a paired computer is to be told of the coordinator it names, if that is one here
 * whose standing it has not been told. A computer from before a coordinator could be away lets the
 * thread go for good instead.
 */
function leadChange(state: WorkspaceState, thread: Thread, computer: PairedComputer): AppCommand[] {
  const { threadId: leadId, away = false } = thread.remoteLead!;
  const lead = state.threads.find((item) => item.id === leadId);
  const release: AppCommand = { type: "task.set-coordinator", taskId: thread.id, coordinatorId: null };
  if (!lead) return state.computers.discardedLeads.includes(leadId) && supportsComputerCommand(computer.capabilities, release) ? [release] : [];
  if (isCoordinator(lead) !== away) return [];
  const told: AppCommand = { type: "task.set-lead-away", taskId: thread.id, away: !away };
  if (supportsComputerCommand(computer.capabilities, told)) return [told];
  return !away && supportsComputerCommand(computer.capabilities, release) ? [release] : [];
}

/**
 * Threads leaving this computer for good, cleared from the archive or outliving their time in it,
 * that may still lead threads on paired computers. Once gone they can no longer say those threads
 * are let go, so that is remembered for them, between launches too.
 */
export function discardedLeads(state: WorkspaceState, threads: readonly Thread[]): WorkspaceTransition {
  const held = new Set(state.computers.discardedLeads);
  const leads = new Set(threads.flatMap((thread) => mayLeadElsewhere(thread) && !held.has(thread.id) ? [thread.id] : []));
  if (!leads.size) return settled(state);
  const remembered = { ...state, computers: { ...state.computers, discardedLeads: [...state.computers.discardedLeads, ...leads].slice(-MAX_DISCARDED_LEADS) } };
  return { state: remembered, effects: [{ type: "persist-preferences", preferences: viewPreferences(remembered) }] };
}
