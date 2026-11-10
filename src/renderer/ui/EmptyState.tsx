import type { ComponentPropsWithRef, ReactNode } from "react";
import "./empty-state.css";

export type EmptyStateProps = Omit<ComponentPropsWithRef<"div">, "title"> & {
  size?: "panel" | "inline";
  /** Drawn in a glass orb above a panel's title. */
  icon?: ReactNode;
  title?: ReactNode;
  detail?: ReactNode;
  action?: ReactNode;
  /** Danger turns a panel's orb red, for a panel that is empty because something failed. */
  tone?: "danger";
};

/** What a panel or list shows when it has nothing to show. */
export function EmptyState({ size = "panel", icon, title, detail, action, tone, className, ...rest }: EmptyStateProps) {
  const classes = className ? `empty-view ${className}` : "empty-view";
  if (size === "inline") {
    return (
      <p {...(rest as ComponentPropsWithRef<"p">)} className={classes} data-size="inline">
        {title}
        {title && detail ? " " : null}
        {detail}
        {action && <span className="empty-view-action">{action}</span>}
      </p>
    );
  }
  return (
    <div {...rest} className={classes} data-size="panel" data-tone={tone}>
      {icon && <span className="empty-view-orb" aria-hidden="true">{icon}</span>}
      {title && <h2 className="empty-view-title">{title}</h2>}
      {detail && <p className="empty-view-detail">{detail}</p>}
      {action && <div className="empty-view-action">{action}</div>}
    </div>
  );
}
