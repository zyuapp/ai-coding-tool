import { LuCheck as Check, LuCopy as Copy } from "react-icons/lu";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { copyText } from "../clipboard";

/** How long the tick stands in for the icon after a copy. */
const CONFIRM_MS = 1400;

/**
 * Copies text on click, then shows a tick. The button carries no text of its own: a search walks the
 * text nodes of a message, and a word here would be counted as part of the answer.
 */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);
  return (
    <button
      type="button"
      className={copied ? "copy-affordance copied" : "copy-affordance"}
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void (async () => {
          if (!await copyText(text)) return;
          setCopied(true);
          if (timer.current !== null) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), CONFIRM_MS);
        })();
      }}
    >
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
    </button>
  );
}

/** A block with its own copy button in the corner. Empty text draws the block alone. */
export function Copyable({ text, label, className, children }: { text: string; label: string; className?: string; children: ReactNode }) {
  return (
    <div className={className ? `copyable ${className}` : "copyable"}>
      {children}
      {text ? <CopyButton text={text} label={label} /> : null}
    </div>
  );
}
