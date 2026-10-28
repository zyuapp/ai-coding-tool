import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import type { ArchivePromptView } from "../../application/workspace-state";
import type { AppCommand } from "../../contracts/commands";
import { archiveConsequence, archiveQuestion } from "../../domain/thread-retention";
import { useModalFocus } from "../focus";

/** The question asked before the user archives a thread. Cancel holds the focus, as before any destructive answer. */
export function ArchiveDialog({ prompt, dispatch }: { prompt: ArchivePromptView; dispatch: (command: AppCommand) => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const consequence = useId();
  useModalFocus(dialog);
  useEffect(() => { cancel.current?.focus(); }, []);
  useEffect(() => {
    function close(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      dispatch({ type: "view.archive-prompt", threadId: null });
    }
    document.addEventListener("keydown", close, true);
    return () => document.removeEventListener("keydown", close, true);
  }, [dispatch]);
  const title = archiveQuestion(prompt.title);
  return createPortal(
    <div className="modal-scrim" role="dialog" aria-modal="true" aria-label={title} aria-describedby={consequence} ref={dialog} tabIndex={-1} onPointerDown={(event) => {
      if (event.target === event.currentTarget) dispatch({ type: "view.archive-prompt", threadId: null });
    }}>
      <div className="modal-panel archive-dialog">
        <h2>{title}</h2>
        <p id={consequence}>{archiveConsequence(prompt.running)}</p>
        <div className="worktree-delete-actions">
          <button ref={cancel} type="button" onClick={() => dispatch({ type: "view.archive-prompt", threadId: null })}>Cancel</button>
          <button className="danger" type="button" onClick={() => dispatch({ type: "view.archive-confirm" })}>Archive</button>
        </div>
      </div>
    </div>, document.body,
  );
}
