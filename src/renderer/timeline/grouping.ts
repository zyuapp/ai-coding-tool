import { senderLabel } from "../../domain/message-origin";
import type { ConversationMessage } from "../../domain/conversation";

type TimelineEntry =
  /** `from` names what a folded message's row says it is: its threads' news, or the thread that sent it. */
  | { kind: "message"; id: string; message: ConversationMessage; from?: string }
  | { kind: "turn"; id: string; steps: ConversationMessage[]; final: ConversationMessage | null; endsAt: number | null; live: boolean };

/** `updates` holds a coordinator's thread updates, and its replies to them, that a newer update has since replaced. */
export type TimelineGroup = TimelineEntry | { kind: "updates"; id: string; entries: TimelineEntry[]; count: number };

/** A step runs until the next one starts; the newest step of a live turn has not ended yet. */
export type TimedStep = { message: ConversationMessage; endsAt: number | null };

export type TurnSegment =
  | { kind: "note"; id: string; message: ConversationMessage }
  | { kind: "tools"; id: string; steps: TimedStep[] };

type TimelineOptions = { running: boolean; tailMessageId?: string; runEndedAt?: number; coordinator?: boolean };

function startOf(group: TimelineEntry) {
  return group.kind === "message" ? group.message.at : (group.steps[0] ?? group.final)?.at ?? null;
}

/** Only a live turn is still running; anything else ends at the newest moment known to have passed. */
function endOf(group: TimelineEntry, next: TimelineEntry | undefined, runEndedAt?: number) {
  if (group.kind !== "turn") return null;
  if (group.final) return group.final.at;
  return (next && startOf(next)) ?? (group.live ? null : runEndedAt ?? group.steps.at(-1)?.at ?? null);
}

/**
 * Assistant text and the tool calls it drives belong to one turn. A turn ending in assistant text is
 * settled; the newest turn of a running task is live and keeps collecting steps. A turn no answer
 * closed ends where the next group opens, or where the run it belonged to stopped.
 */
export function groupTimeline(messages: ConversationMessage[], { running, tailMessageId, runEndedAt, coordinator = false }: TimelineOptions): TimelineGroup[] {
  const groups: (TimelineEntry | ConversationMessage[])[] = [];
  for (const message of messages) {
    if (message.kind === "user" || message.kind === "system" || message.artifact) {
      const from = coordinator ? threadSender(message) : undefined;
      groups.push({ kind: "message", id: message.id, message, ...(from ? { from } : {}) });
      continue;
    }
    const open = groups.at(-1);
    if (Array.isArray(open)) open.push(message);
    else groups.push([message]);
  }
  const liveTurn = running && Array.isArray(groups.at(-1)) ? groups.at(-1) : undefined;
  const timeline: TimelineEntry[] = groups.map((group) => {
    if (!Array.isArray(group)) return group;
    const settled = group !== liveTurn && group.at(-1)!.kind === "assistant";
    return {
      kind: "turn",
      id: group[0]!.id,
      steps: settled ? group.slice(0, -1) : group,
      final: settled ? group.at(-1)! : null,
      endsAt: null,
      live: group === liveTurn,
    } satisfies TimelineEntry;
  });
  /** Text can stream before its first block commits, so the turn it belongs to may not exist yet. */
  if (running && tailMessageId && !messages.some((message) => message.id === tailMessageId) && !liveTurn) {
    timeline.push({ kind: "turn", id: tailMessageId, steps: [], final: null, endsAt: null, live: true });
  }
  return foldUpdates(timeline.map((group, index) => group.kind !== "turn" ? group : { ...group, endsAt: endOf(group, timeline[index + 1], runEndedAt) }));
}

/** A coordinator's threads speak to it often, so their messages fold to one row behind the user's own words and its answers. */
function threadSender(message: ConversationMessage) {
  return message.kind === "user" ? senderLabel(message.origin) : undefined;
}

function isUpdate(entry: TimelineEntry) {
  return entry.kind === "message" && entry.message.kind === "user" && entry.message.origin?.kind === "coordination";
}

/**
 * A coordinator is woken with each batch of its threads' news and answers every one. Of updates
 * with no word from the user between them, only the newest and its answer stay open; the rest fold
 * into one row before it.
 */
function foldUpdates(entries: TimelineEntry[]): TimelineGroup[] {
  if (!entries.some(isUpdate)) return entries;
  const folded: TimelineGroup[] = [];
  let run: TimelineEntry[] = [];
  let cycle: TimelineEntry[] = [];
  let count = 0;
  const flush = () => {
    if (count) folded.push({ kind: "updates", id: `updates-${run[0]!.id}`, entries: run, count });
    folded.push(...cycle);
    run = [];
    cycle = [];
    count = 0;
  };
  for (const entry of entries) {
    if (isUpdate(entry)) {
      if (cycle.length) {
        run.push(...cycle);
        count += 1;
      }
      cycle = [entry];
    } else if (entry.kind === "message" && entry.message.kind === "user") {
      flush();
      folded.push(entry);
    } else if (cycle.length) {
      cycle.push(entry);
    } else {
      folded.push(entry);
    }
  }
  flush();
  return folded;
}

export function timeSteps(steps: ConversationMessage[], turnEndsAt: number | null): TimedStep[] {
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
    for (const id of groupMessageIds(group)) rows.set(id, index);
  });
  return rows;
}

export function groupMessageIds(group: TimelineGroup): string[] {
  if (group.kind === "message") return [group.message.id];
  if (group.kind === "updates") return group.entries.flatMap(groupMessageIds);
  return [...group.steps.map((step) => step.id), ...group.final ? [group.final.id] : []];
}
