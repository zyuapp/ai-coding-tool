import { LuCheck as Check } from "react-icons/lu";
import { createContext, isValidElement, useContext, useEffect, useRef, useState, type ComponentPropsWithoutRef, type FocusEvent, type KeyboardEvent, type ReactNode } from "react";
import { settingControl, type SettingId, type SettingMark } from "../../domain/settings-catalog";
import { firstFocusable, placeOf, useKeyboardPlace } from "../focus";

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
    /** Without motion the flash never shows, so a still mark stays until the user next does something. */
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

export type SettingRowProps = {
  /** The catalog entry the row draws its name from, which is also what the jump panel offers. */
  id: SettingId;
  /** Whether the row's step is done. Left out, the row is a plain control with no circle. */
  status?: boolean;
  /** What the row says under its name. */
  description: ReactNode;
  className?: string;
  /** The control itself, on the right of the row. */
  children?: ReactNode;
};

/** The circle at the start of a row: ticked once its step is done, a dashed ring while it is still to do. */
export function SettingStatus({ done, children }: { done: boolean; children?: ReactNode }) {
  return (
    <span className={`setting-status ${done ? "granted" : "pending"}`}>
      {children ?? (done && <Check size={14} aria-hidden="true" />)}
      <span className="setting-status-label">{done ? "Done" : "Not done"}</span>
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

/**
 * One control on a settings page. Its name comes from the catalog, so nothing can be drawn here that
 * the jump panel cannot find.
 */
export function SettingRow({ id, status, description, className, children }: SettingRowProps) {
  const { ref, found } = useSettingMark<HTMLDivElement>(id);
  const text = <>
    <strong>{settingControl(id).label}</strong>
    {typeof description === "string" ? <p>{description}</p> : description}
  </>;

  return (
    <div ref={ref} className={`setting-row${status === undefined ? " plain" : ""}${found ? " found" : ""}${className ? ` ${className}` : ""}`} data-setting={id}>
      {status !== undefined && <SettingStatus done={status} />}
      {isValidElement(children) && children.type === SettingSwitch
        ? <label className="setting-row-text" htmlFor={switchId(id)}>{text}</label>
        : <div>{text}</div>}
      {children && <div className="setting-row-action">{children}</div>}
    </div>
  );
}

/** A group of rows a search can land on as a whole. Its heading should draw the catalog's label for `setting`. */
export function SettingGroup({ setting, children, ...section }: { setting: SettingId } & Omit<ComponentPropsWithoutRef<"section">, "className">) {
  const { ref, found } = useSettingMark<HTMLElement>(setting);
  return <section ref={ref} className={`settings-group${found ? " found" : ""}`} data-setting={setting} {...section}>{children}</section>;
}

/** An on/off control whose name is the catalog label of the row it sits in. The row's text toggles it too. */
export function SettingSwitch({ id, on, onChange }: { id: SettingId; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button id={switchId(id)} type="button" role="switch" className="setting-switch" aria-checked={on} aria-label={settingControl(id).label} onClick={() => onChange(!on)}>
      <span aria-hidden="true" />
    </button>
  );
}

export type ConfirmActionProps = Omit<ComponentPropsWithoutRef<"button">, "onClick" | "type"> & {
  /** The destructive button the first press reveals, beside Cancel. */
  confirm: string;
  onConfirm: () => void;
};

/**
 * A button that asks once more before it acts. The first press swaps it for the destructive button
 * and Cancel, with the focus on Cancel; any answer, or Esc, puts the first button back and focuses it.
 * Moving the focus anywhere else takes the question back too, leaving the focus where it went.
 */
export function ConfirmAction({ confirm, onConfirm, children, ...trigger }: ConfirmActionProps) {
  const [confirming, setConfirming] = useState(false);
  const first = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const danger = useRef<HTMLButtonElement>(null);
  const asked = useRef(false);
  const answered = useRef(false);
  useEffect(() => {
    if (confirming) cancel.current?.focus();
    else if (asked.current) first.current?.focus();
    asked.current = confirming;
  }, [confirming]);
  const answer = () => {
    answered.current = true;
    setConfirming(false);
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    answer();
  };
  const leave = (event: FocusEvent) => {
    if (answered.current || event.relatedTarget === cancel.current || event.relatedTarget === danger.current) return;
    asked.current = false;
    setConfirming(false);
  };
  if (!confirming) return <button ref={first} type="button" {...trigger} onClick={() => { answered.current = false; setConfirming(true); }}>{children}</button>;
  return (
    <>
      <button ref={danger} type="button" className="danger armed" onKeyDown={escape} onBlur={leave} onClick={() => {
        answer();
        onConfirm();
      }}>{confirm}</button>
      <button ref={cancel} type="button" onKeyDown={escape} onBlur={leave} onClick={answer}>Cancel</button>
    </>
  );
}
