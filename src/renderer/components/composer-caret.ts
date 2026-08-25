import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";

export type ComposerCaret = {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  caret: number;
  setCaret: Dispatch<SetStateAction<number>>;
  /** Takes the caret and puts it at this offset, once the prompt the offset belongs to is on screen. */
  moveCaret: (offset: number) => void;
  inputFocused: boolean;
  setInputFocused: Dispatch<SetStateAction<boolean>>;
  /** The prompt whose menus were dismissed, so typing on brings them back. */
  dismissedPrompt: string | null;
  setDismissedPrompt: Dispatch<SetStateAction<string | null>>;
};

/** The caret, the focus, and the dismissals that every part of the composer reads. */
export function useComposerCaret(focusToken: number): ComposerCaret {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [inputFocused, setInputFocused] = useState(false);
  const [caret, setCaret] = useState(0);
  const [pendingCaret, setPendingCaret] = useState<number | null>(null);
  const [dismissedPrompt, setDismissedPrompt] = useState<string | null>(null);

  useEffect(() => {
    if (focusToken) textareaRef.current?.focus({ preventScroll: true });
  }, [focusToken]);

  useLayoutEffect(() => {
    if (pendingCaret === null) return;
    textareaRef.current?.focus();
    textareaRef.current?.setSelectionRange(pendingCaret, pendingCaret);
    setCaret(pendingCaret);
    setPendingCaret(null);
  }, [pendingCaret]);

  return { textareaRef, caret, setCaret, moveCaret: setPendingCaret, inputFocused, setInputFocused, dismissedPrompt, setDismissedPrompt };
}
