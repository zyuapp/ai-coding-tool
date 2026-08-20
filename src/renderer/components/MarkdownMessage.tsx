import { Children, createContext, isValidElement, memo, useContext, type ComponentProps, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { linkableFor, parseFileHref, parseThreadHref, scanLinkables } from "../../domain/markdown-links";
import { MermaidBlock } from "./MermaidBlock";

const CLAUDEX_HREF = /^claudex:/i;
const WEB_HREF = /^https?:/i;

/** What a link in a message can reach. A handler the host leaves out makes that link plain text. */
export type MessageLinkActions = {
  selectTask?: (taskId: string) => void;
  openFile?: (path: string) => void;
  openUrl?: (url: string) => void;
};

const MessageLinks = createContext<MessageLinkActions>({});

export function MessageLinkProvider({ actions, children }: { actions: MessageLinkActions; children: ReactNode }) {
  return <MessageLinks.Provider value={actions}>{children}</MessageLinks.Provider>;
}

function MarkdownPre({ children, ...props }: ComponentProps<"pre">) {
  const child = Children.count(children) === 1 ? Children.only(children) : null;
  if (isValidElement<{ className?: string; children?: ReactNode }>(child) && child.props.className?.split(" ").includes("language-mermaid")) {
    return <MermaidBlock source={String(child.props.children ?? "").replace(/\n$/, "")} />;
  }
  return <pre {...props}>{children}</pre>;
}

function MarkdownLink({ children, ...props }: ComponentProps<"a">) {
  const actions = useContext(MessageLinks);
  const href = props.href ?? "";
  const inApp = (() => {
    const taskId = parseThreadHref(href);
    if (taskId) return actions.selectTask && (() => actions.selectTask!(taskId));
    const path = parseFileHref(href);
    if (path) return actions.openFile && (() => actions.openFile!(path));
    return undefined;
  })();
  if (inApp) return <a {...props} onClick={(event) => { event.preventDefault(); inApp(); }}>{children}</a>;
  /** Anything else under the scheme is text, never a live link. */
  if (CLAUDEX_HREF.test(href)) return <>{children}</>;
  if (actions.openUrl && WEB_HREF.test(href)) {
    return <a {...props} onClick={(event) => { event.preventDefault(); actions.openUrl!(href); }}>{children}</a>;
  }
  return <a {...props} target="_blank" rel="noreferrer">{children}</a>;
}

type MdastNode = { type: string; value?: string; url?: string; children?: MdastNode[] };

/**
 * Links the references an agent writes as plain prose — a path, a thread URL, a URL in backticks.
 * Only what {@link scanLinkables} is sure of becomes a link, so ordinary prose stays prose.
 */
function autoLinks() {
  const fromText = (node: MdastNode): MdastNode[] => {
    const value = node.value ?? "";
    const found = scanLinkables(value);
    if (found.length === 0) return [node];
    const parts: MdastNode[] = [];
    let read = 0;
    for (const linkable of found) {
      if (linkable.start > read) parts.push({ type: "text", value: value.slice(read, linkable.start) });
      parts.push({ type: "link", url: linkable.href, children: [{ type: "text", value: linkable.text }] });
      read = linkable.end;
    }
    if (read < value.length) parts.push({ type: "text", value: value.slice(read) });
    return parts;
  };
  const walk = (node: MdastNode) => {
    if (!node.children || node.type === "link" || node.type === "linkReference") return;
    node.children = node.children.flatMap((child) => {
      if (child.type === "text") return fromText(child);
      if (child.type === "inlineCode") {
        const href = linkableFor((child.value ?? "").trim());
        return href ? { type: "link", url: href, children: [child] } : child;
      }
      walk(child);
      return child;
    });
  };
  return walk;
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
    <ReactMarkdown
      remarkPlugins={[remarkGfm, autoLinks]}
      rehypePlugins={animate ? [wordSpans] : []}
      skipHtml
      urlTransform={(url) => (CLAUDEX_HREF.test(url) ? url : defaultUrlTransform(url))}
      components={{ pre: MarkdownPre, a: MarkdownLink }}
    >
      {children}
    </ReactMarkdown>
  );
});
