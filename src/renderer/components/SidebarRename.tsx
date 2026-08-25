import { useRef, useState } from "react";
import { useDismissibleLayer } from "../focus";

/** Which row of a list is being renamed, the input over it, and the row focus goes back to. */
export function useRenaming(onCommit: (id: string, value: string) => void) {
  const [editing, setEditing] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const row = useRef<HTMLElement>(null);
  useDismissibleLayer(editing !== null, [input], () => input.current?.blur(), row);
  return {
    editing,
    input,
    row,
    start: (id: string, element?: HTMLElement | null) => {
      if (element) row.current = element;
      setEditing(id);
    },
    cancel: () => setEditing(null),
    commit: (id: string, value: string) => {
      setEditing(null);
      onCommit(id, value);
    },
  };
}

export type Renaming = ReturnType<typeof useRenaming>;

/**
 * A name being typed in place, over the row it belongs to. Enter and blur keep what was typed and
 * Escape leaves it, so both lists rename the same way.
 */
export function RenameInput({ inputRef, className, label, value, placeholder, onCommit, onCancel }: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  className: string;
  label: string;
  value: string;
  placeholder?: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  return (
    <input
      ref={inputRef}
      className={className}
      aria-label={label}
      autoFocus
      defaultValue={value}
      placeholder={placeholder}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      /** The row answers Enter itself and dragging claims the arrow and space keys. */
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") onCommit(event.currentTarget.value);
        else if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
      onBlur={(event) => onCommit(event.currentTarget.value)}
    />
  );
}
