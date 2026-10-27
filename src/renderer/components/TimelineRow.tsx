import { memo, useContext, useMemo } from "react";
import { attachmentUrl } from "../../application/attachments";
import type { StreamingTail } from "../../application/thread-run-state";
import type { AgentEngine } from "../../domain/agent-engine";
import type { ConversationMessage } from "../../domain/conversation";
import { messageLabel } from "../../domain/message-origin";
import { groupMessageIds, timeSteps, toSegments, type TimelineGroup } from "../timeline/grouping";
import { MessageArtifactScope } from "./MarkdownMessage";
import { AnnotationRow } from "./AnnotationRow";
import { CopyButton } from "./CopyButton";
import { FileRow } from "./FileRow";
import { PasteRow } from "./PasteRow";
import { StreamingText } from "./StreamingText";
import { SystemNotice } from "./SystemNotice";
import { Fold, SettledSteps, TurnSegments } from "./TurnWork";
import { ThreadCards } from "./Coordination";

let clockFormatter: Intl.DateTimeFormat | undefined;
let momentFormatter: Intl.DateTimeFormat | undefined;
const clockTime = (at: number) => (clockFormatter ??= new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })).format(at);
const fullMoment = (at: number) => (momentFormatter ??= new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "medium" })).format(at);

/**
 * When a message was sent, and a copy of it. The clock is drawn from an attribute, so it is never a
 * text node a search or a selection of the message could pick up.
 */
function MessageActions({ at, text, label }: { at: number; text: string; label: string }) {
  return (
    <div className="message-actions">
      <time className="message-time" dateTime={new Date(at).toISOString()} title={fullMoment(at)} data-clock={clockTime(at)} />
      {text && <CopyButton text={text} label={label} />}
    </div>
  );
}

function UserMessage({ message, onView }: { message: ConversationMessage; onView: (source: string) => void }) {
  const { taskId } = useContext(MessageArtifactScope);
  const label = messageLabel(message);
  return (
    <article className="message user">
      <div className="message-stack">
        {message.annotations?.length ? <AnnotationRow annotations={message.annotations} /> : null}
        {message.pastes?.length ? <PasteRow pastes={message.pastes} /> : null}
        {message.files?.length ? <FileRow files={message.files} /> : null}
        {message.attachments?.length ? (
          <div className="message-attachments">
            {message.attachments.map((file, index) => (
              <button
                type="button" key={file} className="message-attachment"
                aria-label={`View screenshot ${index + 1}`}
                onClick={() => onView(attachmentUrl(file, taskId))}
              >
                <img src={attachmentUrl(file, taskId)} alt="" />
              </button>
            ))}
          </div>
        ) : null}
        {label && <div className="message-origin">{label}</div>}
        {message.text && <div className="message-text">{message.text}</div>}
        <MessageActions at={message.at} text={message.text} label="Copy the message" />
      </div>
    </article>
  );
}

type TimelineRowProps = {
  /** The engine whose tools the turn's steps name. */
  engine: AgentEngine;
  group: TimelineGroup;
  index: number;
  /** Where the virtualizer holds this row, in the scroller's own terms. */
  offset: number;
  measure: (node: Element | null) => void;
  streamingTail?: StreamingTail | null;
  /** The newest settled answer, whose time and copy button stay in view without a hover. */
  latest?: boolean;
  onViewAttachment: (source: string) => void;
};

/** The live turn re-renders on every tail, so its segments are only rebuilt when its steps change. */
function LiveSteps({ engine, steps, tail }: { engine: AgentEngine; steps: ConversationMessage[]; tail?: StreamingTail | null }) {
  const segments = useMemo(() => toSegments(timeSteps(steps, null)), [steps]);
  return <TurnSegments engine={engine} segments={segments} tail={tail} live />;
}

type Entry = Exclude<TimelineGroup, { kind: "updates" }>;

function TimelineEntry({ engine, entry, streamingTail, latest = false, onViewAttachment }: { engine: AgentEngine; entry: Entry; streamingTail?: StreamingTail | null; latest?: boolean; onViewAttachment: (source: string) => void }) {
  if (entry.kind === "threads") return <ThreadCards threadIds={entry.threadIds} />;
  if (entry.kind === "turn") {
    return (
      <article className={latest ? "message assistant turn latest" : "message assistant turn"}>
        {entry.live
          ? <LiveSteps engine={engine} steps={entry.steps} tail={streamingTail} />
          : entry.steps.length > 0 && <SettledSteps engine={engine} steps={entry.steps} endsAt={entry.endsAt} />}
        {entry.final && <div data-message-id={entry.final.id} className="message-text markdown-body"><StreamingText committed={entry.final.text} messageId={entry.final.id} /></div>}
        {/* Outside the answer, so neither a search nor a selection of it picks the button up. */}
        {entry.final && <MessageActions at={entry.final.at} text={entry.final.text} label="Copy the answer" />}
      </article>
    );
  }
  const message = entry.message;
  if (message.kind === "system") return <SystemNotice message={message} />;
  if (message.kind === "assistant") {
    return (
      <article className="message assistant">
        <div className="message-text markdown-body"><StreamingText committed={message.text} messageId={message.id} /></div>
      </article>
    );
  }
  if (entry.from) return <ThreadMessage from={entry.from} message={message} />;
  return <UserMessage message={message} onView={onViewAttachment} />;
}

/** A message a coordinator's threads sent it, behind one row naming its sender until opened. */
function ThreadMessage({ from, message }: { from: string; message: ConversationMessage }) {
  const summary = (
    <>
      <span className="work-lead">{from}</span>
      <span className="thread-message-preview">{message.text}</span>
    </>
  );
  return (
    <Fold className="work-group thread-message" holds={[message.id]} summary={summary}>
      {() => <div className="thread-message-text">{message.text}</div>}
    </Fold>
  );
}

/** Earlier thread updates and the coordinator's answers to them, behind one row until opened. */
function FoldedUpdates({ engine, group, onViewAttachment }: { engine: AgentEngine; group: Extract<TimelineGroup, { kind: "updates" }>; onViewAttachment: (source: string) => void }) {
  const summary = (
    <>
      <span className="work-lead">Earlier thread updates</span>
      <span className="work-summary">{group.count}</span>
    </>
  );
  return (
    <Fold className="work-group updates-fold" holds={groupMessageIds(group)} summary={summary}>
      {() => (
        <div className="updates-fold-entries">
          {group.entries.map((entry) => (
            <div key={entry.id} data-message-id={entry.kind === "message" ? entry.message.id : undefined}>
              <TimelineEntry engine={engine} entry={entry} onViewAttachment={onViewAttachment} />
            </div>
          ))}
        </div>
      )}
    </Fold>
  );
}

export const TimelineRow = memo(function TimelineRow({ engine, group, index, offset, measure, streamingTail, latest, onViewAttachment }: TimelineRowProps) {
  const message = group.kind === "message" ? group.message : null;
  return (
    <div
      className={`timeline-row ${message?.kind ?? group.kind}`}
      data-index={index}
      data-group-id={group.id}
      data-message-id={message?.id}
      ref={measure}
      style={{ transform: `translateY(${offset}px)` }}
    >
      {group.kind === "updates"
        ? <FoldedUpdates engine={engine} group={group} onViewAttachment={onViewAttachment} />
        : <TimelineEntry engine={engine} entry={group} streamingTail={streamingTail} latest={latest} onViewAttachment={onViewAttachment} />}
    </div>
  );
});
