import { LuCheck as Check, LuChevronDown as ChevronDown, LuSearch as Search, LuX as Clear } from "react-icons/lu";
import { useId, type ComponentPropsWithRef, type ReactNode } from "react";
import { IconButton } from "./Button";
import "./field.css";

const joined = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(" ") || undefined;

export type SearchFieldProps = ComponentPropsWithRef<"input"> & {
  /** The field's accessible name, and its placeholder unless one is given. */
  label: string;
  /** `field` sits on a page, `menu` heads a menu or picker, `palette` is the whole head of a command palette. */
  variant?: "field" | "menu" | "palette";
  /** Draws a clear button while the field holds text, in place of the native one. */
  onClear?: () => void;
  /** The clear button's tooltip; it has none unless given. */
  clearTip?: string;
  wrapClassName?: string;
};

/** A search box: a magnifier, the input, and an optional clear button. Clicking anywhere but the clear button focuses the input. */
export function SearchField({ label, variant = "field", onClear, clearTip, wrapClassName, type = "search", placeholder = label, ...input }: SearchFieldProps) {
  const filled = onClear !== undefined && input.value !== undefined && String(input.value) !== "";
  return (
    <div className={joined("search-field", wrapClassName)} data-variant={variant} data-clearable={onClear ? "" : undefined}>
      <label className="search-field-box">
        <Search size={variant === "palette" ? 16 : 14} aria-hidden="true" />
        <input type={type} aria-label={label} placeholder={placeholder} {...input} />
      </label>
      {filled && <IconButton className="search-field-clear" label="Clear search" tip={clearTip ?? false} size="xs" onClick={onClear}><Clear size={14} aria-hidden="true" /></IconButton>}
    </div>
  );
}

export type FieldGroupProps = {
  /** A visible name drawn above the control, tied to `htmlFor`. */
  label?: ReactNode;
  /** The id of the control the label names; the hint and error take ids from it. */
  htmlFor?: string;
  hint?: ReactNode;
  /** Says under the control why it is invalid. */
  error?: ReactNode;
  /** Reads the error out the moment it appears. */
  announce?: boolean;
  className?: string;
  children: ReactNode;
};

/** A label over a control, or over several, such as a path and the button that picks it, with a hint or error under them. */
export function FieldGroup({ label, htmlFor, hint, error, announce, className, children }: FieldGroupProps) {
  return (
    <div className={joined("text-field-group", className)}>
      {label && <label className="text-field-label" htmlFor={htmlFor}>{label}</label>}
      {children}
      {hint && <p id={htmlFor && `${htmlFor}-hint`} className="text-field-hint">{hint}</p>}
      {error && <p id={htmlFor && `${htmlFor}-error`} className="text-field-error" role={announce ? "alert" : undefined}>{error}</p>}
    </div>
  );
}

type TextFieldOwnProps = {
  /** A visible name drawn above the field and tied to it. */
  label?: ReactNode;
  hint?: ReactNode;
  /** Marks the field invalid and says why under it. */
  error?: ReactNode;
  mono?: boolean;
  size?: "sm" | "md";
  wrapClassName?: string;
};

export type TextFieldProps = TextFieldOwnProps & (
  | (Omit<ComponentPropsWithRef<"input">, "size"> & { multiline?: false })
  | (ComponentPropsWithRef<"textarea"> & { multiline: true })
);

/** A one-line input, or a textarea when `multiline`. With a label, hint, or error it comes wrapped with them, all tied to the field. */
export function TextField(props: TextFieldProps) {
  const { label, hint, error, mono, size = "md", wrapClassName, multiline, className, ...control } = props;
  const fallbackId = useId();
  const id = control.id ?? fallbackId;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const shared = {
    id,
    className: joined("text-field", className),
    "data-size": size,
    "data-mono": mono ? "" : undefined,
    "data-multiline": multiline ? "" : undefined,
    "aria-invalid": control["aria-invalid"] ?? (error ? true : undefined),
    "aria-describedby": joined(control["aria-describedby"], hintId, errorId),
  };
  const field = multiline
    ? <textarea {...(control as ComponentPropsWithRef<"textarea">)} {...shared} />
    : <input {...(control as ComponentPropsWithRef<"input">)} {...shared} />;
  if (!label && !hint && !error) return field;
  return <FieldGroup label={label} htmlFor={id} hint={hint} error={error} className={wrapClassName}>{field}</FieldGroup>;
}

export type SelectProps = ComponentPropsWithRef<"select"> & {
  /** The accessible name, for a select whose row or heading does not already name it. */
  label?: string;
  wrapClassName?: string;
};

/** A native select drawn as a field, with a chevron. */
export function Select({ label, wrapClassName, ...select }: SelectProps) {
  return (
    <span className={joined("select", wrapClassName)}>
      <select aria-label={label} {...select} />
      <ChevronDown size={14} aria-hidden="true" />
    </span>
  );
}

export type SwitchProps = Omit<ComponentPropsWithRef<"button">, "onChange" | "onClick" | "children" | "role" | "type"> & {
  on: boolean;
  onChange: (on: boolean) => void;
  label: string;
};

/** An on/off control. Each press asks for the other state; the caller decides whether `on` follows. */
export function Switch({ on, onChange, label, className, ...button }: SwitchProps) {
  return (
    <button type="button" role="switch" className={joined("switch", className)} aria-checked={on} aria-label={label} {...button} onClick={() => onChange(!on)}>
      <span aria-hidden="true" />
    </button>
  );
}

export type CheckboxProps = Omit<ComponentPropsWithRef<"input">, "type"> & {
  label?: ReactNode;
  /** A tooltip on the whole hit area, since the input itself is not drawn. */
  tip?: string;
  wrapClassName?: string;
};

/** A native checkbox drawn as a ticked box, with an optional label beside it. */
export function Checkbox({ label, tip, wrapClassName, ...input }: CheckboxProps) {
  return (
    <label className={joined("checkbox", wrapClassName)} data-tip={tip}>
      <input type="checkbox" {...input} />
      <Check size={14} aria-hidden="true" />
      {label && <span>{label}</span>}
    </label>
  );
}
