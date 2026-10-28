import type { IconType } from "react-icons";
import { LuBot as Bot, LuChevronDown as ChevronDown, LuCornerDownRight as CornerDownRight, LuFileText as FileText, LuGlobe as Globe, LuHistory as History, LuPenLine as PenLine, LuSearch as Search, LuTerminal as Terminal, LuWrench as Wrench, LuX as X } from "react-icons/lu";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MobileMessage, MobileThreadView } from "../../contracts/mobile";
import type { AgentEngine } from "../../domain/agent-engine";
import type { ToolFamily } from "../../domain/tool-call";
import { CopyButton } from "../../renderer/components/CopyButton";
import { clockTime, runFamily, summariseTools, transcriptBlocks } from "../format";
import { returnToComposer } from "./Composer";
import { Markdown } from "./Markdown";

const FAMILY_ICONS: Record<ToolFamily, IconType> = {
  shell: Terminal,
  read: FileText,
  write: PenLine,
  search: Search,
  web: Globe,
  agent: Bot,
  other: Wrench,
};

/** A run of more than one call opens to every call in the order it was made. */
function ToolRun({ engine, calls }: { engine: AgentEngine; calls: MobileMessage[] }) {
  const [open, setOpen] = useState(false);
  const Icon = FAMILY_ICONS[runFamily(engine, calls)];
  const row = (
    <>
      <span className="work-glyph" aria-hidden="true"><Icon size={14} strokeWidth={1.75} /></span>
      <span className="work-summary">{summariseTools(calls)}</span>
    </>
  );
  if (calls.length < 2) return <div className="work"><div className="work-row">{row}</div></div>;
  return (
    <div className="work" data-open={open || undefined}>
      <button type="button" className="work-row" aria-expanded={open} onClick={() => setOpen(!open)}>
        {row}
        <span className="work-more"><span className="work-count">{calls.length}</span><ChevronDown className="work-chevron" size={14} strokeWidth={2.2} aria-hidden="true" /></span>
      </button>
      {open && <ol className="work-calls">{calls.map((call, index) => <li key={index}>{call.text}</li>)}</ol>}
    </div>
  );
}

function Message({ message, answer }: { message: MobileMessage; answer: boolean }) {
  if (message.kind === "user") {
    return (
      <div className="turn user">
        {message.origin && <div className="origin">{message.origin}</div>}
        <div className="bubble">{message.text}</div>
      </div>
    );
  }
  if (message.kind === "system") return <div className="notice">{message.text}</div>;
  return (
    <div className="turn assistant">
      <Markdown text={message.text} />
      {answer && (
        <div className="answer-meta">
          <time className="answer-time" dateTime={new Date(message.at).toISOString()}>{clockTime(message.at)}</time>
          <CopyButton text={message.text} label="Copy reply" />
        </div>
      )}
    </div>
  );
}

/**
 * The transcript, pinned to its end. A phone that is already reading further up is left where it
 * is, so a reply arriving mid-scroll does not snatch the page away. Whether it is pinned is decided
 * from the scroll position before a new block is measured, so a whole reply landing at once still
 * keeps the end in view.
 */
export function Conversation({ thread, onSteerQueued, onDropQueued }: {
  thread: MobileThreadView;
  onSteerQueued: (messageId: string) => void;
  onDropQueued: (messageId: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const blocks = transcriptBlocks(thread.messages);
  const tail = thread.messages.at(-1);
  const anchor = `${thread.id}:${thread.messages.length}:${tail?.at ?? 0}:${thread.streamingTail?.length ?? 0}`;

  function onScroll() {
    const node = scroller.current;
    if (node) pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
  }

  useLayoutEffect(() => {
    const node = scroller.current;
    if (node && pinned.current) node.scrollTop = node.scrollHeight;
  }, [anchor]);

  useLayoutEffect(() => {
    pinned.current = true;
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [thread.id]);

  /** The scroller shrinks under the keyboard and grows under a card or a taller composer; both keep the end in view. */
  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      if (pinned.current) node.scrollTop = node.scrollHeight;
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="transcript" ref={scroller} onScroll={onScroll}>
      {thread.loading && <p className="notice" role="status">Loading conversation…</p>}
      {thread.omitted > 0 && <p className="omitted"><History size={14} strokeWidth={2} aria-hidden="true" />{thread.omitted} earlier {thread.omitted === 1 ? "message" : "messages"} are only on the computer.</p>}
      {blocks.map((block) => (block.kind === "tools"
        ? <ToolRun key={block.key} engine={thread.settings.engine} calls={block.calls} />
        : <Message key={block.key} message={block.message} answer={block.answer} />))}
      {thread.streamingTail !== null && (
        <div className="turn assistant">
          <Markdown text={thread.streamingTail} />
        </div>
      )}
      {thread.status === "running" && thread.streamingTail === null && (
        <div className="thinking-row" role="status"><span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" /><span className="sr-only">Working</span></div>
      )}
      {thread.queued.length > 0 && (
        <div className="queued-list" role="list" aria-label="Queued messages">
          {thread.queued.map((message) => (
            <div key={message.id} className="queued" role="listitem" data-steering={message.steering || undefined}>
              <CornerDownRight className="queued-mark" size={14} aria-hidden="true" />
              <span className="queued-body">
                {message.origin && <span className="queued-origin">{message.origin}</span>}
                <span className="queued-text">{message.text}</span>
              </span>
              {message.steering
                ? <span className="queued-state">Steering…</span>
                : <span className="queued-actions">
                  <button type="button" className="queued-steer" onClick={() => onSteerQueued(message.id)}>Steer</button>
                  <button type="button" className="queued-drop" aria-label="Remove queued message" onClick={() => {
                    onDropQueued(message.id);
                    returnToComposer(message.text);
                  }}><X size={16} /></button>
                </span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
