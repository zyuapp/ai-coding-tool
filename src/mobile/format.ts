import type { MobileMessage, MobileRunStatus, MobileThreadEntry, MobileThreadSettings } from "../contracts/mobile";
import { effortForModel, modelsFor, type AgentEngine } from "../domain/agent-engine";
import type { ExecutionPolicy } from "../domain/run";
import { toolFamily, type ToolFamily } from "../domain/tool-call";

/**
 * A transcript as a phone reads it. A run of tool calls is one line saying what was used and how
 * often, because the argument that tells two calls apart is not carried this far and a column of
 * fifteen identical rows is worse than a count.
 */
export type TranscriptBlock =
  | { kind: "message"; key: string; message: MobileMessage; answer: boolean }
  | { kind: "tools"; key: string; calls: MobileMessage[]; at: number };

/** `answer` marks the assistant text that closes a turn: the one the clock hangs under. */
export function transcriptBlocks(messages: MobileMessage[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  messages.forEach((message, index) => {
    if (message.kind !== "tool") {
      const next = messages.slice(index + 1).find((later) => later.kind !== "tool");
      const answer = message.kind === "assistant" && next?.kind !== "assistant";
      blocks.push({ kind: "message", key: `${index}-${message.at}`, message, answer });
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

const STATUS_LABELS: Record<Exclude<MobileRunStatus, "idle">, string> = {
  running: "Working",
  stopped: "Stopped",
  "awaiting-approval": "Needs you",
};

/** A row's second line: what the thread is doing and when it last moved. An idle thread only has a when. */
export function threadMeta(entry: Pick<MobileThreadEntry, "status" | "lastActivityAt">, now: number): string {
  const when = relativeTime(entry.lastActivityAt, now);
  return entry.status === "idle" ? when : `${STATUS_LABELS[entry.status]} · ${when}`;
}

/** What a folded group still owes the eye: a thread waiting on the user, else one with news. */
export function groupMark(threads: Pick<MobileThreadEntry, "status" | "unread">[]): "needs-you" | "unread" | null {
  if (threads.some((thread) => thread.status === "awaiting-approval")) return "needs-you";
  if (threads.some((thread) => thread.unread)) return "unread";
  return null;
}

let clockFormatter: Intl.DateTimeFormat | undefined;

export function clockTime(at: number): string {
  return (clockFormatter ??= new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })).format(at);
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

const MODE_LABELS: Record<ExecutionPolicy, string> = {
  autonomous: "Auto",
  bypass: "Bypass",
  "allow-edits": "Edits",
  confirm: "Confirm",
  plan: "Plan",
};

/** A thread's settings as the composer's bottom edge reads them. Effort is null for a model that takes none. */
export function settingsSummary(settings: MobileThreadSettings): { mode: string; model: string; effort: string | null } {
  const spec = modelsFor(settings.engine).find((candidate) => candidate.id === settings.model);
  return {
    mode: MODE_LABELS[settings.policy],
    model: spec?.label ?? settings.model,
    effort:
      spec?.efforts.find((candidate) => candidate.id === effortForModel(settings.model, settings.effort))?.label ?? null,
  };
}
