import { LuCheck as Check } from "react-icons/lu";
import { createContext, isValidElement, useContext, useEffect, useRef, type ComponentPropsWithRef, type ReactNode } from "react";
import { settingControl, type SettingId, type SettingMark } from "../../domain/settings-catalog";
import { firstFocusable, placeOf, useKeyboardPlace } from "../focus";
import { Switch } from "../ui/Field";

export const SettingFocus = createContext<SettingMark | null>(null);

/** Whether a search landed on `id`, and the element to bring into view, flash, and hand the keyboard to each time one does. */
export function useSettingMark<T extends HTMLElement>(id: string) {
  const mark = useContext(SettingFocus);
  const visit = mark?.id === id ? mark.visit : null;
  const element = useRef<T>(null);

  useEffect(() => {
    const target = element.current;
    if (visit === null || !target) return;
    target.scrollIntoView({ block: "center" });
    firstFocusable(target)?.focus({ preventScroll: true });
    /** A finished flash leaves nothing to replay, so the class comes off and back on to start a new one. */
    target.classList.remove("found");
    void target.offsetWidth;
    target.classList.add("found");
    /** A still mark outlasts the flash, staying until the user next does something. */
    target.dataset.landed = "";
    const clear = () => { delete target.dataset.landed; };
    const options = { capture: true, once: true } as const;
    document.addEventListener("pointerdown", clear, options);
    document.addEventListener("keydown", clear, options);
    return () => {
      clear();
      document.removeEventListener("pointerdown", clear, options);
      document.removeEventListener("keydown", clear, options);
    };
  }, [visit]);

  return { ref: element, found: visit !== null };
}

/**
 * The circle at the start of a row: ticked once its step is done, a dashed ring while it is still to do.
 * A quiet one marks a row that is not a step, drawing only its icon until it is done, and says nothing aloud.
 */
export function SettingStatus({ done, quiet, children }: { done: boolean; quiet?: boolean; children?: ReactNode }) {
  return (
    <span className={`setting-status ${done ? "granted" : quiet ? "blank" : "pending"}`} aria-hidden={quiet || undefined}>
      {children ?? (done && <Check size={14} aria-hidden="true" />)}
      {!quiet && <span className="setting-status-label">{done ? "Done" : "Not done"}</span>}
    </span>
  );
}

const rowsOf = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(".setting-row")];

/** The keyboard's place in a list of rows whose buttons can take their own row away, such as Restore or Remove. */
export function useRowListFocus<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const onClickCapture = useKeyboardPlace(
    ref,
    (pressed, root) => {
      const row = pressed.closest<HTMLElement>(".setting-row");
      return row ? rowsOf(root).indexOf(row) : null;
    },
    (at, root) => {
      const row = placeOf(rowsOf(root), at);
      return row && firstFocusable(row);
    },
  );
  return { ref, onClickCapture };
}

const switchId = (id: SettingId) => `setting-switch-${id}`;

export type SettingRowBaseProps = Omit<ComponentPropsWithRef<"div">, "title" | "children"> & {
  /** The row's name. A string is drawn as the row's title; anything else is drawn as given. */
  title: ReactNode;
  /** What the row says under its name. A string is one line of it; anything else is drawn as given. */
  description?: ReactNode;
  /** A mark in the row's lead column, such as a glyph. */
  leading?: ReactNode;
  /** Whether the row's step is done, drawn as the circle in its lead column. */
  status?: boolean;
  /** The setting a search can land on this row by. */
  mark?: string;
  /** Tighter rows for a checklist. */
  density?: "compact";
  /** Names the control the row's text toggles, so clicking the text works the control. */
  labelFor?: string;
  actionClassName?: string;
  /** The controls, at the row's trailing edge. */
  children?: ReactNode;
  /** Drawn under the row's text and controls, across both. */
  footer?: ReactNode;
};

/** One line of a settings page: a lead mark, a name over what it says, and the controls at its end. */
export function SettingRowBase({ title, description, leading, status, mark, density, labelFor, actionClassName, className, children, footer, ref, ...rest }: SettingRowBaseProps) {
  const landing = useSettingMark<HTMLDivElement>(mark ?? "");
  const lead = status !== undefined ? <SettingStatus done={status} /> : leading;
  const text = <>
    {typeof title === "string" ? <strong>{title}</strong> : title}
    {typeof description === "string" ? <p>{description}</p> : description}
  </>;
  const classes = ["setting-row", lead === undefined && "plain", landing.found && "found", className].filter(Boolean).join(" ");
  const attach = (element: HTMLDivElement | null) => {
    landing.ref.current = element;
    if (typeof ref === "function") ref(element);
    else if (ref) ref.current = element;
  };
  return (
    <div {...rest} ref={attach} className={classes} data-setting={mark} data-density={density}>
      {lead}
      {labelFor ? <label className="setting-row-text" htmlFor={labelFor}>{text}</label> : <div>{text}</div>}
      {children && <div className={actionClassName ? `setting-row-action ${actionClassName}` : "setting-row-action"}>{children}</div>}
      {footer}
    </div>
  );
}

export type SettingRowProps = Omit<SettingRowBaseProps, "title" | "mark" | "labelFor"> & {
  /** The catalog entry the row draws its name from, which is also what the jump panel offers. */
  id: SettingId;
};

/**
 * One control on a settings page. Its name comes from the catalog, so nothing can be drawn here that
 * the jump panel cannot find.
 */
export function SettingRow({ id, children, ...row }: SettingRowProps) {
  const switched = isValidElement(children) && children.type === SettingSwitch;
  return <SettingRowBase {...row} title={settingControl(id).label} mark={id} labelFor={switched ? switchId(id) : undefined}>{children}</SettingRowBase>;
}

/** An on/off control whose name is the catalog label of the row it sits in. The row's text toggles it too. */
export function SettingSwitch({ id, on, onChange }: { id: SettingId; on: boolean; onChange: (on: boolean) => void }) {
  return <Switch id={switchId(id)} className="setting-switch" on={on} onChange={onChange} label={settingControl(id).label} />;
}
