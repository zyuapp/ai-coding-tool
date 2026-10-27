import { LuChevronDown as ChevronDown, LuFolderGit2 as FolderGit2, LuFolderSymlink as FolderSymlink, LuX as X } from "react-icons/lu";
import { useState } from "react";
import type { MobileDraftView } from "../../contracts/mobile";
import { Sheet } from "./Sheet";

/**
 * How the thread starts once it has a project: in the project's checkout, in one of its own, or in
 * one the project already has. A project with no repository has no checkouts to offer, so it shows
 * none. Nothing here touches disk; the first message does that.
 */
export function StartOptions({ draft, onSetWorktree, onStartIn }: {
  draft: MobileDraftView;
  onSetWorktree: (worktree: boolean) => void;
  onStartIn: (worktreeId: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  if (draft.projectId === null) return null;
  return (
    <div className="thread-start" aria-label="How this thread starts">
      <span className="thread-start-project"><FolderGit2 size={14} aria-hidden="true" /><span>{draft.projectName}</span></span>
      {draft.worktreeName ? (
        <span className="thread-start-worktree">
          <FolderSymlink size={14} aria-hidden="true" />
          <span>{draft.worktreeName}</span>
          <button type="button" aria-label={`Leave ${draft.worktreeName}`} onClick={() => onSetWorktree(false)}><X size={14} /></button>
        </span>
      ) : (<>
        {draft.canWorktree && <button type="button" className="thread-start-toggle" aria-pressed={draft.worktree} onClick={() => onSetWorktree(!draft.worktree)}>
          <FolderSymlink size={14} aria-hidden="true" />
          <span>Worktree</span>
        </button>}
        {draft.worktrees.length > 0 && (
          <button type="button" className="thread-start-toggle" aria-haspopup="dialog" onClick={() => setPicking(true)}>
            <span>Existing</span>
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        )}
      </>)}
      {picking && (
        <Sheet title="Start in a worktree" onClose={() => setPicking(false)}>
          <section className="sheet-group" aria-label="Worktrees">
            {draft.worktrees.map((choice) => (
              <button key={choice.id} type="button" className="sheet-option location-option" onClick={() => { setPicking(false); onStartIn(choice.id); }}>
                <span className="menu-glyph" aria-hidden="true"><FolderSymlink size={18} strokeWidth={1.8} /></span>
                <span className="menu-copy"><strong>{choice.name}</strong><small>{choice.branch ?? "Detached"}</small></span>
              </button>
            ))}
          </section>
        </Sheet>
      )}
    </div>
  );
}
