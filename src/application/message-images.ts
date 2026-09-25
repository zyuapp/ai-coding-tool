import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes, Root } from "mdast";
import { MAX_MESSAGE_IMAGES, messageImagePath } from "../domain/message-artifacts";

export type MessageImage = { path: string; label: string };

/** The same Markdown destinations supply both previews and durable copies, including reference links. */
export function messageImages(text: string): MessageImage[] {
  if (!/\.(?:png|jpe?g|gif|webp)\b/i.test(text)) return [];
  const tree: Root = fromMarkdown(text);
  const definitions = new Map<string, string>();
  const define = (node: Nodes) => {
    if (node.type === "definition" && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
    if ("children" in node) for (const child of node.children) define(child);
  };
  define(tree);
  const images = new Map<string, MessageImage>();
  const walk = (node: Nodes) => {
    if (images.size >= MAX_MESSAGE_IMAGES) return;
    const url = node.type === "link" || node.type === "image" ? node.url
      : node.type === "linkReference" || node.type === "imageReference" ? definitions.get(node.identifier) : undefined;
    const file = url ? messageImagePath(url) : null;
    if (file && !images.has(file)) {
      const label = node.type === "image" || node.type === "imageReference" ? node.alt
        : "children" in node ? node.children.map((child) => "value" in child ? child.value : "").join("") : "";
      images.set(file, { path: file, label: label || "Screenshot" });
    }
    if ("children" in node) for (const child of node.children) walk(child);
  };
  walk(tree);
  return [...images.values()];
}
