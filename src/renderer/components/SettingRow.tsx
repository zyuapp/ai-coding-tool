import { LuCheck as Check } from "react-icons/lu";
import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { settingControl, type SettingId } from "../../domain/settings-catalog";

/** The control the jump panel sent the user to, so the row that owns it can take them there. */
export const SettingFocus = createContext<string | null>(null);

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
  const found = useContext(SettingFocus) === id;
  const row = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (found) row.current?.scrollIntoView({ block: "center" });
  }, [found]);

  return (
    <div ref={row} className={`setting-row${found ? " found" : ""}${className ? ` ${className}` : ""}`} data-setting={id}>
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
