import type { RunEvent, StartRunCommand } from "../contracts/ipc.js";
import type { ExecutionPolicy } from "../domain/run.js";

export type RunEventGateState = {
  lastSequence: number;
  terminal: boolean;
};

export type CorrelatedRunState = RunEventGateState & {
  taskId: string;
  runId: string;
};

/** Provider sessions can begin follow-up turns, but cannot choose a new permission ceiling. */
export type RunSession = {
  runId: string;
  policy: ExecutionPolicy;
};

/** The statuses that close a run's books; every other one leaves it open. */
export function isTerminalStatus(status: string | undefined): status is "succeeded" | "failed" | "cancelled" {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

export function acceptRunEvent(state: RunEventGateState, event: { sequence: number; type: string; status?: string }) {
  if (state.terminal || event.sequence <= state.lastSequence) return false;
  state.lastSequence = event.sequence;
  if (event.type === "run.status" && isTerminalStatus(event.status)) state.terminal = true;
  return true;
}

export function supersedePendingStarts<T>(pending: Map<string, T>, keepKey: string, matches: (value: T) => boolean = () => true) {
  const superseded: Array<[string, T]> = [];
  for (const [key, value] of pending) {
    if (key === keepKey || !matches(value)) continue;
    pending.delete(key);
    superseded.push([key, value]);
  }
  return superseded;
}

export function failedEventsForTransportLoss(states: Iterable<CorrelatedRunState>, message: string): RunEvent[] {
  return [...states]
    .filter((state) => !state.terminal)
    .map((state) => ({
      type: "run.status" as const,
      taskId: state.taskId,
      runId: state.runId,
      sequence: state.lastSequence + 1,
      status: "failed" as const,
      message,
    }));
}

function runKey(taskId: string, runId: string) {
  return `${taskId}\u0000${runId}`;
}

/**
 * What main knows about the runs it has asked for: the sequence and terminal state of each one, the
 * permission ceiling of each thread, and the starts still being resolved against their workspace.
 */
export class RunLedger {
  private readonly states = new Map<string, CorrelatedRunState>();
  private readonly sessions = new Map<string, RunSession>();
  private readonly starts = new Map<string, StartRunCommand>();

  /** A start is on the books from the moment it is asked for, and stays pending until it is sent or dropped. */
  beginStart(command: StartRunCommand) {
    this.states.set(runKey(command.taskId, command.runId), { taskId: command.taskId, runId: command.runId, lastSequence: 0, terminal: false });
    this.sessions.set(command.taskId, { runId: command.runId, policy: command.policy });
    this.starts.set(runKey(command.taskId, command.runId), command);
  }

  knows(taskId: string, runId: string) {
    return this.states.has(runKey(taskId, runId));
  }

  state(taskId: string, runId: string) {
    return this.states.get(runKey(taskId, runId));
  }

  session(taskId: string) {
    return this.sessions.get(taskId);
  }

  /** Gives a run books to write into, whether or not the agent process ever saw it. */
  reopen(taskId: string, runId: string) {
    const state = this.states.get(runKey(taskId, runId)) ?? { taskId, runId, lastSequence: 0, terminal: false };
    this.states.set(runKey(taskId, runId), state);
    return state;
  }

  /**
   * Whether the event is the next word of a run main is following. A turn the agent began itself
   * opens its own books here, and takes the thread's ceiling with it; a terminal event closes them.
   */
  accept(event: RunEvent) {
    const key = runKey(event.taskId, event.runId);
    let state = this.states.get(key);
    if (!state && event.type === "run.started") {
      state = { taskId: event.taskId, runId: event.runId, lastSequence: 0, terminal: false };
      this.states.set(key, state);
      const session = this.sessions.get(event.taskId);
      if (session && event.agentInitiated && !this.states.has(runKey(event.taskId, session.runId))) this.sessions.set(event.taskId, { ...session, runId: event.runId });
    }
    if (!state || !acceptRunEvent(state, event)) return false;
    if (state.terminal) this.states.delete(key);
    return true;
  }

  pendingStart(taskId: string, runId: string) {
    return this.starts.get(runKey(taskId, runId));
  }

  /** Takes a start off the pending list, so whoever takes it is the only one who acts on it. */
  takeStart(taskId: string, runId: string) {
    const key = runKey(taskId, runId);
    const command = this.starts.get(key);
    this.starts.delete(key);
    return command;
  }

  /** The thread's older pending starts, dropped in favour of this one, minus any run already settled. */
  supersedeStarts(taskId: string, runId: string) {
    return supersedePendingStarts(this.starts, runKey(taskId, runId), (command) => command.taskId === taskId)
      .filter(([key]) => !this.states.get(key)?.terminal)
      .map(([, command]) => command);
  }

  /** A thread renamed while its start is still being resolved carries the new title into the run. */
  retitleStarts(taskId: string, title: string) {
    for (const command of this.starts.values()) {
      if (command.taskId === taskId) command.title = title;
    }
  }

  clearStarts() {
    this.starts.clear();
  }

  /** The agent process held every session, so its death leaves no thread with a ceiling to keep. */
  forgetSessions() {
    this.sessions.clear();
  }

  failuresFor(message: string) {
    return failedEventsForTransportLoss(this.states.values(), message);
  }
}
