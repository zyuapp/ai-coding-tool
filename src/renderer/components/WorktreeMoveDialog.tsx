import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { LuFolderSymlink as FolderSymlink, LuHouse as House, LuMoveRight as MoveRight } from "react-icons/lu";
import type { WorktreeMoveView } from "../../application/workspace-state";
import { useModalFocus } from "../focus";

export type WorktreeMoveDialogProps = {
  move: WorktreeMoveView;
  onConfirm: () => void;
  onClose: () => void;
};

/** What the move costs, said in the one sentence the thread would otherwise have to be told after. */
function explain({ worktree, changes, others }: WorktreeMoveView) {
  if (worktree) return "It moves into a checkout of its own and works there from now on.";
  const held = `Its ${changes} uncommitted ${changes === 1 ? "change is" : "changes are"} committed first so nothing is lost`;
  return others > 0
    ? `${held}, then the worktree stays for the ${others === 1 ? "thread" : "threads"} still in it.`
    : `${held}, then the worktree is removed.`;
}

/** The question the thread menu asks before a move: where it goes, what it costs, and two answers. */
export function WorktreeMoveDialog({ move, onConfirm, onClose }: WorktreeMoveDialogProps) {
  const dialog = useRef<HTMLDivElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  useModalFocus(dialog);

  /** Confirm holds the focus, so Enter answers the question the dialog came to ask. */
  useEffect(() => { confirm.current?.focus(); }, []);

  /** Escape closes the question rather than reaching the window, which would answer it by stopping a run. */
  useEffect(() => {
    function close(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    }
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [onClose]);

  const title = move.worktree ? "Give this thread a worktree?" : "Return this thread to your project checkout?";
  const [from, to] = move.worktree
    ? [{ label: "Local", Icon: House }, { label: "Worktree", Icon: FolderSymlink }]
    : [{ label: "Worktree", Icon: FolderSymlink }, { label: "Local", Icon: House }];

  return createPortal(
    <div
      className="modal-scrim"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      ref={dialog}
      tabIndex={-1}
      onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="modal-panel worktree-move">
        <div className="worktree-move-places" aria-hidden="true">
          <div className="worktree-move-place">
            <span className="worktree-move-disc"><from.Icon size={20} /></span>
            <em>{from.label}</em>
          </div>
          <span className="worktree-move-arrow"><MoveRight size={22} /></span>
          <div className="worktree-move-place target">
            <span className="worktree-move-disc"><to.Icon size={20} /></span>
            <em>{to.label}</em>
          </div>
        </div>
        <div className="worktree-move-copy">
          <h2>{title}</h2>
          <p>{explain(move)}</p>
        </div>
        <div className="worktree-move-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button ref={confirm} type="button" className="primary" onClick={onConfirm}>Confirm</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
