import { LuCheck as Check, LuFolderGit2 as FolderGit2, LuFolderSymlink as FolderSymlink, LuPlus as Plus } from "react-icons/lu";
import type { MobileThreadView, MobileWorktreeChoice } from "../../contracts/mobile";
import type { WorktreeDestination } from "../../domain/worktree";
import { Sheet } from "./Sheet";

function Choice({ icon, label, detail, current, disabled, onSelect }: {
  icon: React.ReactNode;
  label: string;
  detail?: string | null;
  current?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
}) {
  return (
    <button type="button" role="radio" aria-checked={current ?? false} className="sheet-option location-option" disabled={disabled || current} onClick={onSelect}>
      <span className="menu-glyph" aria-hidden="true">{icon}</span>
      <span className="menu-copy"><strong>{label}</strong>{detail && <small>{detail}</small>}</span>
      <span className="sheet-check" aria-hidden="true">{current && <Check size={16} />}</span>
    </button>
  );
}

/**
 * Where the thread works, and where it could: the project's own checkout, one it already has, or
 * a fresh one. Moving leaves the files where they are, which the sheet says once, at the bottom.
 */
export function LocationSheet({ thread, onClose, onMove }: {
  thread: MobileThreadView;
  onClose: () => void;
  onMove: (destination: WorktreeDestination) => void;
}) {
  const location = thread.location;
  const inWorktree = location.kind === "worktree";
  const locked = !thread.canMove;
  const move = (destination: WorktreeDestination) => () => { onClose(); onMove(destination); };
  const branchOf = (choice: MobileWorktreeChoice) => choice.branch ?? "Detached";
  return (
    <Sheet title="Location" onClose={onClose}>
      <section className="sheet-group" role="radiogroup" aria-label="Where this thread works">
        <Choice icon={<FolderGit2 size={17} strokeWidth={1.8} />} label={thread.projectName ?? "Project"} detail="The project's own checkout" current={location.kind === "local"} disabled={locked} onSelect={move({ kind: "local" })} />
        {inWorktree && <Choice icon={<FolderSymlink size={17} strokeWidth={1.8} />} label={location.name} detail={location.threads === 1 ? "Only this thread works here" : `${location.threads} threads work here`} current />}
        {thread.worktrees.map((choice) => (
          <Choice key={choice.id} icon={<FolderSymlink size={17} strokeWidth={1.8} />} label={choice.name} detail={branchOf(choice)} disabled={locked} onSelect={move({ kind: "worktree", id: choice.id })} />
        ))}
        <Choice icon={<Plus size={17} strokeWidth={1.8} />} label="New worktree" detail="A checkout of its own, cut from the project" disabled={locked} onSelect={move({ kind: "new" })} />
      </section>
      <p className="sheet-note">{locked ? "Wait for the run to finish before moving the thread." : "Existing file changes stay in the old checkout."}</p>
    </Sheet>
  );
}
