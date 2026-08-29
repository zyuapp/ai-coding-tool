import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LuFolderOpen as FolderOpen } from "react-icons/lu";
import type { ProjectEditorView } from "../../application/workspace-state";
import { folderName } from "../../domain/project";
import { useModalFocus } from "../focus";

export type ProjectEditDialogProps = {
  editor: ProjectEditorView;
  onSave: (edit: { name: string | null; root: string }) => void;
  onClose: () => void;
};

export function ProjectEditDialog({ editor, onSave, onClose }: ProjectEditDialogProps) {
  const { project, checkouts, saving, error } = editor;
  const dialog = useRef<HTMLDivElement>(null);
  const [name, setName] = useState(project.name ?? "");
  const [root, setRoot] = useState(project.root);
  useModalFocus(dialog);

  /** Escape closes the editor rather than reaching the window, which would answer it by stopping a run. */
  useEffect(() => {
    function close(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    }
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [onClose]);

  const trimmedRoot = root.trim();
  const unchanged = trimmedRoot === project.root && name.trim() === (project.name ?? "");

  function save() {
    if (!trimmedRoot || saving || unchanged) return;
    onSave({ name: name.trim() || null, root: trimmedRoot });
  }

  return createPortal(
    <div
      className="modal-scrim"
      role="dialog"
      aria-modal="true"
      aria-label={`Edit ${project.name ?? folderName(project.root)}`}
      ref={dialog}
      tabIndex={-1}
      onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <form
        className="modal-panel project-edit-panel"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <h2>Edit project</h2>
        <label className="project-edit-field">
          <span>Name</span>
          <input
            value={name}
            placeholder={folderName(trimmedRoot || project.root)}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="project-edit-field">
          <span>Folder</span>
          <div className="project-edit-path">
            <input value={root} spellCheck={false} onChange={(event) => setRoot(event.target.value)} />
            {/** The picker only fills the field; nothing moves until the folder is saved. */}
            <button type="button" onClick={() => void window.desktop.openFolder().then((chosen) => { if (chosen) setRoot(chosen.root); })}>
              <FolderOpen size={14} aria-hidden="true" />Choose…
            </button>
          </div>
        </label>
        {error && <p className="project-edit-error" role="alert">{error}</p>}
        {!error && checkouts > 0 && trimmedRoot !== project.root && (
          <p className="project-edit-note">
            {checkouts === 1 ? "1 worktree stays" : `${checkouts} worktrees stay`} where they are: they are checkouts of the folder this project is leaving.
          </p>
        )}
        <div className="project-edit-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={!trimmedRoot || saving || unchanged}>{saving ? "Opening…" : "Save"}</button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
