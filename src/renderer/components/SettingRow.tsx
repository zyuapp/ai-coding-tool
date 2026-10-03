import { LuCheck as Check } from "react-icons/lu";
import { createContext, useContext, useEffect, useRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { settingControl, type SettingId } from "../../domain/settings-catalog";

/** The control a search sent the user to. `visit` counts the trips, so landing on the same one again still shows it. */
export type SettingMark = { id: string; visit: number };

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
    for (const animation of target.getAnimations?.({ subtree: true }) ?? []) {
      animation.cancel();
      animation.play();
    }
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
        : <span className={`setting-status ${status ? "granted" : ""}`}>{status && <Check size={13} />}</span>}
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
