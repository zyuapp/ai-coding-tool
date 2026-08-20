/** The quiet line under a shortened list that opens the rest of it. */
export function ShowMore({ label, expanded, onSelect }: { label: string; expanded?: boolean; onSelect: () => void }) {
  return (
    <button
      className="show-more"
      type="button"
      onClick={onSelect}
      {...(expanded === undefined ? {} : { "aria-expanded": expanded })}
    >{label}</button>
  );
}
