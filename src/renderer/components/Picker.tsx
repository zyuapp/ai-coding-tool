import { LuCheck as Check, LuSearch as Search } from "react-icons/lu";
import type { ComponentProps, ReactNode } from "react";
import { moveListFocus } from "../focus";

/** The shared surface and keyboard navigation for compact pickers. Callers own placement and dismissal. */
export function PickerPopover({ className, ...props }: ComponentProps<"div">) {
  return <div className={`picker-popover ${className ?? ""}`.trimEnd()} data-popover-menu onKeyDown={moveListFocus} {...props} />;
}

export function PickerSearch({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="picker-search-field">
    <Search size={13} aria-hidden="true" />
    <input className="picker-search" aria-label={label} placeholder={label} autoFocus value={value} onInput={(event) => onChange(event.currentTarget.value)} />
  </label>;
}

type PickerOptionProps = Omit<ComponentProps<"button">, "role" | "aria-selected" | "aria-checked"> & {
  selected: boolean;
  role?: "option" | "menuitemradio";
  /** An action such as creating a branch can use the same column for its icon. */
  mark?: ReactNode;
};

/** Every row reserves the same leading mark column, including unselected options. */
export function PickerOption({ selected, role = "option", mark, className, children, ...props }: PickerOptionProps) {
  return <button
    type="button"
    role={role}
    aria-selected={role === "option" ? selected : undefined}
    aria-checked={role === "menuitemradio" ? selected : undefined}
    className={`picker-option ${className ?? ""}`.trimEnd()}
    {...props}
  >
    <span className="picker-mark" aria-hidden="true">{mark ?? (selected && <Check size={14} />)}</span>
    <span className="picker-label">{children}</span>
  </button>;
}
