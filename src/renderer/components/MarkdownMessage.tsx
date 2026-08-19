import { Children, isValidElement, memo, type ComponentProps, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { MermaidBlock } from "./MermaidBlock";

/** The only in-app href. Anything else under the scheme is text, never a live link. */
const THREAD_HREF = /^claudex:\/\/thread\/([^/?#]+)$/i;
const CLAUDEX_HREF = /^claudex:/i;

function MarkdownPre({ children, ...props }: ComponentProps<"pre">) {
  const child = Children.count(children) === 1 ? Children.only(children) : null;
  if (isValidElement<{ className?: string; children?: ReactNode }>(child) && child.props.className?.split(" ").includes("language-mermaid")) {
    return <MermaidBlock source={String(child.props.children ?? "").replace(/\n$/, "")} />;
  }
  return <pre {...props}>{children}</pre>;
}

function MarkdownLink({ children, onSelectTask, ...props }: ComponentProps<"a"> & { onSelectTask?: (taskId: string) => void }) {
  if (props.href && CLAUDEX_HREF.test(props.href)) {
    const taskId = THREAD_HREF.exec(props.href)?.[1];
    if (!taskId || !onSelectTask) return <>{children}</>;
    return <a {...props} onClick={(event) => { event.preventDefault(); onSelectTask(taskId); }}>{children}</a>;
  }
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

export const MarkdownMessage = memo(function MarkdownMessage({ children, animate, onSelectTask }: { children: string; animate?: boolean; onSelectTask?: (taskId: string) => void }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={animate ? [wordSpans] : []}
      skipHtml
      urlTransform={(url) => (CLAUDEX_HREF.test(url) ? url : defaultUrlTransform(url))}
      components={{ pre: MarkdownPre, a: (props) => <MarkdownLink {...props} onSelectTask={onSelectTask} /> }}
    >
      {children}
    </ReactMarkdown>
  );
});
