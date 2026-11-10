import { useId, useRef } from "react";
import type { WorktreeSettingsView } from "../../application/worktree-settings";
import type { WorktreeCommand } from "../../contracts/commands";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";

export function WorktreeDeleteDialog({ worktree, dispatch }: { worktree: WorktreeSettingsView; dispatch: (command: WorktreeCommand) => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  const consequence = useId();
  const warning = useId();
  const close = () => dispatch({ type: "worktree.confirm-delete", root: null });
  const linked = worktree.threads.length;
  const returning = linked ? ` ${linked} linked ${linked === 1 ? "thread returns" : "threads return"} to the project folder.` : "";
  return (
    <Dialog
      title={worktree.available ? "Delete worktree?" : "Forget missing folder?"}
      className="worktree-delete-dialog"
      onClose={close}
      initialFocus={cancel}
      aria-describedby={`${consequence} ${warning}`}
      actions={<>
        <Button ref={cancel} size="lg" onClick={close}>Cancel</Button>
        <Button variant="danger" size="lg" disabled={worktree.busy || worktree.deleting} busy={worktree.deleting} onClick={() => dispatch({ type: "worktree.delete", root: worktree.root, missingOnly: !worktree.available })}>{worktree.deleting ? "Deleting…" : worktree.available ? "Delete worktree" : "Forget folder"}</Button>
      </>}
    >
      <div className="worktree-delete-target raised"><strong>{worktree.title}</strong><span>{worktree.project}</span><code>{worktree.root}</code></div>
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
    </Dialog>
  );
}

export function WorktreeBulkDeleteDialog({ worktrees, dispatch }: { worktrees: WorktreeSettingsView[]; dispatch: (command: WorktreeCommand) => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  const consequence = useId();
  const warning = useId();
  const close = () => dispatch({ type: "worktree.confirm-delete-safe", open: false });
  const count = worktrees.length;
  const noun = count === 1 ? "worktree" : "worktrees";
  const linked = worktrees.reduce((total, worktree) => total + worktree.threads.length, 0);
  const returning = linked ? ` ${linked} linked ${linked === 1 ? "thread returns" : "threads return"} to ${count === 1 ? "its" : "their"} project folder.` : "";
  return (
    <Dialog
      title={`Delete ${count} safe ${noun}?`}
      className="worktree-delete-dialog"
      onClose={close}
      initialFocus={cancel}
      aria-describedby={`${consequence} ${warning}`}
      actions={<>
        <Button ref={cancel} size="lg" onClick={close}>Cancel</Button>
        <Button variant="danger" size="lg" onClick={() => dispatch({ type: "worktree.delete-safe", roots: worktrees.map((worktree) => worktree.root) })}>Delete {count} {noun}</Button>
      </>}
    >
      <p id={consequence}>No uncommitted changes, and every commit is on the default branch. Branches and thread history stay.{returning}</p>
      <ul className="worktree-bulk-list raised">
        {worktrees.map((worktree) => <li key={worktree.root}>
          <strong>{worktree.title}</strong>
          <span>{worktree.project}{worktree.threads.length ? ` · ${worktree.threads.length} ${worktree.threads.length === 1 ? "thread" : "threads"}` : ""}</span>
        </li>)}
      </ul>
      <p id={warning} className="worktree-delete-warning">Git-ignored files are deleted with the folders.</p>
    </Dialog>
  );
}
