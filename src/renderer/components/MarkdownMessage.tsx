import { Children, createContext, isValidElement, memo, useContext, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { parseFileHref, parseThreadHref } from "../../domain/markdown-links";
import { Copyable } from "./CopyButton";
import { MermaidBlock } from "./MermaidBlock";
import { ContextMenu } from "./PopoverMenu";
import { isCommitHash, messageImagePath, messageImageUrl } from "../../domain/message-artifacts";
import { messageImages, type MessageImage } from "../message-images";

const APP_HREF = /^aicodingtool:/i;
const WEB_HREF = /^https?:/i;

/** What a link in a message can reach. A handler the host leaves out makes that link plain text. */
export type MessageLinkActions = {
  selectThread?: (threadId: string) => void;
  openFile?: (path: string, line: number | null) => void;
  openUrlInApp?: (url: string) => void;
  openImage?: (source: string) => void;
  openCommit?: (commit: string, taskId?: string) => void;
};

export const MessageArtifactScope = createContext<{ root: string; taskId?: string }>({ root: "" });
const MessageId = createContext("");
const CodeBlock = createContext(false);

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
      <CodeBlock.Provider value><pre {...props}>{children}</pre></CodeBlock.Provider>
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
  const scope = useContext(MessageArtifactScope);
  const messageId = useContext(MessageId);
  const href = props.href ?? "";
  const threadId = parseThreadHref(href);
  if (threadId && actions.selectThread) return <a {...props} onClick={(event) => { event.preventDefault(); actions.selectThread!(threadId); }}>{children}</a>;
  /** Anything else under the scheme is text, never a live link. */
  if (APP_HREF.test(href)) return <>{children}</>;
  const image = messageImagePath(href);
  if (image && messageId && actions.openImage) return <a {...props} onClick={(event) => {
    event.preventDefault();
    actions.openImage!(messageImageUrl(image, scope.root, messageId));
  }}>{children}</a>;
  const file = parseFileHref(href);
  if (file) return actions.openFile
    ? <a {...props} onClick={(event) => { event.preventDefault(); actions.openFile!(file.file, file.line); }}>{children}</a>
    : <>{children}</>;
  if (WEB_HREF.test(href)) return <WebLink {...props} openInApp={actions.openUrlInApp && (() => actions.openUrlInApp!(href))}>{children}</WebLink>;
  return <a {...props} target="_blank" rel="noreferrer">{children}</a>;
}

function MarkdownCode({ children, ...props }: ComponentProps<"code">) {
  const actions = useContext(MessageLinks);
  const scope = useContext(MessageArtifactScope);
  const block = useContext(CodeBlock);
  const hash = typeof children === "string" ? children : "";
  return !block && isCommitHash(hash) && actions.openCommit
    ? <button type="button" className="message-commit" aria-label={`View commit ${hash}`} onClick={() => actions.openCommit!(hash, scope.taskId)}><code {...props}>{children}</code></button>
    : <code {...props}>{children}</code>;
}

function MessageImagePreview({ image: linked, messageId }: { image: MessageImage; messageId: string }) {
  const scope = useContext(MessageArtifactScope);
  const actions = useContext(MessageLinks);
  const [failed, setFailed] = useState(false);
  const source = messageImageUrl(linked.path, scope.root, messageId);
  return <div className="message-image-preview">
    {failed ? <span className="message-image-unavailable">{linked.label} · Preview unavailable</span> :
      <button type="button" aria-label={`Enlarge ${linked.label}`} onClick={() => actions.openImage?.(source)}>
        <img src={messageImageUrl(linked.path, scope.root, messageId, true)} alt={linked.label} loading="lazy" decoding="async" onError={() => setFailed(true)} />
      </button>}
  </div>;
}

/** Local Markdown images use the same bounded preview gallery as links, rather than a file: URL. */
function MarkdownImage({ src, alt, ...props }: ComponentProps<"img">) {
  if (typeof src === "string" && messageImagePath(src)) return <span>{alt}</span>;
  return <img {...props} src={src} alt={alt} loading="lazy" />;
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

export const MarkdownMessage = memo(function MarkdownMessage({ children, animate, messageId = "" }: { children: string; animate?: boolean; messageId?: string }) {
  const actions = useContext(MessageLinks);
  const images = useMemo(() => !animate && messageId && actions.openImage ? messageImages(children) : [], [children, animate, messageId, actions.openImage]);
  return (
    <MessageId.Provider value={messageId}>
    <Unsettled.Provider value={!!animate}>
      <Source.Provider value={children}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={animate ? [wordSpans] : []}
          skipHtml
          urlTransform={(url) => (APP_HREF.test(url) ? url : defaultUrlTransform(url))}
          components={{ pre: MarkdownPre, table: MarkdownTable, a: MarkdownLink, code: MarkdownCode, img: MarkdownImage }}
        >
          {children}
        </ReactMarkdown>
        {images.length > 0 && <div className="message-image-previews">{images.map((linked) => <MessageImagePreview key={`${messageId}:${linked.path}`} image={linked} messageId={messageId} />)}</div>}
      </Source.Provider>
    </Unsettled.Provider>
    </MessageId.Provider>
  );
});
