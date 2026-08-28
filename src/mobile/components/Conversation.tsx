import type { IconType } from "react-icons";
import { LuBot as Bot, LuFileText as FileText, LuGlobe as Globe, LuPenLine as PenLine, LuSearch as Search, LuTerminal as Terminal, LuWrench as Wrench } from "react-icons/lu";
import { useEffect, useRef } from "react";
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

function Message({ message }: { message: MobileMessage }) {
  if (message.kind === "user") {
    return (
      <div className="turn user">
        <div className="bubble">{message.text}</div>
        <time className="turn-when">{clockTime(message.at)}</time>
      </div>
    );
  }
  if (message.kind === "system") return <div className="notice">{message.text}</div>;
  return (
    <div className="turn assistant">
      <Markdown text={message.text} />
    </div>
  );
}

/**
 * The transcript, pinned to its end. A phone that is already reading further up is left where it
 * is, so a reply arriving mid-scroll does not snatch the page away.
 */
export function Conversation({ thread }: { thread: MobileThreadView }) {
  const scroller = useRef<HTMLDivElement>(null);
  const blocks = transcriptBlocks(thread.messages);
  const tail = thread.messages.at(-1);
  const anchor = `${thread.id}:${thread.messages.length}:${tail?.at ?? 0}:${thread.streamingTail?.length ?? 0}`;

  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    if (distance < 240) node.scrollTo({ top: node.scrollHeight });
  }, [anchor]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [thread.id]);

  return (
    <div className="transcript" ref={scroller}>
      {thread.omitted > 0 && <p className="omitted">{thread.omitted} earlier {thread.omitted === 1 ? "message" : "messages"} are only on the Mac.</p>}
      {blocks.map((block) => (block.kind === "tools"
        ? <ToolRun key={block.key} engine={thread.settings.engine} calls={block.calls} />
        : <Message key={block.key} message={block.message} />))}
      {thread.streamingTail !== null && (
        <div className="turn assistant">
          <Markdown text={thread.streamingTail} />
          <span className="caret" aria-hidden="true" />
        </div>
      )}
      {thread.queued.map((message) => <div key={message.id} className="turn user queued"><div className="bubble">{message.text}</div><span className="turn-when">Queued</span></div>)}
    </div>
  );
}
