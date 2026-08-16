import type { RunEvent } from "../contracts/ipc.js";

export type RunEventGateState = {
  lastSequence: number;
  terminal: boolean;
};

export type CorrelatedRunState = RunEventGateState & {
  taskId: string;
  runId: string;
};

export function acceptRunEvent(state: RunEventGateState, event: { sequence: number; type: string; status?: string }) {
  if (state.terminal || event.sequence <= state.lastSequence) return false;
  state.lastSequence = event.sequence;
  if (event.type === "run.status" && (event.status === "succeeded" || event.status === "failed" || event.status === "cancelled")) state.terminal = true;
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
