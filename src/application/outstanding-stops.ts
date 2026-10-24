/**
 * What a Stop all still answers for after it is pressed: the runs it cancelled here, the session work
 * it stopped and the agent's answer to that, what it stopped on paired computers, and each start it
 * caught on its way to one. Each is kept until it is spent, and asked only whether a run, a turn or a
 * start is the stop's. What it stopped here is session-only; what it stopped or caught elsewhere the
 * coordinator keeps, so it is heard quietly after a restart here too.
 */
import type { WorkspaceEffect } from "./workspace-reducer/types.js";
import { remotelyLedThreads, type RemoteWork } from "./coordination.js";
import type { StopIntent } from "./run-settlement.js";
import { updateThread, type ActiveRun } from "./thread-run-state.js";
import type { ThreadChange } from "./thread-activity.js";
import type { PairedComputer } from "./computers.js";
import type { WorkspaceState } from "./workspace-state.js";
import { supportsComputerCommand } from "../contracts/computer-capabilities.js";
import type { AppCommand } from "../contracts/commands.js";
import { isCoordinator } from "../domain/coordination.js";
import type { CaughtStart, RemoteStop, Thread } from "../domain/thread.js";
import { resumesOnItsOwn } from "../domain/usage-limit.js";

/** A thread whose session work Stop all stopped, and when, so only the agent's answer to that stop ends quietly. */
export type QuietSession = { taskId: string; at: number };

/** How long after Stop all stopped a thread's session work the agent's own turn is still its answer to that stop. */
const STOP_ANSWER_MS = 2 * 60_000;

/** Whether a turn the agent opens at `at` could still be its answer to the stop that hushed its session. */
function answersInTime(session: Pick<QuietSession, "at">, at: number): boolean {
  return at - session.at <= STOP_ANSWER_MS;
}

/** What one Stop all covers under a coordinator. */
export type StopAllCover = {
  /** The runs here it cancels. */
  cancelled: readonly Pick<ActiveRun, "runId">[];
  /** The threads here whose session work it stops. */
  hushed: readonly string[];
  /** Each thread under it on a paired computer with work going there. */
  elsewhere: readonly RemoteWork[];
  /** Each start on its way to a paired computer it catches. */
  landing: readonly { id: string; computer: string }[];
};

/**
 * A coordinator's Stop all made outstanding, with what stops its threads' work on paired computers.
 * A run that never said it ended leaves its id behind, so only runs still going are kept, and a
 * stop of a thread's session work the agent never answered in time is let go of.
 */
export function withStopAll(state: WorkspaceState, leadId: string, cover: StopAllCover, at: number): { state: WorkspaceState; effects: WorkspaceEffect[] } {
  const remote = remoteStops(cover.elsewhere, at);
  const going = new Set(Object.values(state.activeRuns).map((run) => run.runId));
  const quietStops = [...state.quietStops.filter((runId) => going.has(runId)), ...cover.cancelled.map((run) => run.runId)];
  const caught = Object.fromEntries(cover.landing.map((start): [string, CaughtStart] => [start.id, { computer: start.computer }]));
  const stopping = Object.keys(remote.stops).length || cover.landing.length ? updateThread(state, leadId, (item) => ({
    ...item,
    ...Object.keys(remote.stops).length ? { remoteStops: { ...item.remoteStops, ...remote.stops } } : {},
    ...cover.landing.length ? { caughtStarts: { ...item.caughtStarts, ...caught } } : {},
  })) : state;
  const hushed = new Set(cover.hushed);
  const quietSessions = [
    ...state.quietSessions.filter((session) => !hushed.has(session.taskId) && answersInTime(session, at) && state.threads.some((thread) => thread.id === session.taskId)),
    ...[...hushed].map((taskId) => ({ taskId, at })),
  ];
  return { state: { ...stopping, quietStops, quietSessions }, effects: remote.effects };
}

/**
 * What stops the work of a coordinator's threads on paired computers: one batch for each computer,
 * with only what its build takes, and the runs and the waits to carry on after a session limit it
 * ends, so their ends are heard quietly here.
 */
function remoteStops(work: readonly RemoteWork[], at: number): { effects: WorkspaceEffect[]; stops: Record<string, RemoteStop> } {
  const batches = new Map<string, { computer: PairedComputer; inputs: AppCommand[] }>();
  const stops: Record<string, RemoteStop> = {};
  for (const { thread, computer, runId, processIds } of work) {
    const batch = batches.get(computer.id) ?? { computer, inputs: [] };
    const cancel: AppCommand = { type: "run.cancel", taskId: thread.id };
    if (runId && supportsComputerCommand(computer.capabilities, cancel)) {
      batch.inputs.push(cancel);
      stops[thread.id] = { computer: computer.id, runId };
    }
    const lifted: AppCommand = { type: "limit.cancel", taskId: thread.id };
    if (thread.limitPause && supportsComputerCommand(computer.capabilities, lifted)) {
      batch.inputs.push(lifted);
      if (resumesOnItsOwn(thread.limitPause)) stops[thread.id] ??= { computer: computer.id };
    }
    /** Only what that computer's build can stop is counted as its work, so each goes, and the agent's answer to it there ends quietly, as one here does. */
    batch.inputs.push(...processIds.map((processId): AppCommand => ({ type: "run.stop-process", taskId: thread.id, processId })));
    if (processIds.length) stops[thread.id] = { ...stops[thread.id] ?? { computer: computer.id }, answer: { at } };
    batches.set(computer.id, batch);
  }
  const effects = [...batches.values()].flatMap(({ computer, inputs }): WorkspaceEffect[] => inputs.length ? [{ type: "computer.forward", id: computer.id, inputs }] : []);
  return { effects, stops };
}

