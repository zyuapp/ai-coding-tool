import { useId, useRef } from "react";
import { LuFolderSymlink as FolderSymlink, LuHouse as House, LuMoveRight as MoveRight } from "react-icons/lu";
import type { WorktreeMoveView } from "../../application/workspace-state";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";

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
  const confirm = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const explanation = useId();
  const [from, to] = move.worktree
    ? [{ label: "Local", Icon: House }, { label: "Worktree", Icon: FolderSymlink }]
    : [{ label: "Worktree", Icon: FolderSymlink }, { label: "Local", Icon: House }];

  return (
    <Dialog
      title={move.worktree ? "Give this thread a worktree?" : "Return this thread to your project checkout?"}
      className="worktree-move"
      onClose={onClose}
      /** Enter takes a move that costs nothing; returning commits changes and can remove the worktree, so Cancel holds the focus. */
      initialFocus={move.worktree ? confirm : cancel}
      aria-describedby={explanation}
      media={
        <div className="worktree-move-places" aria-hidden="true">
          <div className="worktree-move-place">
            <span className="worktree-move-disc raised"><from.Icon size={20} /></span>
            <em>{from.label}</em>
          </div>
          <span className="worktree-move-arrow"><MoveRight size={22} /></span>
          <div className="worktree-move-place target">
            <span className="worktree-move-disc raised"><to.Icon size={20} /></span>
            <em>{to.label}</em>
          </div>
        </div>
      }
      actions={<>
        <Button ref={cancel} size="lg" onClick={onClose}>Cancel</Button>
        <Button ref={confirm} variant="primary" size="lg" onClick={onConfirm}>{move.worktree ? "Move to worktree" : "Return to local"}</Button>
      </>}
    >
      <p id={explanation}>{explain(move)}</p>
    </Dialog>
  );
}
