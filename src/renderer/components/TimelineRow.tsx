import { memo, useContext } from "react";
import { attachmentUrl } from "../../application/attachments";
import type { StreamingTail } from "../../application/thread-run-state";
import type { AgentEngine } from "../../domain/agent-engine";
import type { ConversationMessage } from "../../domain/conversation";
import { groupMessageIds, timeSteps, toSegments, type TimelineGroup } from "../timeline/grouping";
import { MessageArtifactScope } from "./MarkdownMessage";
import { AnnotationRow } from "./AnnotationRow";
import { CopyButton } from "./CopyButton";
import { FileRow } from "./FileRow";
import { PasteRow } from "./PasteRow";
import { StreamingText } from "./StreamingText";
import { SystemNotice } from "./SystemNotice";
import { Fold, SettledSteps, TurnSegments } from "./TurnWork";

let clockFormatter: Intl.DateTimeFormat | undefined;
let momentFormatter: Intl.DateTimeFormat | undefined;
const clockTime = (at: number) => (clockFormatter ??= new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })).format(at);
const fullMoment = (at: number) => (momentFormatter ??= new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "medium" })).format(at);

function UserMessage({ message, onView }: { message: ConversationMessage; onView: (source: string) => void }) {
  const { taskId } = useContext(MessageArtifactScope);
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
        {message.detail && <div className="message-origin">{message.detail}</div>}
        {message.text && <div className="message-text">{message.text}</div>}
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
  onViewAttachment: (source: string) => void;
};

type Entry = Exclude<TimelineGroup, { kind: "updates" }>;

function TimelineEntry({ engine, entry, streamingTail, onViewAttachment }: { engine: AgentEngine; entry: Entry; streamingTail?: StreamingTail | null; onViewAttachment: (source: string) => void }) {
  if (entry.kind === "turn") {
    return (
      <article className="message assistant turn">
        {entry.live
          ? <TurnSegments engine={engine} segments={toSegments(timeSteps(entry.steps, null))} tail={streamingTail} live />
          : entry.steps.length > 0 && <SettledSteps engine={engine} steps={entry.steps} endsAt={entry.endsAt} />}
        {entry.final && <div data-message-id={entry.final.id} className="message-text markdown-body"><StreamingText committed={entry.final.text} messageId={entry.final.id} /></div>}
        {/* Outside the answer, so neither a search nor a selection of it picks the button up. */}
        {entry.final && (
          <div className="answer-actions">
            <time className="answer-time" dateTime={new Date(entry.final.at).toISOString()} title={fullMoment(entry.final.at)}>{clockTime(entry.final.at)}</time>
            <CopyButton text={entry.final.text} label="Copy the answer" />
          </div>
        )}
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
  return <UserMessage message={message} onView={onViewAttachment} />;
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

export const TimelineRow = memo(function TimelineRow({ engine, group, index, offset, measure, streamingTail, onViewAttachment }: TimelineRowProps) {
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
        : <TimelineEntry engine={engine} entry={group} streamingTail={streamingTail} onViewAttachment={onViewAttachment} />}
    </div>
  );
});
