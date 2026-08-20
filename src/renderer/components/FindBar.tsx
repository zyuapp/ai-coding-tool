import { useEffect, useRef } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import type { FindView } from "../../application/workspace-state";

export type FindBarProps = {
  find: FindView;
  /** What is being searched, as the bar says it: "transcript", "page", "terminal". */
  label: string;
  onQuery: (query: string) => void;
  onStep: (delta: -1 | 1) => void;
  onClose: () => void;
};

export function FindBar({ find, label, onQuery, onStep, onClose }: FindBarProps) {
  const input = useRef<HTMLInputElement>(null);

  /** Asking for find again means asking for the caret, whether or not the bar was already open. */
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [find.focus]);

  const searching = find.query.trim().length > 0;
  const count = searching ? `${find.matches ? find.index + 1 : 0}/${find.matches}` : "";

  return (
    <div className="find-bar" role="search">
      <Search size={14} aria-hidden="true" />
      <input
        ref={input}
        value={find.query}
        aria-label={`Find in ${label}`}
        placeholder={`Find in ${label}`}
        spellCheck={false}
        onInput={(event) => onQuery(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
          else if (event.key === "Enter") onStep(event.shiftKey ? -1 : 1);
          else return;
          event.preventDefault();
        }}
      />
      <span className={`find-count ${searching && !find.matches ? "empty" : ""}`.trimEnd()} aria-live="polite">
        {searching && !find.matches ? "No matches" : count}
      </span>
      <button type="button" aria-label="Previous match" disabled={!find.matches} onClick={() => onStep(-1)}><ChevronUp size={15} /></button>
      <button type="button" aria-label="Next match" disabled={!find.matches} onClick={() => onStep(1)}><ChevronDown size={15} /></button>
      <button type="button" aria-label="Close find" onClick={onClose}><X size={15} /></button>
    </div>
  );
}
