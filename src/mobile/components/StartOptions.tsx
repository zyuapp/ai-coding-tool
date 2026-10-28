import { LuCheck as Check, LuChevronDown as ChevronDown, LuFolderGit2 as FolderGit2, LuFolderSymlink as FolderSymlink, LuX as X } from "react-icons/lu";
import { useState } from "react";
import type { MobileDraftView } from "../../contracts/mobile";
import { Sheet } from "./Sheet";

/**
 * Where the thread starts: which project, and within it the project's checkout, one of its own, or
 * one the project already has. A project with no repository has no checkouts to offer, so it shows
 * none. Nothing here touches disk; the first message does that.
 */
export function StartOptions({ draft, onPickProject, onSetWorktree, onStartIn }: {
  draft: MobileDraftView;
  /** Absent when there is no project to choose. */
  onPickProject?: () => void;
  onSetWorktree: (worktree: boolean) => void;
  onStartIn: (worktreeId: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  if (draft.projectId === null && !onPickProject) return null;
  const project = <><FolderGit2 size={14} aria-hidden="true" /><span>{draft.projectName ?? "No project"}</span></>;
  return (
    <div className="thread-start" aria-label="How this thread starts">
      {onPickProject
        ? <button type="button" className="thread-start-project" aria-haspopup="dialog" aria-label={`Project: ${draft.projectName ?? "None"}`} onClick={onPickProject}>{project}<ChevronDown size={14} aria-hidden="true" /></button>
        : <span className="thread-start-project">{project}</span>}
      {draft.projectId === null ? null : draft.worktreeName ? (
        <span className="thread-start-worktree">
          <FolderSymlink size={14} aria-hidden="true" />
          <span>{draft.worktreeName}</span>
          <button type="button" aria-label={`Leave ${draft.worktreeName}`} onClick={() => onSetWorktree(false)}><X size={14} /></button>
        </span>
      ) : (<>
        {draft.canWorktree && <button type="button" className="thread-start-toggle" aria-pressed={draft.worktree} onClick={() => onSetWorktree(!draft.worktree)}>
          {draft.worktree ? <Check size={14} strokeWidth={2.4} aria-hidden="true" /> : <FolderSymlink size={14} aria-hidden="true" />}
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
