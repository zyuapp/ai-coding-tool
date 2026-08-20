import { useRef, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Ellipsis } from "lucide-react";
import { moveListFocus, useDismissibleLayer } from "../focus";

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
  menuRef?: RefObject<HTMLDivElement | null>;
};

/** Choosing an item always closes the menu, so no item has to remember to. */
function MenuList({ items, onSetOpenMenu, className, style, menuRef }: MenuListProps) {
  const first = items.findIndex((item) => !item.disabled);
  return (
    <div ref={menuRef} className={`menu-popover ${className ?? ""}`.trimEnd()} data-popover-menu role="menu" style={style} onKeyDown={moveListFocus}>
      {items.map((item, index) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={item.danger ? "danger-menu-item" : undefined}
          disabled={item.disabled}
          autoFocus={index === first}
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
 * state here is the comparison; the shared dismissible layer handles outside presses and Escape,
 * and focus leaving closes it here.
 */
export function PopoverMenu({ id, openMenu, onSetOpenMenu, items, label, className, popoverClassName, children }: PopoverMenuProps) {
  const open = openMenu === id;
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useDismissibleLayer(open, [root], () => onSetOpenMenu(null), trigger);
  return (
    <div
      ref={root}
      className={`${className} ${open ? "open" : ""}`.trimEnd()}
      data-popover-menu
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onSetOpenMenu(null);
      }}
    >
      {children}
      <button
        ref={trigger}
        className="menu-trigger"
        type="button"
        aria-label={label}
        aria-haspopup="menu"
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
export function ContextMenu({ items, onSetOpenMenu, position, returnFocus }: Omit<MenuListProps, "className" | "style" | "menuRef"> & { position: CSSProperties; returnFocus?: RefObject<HTMLElement | null> }) {
  const menu = useRef<HTMLDivElement>(null);
  useDismissibleLayer(true, [menu], () => onSetOpenMenu(null), returnFocus);
  return createPortal(
    <MenuList menuRef={menu} items={items} onSetOpenMenu={onSetOpenMenu} className="context-menu-popover" style={position} />,
    document.body,
  );
}