/**
 * Who asked this run to end before it ended by itself: Stop all, whose stop it is heard as, or the
 * user.
 */
export function stopIntentOf(state: Pick<WorkspaceState, "quietStops">, run: Pick<ActiveRun, "runId" | "cancelling">): StopIntent | undefined {
  return state.quietStops.includes(run.runId) ? "stop-all" : run.cancelling ? "user" : undefined;
}

/** The Stop all that cancelled this run answered by its end. */
export function withRunAnswered(state: WorkspaceState, runId: string): WorkspaceState {
  return { ...state, quietStops: state.quietStops.filter((id) => id !== runId) };
}

/**
 * A thread's turn beginning. The turn the agent opens itself on hearing that what Stop all stopped
 * has stopped is its answer to that stop; any other run is the thread picked back up, and so is a
 * turn of its own long after the stop, so either spends it.
 */
export function withTurnBegun(state: WorkspaceState, taskId: string, agentsOwn: boolean, at: number): { state: WorkspaceState; answersStop: boolean } {
  const hushed = state.quietSessions.find((session) => session.taskId === taskId);
  if (!hushed) return { state, answersStop: false };
  return { state: { ...state, quietSessions: state.quietSessions.filter((session) => session !== hushed) }, answersStop: agentsOwn && answersInTime(hushed, at) };
}

/** What Stop all makes of a turn of a coordinator's thread on a paired computer, as that computer last said it stands. */
export type RemoteTurnStop = {
  /** The turn that ended is Stop all's: one it stopped there, or a start it caught on its way. */
  stopAll: boolean;
  /** The turn that ended is the agent's answer to the session work the stop stopped. */
  answered: boolean;
  /** What the coordinator holds of the stop moved on, so it is written even with nothing else to hear. */
  spent: boolean;
  /** The coordinator with what is left of the stop. */
  held: (lead: Thread) => Thread;
};

/**
 * What Stop all stopped there ends quietly once it is heard to, whenever that is, and so does the
 * agent's answer to the session work it stopped. A thread that carried on before the stop landed,
 * from its wait or into a run of its own, is no longer the stop's. A stop is only heard of from the
 * computer it was sent to. The start Stop all caught on its way that this thread is, heard ending,
 * is settled, even when its end is the first heard of it.
 */
export function remoteTurnStop(lead: Thread, member: Thread, computer: string, run: ActiveRun | undefined, ended: boolean, at: number): RemoteTurnStop {
  const sent = lead.remoteStops?.[member.id];
  const stop = sent?.computer === computer ? sent : undefined;
  const answered = ended && stop?.answer?.runId !== undefined;
  const kept = stop && keptStop(stop, run, ended, answered, at);
  const spent = kept !== stop;
  const landed = ended ? caughtStartOf(lead, member, computer) : undefined;
  return {
    stopAll: landed !== undefined || stop !== undefined,
    answered,
    spent,
    held: (item) => {
      const settled = landed === undefined ? item : withoutCaughtStart(item, landed);
      return spent ? withRemoteStop(settled, member.id, kept) : settled;
    },
  };
}

/**
 * What is left of what Stop all stopped of a thread elsewhere, as that thread stands now. The first
 * turn the agent opens there itself after the stop stopped the thread's session work, soon enough,
 * is its answer to it; any other run, as one someone sent it or one a build too old to say whose it
 * is, is the thread carrying on. Once the run the stop cancelled has ended, its answer may still
 * come; any other turn seen to end, or never seen at all, spends the stop.
 */
function keptStop(stop: RemoteStop, run: ActiveRun | undefined, ended: boolean, answered: boolean, at: number): RemoteStop | undefined {
  const { answer } = stop;
  if (run) {
    if (run.runId === stop.runId || run.runId === answer?.runId) return stop;
    return answer && answer.runId === undefined && run.agentInitiated && answersInTime(answer, at) ? { computer: stop.computer, answer: { ...answer, runId: run.runId } } : undefined;
  }
  if (!ended) return stop;
  return answer && !answered && answer.runId === undefined && stop.runId !== undefined ? { computer: stop.computer, answer } : undefined;
}

