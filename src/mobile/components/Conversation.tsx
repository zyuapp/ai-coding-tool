import type { IconType } from "react-icons";
import { LuBot as Bot, LuFileText as FileText, LuGlobe as Globe, LuPenLine as PenLine, LuSearch as Search, LuTerminal as Terminal, LuWrench as Wrench } from "react-icons/lu";
import { useEffect, useLayoutEffect, useRef } from "react";
import type { MobileMessage, MobileThreadView } from "../../contracts/mobile";
import type { AgentEngine } from "../../domain/agent-engine";
import type { ToolFamily } from "../../domain/tool-call";
import { clockTime, runFamily, summariseTools, transcriptBlocks } from "../format";
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

function ToolRun({ engine, calls }: { engine: AgentEngine; calls: MobileMessage[] }) {
  const Icon = FAMILY_ICONS[runFamily(engine, calls)];
  return (
    <div className="work">
      <span className="work-glyph" aria-hidden="true"><Icon size={14} strokeWidth={1.75} /></span>
      <span className="work-summary">{summariseTools(calls)}</span>
      <span className="work-count">{calls.length}</span>
    </div>
  );
}

function Message({ message, answer }: { message: MobileMessage; answer: boolean }) {
  if (message.kind === "user") {
    return (
      <div className="turn user">
        <div className="bubble">{message.text}</div>
      </div>
    );
  }
  if (message.kind === "system") return <div className="notice">{message.text}</div>;
  return (
    <div className="turn assistant">
      <Markdown text={message.text} />
      {answer && <time className="answer-time" dateTime={new Date(message.at).toISOString()}>{clockTime(message.at)}</time>}
    </div>
  );
}

/**
 * The transcript, pinned to its end. A phone that is already reading further up is left where it
 * is, so a reply arriving mid-scroll does not snatch the page away. Whether it is pinned is decided
 * from the scroll position before a new block is measured, so a whole reply landing at once still
 * keeps the end in view.
 */
export function Conversation({ thread }: { thread: MobileThreadView }) {
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
      {thread.omitted > 0 && <p className="omitted">{thread.omitted} earlier {thread.omitted === 1 ? "message" : "messages"} are only on the computer.</p>}
      {blocks.map((block) => (block.kind === "tools"
        ? <ToolRun key={block.key} engine={thread.settings.engine} calls={block.calls} />
        : <Message key={block.key} message={block.message} answer={block.answer} />))}
      {thread.streamingTail !== null && (
        <div className="turn assistant">
          <Markdown text={thread.streamingTail} />
        </div>
      )}
      {thread.status === "running" && thread.streamingTail === null && (
        <div className="thinking-row" aria-hidden="true"><span /><span /><span /></div>
      )}
      {thread.queued.map((message) => (
        <div key={message.id} className="queued">
          <span className="queued-text">{message.text}</span>
          <span className="queued-state">Queued</span>
        </div>
      ))}
    </div>
  );
}
