import { LuX as X } from "react-icons/lu";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { IconButton } from "./Button";
import "./glass.css";
import "./notice.css";

export type NoticeTone = "info" | "accent" | "warning" | "danger" | "neutral";

export type NoticeProps = Omit<ComponentPropsWithRef<"div">, "children"> & {
  tone?: NoticeTone;
  icon?: ReactNode;
  /** A banner of glass over the composer, rather than a strip in the flow. */
  floating?: boolean;
  /** Draws a close button; the notice stays until the caller stops rendering it. */
  onDismiss?: () => void;
  dismissLabel?: string;
  /** The close button's tooltip, when it should read shorter than its label. */
  dismissTip?: string;
  actions?: ReactNode;
  children: ReactNode;
};

/** A message beside what it is about. A danger notice is announced as an alert, any other as a status. */
export function Notice({ tone = "neutral", icon, floating, onDismiss, dismissLabel = "Dismiss", dismissTip, actions, className, children, ...rest }: NoticeProps) {
  const classes = ["notice", floating && "glass-float", className].filter(Boolean).join(" ");
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      {...rest}
      className={classes}
      data-tone={tone === "neutral" ? undefined : tone}
      data-floating={floating || undefined}
    >
      {icon && <span className="notice-glyph" aria-hidden="true">{icon}</span>}
      <span className="notice-text">{children}</span>
      {actions && <span className="notice-actions">{actions}</span>}
      {onDismiss && (
        <IconButton label={dismissLabel} tip={dismissTip} size="xs" onClick={onDismiss}>
          <X size={12} aria-hidden="true" />
        </IconButton>
      )}
    </div>
  );
}
