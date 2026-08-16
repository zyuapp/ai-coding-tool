import { Children, isValidElement, memo, type ComponentProps, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MermaidBlock } from "./MermaidBlock";

function MarkdownPre({ children, ...props }: ComponentProps<"pre">) {
  const child = Children.count(children) === 1 ? Children.only(children) : null;
  if (isValidElement<{ className?: string; children?: ReactNode }>(child) && child.props.className?.split(" ").includes("language-mermaid")) {
    return <MermaidBlock source={String(child.props.children ?? "").replace(/\n$/, "")} />;
  }
  return <pre {...props}>{children}</pre>;
}

function MarkdownLink({ children, ...props }: ComponentProps<"a">) {
  return <a {...props} target="_blank" rel="noreferrer">{children}</a>;
}

export const MarkdownMessage = memo(function MarkdownMessage({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{ pre: MarkdownPre, a: MarkdownLink }}
    >
      {children}
    </ReactMarkdown>
  );
});
