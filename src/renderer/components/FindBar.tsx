import { useEffect, useRef } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import type { FindView } from "../../application/workspace-state";
import { useFocusReturn } from "../focus";

export type FindBarProps = {
  find: FindView;
  /** What is being searched, as the bar says it: "thread", "page", "terminal", "review", or a panel's own name. */
  label: string;
  onQuery: (query: string) => void;
  onStep: (delta: -1 | 1) => void;
  onClose: () => void;
};

export function FindBar({ find, label, onQuery, onStep, onClose }: FindBarProps) {
  const input = useRef<HTMLInputElement>(null);
  useFocusReturn(input);

  /** Asking for find again means asking for the caret, whether or not the bar was already open. */
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [find.focus]);

  const searching = find.query.trim().length > 0;
  /** A view still reading has a total that is not final yet, so the bar says so rather than settling on it. */
  const count = searching ? `${find.matches ? find.index + 1 : 0}/${find.matches}${find.counting ? "+" : ""}` : "";

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
      <span className={`find-count ${searching && !find.matches && !find.counting ? "empty" : ""}`.trimEnd()} aria-live="polite">
        {searching && !find.matches ? (find.counting ? "Counting…" : "No matches") : count}
      </span>
      <button type="button" aria-label="Previous match" disabled={!find.matches} onClick={() => onStep(-1)}><ChevronUp size={15} /></button>
      <button type="button" aria-label="Next match" disabled={!find.matches} onClick={() => onStep(1)}><ChevronDown size={15} /></button>
      <button type="button" aria-label="Close find" onClick={onClose}><X size={15} /></button>
    </div>
  );
}
