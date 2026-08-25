import { Children, createContext, isValidElement, memo, useContext, useRef, useState, type ComponentProps, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { parseFileHref, parseThreadHref } from "../../domain/markdown-links";
import { Copyable } from "./CopyButton";
import { MermaidBlock } from "./MermaidBlock";
import { ContextMenu } from "./PopoverMenu";

const APP_HREF = /^aicodingtool:/i;
const WEB_HREF = /^https?:/i;

/** What a link in a message can reach. A handler the host leaves out makes that link plain text. */
export type MessageLinkActions = {
  selectTask?: (taskId: string) => void;
  openFile?: (path: string, line: number | null) => void;
  openUrlInApp?: (url: string) => void;
};

const MessageLinks = createContext<MessageLinkActions>({});

export function MessageLinkProvider({ actions, children }: { actions: MessageLinkActions; children: ReactNode }) {
  return <MessageLinks.Provider value={actions}>{children}</MessageLinks.Provider>;
}

export function useMessageLinks() {
  return useContext(MessageLinks);
}

/** Whether this document is the part of a stream still being written, whose last block will grow. */
const Unsettled = createContext(false);

/** The Markdown this document was rendered from, which a block slices to copy itself back out. */
const Source = createContext("");

/** What a node was written as. A block still being streamed has nothing settled to copy yet. */
function useBlockSource(node: ExtraProps["node"]) {
  const source = useContext(Source);
  const unsettled = useContext(Unsettled);
  const at = node?.position;
  if (unsettled || !at) return "";
  return source.slice(at.start.offset ?? 0, at.end.offset ?? 0);
}

function MarkdownPre({ children, node, ...props }: ComponentProps<"pre"> & ExtraProps) {
  const unsettled = useContext(Unsettled);
  const child = Children.count(children) === 1 ? Children.only(children) : null;
  const code = isValidElement<{ className?: string; children?: ReactNode }>(child) ? child : null;
  /** The fence marks frame the block, so what is copied is only what was written inside them. */
  const inside = String(code?.props.children ?? "").replace(/\n$/, "");
  const copied = unsettled ? "" : inside;
  if (code?.props.className?.split(" ").includes("language-mermaid")) {
    return (
      <Copyable text={copied} label="Copy the diagram">
        <MermaidBlock source={inside} pending={unsettled} />
      </Copyable>
    );
  }
  return (
    <Copyable text={copied} label="Copy the code">
      <pre {...props}>{children}</pre>
    </Copyable>
  );
}

/** A table has no plain text of its own, so it is copied as the Markdown it was written as. */
function MarkdownTable({ node, ...props }: ComponentProps<"table"> & ExtraProps) {
  const source = useBlockSource(node);
  return (
    <Copyable text={source} label="Copy the table" className="copyable-table">
      <table {...props} />
    </Copyable>
  );
}

export function WebLink({ children, openInApp, ...props }: ComponentProps<"a"> & { openInApp?: () => void }) {
  const link = useRef<HTMLAnchorElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <a
        {...props}
        ref={link}
        target="_blank"
        rel="noreferrer"
        onContextMenu={openInApp ? (event) => {
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY });
        } : undefined}
      >
        {children}
      </a>
      {menu && openInApp && <ContextMenu
        at={menu}
        returnFocus={link}
        onClose={() => setMenu(null)}
        entries={[{ label: "Open in AI Coding Tool", onSelect: openInApp }]}
      />}
    </>
  );
}

function MarkdownLink({ children, ...props }: ComponentProps<"a">) {
  const actions = useContext(MessageLinks);
  const href = props.href ?? "";
  const taskId = parseThreadHref(href);
  if (taskId && actions.selectTask) return <a {...props} onClick={(event) => { event.preventDefault(); actions.selectTask!(taskId); }}>{children}</a>;
  /** Anything else under the scheme is text, never a live link. */
  if (APP_HREF.test(href)) return <>{children}</>;
  const file = parseFileHref(href);
  if (file) return actions.openFile
    ? <a {...props} onClick={(event) => { event.preventDefault(); actions.openFile!(file.file, file.line); }}>{children}</a>
    : <>{children}</>;
  if (WEB_HREF.test(href)) return <WebLink {...props} openInApp={actions.openUrlInApp && (() => actions.openUrlInApp!(href))}>{children}</WebLink>;
  return <a {...props} target="_blank" rel="noreferrer">{children}</a>;
}

type HastNode = { type: string; tagName?: string; value?: string; children?: HastNode[] };

/** Splits rendered prose into words so each one can fade in as it is read out. Code keeps its shape. */
function wordSpans() {
  const split = (value: string): HastNode[] => value.split(/(?<=\s)(?=\S)/).map((word) => ({
    type: "element",
    tagName: "span",
    properties: { className: ["stream-word"] },
    children: [{ type: "text", value: word }],
  } as HastNode));
  const walk = (node: HastNode) => {
    if (!node.children || node.tagName === "code" || node.tagName === "pre") return;
    node.children = node.children.flatMap((child) => {
      /** Whitespace between structural nodes is not prose, and a span there is invalid inside a table. */
      if (child.type === "text") return /\S/.test(child.value ?? "") ? split(child.value ?? "") : child;
      walk(child);
      return child;
    });
  };
  return walk;
}

export const MarkdownMessage = memo(function MarkdownMessage({ children, animate }: { children: string; animate?: boolean }) {
  return (
    <Unsettled.Provider value={!!animate}>
      <Source.Provider value={children}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={animate ? [wordSpans] : []}
          skipHtml
          urlTransform={(url) => (APP_HREF.test(url) ? url : defaultUrlTransform(url))}
          components={{ pre: MarkdownPre, table: MarkdownTable, a: MarkdownLink }}
        >
          {children}
        </ReactMarkdown>
      </Source.Provider>
    </Unsettled.Provider>
  );
});
