import { Children, createContext, isValidElement, memo, useContext, useRef, useState, type ComponentProps, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { parseFileHref, parseThreadHref } from "../../domain/markdown-links";
import { MermaidBlock } from "./MermaidBlock";
import { ContextMenu } from "./PopoverMenu";

const CLAUDEX_HREF = /^claudex:/i;
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

function MarkdownPre({ children, ...props }: ComponentProps<"pre">) {
  const unsettled = useContext(Unsettled);
  const child = Children.count(children) === 1 ? Children.only(children) : null;
  if (isValidElement<{ className?: string; children?: ReactNode }>(child) && child.props.className?.split(" ").includes("language-mermaid")) {
    return <MermaidBlock source={String(child.props.children ?? "").replace(/\n$/, "")} pending={unsettled} />;
  }
  return <pre {...props}>{children}</pre>;
}

export function WebLink({ children, openInApp, ...props }: ComponentProps<"a"> & { openInApp?: () => void }) {
  const link = useRef<HTMLAnchorElement>(null);
  const [menu, setMenu] = useState<{ left: number; top: number } | null>(null);
  return (
    <>
      <a
        {...props}
        ref={link}
        target="_blank"
        rel="noreferrer"
        onContextMenu={openInApp ? (event) => {
          event.preventDefault();
          setMenu({
            left: Math.max(8, Math.min(event.clientX, innerWidth - 136)),
            top: Math.max(8, Math.min(event.clientY, innerHeight - 48)),
          });
        } : undefined}
      >
        {children}
      </a>
      {menu && openInApp && <ContextMenu
        position={menu}
        returnFocus={link}
        onSetOpenMenu={() => setMenu(null)}
        items={[{ label: "Open in Claudex", onSelect: openInApp }]}
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
  if (CLAUDEX_HREF.test(href)) return <>{children}</>;
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
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={animate ? [wordSpans] : []}
        skipHtml
        urlTransform={(url) => (CLAUDEX_HREF.test(url) ? url : defaultUrlTransform(url))}
        components={{ pre: MarkdownPre, a: MarkdownLink }}
      >
        {children}
      </ReactMarkdown>
    </Unsettled.Provider>
  );
});
