import type { IconType } from "react-icons";
import { LuBot as Bot, LuFileText as FileText, LuGlobe as Globe, LuPenLine as PenLine, LuSearch as Search, LuTerminal as Terminal, LuWrench as Wrench } from "react-icons/lu";
import { createContext, memo, useContext, useEffect, useState, type ReactNode } from "react";
import type { StreamingTail } from "../../application/thread-run-state";
import type { AgentEngine } from "../../domain/agent-engine";
import type { ConversationMessage } from "../../domain/conversation";
import { describeToolCall, type ToolCall, type ToolFamily } from "../../domain/tool-call";
import { timeSteps, toSegments, type TimedStep, type TurnSegment } from "../timeline/grouping";
import { Copyable } from "./CopyButton";
import { MarkdownMessage } from "./MarkdownMessage";
import { StreamingText } from "./StreamingText";

/** The message a match is in. Whatever holds it opens, however deep the fold it was written into. */
export const RevealedMessage = createContext<string | null>(null);

export function formatElapsed(ms: number) {
  const seconds = Math.round(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Work still in flight has no end yet, so it counts up from its start once a second. */
export function Elapsed({ startedAt, endsAt }: { startedAt: number; endsAt: number | null }) {
  const [end, setEnd] = useState(() => endsAt ?? Date.now());
  useEffect(() => {
    if (endsAt !== null) {
      setEnd(endsAt);
      return;
    }
    setEnd(Date.now());
    const timer = setInterval(() => setEnd(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [endsAt]);
  return <span className="work-time">{formatElapsed(end - startedAt)}</span>;
}

/**
 * Folded work stays out of the DOM until opened, so a long turn costs one row until it is read. A
 * fold holding the match being read opens itself, because a match nobody can see is no match at all.
 * Closing it by hand keeps it closed until the match moves on.
 */
export function Fold({ className, summary, tip, holds, messageId, children }: { className: string; summary: ReactNode; tip?: string; holds: string[]; messageId?: string; children: () => ReactNode }) {
  const revealed = useContext(RevealedMessage);
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (dismissed !== null && dismissed !== revealed) setDismissed(null);
  const forced = revealed !== null && revealed !== dismissed && holds.includes(revealed);
  const shown = open || forced;
  return (
    <details className={className} open={shown} data-message-id={messageId} onToggle={(event) => {
      const next = event.currentTarget.open;
      if (next === shown) return;
      if (forced && !next) setDismissed(revealed);
      setOpen(next);
    }}>
      <summary data-tip={tip}>{summary}</summary>
      {shown && children()}
    </details>
  );
}

const FAMILY_ICONS: Record<ToolFamily, IconType> = {
  shell: Terminal,
  read: FileText,
  write: PenLine,
  search: Search,
  web: Globe,
  agent: Bot,
  other: Wrench,
};

function ToolGlyph({ family }: { family: ToolFamily }) {
  const Icon = FAMILY_ICONS[family];
  return <span className="work-glyph" aria-hidden="true"><Icon size={12} strokeWidth={1.75} /></span>;
}

/** Messages never change once written, so a call is read from its input once per engine. */
const calls = new Map<AgentEngine, WeakMap<ConversationMessage, ToolCall>>();

function toolCallOf(engine: AgentEngine, message: ConversationMessage): ToolCall {
  let known = calls.get(engine);
  if (!known) calls.set(engine, known = new WeakMap());
  let call = known.get(message);
  if (!call) known.set(message, call = describeToolCall(engine, message.text, message.detail));
  return call;
}

/**
 * One call. `named` draws the tool it was, which only a run of mixed tools needs: a run of one tool
 * says so once in its own summary, and repeating it there is what buried the argument to begin with.
 */
const ToolStep = memo(function ToolStep({ engine, step, named = true }: { engine: AgentEngine; step: TimedStep; named?: boolean }) {
  const call = toolCallOf(engine, step.message);
  const label = call.argument || step.message.text;
  const summary = (
    <>
      {named && <><ToolGlyph family={call.family} /><span className="work-tool">{step.message.text}</span></>}
      <span className="work-arg">{call.sigil && <span className="work-sigil">{call.sigil}</span>}{label}</span>
      <span className="work-meta"><Elapsed startedAt={step.message.at} endsAt={step.endsAt} /></span>
    </>
  );
  return (
    <Fold className="work-row" tip={`${step.message.text} · ${label}`} holds={[step.message.id]} messageId={step.message.id} summary={summary}>
      {() => step.message.detail
        ? <Copyable text={step.message.detail} label="Copy the output"><pre>{step.message.detail}</pre></Copyable>
        : <p className="work-empty">No output</p>}
    </Fold>
  );
});

/** Run of tool calls: the newest one stays visible, the rest hide behind a +N counter. */
const ToolRun = memo(function ToolRun({ engine, steps }: { engine: AgentEngine; steps: TimedStep[] }) {
  if (steps.length === 1) return <ToolStep engine={engine} step={steps[0]!} />;
  const hidden = steps.length - 1;
  const newest = steps.at(-1)!;
  const call = toolCallOf(engine, newest.message);
  const uniform = steps.every((step) => step.message.text === steps[0]!.message.text);
  const label = call.argument || newest.message.text;
  const summary = (
    <>
      <ToolGlyph family={call.family} />
      <span className="work-arg">{call.sigil && <span className="work-sigil">{call.sigil}</span>}{label}</span>
      <span className="work-meta">
        <span className="work-count" role="img" aria-label={`${hidden} earlier tool ${hidden === 1 ? "call" : "calls"}`}>+{hidden}</span>
        <Elapsed startedAt={steps[0]!.message.at} endsAt={newest.endsAt} />
      </span>
    </>
  );
  return (
    <Fold className="work-run" tip={`${newest.message.text} · ${label}`} holds={steps.map((step) => step.message.id)} summary={summary}>
      {() => (
        <div className="work-steps">
          {steps.map((step) => <ToolStep key={step.message.id} engine={engine} step={step} named={!uniform} />)}
        </div>
      )}
    </Fold>
  );
});

/**
 * A live turn streams its newest text. The tail can arrive before its first block commits, so it
 * renders under the message id it will belong to and keeps that node once the block lands.
 */
export function TurnSegments({ engine, segments, tail, live = false }: { engine: AgentEngine; segments: TurnSegment[]; tail?: StreamingTail | null; live?: boolean }) {
  const newest = segments.at(-1);
  const streamingId = live ? tail?.messageId ?? (newest?.kind === "note" ? newest.message.id : undefined) : undefined;
  const nodes = segments.map((segment) => segment.kind === "tools"
    ? <ToolRun key={segment.id} engine={engine} steps={segment.steps} />
    : (
      <div key={segment.id} data-message-id={segment.message.id} className="message-text markdown-body work-note">
        {segment.message.id === streamingId
          ? <StreamingText messageId={segment.message.id} committed={segment.message.text} tail={tail?.messageId === segment.message.id ? tail.text : ""} streaming />
          : <MarkdownMessage messageId={segment.message.id} cache>{segment.message.text}</MarkdownMessage>}
      </div>
    ));
  if (streamingId && !segments.some((segment) => segment.kind === "note" && segment.message.id === streamingId)) {
    nodes.push(
      <div key={streamingId} data-message-id={streamingId} className="message-text markdown-body work-note">
        <StreamingText messageId={streamingId} committed="" tail={tail?.text ?? ""} streaming />
      </div>,
    );
  }
  return nodes;
}

const counted = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** What a settled turn changed and ran, so its folded row says whether it is worth opening. */
export function workDigest(engine: AgentEngine, steps: ConversationMessage[]): string {
  let edits = 0;
  let commands = 0;
  for (const step of steps) {
    if (step.kind !== "tool") continue;
    const { family } = toolCallOf(engine, step);
    if (family === "write") edits += 1;
    else if (family === "shell") commands += 1;
  }
  return [edits && counted(edits, "edit", "edits"), commands && counted(commands, "command", "commands")].filter(Boolean).join(" · ");
}

/** Settled turn: every step, tool calls and interim text alike, folds behind one row. */
export function SettledSteps({ engine, steps, endsAt }: { engine: AgentEngine; steps: ConversationMessage[]; endsAt: number | null }) {
  const digest = workDigest(engine, steps);
  const summary = (
    <>
      <span className="work-lead">Worked</span>
      <Elapsed startedAt={steps[0]!.at} endsAt={endsAt} />
      <span className="work-summary">{[counted(steps.length, "step", "steps"), digest].filter(Boolean).join(" · ")}</span>
    </>
  );
  return (
    <Fold className="work-group settled-fold" holds={steps.map((step) => step.id)} summary={summary}>
      {() => <div className="work-steps"><TurnSegments engine={engine} segments={toSegments(timeSteps(steps, endsAt))} /></div>}
    </Fold>
  );
}
