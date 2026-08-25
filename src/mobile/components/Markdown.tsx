import { memo, type ComponentProps } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

/** A phone can act on neither a file path nor a thread link, so only the web ones stay clickable. */
function urlTransform(url: string): string {
  return /^https?:/i.test(url) ? defaultUrlTransform(url) : "";
}

function Link({ children, ...props }: ComponentProps<"a">) {
  return <a {...props} target="_blank" rel="noreferrer">{children}</a>;
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={urlTransform} components={{ a: Link }}>{text}</ReactMarkdown>
    </div>
  );
});
