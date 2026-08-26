import { attachmentUrl } from "../../application/attachments";
import type { StreamingTail } from "../../application/task-workspace";
import type { TaskMessage } from "../../domain/task";
import { timeSteps, toSegments, type TimelineGroup } from "../timeline/grouping";
import { AnnotationRow } from "./AnnotationRow";
import { CopyButton } from "./CopyButton";
import { FileRow } from "./FileRow";
import { PasteRow } from "./PasteRow";
import { StreamingText } from "./StreamingText";
import { SystemNotice } from "./SystemNotice";
import { SettledSteps, TurnSegments } from "./TurnWork";

let clockFormatter: Intl.DateTimeFormat | undefined;
let momentFormatter: Intl.DateTimeFormat | undefined;
const clockTime = (at: number) => (clockFormatter ??= new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })).format(at);
const fullMoment = (at: number) => (momentFormatter ??= new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "medium" })).format(at);

function UserMessage({ message, onView }: { message: TaskMessage; onView: (source: string) => void }) {
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
                onClick={() => onView(attachmentUrl(file))}
              >
                <img src={attachmentUrl(file)} alt="" />
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
  group: TimelineGroup;
  index: number;
  /** Where the virtualizer holds this row, in the scroller's own terms. */
  offset: number;
  measure: (node: Element | null) => void;
  streamingTail?: StreamingTail | null;
  onViewAttachment: (source: string) => void;
};

export function TimelineRow({ group, index, offset, measure, streamingTail, onViewAttachment }: TimelineRowProps) {
  const message = group.kind === "message" ? group.message : null;
  return (
    <div
      className={`timeline-row ${message?.kind ?? "turn"}`}
      data-index={index}
      data-group-id={group.id}
      data-message-id={message?.id}
      ref={measure}
      style={{ transform: `translateY(${offset}px)` }}
    >
      {group.kind === "turn" ? (
        <article className="message assistant turn">
          {group.live
            ? <TurnSegments segments={toSegments(timeSteps(group.steps, null))} tail={streamingTail} live />
            : group.steps.length > 0 && <SettledSteps steps={group.steps} endsAt={group.endsAt} />}
          {group.final && <div data-message-id={group.final.id} className="message-text markdown-body"><StreamingText committed={group.final.text} /></div>}
          {/* Outside the answer, so neither a search nor a selection of it picks the button up. */}
          {group.final && (
            <div className="answer-actions">
              <time className="answer-time" dateTime={new Date(group.final.at).toISOString()} title={fullMoment(group.final.at)}>{clockTime(group.final.at)}</time>
              <CopyButton text={group.final.text} label="Copy the answer" />
            </div>
          )}
        </article>
      ) : message!.kind === "system" ? (
        <SystemNotice message={message!} />
      ) : (
        <UserMessage message={message!} onView={onViewAttachment} />
      )}
    </div>
  );
}
