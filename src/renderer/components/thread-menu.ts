import type { Thread } from "../../domain/thread";
import { threadLink } from "../../domain/thread-handles";
import type { MenuEntry } from "./PopoverMenu";

/** The same thread actions from its sidebar row and its heading. */
export function threadMenuEntries(thread: Thread, actions: {
  onRename: () => void;
  onFork: (worktree: boolean) => void;
  onArchive: () => void;
}): MenuEntry[] {
  return [
    { label: "Rename", onSelect: actions.onRename },
    "separator",
    { label: "Copy link", onSelect: () => void navigator.clipboard?.writeText(threadLink(thread.id)) },
    "separator",
    { label: "Fork", onSelect: () => actions.onFork(false) },
    { label: "Fork into a new worktree", onSelect: () => actions.onFork(true) },
    "separator",
    { label: "Archive", danger: true, onSelect: actions.onArchive },
  ];
}
