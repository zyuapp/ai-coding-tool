import { LuCheck as Check, LuCopy as Copy, LuX as X } from "react-icons/lu";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { copyText } from "../clipboard";

/** How long the result stands in for the icon after a copy. */
const CONFIRM_MS = 1400;

/**
 * Copies text on click, then shows a tick, or a cross when the clipboard refused it. The button
 * carries no text of its own: a search walks the text nodes of a message, and a word here would be
 * counted as part of the answer.
 */
export function CopyButton({ text, label, className = "copy-affordance" }: { text: string; label: string; className?: string }) {
  const [result, setResult] = useState<"copied" | "failed" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);
  const Icon = result === "copied" ? Check : result === "failed" ? X : Copy;
  return (
    <button
      type="button"
      className={result ? `${className} ${result}` : className}
      aria-label={result === "failed" ? "Copy failed" : result === "copied" ? "Copied" : label}
      data-tip={result === "failed" ? "Copy failed" : result === "copied" ? "Copied" : label}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void (async () => {
          const copied = await copyText(text);
          setResult(copied ? "copied" : "failed");
          if (timer.current !== null) clearTimeout(timer.current);
          timer.current = setTimeout(() => setResult(null), CONFIRM_MS);
        })();
      }}
    >
      <Icon size={14} aria-hidden="true" />
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
