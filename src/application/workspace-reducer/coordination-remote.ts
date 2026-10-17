/** What a coordinator here hears of the threads it started on paired computers, and how they are let go once it is gone. */
import { now } from "./shared.js";
import type { WorkspaceEffect } from "./types.js";
import { coordinationMembers, coordinationNote, decisionHeadline, decisionNote, remotelyLedThreads, reportHeadline, reportNote, turnNote } from "../coordination.js";
import type { ThreadChange } from "../thread-activity.js";
import { announced, waitingHeadline } from "../notices.js";
import { settledHeadline } from "../run-testimony.js";
import { updateThread } from "../thread-run-state.js";
import { lastWorkingIds, type PairedComputer } from "../computers.js";
import type { WorkspaceState } from "../workspace-state.js";
import { supportsComputerCommand } from "../../contracts/computer-capabilities.js";
import type { AppCommand } from "../../contracts/commands.js";
import { isCoordinator, openDecisions, withCoordinationNote, withRemoteHeard, type CoordinationNote } from "../../domain/coordination.js";
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
      news.state = heard.state;
      news.effects.push(...heard.effects);
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
  const since = heard ?? 0;
  const at = now();
  const notes: CoordinationNote[] = [];
  const effects: WorkspaceEffect[] = [];
  let newest = heard ?? threadCreatedAt(member);
  let { quietStops, stoppedStarts } = state;
  const run = holder.activeRuns[member.id];
  const ran = prior?.activeRuns[member.id];
  if (heard === undefined) notes.push(coordinationNote(member.id, `"${member.title}" started on ${computer.name}.`, at, { quiet: true }));
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
  /** A thread waiting out a session limit carries on by itself, so its turn has not ended. */
  const ended = member.runEndedAt !== undefined && member.runEndedAt > since && !run && !(member.limitPause && resumesOnItsOwn(member.limitPause));
  if (ended) {
    /** So is one a start Stop all caught on its way stopped as it landed. */
    const caught = stoppedStarts.some((start) => start.threadId === member.id);
    if (caught) stoppedStarts = stoppedStarts.filter((start) => start.threadId !== member.id);
    const stopped = ran !== undefined && quietStops.includes(ran.runId);
    if (stopped) quietStops = quietStops.filter((runId) => runId !== ran.runId);
    const quiet = stopped || caught;
    const ending = lastRunOutcome(member);
    const status = quiet || ending === "stopped" ? "cancelled" : ending === "failed" ? "failed" : "succeeded";
    notes.push(turnNote(member, status, at, { quiet }));
    /**
     * Said as a run here would say it: a failure in the words that computer left on the thread, and a
     * finish only for a run someone started, so one this computer never saw go speaks only if it failed.
     */
    const surfacing = status === "failed" ? "failed" : status === "succeeded" && ran && ran.origin !== "automation" ? "attended" : null;
    const failure = member.messages.at(-1);
    const headline = settledHeadline(surfacing, failure?.kind === "system" && failure.tone === "error" ? failure.text : undefined);
    if (headline) effects.push(...announced(state, member, headline, surfacing === "failed" ? "failed" : "finished"));
    newest = Math.max(newest, member.runEndedAt!);
  }
  /** Waiting on the user is said as it starts, as it is of a thread here. */
  if (run?.origin === "composer" && computer.status === "connected") {
    const approval = run.status === "awaiting-approval" ? holder.approvals[run.runId] : undefined;
    if (approval && (ran?.runId !== run.runId || ran.status !== "awaiting-approval")) effects.push(...announced(state, member, waitingHeadline(approval), "waiting"));
    const question = run.questions?.[0];
    if (question && !(ran?.runId === run.runId && ran.questions?.length)) effects.push(...announced(state, member, waitingHeadline(question), "waiting"));
  }
  const stops = quietStops === state.quietStops && stoppedStarts === state.stoppedStarts ? state : { ...state, quietStops, stoppedStarts };
  if (!notes.length && newest === heard) return { state: stops, effects };
  const led = new Set(coordinationMembers(state, lead.id).flatMap(({ thread, computer: there }) => there ? [thread.id] : []));
  const told = notes.reduce(withCoordinationNote, withRemoteHeard(lead, member.id, newest, led));
  return { state: updateThread(stops, lead.id, () => told), effects };
}

/**
 * Each thread on a paired computer still working under a thread here that is no longer a live
 * coordinator, or under one cleared from the archive here, is let go there, as this computer's own
 * threads stand on their own once their coordinator goes. It is read off what each computer says it
 * holds, so one that was away, or whose state comes in only after its line is back, is told once it
 * says so, and what could not be carried is tried again the next time its threads move.
 */
export function released(previous: WorkspaceState, state: WorkspaceState, threads: readonly ThreadChange[]): WorkspaceEffect[] {
  const ended = threads.some(({ before, after }) => isCoordinator(before) && !isCoordinator(after));
  if (!ended && previous.computers.paired === state.computers.paired) return [];
  const before = new Map(previous.computers.paired.map((computer) => [computer.id, computer]));
  const effects: WorkspaceEffect[] = [];
  for (const computer of state.computers.paired) {
    if (computer.status !== "connected" || !computer.state) continue;
    const was = before.get(computer.id);
    if (!ended && was?.status === "connected" && was.state?.threads === computer.state.threads) continue;
    const inputs = remotelyLedThreads(computer.state.threads).flatMap((thread): AppCommand[] => {
      const leadId = thread.remoteLead!.threadId;
      const lead = state.threads.find((item) => item.id === leadId);
      const gone = lead ? !isCoordinator(lead) : state.computers.discardedLeads.includes(leadId);
      return gone ? [{ type: "task.set-coordinator", taskId: thread.id, coordinatorId: null }] : [];
    }).filter((command) => supportsComputerCommand(computer.capabilities, command));
    if (inputs.length) effects.push({ type: "computer.forward", id: computer.id, inputs, silent: true });
  }
  return effects;
}

