import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { WorktreeSettingsView } from "../../application/worktree-settings";
import type { WorktreeCommand } from "../../contracts/commands";
import { useModalFocus } from "../focus";

export function WorktreeDeleteDialog({ worktree, dispatch }: { worktree: WorktreeSettingsView; dispatch: (command: WorktreeCommand) => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useModalFocus(dialog);
  useEffect(() => { cancel.current?.focus(); }, []);
  useEffect(() => {
    function close(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      dispatch({ type: "worktree.confirm-delete", root: null });
    }
    document.addEventListener("keydown", close, true);
    return () => document.removeEventListener("keydown", close, true);
  }, [dispatch]);
  const title = worktree.available ? "Delete worktree?" : "Forget missing folder?";
  return createPortal(
    <div className="modal-scrim" role="dialog" aria-modal="true" aria-label={title} ref={dialog} tabIndex={-1} onPointerDown={(event) => {
      if (event.target === event.currentTarget) dispatch({ type: "worktree.confirm-delete", root: null });
    }}>
      <div className="modal-panel worktree-delete-dialog">
        <h2>{title}</h2>
        <div className="worktree-delete-target"><strong>{worktree.title}</strong><span>{worktree.project}</span><code>{worktree.root}</code></div>
        {!worktree.available && <>
          <p>The folder is already gone. This removes it from the worktree list.</p>
          <p>Your thread history stays. Linked threads will use the project folder when you continue them.</p>
        </>}
        {worktree.available && <>
          <p>This deletes the worktree folder. Your branch and thread history stay, and linked threads return to the project folder.</p>
          {worktree.repository
            ? <><p>Uncommitted changes are saved as a Git commit before deletion. Recovery details appear here and in linked threads.</p><p>Git-ignored files are deleted with the folder.</p></>
            : <p className="worktree-delete-warning">Git cannot preserve this folder’s contents because its repository is unavailable. Its files will be permanently deleted.</p>}
        </>}
        {worktree.busy && <p className="worktree-delete-warning" role="status">Wait for the active run to finish before deleting this worktree.</p>}
        <div className="worktree-delete-actions">
          <button ref={cancel} type="button" onClick={() => dispatch({ type: "worktree.confirm-delete", root: null })}>Cancel</button>
          <button className="danger" type="button" disabled={worktree.busy || worktree.deleting} onClick={() => dispatch({ type: "worktree.delete", root: worktree.root, missingOnly: !worktree.available })}>{worktree.available ? "Delete worktree" : "Forget folder"}</button>
        </div>
      </div>
    </div>, document.body,
  );
}
