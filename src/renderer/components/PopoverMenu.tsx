import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import { Ellipsis } from "lucide-react";

export type MenuItem = {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
};

type MenuListProps = {
  items: MenuItem[];
  onSetOpenMenu: (menu: string | null) => void;
  className?: string;
  style?: CSSProperties;
};

/** Choosing an item always closes the menu, so no item has to remember to. */
function MenuList({ items, onSetOpenMenu, className, style }: MenuListProps) {
  return (
    <div className={`menu-popover ${className ?? ""}`.trimEnd()} data-popover-menu role="menu" style={style}>
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={item.danger ? "danger-menu-item" : undefined}
          disabled={item.disabled}
          onClick={() => {
            onSetOpenMenu(null);
            item.onSelect();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export type PopoverMenuProps = {
  /** The value `openMenu` carries while this menu is the open one. */
  id: string;
  openMenu: string | null;
  onSetOpenMenu: (menu: string | null) => void;
  items: MenuItem[];
  /** Names the trigger for assistive technology. */
  label: string;
  className: string;
  popoverClassName?: string;
  /** Sits ahead of the trigger, for a row that is also a menu. */
  children?: ReactNode;
};

/**
 * An ellipsis trigger and the list it opens. The reducer owns which menu is open, so the only
 * state here is the comparison; a pointer outside any `[data-popover-menu]` closes it in `App`,
 * and focus leaving closes it here.
 */
export function PopoverMenu({ id, openMenu, onSetOpenMenu, items, label, className, popoverClassName, children }: PopoverMenuProps) {
  const open = openMenu === id;
  return (
    <div
      className={`${className} ${open ? "open" : ""}`.trimEnd()}
      data-popover-menu
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onSetOpenMenu(null);
      }}
    >
      {children}
      <button
        className="menu-trigger"
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => onSetOpenMenu(open ? null : id)}
      >
        <Ellipsis size={16} />
      </button>
      {open && <MenuList items={items} onSetOpenMenu={onSetOpenMenu} className={popoverClassName} />}
    </div>
  );
}

/** The same list with no trigger of its own, placed where a right-click asked for it. */
export function ContextMenu({ items, onSetOpenMenu, position }: Omit<MenuListProps, "className" | "style"> & { position: CSSProperties }) {
  return createPortal(
    <MenuList items={items} onSetOpenMenu={onSetOpenMenu} className="context-menu-popover" style={position} />,
    document.body,
  );
}
