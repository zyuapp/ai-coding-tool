import { LuX as X } from "react-icons/lu";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { IconButton } from "./Button";
import "./panel.css";

const joined = (base: string, extra: string | undefined) => (extra ? `${base} ${extra}` : base);

/** A string that may be cut short carries itself as the tip that shows only while it is. */
const overflowTip = (text: ReactNode) => (typeof text === "string" ? { "data-tip": text, "data-tip-overflow": "" } : {});

export type PanelHeaderProps = Omit<ComponentPropsWithRef<"header">, "title" | "children"> & {
  /** A mark before the title, drawn by the call site at its own size. */
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Controls at the trailing edge, before the close button. */
  actions?: ReactNode;
  onClose?: () => void;
  /** The close button's name, and its tip unless `closeTip` is given. */
  closeLabel?: string;
  closeTip?: string;
  /** Anything else the head carries, between the title and the actions. */
  children?: ReactNode;
};

/** The head of a panel: one row as tall as the window's chrome, its title, and what closes it. */
export function PanelHeader({ icon, title, subtitle, actions, onClose, closeLabel = "Close", closeTip, className, children, ...rest }: PanelHeaderProps) {
  return (
    <header {...rest} className={joined("panel-header", className)}>
      <div className="panel-header-title">
        {icon !== undefined && <span className="panel-header-icon">{icon}</span>}
        <div className="panel-header-text">
          <h2 {...overflowTip(title)}>{title}</h2>
          {subtitle !== undefined && <p {...overflowTip(subtitle)}>{subtitle}</p>}
        </div>
      </div>
      {children}
      {actions !== undefined && <div className="panel-header-actions">{actions}</div>}
      {onClose && <IconButton className="panel-header-close" size="lg" label={closeLabel} tip={closeTip} onClick={onClose}><X size={18} aria-hidden="true" /></IconButton>}
    </header>
  );
}

export type ToolbarProps = ComponentPropsWithRef<"div">;

/** A strip of small icon buttons and fields under a panel's head, such as a browser's address bar. */
export function Toolbar({ className, ...rest }: ToolbarProps) {
  return <div {...rest} className={joined("toolbar", className)} />;
}
