import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import type { WorktreeSettingsView } from "../../application/worktree-settings";
import type { WorktreeCommand } from "../../contracts/commands";
import { useModalFocus } from "../focus";

/** Focuses Cancel, traps focus, and closes on Escape. */
function useConfirmation(close: () => void) {
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useModalFocus(dialog);
  useEffect(() => { cancel.current?.focus(); }, []);
  useEffect(() => {
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    }
    document.addEventListener("keydown", escape, true);
    return () => document.removeEventListener("keydown", escape, true);
  }, [close]);
  return { dialog, cancel };
}

export function WorktreeDeleteDialog({ worktree, dispatch }: { worktree: WorktreeSettingsView; dispatch: (command: WorktreeCommand) => void }) {
  const { dialog, cancel } = useConfirmation(() => dispatch({ type: "worktree.confirm-delete", root: null }));
  const consequence = useId();
  const warning = useId();
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

export function WorktreeBulkDeleteDialog({ worktrees, dispatch }: { worktrees: WorktreeSettingsView[]; dispatch: (command: WorktreeCommand) => void }) {
  const close = () => dispatch({ type: "worktree.confirm-delete-safe", open: false });
  const { dialog, cancel } = useConfirmation(close);
  const consequence = useId();
  const warning = useId();
  const count = worktrees.length;
  const noun = count === 1 ? "worktree" : "worktrees";
  const title = `Delete ${count} safe ${noun}?`;
  const linked = worktrees.reduce((total, worktree) => total + worktree.threads.length, 0);
  const returning = linked ? ` ${linked} linked ${linked === 1 ? "thread returns" : "threads return"} to ${count === 1 ? "its" : "their"} project folder.` : "";
  return createPortal(
    <div className="modal-scrim" role="dialog" aria-modal="true" aria-label={title} aria-describedby={`${consequence} ${warning}`} ref={dialog} tabIndex={-1} onPointerDown={(event) => {
      if (event.target === event.currentTarget) close();
    }}>
      <div className="modal-panel worktree-delete-dialog">
        <h2>{title}</h2>
        <p id={consequence}>No uncommitted changes, and every commit is on the default branch. Branches and thread history stay.{returning}</p>
        <ul className="worktree-bulk-list">
          {worktrees.map((worktree) => <li key={worktree.root}>
            <strong>{worktree.title}</strong>
            <span>{worktree.project}{worktree.threads.length ? ` · ${worktree.threads.length} ${worktree.threads.length === 1 ? "thread" : "threads"}` : ""}</span>
          </li>)}
        </ul>
        <p id={warning} className="worktree-delete-warning">Git-ignored files are deleted with the folders.</p>
        <div className="worktree-delete-actions">
          <button ref={cancel} type="button" onClick={close}>Cancel</button>
          <button className="danger" type="button" onClick={() => dispatch({ type: "worktree.delete-safe", roots: worktrees.map((worktree) => worktree.root) })}>Delete {count} {noun}</button>
        </div>
      </div>
    </div>, document.body,
  );
}
