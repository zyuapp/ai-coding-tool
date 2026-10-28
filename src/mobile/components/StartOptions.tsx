import { LuCheck as Check, LuChevronDown as ChevronDown, LuFolderGit2 as FolderGit2, LuFolderSymlink as FolderSymlink, LuPlus as Plus } from "react-icons/lu";
import { useState } from "react";
import type { MobileDraftView } from "../../contracts/mobile";
import { LocationChoice } from "./LocationSheet";
import { Sheet } from "./Sheet";

/**
 * Where the thread starts: which project, and within it the project's checkout, one of its own, or
 * one the project already has. With nothing but a checkout of its own to ask for, the chip is a
 * switch; once the project has others, it opens the same choices a thread's Location offers.
 * A project with no repository has no checkouts to offer, so it shows none. Nothing here touches
 * disk; the first message does that.
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
  const fresh = draft.worktree && draft.worktreeName === null;
  const local = !draft.worktree && draft.worktreeName === null;
  const choosing = draft.worktrees.length > 0 || draft.worktreeName !== null;
  const pick = (action: () => void) => () => { setPicking(false); action(); };
  return (
    <div className="thread-start" aria-label="How this thread starts">
      {onPickProject
        ? <button type="button" className="thread-start-project" aria-haspopup="dialog" aria-label={`Project: ${draft.projectName ?? "None"}`} onClick={onPickProject}>{project}<ChevronDown size={14} aria-hidden="true" /></button>
        : <span className="thread-start-project">{project}</span>}
      {draft.projectId === null ? null : choosing ? (
        <button type="button" className="thread-start-toggle thread-start-where" data-chosen={!local || undefined} aria-haspopup="dialog" onClick={() => setPicking(true)}>
          <FolderSymlink size={14} aria-hidden="true" />
          <span>{draft.worktreeName ?? (fresh ? "New worktree" : "Worktree")}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      ) : draft.canWorktree && (
        <button type="button" className="thread-start-toggle" aria-pressed={draft.worktree} onClick={() => onSetWorktree(!draft.worktree)}>
          {draft.worktree ? <Check size={14} strokeWidth={2.4} aria-hidden="true" /> : <FolderSymlink size={14} aria-hidden="true" />}
          <span>Worktree</span>
        </button>
      )}
      {picking && (
        <Sheet title="Start in" onClose={() => setPicking(false)}>
          <section className="sheet-group" role="radiogroup" aria-label="Where this thread starts">
            <LocationChoice icon={<FolderGit2 size={18} strokeWidth={1.8} />} label={draft.projectName ?? "Project"} detail="The project's own checkout" current={local} onSelect={pick(() => onSetWorktree(false))} />
            {draft.worktreeName !== null && !draft.worktrees.some((choice) => choice.name === draft.worktreeName) && (
              <LocationChoice icon={<FolderSymlink size={18} strokeWidth={1.8} />} label={draft.worktreeName} current />
            )}
            {draft.worktrees.map((choice) => (
              <LocationChoice key={choice.id} icon={<FolderSymlink size={18} strokeWidth={1.8} />} label={choice.name} detail={choice.branch ?? "Detached"} current={choice.name === draft.worktreeName} onSelect={pick(() => onStartIn(choice.id))} />
            ))}
            {draft.canWorktree && <LocationChoice icon={<Plus size={18} strokeWidth={1.8} />} label="New worktree" detail="A checkout of its own, cut from the project" current={fresh} onSelect={pick(() => onSetWorktree(true))} />}
          </section>
        </Sheet>
      )}
    </div>
  );
}
