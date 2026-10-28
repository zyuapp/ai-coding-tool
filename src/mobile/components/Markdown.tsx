import { memo, type ComponentProps } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copyable } from "../../renderer/components/CopyButton";

/** A phone can act on neither a file path nor a thread link, so only the web ones stay clickable. */
function urlTransform(url: string): string {
  return /^https?:/i.test(url) ? defaultUrlTransform(url) : "";
}

/** A link the phone cannot follow reads as the text it labels, so nothing looks tappable that is not. */
function Link({ children, href, node: _node, ...props }: ComponentProps<"a"> & { node?: unknown }) {
  if (!href) return <>{children}</>;
  return <a {...props} href={href} target="_blank" rel="noreferrer">{children}</a>;
}

type HastNode = { type: string; value?: string; children?: HastNode[] };

function textOf(node: HastNode | undefined): string {
  if (!node) return "";
  return node.type === "text" ? node.value ?? "" : (node.children ?? []).map(textOf).join("");
}

/** A code block carries a copy button, since selecting a scrolling block by touch is a chore. */
function Pre({ children, node, ...props }: ComponentProps<"pre"> & { node?: unknown }) {
  return (
    <Copyable className="code-block" text={textOf(node as HastNode | undefined).replace(/\n$/, "")} label="Copy code">
      <pre {...props}>{children}</pre>
    </Copyable>
  );
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={urlTransform} components={{ a: Link, pre: Pre }}>{text}</ReactMarkdown>
    </div>
  );
});
