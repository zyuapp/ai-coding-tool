import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import type { WorktreeSettingsView } from "../../application/worktree-settings";
import type { WorktreeCommand } from "../../contracts/commands";
import { useModalFocus } from "../focus";

export function WorktreeDeleteDialog({ worktree, dispatch }: { worktree: WorktreeSettingsView; dispatch: (command: WorktreeCommand) => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const consequence = useId();
  const warning = useId();
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
  const linked = worktree.threads.length;
  const returning = linked ? ` ${linked} linked ${linked === 1 ? "thread returns" : "threads return"} to the project folder.` : "";
  return createPortal(
    <div className="modal-scrim" role="dialog" aria-modal="true" aria-label={title} aria-describedby={`${consequence} ${warning}`} ref={dialog} tabIndex={-1} onPointerDown={(event) => {
      if (event.target === event.currentTarget) dispatch({ type: "worktree.confirm-delete", root: null });
    }}>
      <div className="modal-panel worktree-delete-dialog">
        <h2>{title}</h2>
        <div className="worktree-delete-target"><strong>{worktree.title}</strong><span>{worktree.project}</span><code>{worktree.root}</code></div>
        {!worktree.available && <p id={consequence}>The folder is already gone. Thread history stays.{returning}</p>}
        {worktree.available && worktree.repository && <>
          <p id={consequence}>The branch and thread history stay, and uncommitted changes are saved as a commit.{returning}</p>
          <p id={warning} className="worktree-delete-warning">Git-ignored files are deleted with the folder.</p>
        </>}
        {worktree.available && !worktree.repository && <>
          {returning && <p id={consequence}>{returning.trim()}</p>}
          <p id={warning} className="worktree-delete-warning">The repository is unavailable, so every file in the folder is permanently deleted.</p>
        </>}
        {worktree.busy && <p className="worktree-delete-warning" role="status">Wait for the active run to finish.</p>}
        <div className="worktree-delete-actions">
          <button ref={cancel} type="button" onClick={() => dispatch({ type: "worktree.confirm-delete", root: null })}>Cancel</button>
          <button className="danger" type="button" disabled={worktree.busy || worktree.deleting} aria-busy={worktree.deleting || undefined} onClick={() => dispatch({ type: "worktree.delete", root: worktree.root, missingOnly: !worktree.available })}>{worktree.deleting ? "Deleting…" : worktree.available ? "Delete worktree" : "Forget folder"}</button>
        </div>
      </div>
    </div>, document.body,
  );
}
