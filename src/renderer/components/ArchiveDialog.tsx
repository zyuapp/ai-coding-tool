import { useId, useRef } from "react";
import type { ArchivePromptView } from "../../application/workspace-state";
import type { AppCommand } from "../../contracts/commands";
import { archiveConsequence, archiveQuestion } from "../../domain/thread-retention";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";

/** The question asked before the user archives a thread. Cancel holds the focus, as before any destructive answer. */
export function ArchiveDialog({ prompt, dispatch }: { prompt: ArchivePromptView; dispatch: (command: AppCommand) => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  const consequence = useId();
  const close = () => dispatch({ type: "view.archive-prompt", threadId: null });
  return (
    <Dialog
      title={archiveQuestion(prompt.title)}
      className="archive-dialog"
      onClose={close}
      initialFocus={cancel}
      aria-describedby={consequence}
      actions={<>
        <Button ref={cancel} size="lg" onClick={close}>Cancel</Button>
        <Button variant="danger" size="lg" onClick={() => dispatch({ type: "view.archive-confirm" })}>Archive</Button>
      </>}
    >
      <p id={consequence}>{archiveConsequence(prompt.running)}</p>
    </Dialog>
  );
}
