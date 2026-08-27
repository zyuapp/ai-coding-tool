import type { MobileMessage, MobileRunStatus } from "../contracts/mobile";
import type { AgentEngine } from "../domain/agent-engine";
import { toolFamily, type ToolFamily } from "../domain/tool-call";

/**
 * A transcript as a phone reads it. A run of tool calls is one line saying what was used and how
 * often, because the argument that tells two calls apart is not carried this far and a column of
 * fifteen identical rows is worse than a count.
 */
export type TranscriptBlock =
  | { kind: "message"; key: string; message: MobileMessage }
  | { kind: "tools"; key: string; calls: MobileMessage[]; at: number };

export function transcriptBlocks(messages: MobileMessage[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  messages.forEach((message, index) => {
    if (message.kind !== "tool") {
      blocks.push({ kind: "message", key: `${index}-${message.at}`, message });
      return;
    }
    const open = blocks.at(-1);
    if (open?.kind === "tools") open.calls.push(message);
    else blocks.push({ kind: "tools", key: `${index}-${message.at}`, calls: [message], at: message.at });
  });
  return blocks;
}

/** The tools a run used, commonest first, counted where a tool was used more than once. */
export function summariseTools(calls: MobileMessage[]): string {
  const counts = new Map<string, number>();
  for (const call of calls) counts.set(call.text, (counts.get(call.text) ?? 0) + 1);
  return [...counts]
    .sort((left, right) => right[1] - left[1])
    .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
    .join(", ");
}

/** The family of the run's first call, which is what the row draws a glyph for. */
export function runFamily(engine: AgentEngine, calls: MobileMessage[]): ToolFamily {
  return toolFamily(engine, calls[0]?.text ?? "");
}

const STATUS_LABELS: Record<MobileRunStatus, string> = {
  idle: "Idle",
  running: "Working",
  stopped: "Stopped",
  "awaiting-approval": "Needs you",
};

export function statusLabel(status: MobileRunStatus): string {
  return STATUS_LABELS[status];
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long ago, in as few characters as a row can spare. */
export function relativeTime(at: number, now: number): string {
  const gap = Math.max(0, now - at);
  if (gap < MINUTE) return "now";
  if (gap < HOUR) return `${Math.floor(gap / MINUTE)}m`;
  if (gap < DAY) return `${Math.floor(gap / HOUR)}h`;
  if (gap < 7 * DAY) return `${Math.floor(gap / DAY)}d`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
