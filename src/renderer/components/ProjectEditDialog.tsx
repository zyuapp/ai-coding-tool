import { useId, useRef, useState } from "react";
import { LuFolderOpen as FolderOpen } from "react-icons/lu";
import type { ProjectEditorView } from "../../application/workspace-state";
import { folderName } from "../../domain/project";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { FieldGroup, TextField } from "../ui/Field";

export function ChooseFolderButton({ disabled, onClick }: { disabled?: boolean; onClick: () => void }) {
  return <Button icon={<FolderOpen size={14} aria-hidden="true" />} disabled={disabled} onClick={onClick}>Choose folder…</Button>;
}

export type ProjectEditDialogProps = {
  editor: ProjectEditorView;
  onSave: (edit: { name: string | null; root: string }) => void;
  onClose: () => void;
};

export function ProjectEditDialog({ editor, onSave, onClose }: ProjectEditDialogProps) {
  const { project, checkouts, saving, error } = editor;
  const nameField = useRef<HTMLInputElement>(null);
  const folderId = useId();
  const [name, setName] = useState(project.name ?? "");
  const [root, setRoot] = useState(project.root);
  const [pickError, setPickError] = useState<string | null>(null);

  const trimmedRoot = root.trim();
  const unchanged = trimmedRoot === project.root && name.trim() === (project.name ?? "");
  const problem = error || pickError;

  function save() {
    if (!trimmedRoot || saving) return;
    if (unchanged) return onClose();
    onSave({ name: name.trim() || null, root: trimmedRoot });
  }

  return (
    <Dialog
      as="form"
      label={`Edit ${project.name ?? folderName(project.root)}`}
      title="Edit project"
      onClose={onClose}
      onSubmit={save}
      initialFocus={nameField}
      aria-busy={saving}
      actions={<>
        <Button size="lg" onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" size="lg" disabled={!trimmedRoot || saving}>{saving ? "Saving…" : "Save"}</Button>
      </>}
    >
      <TextField
        ref={nameField}
        label="Name"
        value={name}
        placeholder={folderName(trimmedRoot || project.root)}
        readOnly={saving}
        onChange={(event) => setName(event.target.value)}
      />
      <FieldGroup label="Folder" htmlFor={folderId} error={problem} announce
        hint={!problem && checkouts > 0 && trimmedRoot !== project.root
          && `${checkouts === 1 ? "1 worktree stays" : `${checkouts} worktrees stay`} where they are: they are checkouts of the folder this project is leaving.`}>
        <div className="project-edit-path">
          <TextField id={folderId} value={root} spellCheck={false} readOnly={saving} onChange={(event) => { setRoot(event.target.value); setPickError(null); }} />
          {/** The picker only fills the field; nothing moves until the folder is saved. */}
          <ChooseFolderButton disabled={saving} onClick={() => {
            setPickError(null);
            window.desktop.openFolder().then(
              (chosen) => { if (chosen) setRoot(chosen.root); },
              (reason: unknown) => setPickError(reason instanceof Error ? reason.message : "Couldn't open the folder picker."),
            );
          }} />
        </div>
      </FieldGroup>
    </Dialog>
  );
}