/** A coordinator with what Stop all stopped of a thread elsewhere moved on, or done with. */
function withRemoteStop(lead: Thread, threadId: string, stop: RemoteStop | undefined): Thread {
  const { [threadId]: _spent, ...rest } = lead.remoteStops ?? {};
  const kept = stop ? { ...rest, [threadId]: stop } : rest;
  const { remoteStops: _held, ...thread } = lead;
  return Object.keys(kept).length ? { ...thread, remoteStops: kept } : thread;
}

/**
 * The start Stop all caught on its way to `computer` that this thread is, by its suggestion: one heard
 * landing as it, or one not yet heard landing that it names, as a thread first seen there does.
 */
function caughtStartOf(lead: Thread, member: Thread, computer: string): string | undefined {
  const proposalId = member.remoteLead?.proposalId;
  return Object.entries(lead.caughtStarts ?? {}).find(([id, start]) => start.computer === computer && (start.threadId === undefined ? id === proposalId : start.threadId === member.id))?.[0];
}

/**
 * What Stop all stopped on paired computers is kept only for a thread that computer still holds under
 * the coordinator, as far as it has said since this app started: one moved out or filed away there,
 * or on a computer no longer paired, is let go, so a stop that never got there cannot quiet a later
 * turn. A start it caught on its way is kept until that computer shows the thread it became somewhere
 * other than under the coordinator, since it may land, or show up, after its answer.
 */
export function withStopsKept(state: WorkspaceState): WorkspaceState {
  let next = state;
  const holderOf = (id: string) => state.computers.paired.find((computer) => computer.id === id);
  for (const lead of state.threads) {
    const { remoteStops: stops, caughtStarts: starts } = lead;
    if (!stops && !starts) continue;
    const under = (holder: WorkspaceState, threadId: string) => remotelyLedThreads(holder.threads).some((thread) => thread.id === threadId && thread.remoteLead!.threadId === lead.id);
    const stopsKept = Object.entries(stops ?? {}).filter(([threadId, stop]) => {
      const holder = holderOf(stop.computer);
      return holder && (!holder.state || under(holder.state, threadId));
    });
    const startsKept = Object.entries(starts ?? {}).filter(([, start]) => {
      const holder = holderOf(start.computer);
      return holder && (!holder.state || start.threadId === undefined || !holder.state.threads.some((thread) => thread.id === start.threadId) || under(holder.state, start.threadId));
    });
    if (stopsKept.length === Object.keys(stops ?? {}).length && startsKept.length === Object.keys(starts ?? {}).length) continue;
    next = updateThread(next, lead.id, ({ remoteStops: _stops, caughtStarts: _starts, ...thread }) => ({
      ...thread,
      ...stopsKept.length ? { remoteStops: Object.fromEntries(stopsKept) } : {},
      ...startsKept.length ? { caughtStarts: Object.fromEntries(startsKept) } : {},
    }));
  }
  return next;
}

/**
 * A coordinator that is no longer one, filed away or with its role taken off, lets go of what Stop all
 * stopped under it. What it caught on its way is still stopped as it lands, so that is kept.
 */
export function withoutLapsedStops(state: WorkspaceState, threads: readonly ThreadChange[]): WorkspaceState {
  let next = state;
  for (const { after } of threads) {
    if (after?.remoteStops && !isCoordinator(after)) next = updateThread(next, after.id, ({ remoteStops: _stops, ...thread }) => thread);
  }
  return next;
}

/** The paired computer a coordinator's start went to, when Stop all caught it on its way there, landed or not. */
export function caughtStartComputer(lead: Thread | undefined, proposalId: string): string | undefined {
  return lead?.caughtStarts?.[proposalId]?.computer;
}

/** Whether Stop all caught a coordinator's start elsewhere on its way, and it has yet to be heard landing. */
export function catchesStart(lead: Thread | undefined, proposalId: string): boolean {
  const caught = lead?.caughtStarts?.[proposalId];
  return caught !== undefined && caught.threadId === undefined;
}

/**
 * A caught start heard landing as `threadId`, whose end is news only to a coordinator here to hear
 * it; one away since hears nothing of what its thread did meanwhile.
 */
export function withStartLanded(lead: Thread, proposalId: string, threadId: string): Thread {
  return isCoordinator(lead) ? { ...lead, caughtStarts: { ...lead.caughtStarts, [proposalId]: { ...lead.caughtStarts![proposalId]!, threadId } } } : withoutCaughtStart(lead, proposalId);
}

/** A coordinator done with a start elsewhere Stop all caught on its way. */
export function withoutCaughtStart(lead: Thread, proposalId: string): Thread {
  if (!lead.caughtStarts?.[proposalId]) return lead;
  const { [proposalId]: _settled, ...rest } = lead.caughtStarts;
  const { caughtStarts: _held, ...thread } = lead;
  return Object.keys(rest).length ? { ...thread, caughtStarts: rest } : thread;
}
