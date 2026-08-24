import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight, Ellipsis } from "lucide-react";
import { useDismissibleLayer } from "../focus";

export type MenuItem = {
  label: string;
  onSelect?: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** Draws a tick, and marks every item in the list as one of a set that can be ticked. */
  checked?: boolean;
  /** The keystroke that does the same thing, drawn against the item's right edge. */
  shortcut?: string;
  /** Opens beside the item. An item with a list of its own chooses nothing itself. */
  items?: MenuItem[];
};

/** A rule between two groups of items. */
export type MenuEntry = MenuItem | "separator";

/** How close to the window's edge a menu may be drawn. */
const EDGE = 8;

function usableIndexes(entries: MenuEntry[]): number[] {
  return entries.flatMap((entry, index) => entry !== "separator" && !entry.disabled ? [index] : []);
}

type MenuListProps = {
  entries: MenuEntry[];
  /** Closes the whole menu, however deep the item that was chosen sat. */
  onClose: () => void;
  className?: string;
  style?: CSSProperties;
  menuRef?: RefObject<HTMLDivElement | null>;
  /** True when the keyboard opened a nested list; false while the pointer opened it. */
  autoFocus?: boolean;
  /** Set on a list opened from an item, which draws it beside that item and answers ArrowLeft. */
  onLeave?: () => void;
};

/** Choosing an item always closes the menu, so no item has to remember to. */
function MenuList({ entries, onClose, className, style, menuRef, autoFocus, onLeave }: MenuListProps) {
  /** Which item's own list is open, and whether the keyboard asked for it, which is what focuses it. */
  const [sub, setSub] = useState<{ index: number; focus: boolean } | null>(null);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const fallback = useRef<HTMLDivElement>(null);
  const list = menuRef ?? fallback;
  const usable = usableIndexes(entries);
  const checkable = entries.some((entry) => entry !== "separator" && entry.checked !== undefined);
  /**
   * A list opened from an item is drawn to its right until the window runs out, then to its left,
   * and lifted back up when it runs past the bottom. Measured once, while it still sits where the
   * stylesheet put it: measuring it again would read the place the move just gave it and move again.
   */
  const [placement, setPlacement] = useState({ flipped: false, lift: 0 });
  const isSubmenu = Boolean(onLeave);
  const measured = useRef(false);

  useLayoutEffect(() => {
    if (!isSubmenu || measured.current) return;
    const box = list.current?.getBoundingClientRect();
    if (!box) return;
    measured.current = true;
    setPlacement({ flipped: box.right + EDGE > innerWidth, lift: Math.max(0, box.bottom + EDGE - innerHeight) });
  }, [isSubmenu, list]);

  const first = usable[0];
  /** A top-level list takes focus without highlighting a row; a keyboard-opened nested list selects its first row. */
  useEffect(() => {
    if (autoFocus) buttons.current[first ?? -1]?.focus();
    else if (!isSubmenu) list.current?.focus();
  }, [autoFocus, first, isSubmenu, list]);

  function move(delta: number) {
    if (!usable.length) return;
    const at = usable.indexOf(buttons.current.findIndex((button) => button === document.activeElement));
    const next = at < 0 ? usable[delta > 0 ? 0 : usable.length - 1]! : usable[(at + delta + usable.length) % usable.length]!;
    buttons.current[next]?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const focused = buttons.current.findIndex((button) => button === document.activeElement);
    const entry = entries[focused];
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      move(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "ArrowRight" && entry && entry !== "separator" && entry.items?.length) {
      event.preventDefault();
      event.stopPropagation();
      setSub({ index: focused, focus: true });
    } else if (event.key === "ArrowLeft" && onLeave) {
      event.preventDefault();
      event.stopPropagation();
      onLeave();
    }
  }

  return (
    <div
      ref={list}
      className={`menu-popover ${checkable ? "menu-checkable" : ""} ${placement.flipped ? "menu-flipped" : ""} ${className ?? ""}`.replace(/\s+/g, " ").trim()}
      data-popover-menu
      role="menu"
      tabIndex={isSubmenu ? undefined : -1}
      style={placement.lift && typeof style?.top === "number" ? { ...style, top: style.top - placement.lift } : style}
      onKeyDown={onKeyDown}
    >
      {entries.map((entry, index) => {
        if (entry === "separator") return <div key={`separator-${index}`} className="menu-separator" role="separator" />;
        const nested = Boolean(entry.items?.length);
        return (
          <Fragment key={`${index}-${entry.label}`}>
            <button
              ref={(node) => { buttons.current[index] = node; }}
              type="button"
              role={entry.checked === undefined ? "menuitem" : "menuitemcheckbox"}
              aria-checked={entry.checked}
              aria-haspopup={nested ? "menu" : undefined}
              aria-expanded={nested ? sub?.index === index : undefined}
              className={entry.danger ? "danger-menu-item" : undefined}
              disabled={entry.disabled}
              /** The pointer highlights what it is over, which is the same highlight the keyboard moves. */
              onMouseEnter={(event) => {
                setSub(nested ? { index, focus: false } : null);
                event.currentTarget.focus();
              }}
              onClick={() => {
                if (nested) return setSub({ index, focus: true });
                onClose();
                entry.onSelect?.();
              }}
            >
              <span className="menu-tick" aria-hidden="true">{entry.checked && <Check size={12} />}</span>
              <span className="menu-label">{entry.label}</span>
              {entry.shortcut && <span className="menu-shortcut">{entry.shortcut}</span>}
              {nested && <ChevronRight className="menu-chevron" size={12} aria-hidden="true" />}
            </button>
            {nested && sub?.index === index && (
              <MenuList
                entries={entry.items!}
                onClose={onClose}
                onLeave={() => {
                  setSub(null);
                  buttons.current[index]?.focus();
                }}
                autoFocus={sub.focus}
                className="menu-submenu"
                style={{ top: (buttons.current[index]?.offsetTop ?? 0) - 4 }}
              />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

export type PopoverMenuProps = {
  /** The value `openMenu` carries while this menu is the open one. */
  id: string;
  openMenu: string | null;
  onSetOpenMenu: (menu: string | null) => void;
  items: MenuEntry[];
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
      {open && <MenuList entries={items} onClose={() => onSetOpenMenu(null)} className={popoverClassName} />}
    </div>
  );
}

/**
 * The same list with no trigger of its own, placed where a right-click asked for it. It is measured
 * once it is drawn and moved back inside the window, so a menu near an edge never falls off it.
 */
export function ContextMenu({ entries, at, onClose, returnFocus }: {
  entries: MenuEntry[];
  /** Where the pointer asked, in window coordinates. */
  at: { x: number; y: number };
  onClose: () => void;
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null);
  useDismissibleLayer(true, [menu], onClose, returnFocus);

  useLayoutEffect(() => {
    const box = menu.current?.getBoundingClientRect();
    if (!box) return;
    const left = at.x + box.width + EDGE > innerWidth ? Math.max(EDGE, at.x - box.width) : at.x;
    const top = at.y + box.height + EDGE > innerHeight ? Math.max(EDGE, innerHeight - box.height - EDGE) : at.y;
    setPlaced((current) => current?.left === left && current?.top === top ? current : { left, top });
  }, [at.x, at.y]);

  return createPortal(
    <MenuList
      menuRef={menu}
      entries={entries}
      onClose={onClose}
      className="context-menu-popover"
      /** Hidden until it has been measured, so it is never seen at the place it was measured from. */
      style={{ left: placed?.left ?? at.x, top: placed?.top ?? at.y, ...(placed ? {} : { visibility: "hidden" }) }}
    />,
    document.body,
  );
}
