import type { TaskMessage } from "../../domain/task";

export type TimelineGroup =
  | { kind: "message"; id: string; message: TaskMessage }
  | { kind: "turn"; id: string; steps: TaskMessage[]; final: TaskMessage | null; endsAt: number | null; live: boolean };

/** A step runs until the next one starts; the newest step of a live turn has not ended yet. */
export type TimedStep = { message: TaskMessage; endsAt: number | null };

export type TurnSegment =
  | { kind: "note"; id: string; message: TaskMessage }
  | { kind: "tools"; id: string; steps: TimedStep[] };

type TimelineOptions = { running: boolean; tailMessageId?: string; runEndedAt?: number };

function startOf(group: TimelineGroup) {
  return group.kind === "message" ? group.message.at : (group.steps[0] ?? group.final)?.at ?? null;
}

/** Only a live turn is still running; anything else ends at the newest moment known to have passed. */
function endOf(group: TimelineGroup, next: TimelineGroup | undefined, runEndedAt?: number) {
  if (group.kind !== "turn") return null;
  if (group.final) return group.final.at;
  return (next && startOf(next)) ?? (group.live ? null : runEndedAt ?? group.steps.at(-1)?.at ?? null);
}

/**
 * Assistant text and the tool calls it drives belong to one turn. A turn ending in assistant text is
 * settled; the newest turn of a running task is live and keeps collecting steps. A turn no answer
 * closed ends where the next group opens, or where the run it belonged to stopped.
 */
export function groupTimeline(messages: TaskMessage[], { running, tailMessageId, runEndedAt }: TimelineOptions): TimelineGroup[] {
  const groups: (TimelineGroup | TaskMessage[])[] = [];
  for (const message of messages) {
    if (message.kind === "user" || message.kind === "system") {
      groups.push({ kind: "message", id: message.id, message });
      continue;
    }
    const open = groups.at(-1);
    if (Array.isArray(open)) open.push(message);
    else groups.push([message]);
  }
  const liveTurn = running && Array.isArray(groups.at(-1)) ? groups.at(-1) : undefined;
  const timeline: TimelineGroup[] = groups.map((group) => {
    if (!Array.isArray(group)) return group;
    const settled = group !== liveTurn && group.at(-1)!.kind === "assistant";
    return {
      kind: "turn",
      id: group[0]!.id,
      steps: settled ? group.slice(0, -1) : group,
      final: settled ? group.at(-1)! : null,
      endsAt: null,
      live: group === liveTurn,
    } satisfies TimelineGroup;
  });
  /** Text can stream before its first block commits, so the turn it belongs to may not exist yet. */
  if (running && tailMessageId && !messages.some((message) => message.id === tailMessageId) && !liveTurn) {
    timeline.push({ kind: "turn", id: tailMessageId, steps: [], final: null, endsAt: null, live: true });
  }
  return timeline.map((group, index) => group.kind !== "turn" ? group : { ...group, endsAt: endOf(group, timeline[index + 1], runEndedAt) });
}

export function timeSteps(steps: TaskMessage[], turnEndsAt: number | null): TimedStep[] {
  return steps.map((message, index) => ({ message, endsAt: steps[index + 1]?.at ?? turnEndsAt }));
}

export function toSegments(steps: TimedStep[]): TurnSegment[] {
  const segments: TurnSegment[] = [];
  for (const step of steps) {
    if (step.message.kind !== "tool") {
      segments.push({ kind: "note", id: step.message.id, message: step.message });
      continue;
    }
    const open = segments.at(-1);
    if (open?.kind === "tools") open.steps.push(step);
    else segments.push({ kind: "tools", id: step.message.id, steps: [step] });
  }
  return segments;
}

/** Which row a message is in, so a match can be scrolled to whether or not its row is drawn. */
export function messageRows(groups: TimelineGroup[]) {
  const rows = new Map<string, number>();
  groups.forEach((group, index) => {
    rows.set(group.id, index);
    if (group.kind === "message") rows.set(group.message.id, index);
    else {
      for (const step of group.steps) rows.set(step.id, index);
      if (group.final) rows.set(group.final.id, index);
    }
  });
  return rows;
}
