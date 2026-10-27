import { LuCheck as Check } from "react-icons/lu";
import { createContext, useContext, useEffect, useRef, useState, type ComponentPropsWithoutRef, type KeyboardEvent, type ReactNode } from "react";
import { settingControl, type SettingId, type SettingMark } from "../../domain/settings-catalog";

export const SettingFocus = createContext<SettingMark | null>(null);

/** Whether a search landed on `id`, and the element to bring into view and flash each time one does. */
export function useSettingMark<T extends HTMLElement>(id: string) {
  const mark = useContext(SettingFocus);
  const visit = mark?.id === id ? mark.visit : null;
  const element = useRef<T>(null);

  useEffect(() => {
    const target = element.current;
    if (visit === null || !target) return;
    target.scrollIntoView({ block: "center" });
    /** A finished flash leaves nothing to replay, so the class comes off and back on to start a new one. */
    target.classList.remove("found");
    void target.offsetWidth;
    target.classList.add("found");
  }, [visit]);

  return { ref: element, found: visit !== null };
}

export type SettingRowProps = {
  /** The catalog entry the row draws its name from, which is also what the jump panel offers. */
  id: SettingId;
  /** Whether the row's tick is filled. Left out, the row keeps the space blank. */
  status?: boolean;
  /** What the row says under its name. */
  description: ReactNode;
  className?: string;
  /** The control itself, on the right of the row. */
  children?: ReactNode;
};

/**
 * One control on a settings page. Its name comes from the catalog, so nothing can be drawn here that
 * the jump panel cannot find.
 */
export function SettingRow({ id, status, description, className, children }: SettingRowProps) {
  const { ref, found } = useSettingMark<HTMLDivElement>(id);

  return (
    <div ref={ref} className={`setting-row${found ? " found" : ""}${className ? ` ${className}` : ""}`} data-setting={id}>
      {status === undefined
        ? <span className="setting-status blank" aria-hidden="true" />
        : <span className={`setting-status ${status ? "granted" : ""}`}>{status && <Check size={14} />}</span>}
      <div>
        <strong>{settingControl(id).label}</strong>
        {typeof description === "string" ? <p>{description}</p> : description}
      </div>
      {children && <div className="setting-row-action">{children}</div>}
    </div>
  );
}

/** A group of rows a search can land on as a whole. Its heading should draw the catalog's label for `setting`. */
export function SettingGroup({ setting, children, ...section }: { setting: SettingId } & Omit<ComponentPropsWithoutRef<"section">, "className">) {
  const { ref, found } = useSettingMark<HTMLElement>(setting);
  return <section ref={ref} className={`settings-group${found ? " found" : ""}`} data-setting={setting} {...section}>{children}</section>;
}

/** An on/off control whose name is the catalog label of the row it sits in. */
export function SettingSwitch({ id, on, onChange }: { id: SettingId; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button type="button" role="switch" className="setting-switch" aria-checked={on} aria-label={settingControl(id).label} onClick={() => onChange(!on)}>
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
 */
export function ConfirmAction({ confirm, onConfirm, children, ...trigger }: ConfirmActionProps) {
  const [confirming, setConfirming] = useState(false);
  const first = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const asked = useRef(false);
  useEffect(() => {
    if (confirming) cancel.current?.focus();
    else if (asked.current) first.current?.focus();
    asked.current = confirming;
  }, [confirming]);
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    setConfirming(false);
  };
  if (!confirming) return <button ref={first} type="button" {...trigger} onClick={() => setConfirming(true)}>{children}</button>;
  return (
    <>
      <button type="button" className="danger" onKeyDown={escape} onClick={() => {
        setConfirming(false);
        onConfirm();
      }}>{confirm}</button>
      <button ref={cancel} type="button" onKeyDown={escape} onClick={() => setConfirming(false)}>Cancel</button>
    </>
  );
}
