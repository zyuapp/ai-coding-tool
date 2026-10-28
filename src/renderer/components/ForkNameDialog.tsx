import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ForkName } from "../../application/workspace-state";
import { TITLE_LIMIT } from "../../domain/thread";
import { useModalFocus } from "../focus";

export type ForkNameDialogProps = {
  fork: ForkName;
  onConfirm: (title: string) => void;
  onClose: () => void;
};

/** Names a fork before it is made. The suggested name is selected, so Enter takes it and typing replaces it. */
export function ForkNameDialog({ fork, onConfirm, onClose }: ForkNameDialogProps) {
  const dialog = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(fork.title);
  useModalFocus(dialog);

  useEffect(() => { field.current?.select(); }, []);

  /** Escape closes the dialog rather than reaching the window, which would answer it by stopping a run. */
  useEffect(() => {
    function close(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    }
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [onClose]);

  const named = title.trim();
  const heading = fork.worktree ? "Fork into a new worktree" : "Fork thread";

  return createPortal(
    <div
      className="modal-scrim"
      role="dialog"
      aria-modal="true"
      aria-label={heading}
      ref={dialog}
      tabIndex={-1}
      onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <form
        className="modal-panel project-edit-panel"
        onSubmit={(event) => {
          event.preventDefault();
          if (named) onConfirm(named);
        }}
      >
        <h2>{heading}</h2>
        <label className="project-edit-field">
          <span>Name</span>
          <input
            ref={field}
            value={title}
            maxLength={TITLE_LIMIT}
            spellCheck={false}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <div className="project-edit-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={!named}>Fork</button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
