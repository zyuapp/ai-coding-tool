import type { ComponentPropsWithRef, ReactNode } from "react";
import "./nav-list.css";

const joined = (base: string, extra: string | undefined) => (extra ? `${base} ${extra}` : base);

/** A column of filters or places, one of them chosen. */
export function NavList({ label, className, ...rest }: Omit<ComponentPropsWithRef<"nav">, "aria-label"> & { label: string }) {
  return <nav {...rest} aria-label={label} className={joined("nav-list", className)} />;
}

export type NavItemProps = Omit<ComponentPropsWithRef<"button">, "aria-pressed"> & {
  selected: boolean;
  icon?: ReactNode;
  /** How many the item holds, quiet against the trailing edge. */
  count?: ReactNode;
};

export function NavItem({ selected, icon, count, className, type = "button", children, ...rest }: NavItemProps) {
  return <button {...rest} type={type} aria-pressed={selected} className={joined("nav-item", className)}>
    {icon}
    <span className="nav-item-label">{children}</span>
    {count !== undefined && <span className="nav-item-count">{count}</span>}
  </button>;
}

export function NavSeparator() {
  return <hr className="nav-separator" />;
}
