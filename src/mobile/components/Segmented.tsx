import type { KeyboardEvent, ReactNode } from "react";

type Segment<T extends string> = { value: T; label: ReactNode };

/** A radiogroup of segments. Only the checked one is a Tab stop; the arrow keys move the choice. */
export function Segmented<T extends string>({ label, segments, value, onChange }: {
  label: string;
  segments: readonly Segment<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const at = segments.findIndex((segment) => segment.value === value);
    const next = (at + step + segments.length) % segments.length;
    onChange(segments[next]!.value);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  }
  return (
    <div className="segmented" role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
      {segments.map((segment) => (
        <button key={segment.value} type="button" role="radio" aria-checked={segment.value === value} tabIndex={segment.value === value ? 0 : -1} onClick={() => onChange(segment.value)}>{segment.label}</button>
      ))}
    </div>
  );
}
