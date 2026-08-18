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

export const MarkdownMessage = memo(function MarkdownMessage({ children, onSelectTask }: { children: string; onSelectTask?: (taskId: string) => void }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      urlTransform={(url) => (CLAUDEX_HREF.test(url) ? url : defaultUrlTransform(url))}
      components={{ pre: MarkdownPre, a: (props) => <MarkdownLink {...props} onSelectTask={onSelectTask} /> }}
    >
      {children}
    </ReactMarkdown>
  );
});
