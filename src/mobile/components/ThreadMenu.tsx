import type { IconType } from "react-icons";
import { LuArchive as Archive, LuCheck as Check, LuChevronRight as ChevronRight, LuFolderGit2 as FolderGit2, LuFolderSymlink as FolderSymlink, LuGitCompareArrows as GitCompareArrows, LuMessageSquareText as MessageSquareText, LuPencilLine as PencilLine, LuSplit as Split, LuSquarePen as SquarePen } from "react-icons/lu";
import type { MobileThreadEntry, MobileThreadView } from "../../contracts/mobile";
import { changesLabel, locationLabel } from "../format";
import { Sheet } from "./Sheet";

type Entry = {
  icon: IconType;
  label: string;
  detail?: string | null;
  disabled?: boolean;
  /** Set on an entry that opens somewhere else rather than doing something. */
  opens?: boolean;
  danger?: boolean;
  onSelect: () => void;
};

function MenuRow({ entry }: { entry: Entry }) {
  const Icon = entry.icon;
  return (
    <button type="button" className="menu-row" disabled={entry.disabled} data-danger={entry.danger || undefined} onClick={entry.onSelect}>
      <span className="menu-glyph" aria-hidden="true"><Icon size={18} strokeWidth={1.8} /></span>
      <span className="menu-copy"><strong>{entry.label}</strong>{entry.detail && <small>{entry.detail}</small>}</span>
      {entry.opens && <ChevronRight className="menu-chevron" size={16} aria-hidden="true" />}
    </button>
  );
}

/** What a thread can do beyond talking: what the desktop's header offers, with nothing the phone cannot see through. */
export function ThreadMenu({ thread, onClose, onChanges, onLocation, onNewHere, onFork, onRename, onArchive }: {
  thread: MobileThreadView;
  onClose: () => void;
  onChanges: () => void;
  onLocation: () => void;
  onNewHere: () => void;
  onFork: (worktree: boolean) => void;
  onRename: () => void;
  onArchive: () => void;
}) {
  const inProject = thread.projectId !== null;
  const working = thread.location.kind === "creating" || thread.location.kind === "releasing";
  const pick = (action: () => void) => () => { onClose(); action(); };
  const groups: Entry[][] = [
    [
      { icon: GitCompareArrows, label: "Changes", detail: thread.reviewable ? changesLabel(thread.changes) ?? "Review this thread's edits" : "No checkout to review", disabled: !thread.reviewable, opens: true, onSelect: pick(onChanges) },
      { icon: thread.location.kind === "worktree" ? FolderSymlink : FolderGit2, label: "Location", detail: inProject ? locationLabel(thread.location) : "Not in a project", disabled: !inProject || working, opens: true, onSelect: pick(onLocation) },
    ],
    [
      { icon: SquarePen, label: thread.location.kind === "worktree" ? "New thread here" : "New thread in project", detail: !inProject ? "Not in a project" : working ? locationLabel(thread.location) : null, disabled: !inProject || working, onSelect: pick(onNewHere) },
      { icon: Split, label: "Fork thread", detail: "Copy the conversation into a new thread", onSelect: pick(() => onFork(false)) },
      ...(inProject ? [{ icon: FolderSymlink, label: "Fork in a worktree", detail: working ? locationLabel(thread.location) : "The copy gets a checkout of its own", disabled: working, onSelect: pick(() => onFork(true)) }] : []),
    ],
    [
      { icon: PencilLine, label: "Rename…", onSelect: pick(onRename) },
      { icon: Archive, label: "Archive…", danger: true, onSelect: pick(onArchive) },
    ],
  ];
  return <MenuSheet title={thread.title} groups={groups} onClose={onClose} />;
}

function MenuSheet({ title, groups, onClose }: { title: string; groups: Entry[][]; onClose: () => void }) {
  return (
    <Sheet title={title} label="Thread options" onClose={onClose}>
      {groups.map((entries, index) => (
        <div key={index} className="menu-group">
          {entries.map((entry) => <MenuRow key={entry.label} entry={entry} />)}
        </div>
      ))}
    </Sheet>
  );
}

/**
 * A row's options, over the list it was pressed in: what needs only the row. What needs the open
 * thread, its changes and its checkout, is in the thread's own menu, through Open.
 */
export function ThreadRowMenu({ thread, onClose, onOpen, onRename, onFork, onDismiss, onArchive }: {
  thread: MobileThreadEntry;
  onClose: () => void;
  onOpen: () => void;
  onRename: () => void;
  onFork: () => void;
  /** Present when Dismiss would file the row away from Priority. */
  onDismiss?: () => void;
  onArchive: () => void;
}) {
  const pick = (action: () => void) => () => { onClose(); action(); };
  const groups: Entry[][] = [
    [{ icon: MessageSquareText, label: "Open", opens: true, onSelect: pick(onOpen) }],
    [
      { icon: PencilLine, label: "Rename…", onSelect: pick(onRename) },
      { icon: Split, label: "Fork thread", detail: "Copy the conversation into a new thread", onSelect: pick(onFork) },
    ],
    [
      ...(onDismiss ? [{ icon: Check, label: "Dismiss from Priority", onSelect: pick(onDismiss) }] : []),
      { icon: Archive, label: "Archive…", danger: true, onSelect: pick(onArchive) },
    ],
  ];
  return <MenuSheet title={thread.title} groups={groups} onClose={onClose} />;
}
