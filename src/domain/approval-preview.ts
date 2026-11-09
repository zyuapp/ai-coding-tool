/**
 * What a tool is about to do, read from its input, so an approval shows the action itself: the
 * command, the file written whole, or the lines an edit swaps. A call that names only what it
 * touches shows that, and anything else is left to its raw input.
 */
export type ApprovalPreview =
  | { kind: "command"; command: string }
  | { kind: "file"; path: string; content: string }
  | { kind: "edit"; path: string; removed: string[]; added: string[] }
  | { kind: "subject"; text: string }
  | { kind: "raw" };

function text(input: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

/** A text's lines, without the empty one a closing newline would leave after the last. */
function lines(value: string): string[] {
  const split = value.split("\n");
  if (split.length > 1 && split.at(-1) === "") split.pop();
  return split;
}

export function approvalPreview(input: Record<string, unknown>): ApprovalPreview {
  const path = text(input, "file_path", "filePath", "notebook_path", "path");
  const removed = text(input, "old_string", "oldString");
  const added = input.new_string ?? input.newString;
  if (path && removed !== null && typeof added === "string") return { kind: "edit", path, removed: lines(removed), added: added === "" ? [] : lines(added) };
  const content = text(input, "content");
  if (path && content !== null) return { kind: "file", path, content };
  const command = text(input, "command");
  if (command !== null) return { kind: "command", command };
  const subject = path ?? text(input, "url");
  return subject !== null ? { kind: "subject", text: subject } : { kind: "raw" };
}
