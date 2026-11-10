import { useRef, useState } from "react";
import type { ForkName } from "../../application/workspace-state";
import { TITLE_LIMIT } from "../../domain/thread";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { TextField } from "../ui/Field";

export type ForkNameDialogProps = {
  fork: ForkName;
  onConfirm: (title: string) => void;
  onClose: () => void;
};

/** Names a fork before it is made. The suggested name is selected, so Enter takes it and typing replaces it. */
export function ForkNameDialog({ fork, onConfirm, onClose }: ForkNameDialogProps) {
  const field = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(fork.title);
  const named = title.trim();

  return (
    <Dialog
      as="form"
      title={fork.worktree ? "Fork into a new worktree" : "Fork thread"}
      onClose={onClose}
      onSubmit={() => { if (named) onConfirm(named); }}
      initialFocus={field}
      actions={<>
        <Button size="lg" onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" size="lg" disabled={!named}>Fork</Button>
      </>}
    >
      <TextField
        ref={field}
        label="Name"
        value={title}
        maxLength={TITLE_LIMIT}
        spellCheck={false}
        onChange={(event) => setTitle(event.target.value)}
      />
    </Dialog>
  );
}
