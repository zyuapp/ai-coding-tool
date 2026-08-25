import type { ClipboardEvent, FocusEvent, FormEvent, KeyboardEvent } from "react";
import { pasteRidesAsPill } from "../../application/pastes";
import { isImageFile } from "../dropped-files";
import type { ComposerCaret } from "./composer-caret";
import type { ComposerMenus } from "./ComposerMenus";

/** The keys an open `/` or `@` menu takes for itself. Answers whether the menu took this one. */
function menuKeyDown(event: KeyboardEvent<HTMLTextAreaElement>, menus: ComposerMenus) {
  const { commandMenuOpen, threadMenuOpen, matchingCommands, matchingThreads, selectedCommand, selectedThread } = menus;
  if (threadMenuOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
    event.preventDefault();
    menus.setSelectedThread((current) => (current + (event.key === "ArrowDown" ? 1 : matchingThreads.length - 1)) % matchingThreads.length);
    return true;
  }
  if (threadMenuOpen && event.key === "Escape") {
    event.preventDefault();
    menus.dismiss();
    return true;
  }
  if (threadMenuOpen && matchingThreads[selectedThread] && (event.key === "Enter" || event.key === "Tab")) {
    event.preventDefault();
    menus.chooseThread(matchingThreads[selectedThread]);
    return true;
  }
  if (commandMenuOpen && matchingCommands.length > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
    event.preventDefault();
    menus.setSelectedCommand((current) => (current + (event.key === "ArrowDown" ? 1 : matchingCommands.length - 1)) % matchingCommands.length);
    return true;
  }
  if (commandMenuOpen && event.key === "Escape") {
    event.preventDefault();
    menus.dismiss();
    return true;
  }
  if (commandMenuOpen && matchingCommands[selectedCommand] && (event.key === "Enter" || event.key === "Tab")) {
    event.preventDefault();
    menus.chooseCommand(matchingCommands[selectedCommand]);
    return true;
  }
  return false;
}

export function composerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>, { menus, runActive, sending, stepRecall, submit }: {
  menus: ComposerMenus;
  runActive: boolean;
  sending: boolean;
  stepRecall: (step: -1 | 1) => boolean;
  submit: (steer?: boolean) => Promise<void>;
}) {
  if (menuKeyDown(event, menus)) return;
  if (!menus.commandMenuOpen && (event.key === "ArrowUp" || event.key === "ArrowDown") && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
    const { value, selectionStart, selectionEnd } = event.currentTarget;
    const atEdge = event.key === "ArrowUp"
      ? !value.slice(0, selectionStart).includes("\n")
      : !value.slice(selectionEnd).includes("\n");
    if (atEdge && stepRecall(event.key === "ArrowUp" ? -1 : 1)) {
      event.preventDefault();
      return;
    }
  }
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && runActive && !sending) {
    event.preventDefault();
    void submit(true);
    return;
  }
  if (event.key === "Enter" && !event.shiftKey && !sending) {
    event.preventDefault();
    void submit();
  }
}

export function composerPaste(event: ClipboardEvent<HTMLTextAreaElement>, { attachPasted, onFilesAdd, onPasteAdd }: {
  attachPasted: (files: File[]) => Promise<void>;
  onFilesAdd?: (files: File[]) => void;
  onPasteAdd?: (text: string) => void;
}) {
  const pasted = Array.from(event.clipboardData.files);
  const images = pasted.filter(isImageFile);
  const others = pasted.filter((file) => !isImageFile(file));
  if (images.length > 0) {
    event.preventDefault();
    void attachPasted(images);
  }
  if (others.length > 0 && onFilesAdd) {
    event.preventDefault();
    onFilesAdd(others);
  }
  if (pasted.length > 0) return;
  const text = event.clipboardData.getData("text/plain");
  if (!onPasteAdd || !pasteRidesAsPill(text)) return;
  event.preventDefault();
  onPasteAdd(text);
}

export function composerInput(event: FormEvent<HTMLTextAreaElement>, caret: ComposerCaret, onPromptChange: (prompt: string) => void) {
  const { value, selectionStart } = event.currentTarget;
  const inputType = (event.nativeEvent as InputEvent).inputType;
  onPromptChange(value);
  caret.setCaret(selectionStart);
  /** Pasted text is not typing, so a `/` it carries must not open the menu. */
  caret.setDismissedPrompt(inputType === "insertFromPaste" || inputType === "insertFromDrop" ? value : null);
}

/** Focus leaving the prompt for anywhere but its own menus closes them. */
export function composerBlur(event: FocusEvent<HTMLTextAreaElement>, menus: ComposerMenus, caret: ComposerCaret) {
  const open = [menus.commandMenuRef.current, menus.threadMenuRef.current];
  if (!open.some((menu) => menu?.contains(event.relatedTarget as Node))) caret.setInputFocused(false);
}
