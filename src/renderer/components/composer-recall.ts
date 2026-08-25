import { useEffect, useState } from "react";
import type { QueuedMessage } from "../../application/workspace-state";
import type { Annotation as TaskAnnotation, AttachedFile, PastedText, RecalledMessage, StagedImage } from "../../domain/task";
import type { ComposerCaret } from "./composer-caret";

function carries(message: RecalledMessage) {
  return message.text.trim() !== "" || message.annotations.length > 0 || message.pastes.length > 0
    || message.files.length > 0 || message.attachments.length > 0;
}

/** Stepping ↑/↓ through the sent history; the live draft is stashed and comes back below the newest. */
export function useComposerRecall({ prompt, annotations, pastes, files, images, history, queuedMessages, caret, onPromptChange, onAnnotationRecall, onPasteRecall, onFileRecall, onImageRecall }: {
  prompt: string;
  annotations: TaskAnnotation[];
  pastes: PastedText[];
  files: AttachedFile[];
  images: StagedImage[];
  history: RecalledMessage[];
  queuedMessages: QueuedMessage[];
  caret: ComposerCaret;
  onPromptChange: (prompt: string) => void;
  onAnnotationRecall?: (annotations: TaskAnnotation[]) => void;
  onPasteRecall?: (pastes: PastedText[]) => void;
  onFileRecall?: (files: AttachedFile[]) => void;
  onImageRecall?: (paths: string[]) => void;
}) {
  /** Where ↑/↓ sits in the sent history, with the draft it replaced and the text it put on screen. */
  const [recall, setRecall] = useState<{ index: number; draft: RecalledMessage; shown: string } | null>(null);

  const sent = [...history, ...queuedMessages.map((message) => ({ text: message.text, annotations: message.annotations ?? [], pastes: message.pastes ?? [], files: message.files ?? [], attachments: message.attachments }))];
  /** A send is worth offering back when it carried anything. Only a repeated text collapses into one. */
  const recallable = sent.filter((message, index) => carries(message)
    && !(message.text !== "" && message.text === sent[index - 1]?.text));

  /** Typing, sending, or switching drafts all change the prompt out from under a recall, ending it. */
  useEffect(() => {
    if (recall && prompt !== recall.shown) setRecall(null);
  }, [prompt, recall]);

  return function stepRecall(step: -1 | 1) {
    /** A recall starts from an empty composer only, so an arrow key in a draft stays a caret move. */
    if (recall === null && (step === 1 || prompt !== "")) return false;
    const index = (recall?.index ?? recallable.length) + step;
    if (index < 0) return false;
    const draft = recall?.draft ?? { text: prompt, annotations, pastes, files, attachments: images.map((image) => image.path) };
    const next = index >= recallable.length ? draft : recallable[index];
    setRecall(index >= recallable.length ? null : { index, draft, shown: next.text });
    onPromptChange(next.text);
    onAnnotationRecall?.(next.annotations);
    onPasteRecall?.(next.pastes); onFileRecall?.(next.files); onImageRecall?.(next.attachments);
    caret.setDismissedPrompt(next.text);
    caret.moveCaret(next.text.length);
    return true;
  };
}
