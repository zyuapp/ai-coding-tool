import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { LuCheck as Check, LuChevronDown as ChevronDown, LuChevronRight as ChevronRight, LuEllipsis as Ellipsis, LuSearch as Search } from "react-icons/lu";
import { useDismissibleLayer } from "../focus";
import { useCommandControls } from "./CommandControl";
import type { AppCommand } from "../../contracts/commands";
import { REMOTE_UNSUPPORTED } from "../../contracts/computer-capabilities";

export type MenuItem = {
  /** Declaring the operation gives every menu the same remote availability as command dispatch. */
  command?: AppCommand;
  label: string;
  className?: string;
  title?: string;
  onSelect?: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** Draws a tick, and marks every item in the list as one of a set that can be ticked. */
  checked?: boolean;
  /** The keystroke that does the same thing, drawn against the item's right edge. */
  shortcut?: string;
  /** Quiet words in the same place when there is no keystroke, such as which computer holds the item. */
  detail?: string;
  /** Opens beside the item. An item with a list of its own chooses nothing itself. */
  items?: MenuItem[];
  /** A submenu with its own search field or virtual list. */
  panel?: ReactNode;
  onOpen?: () => void;
};

/** A rule between two groups of items. */
export type MenuEntry = MenuItem | "separator";

/** How close to the window's edge a menu may be drawn. */
const EDGE = 8;

/** The small gap between a row and a menu drawn outside the row's clipping container. */
const ANCHOR_GAP = 4;

/** How long the pointer may rest on a sibling before an open submenu gives way to it, so a diagonal path into the submenu keeps it. */
const SUBMENU_INTENT_MS = 220;

/** How long typed letters keep adding to one search before the next key starts a new one. */
const TYPEAHEAD_MS = 700;

/**
 * Typing a row's first letters focuses it, as native menus do. A repeated single letter steps through
 * the rows that start with it. Returns whether the key was a letter the list took.
 */
export function useTypeahead() {
  const typed = useRef({ text: "", at: -Infinity });
  return (event: KeyboardEvent<HTMLElement>, rows: readonly (HTMLButtonElement | null)[]) => {
    if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return false;
    const fresh = event.timeStamp - typed.current.at > TYPEAHEAD_MS;
    if (event.key === " " && fresh) return false;
    const text = (fresh ? "" : typed.current.text) + event.key.toLowerCase();
    typed.current = { text, at: event.timeStamp };
    const usable = rows.filter((row): row is HTMLButtonElement => Boolean(row && !row.disabled && row.getAttribute("aria-disabled") !== "true"));
    const at = usable.indexOf(document.activeElement as HTMLButtonElement);
    const needle = [...text].every((letter) => letter === text[0]) ? text[0] : text;
    const start = needle.length === 1 ? at + 1 : Math.max(at, 0);
    const match = [...usable.slice(start), ...usable.slice(0, start)]
      .find((row) => (row.querySelector(".menu-label") ?? row).textContent?.trim().toLowerCase().startsWith(needle));
    event.stopPropagation();
    if (!match) return true;
    event.preventDefault();
    match.focus();
    return true;
  };
}

/** Every item the keyboard can rest on. A disabled item stays reachable so its reason can be read. */
function itemIndexes(entries: MenuEntry[]): number[] {
  return entries.flatMap((entry, index) => entry !== "separator" ? [index] : []);
}

function SubmenuPanel({ children, top, autoFocus, onLeave }: { children: ReactNode; top: number; autoFocus: boolean; onLeave: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const place = () => {
      const box = element.getBoundingClientRect();
      const parent = element.parentElement!.getBoundingClientRect();
      let left = parent.right - 5;
      if (left + box.width + EDGE > innerWidth) left = parent.left - box.width + 5;
      left = Math.max(EDGE, Math.min(left, innerWidth - box.width - EDGE)) - parent.left;
      const placedTop = Math.max(EDGE, Math.min(parent.top + top, innerHeight - box.height - EDGE)) - parent.top;
      setPlacement((current) => current?.left === left && current?.top === placedTop ? current : { left, top: placedTop });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [top]);
  useEffect(() => {
    if (autoFocus) root.current?.querySelector<HTMLElement>('input, button:not(:disabled)')?.focus();
  }, [autoFocus]);
  return <div ref={root} className="menu-popover menu-submenu" data-popover-menu style={placement ?? { top }} onKeyDown={(event) => {
    if (event.key === "Escape" || event.key === "ArrowLeft" && (event.target as HTMLElement).tagName !== "INPUT") {
      event.preventDefault();
      event.stopPropagation();
      onLeave();
    }
  }}>{children}</div>;
}

/** A sibling waiting out the pointer's way into an open submenu. */
function useHoverIntent() {
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => {
    if (pending.current) clearTimeout(pending.current);
    pending.current = null;
  };
  useEffect(() => cancel, []);
  /** Runs `apply` now, or after the pointer rests when `wait`, replacing whatever was waiting. */
  const schedule = (apply: () => void, wait: boolean) => {
    cancel();
    if (!wait) return apply();
    pending.current = setTimeout(() => { pending.current = null; apply(); }, SUBMENU_INTENT_MS);
  };
  return { schedule, cancel };
}

/**
 * A list opened from an item is drawn to its right until the window runs out, then to its left,
 * and lifted back up when it runs past the bottom. Measured once, while it still sits where the
 * stylesheet put it: measuring it again would read the place the move just gave it and move again.
 */
function useSubmenuPlacement(isSubmenu: boolean, list: RefObject<HTMLDivElement | null>) {
  const [placement, setPlacement] = useState({ flipped: false, lift: 0 });
  const measured = useRef(false);
  useLayoutEffect(() => {
    if (!isSubmenu || measured.current) return;
    const box = list.current?.getBoundingClientRect();
    if (!box) return;
    measured.current = true;
    setPlacement({ flipped: box.right + EDGE > innerWidth, lift: Math.max(0, box.bottom + EDGE - innerHeight) });
  }, [isSubmenu, list]);
  return placement;
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
  /** A field above the items that narrows them. It holds the caret while the list is open, and Enter picks the top item. */
  search?: { value: string; label: string; onChange: (value: string) => void };
};

type MenuSearchProps = {
  search: NonNullable<MenuListProps["search"]>;
  field: RefObject<HTMLInputElement | null>;
  /** Enter, which takes the list's top item. */
  onSubmit: () => void;
};

/** Escape empties a typed search before it closes the menu, as every other search field does. */
function MenuSearch({ search, field, onSubmit }: MenuSearchProps) {
  return <div className="menu-search">
    <label className="menu-search-field">
      <Search size={14} aria-hidden="true" />
      <input
        ref={field}
        type="search"
        value={search.value}
        placeholder={search.label}
        aria-label={search.label}
        onInput={(event) => search.onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && search.value) search.onChange("");
          else if (event.key === "Enter") onSubmit();
          else return;
          event.preventDefault();
        }}
      />
    </label>
  </div>;
}

/** Choosing an item always closes the menu, so no item has to remember to. */
export function MenuList({ entries: supplied, onClose, className, style, menuRef, autoFocus, onLeave, search }: MenuListProps) {
  const controls = useCommandControls();
  const entries = supplied.map((entry) => entry !== "separator" && entry.command && !controls.available(entry.command)
    ? { ...entry, disabled: true, title: REMOTE_UNSUPPORTED, shortcut: undefined, detail: "Not on remote" } : entry);
  const typeahead = useTypeahead();
  const intent = useHoverIntent();
  /** Which item's own list is open, and whether the keyboard asked for it, which is what focuses it. */
  const [sub, setSub] = useState<{ index: number; focus: boolean } | null>(null);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const field = useRef<HTMLInputElement>(null);
  const fallback = useRef<HTMLDivElement>(null);
  const list = menuRef ?? fallback;
  const usable = itemIndexes(entries);
  const checkable = entries.some((entry) => entry !== "separator" && entry.checked !== undefined);
  const isSubmenu = Boolean(onLeave);
  const placement = useSubmenuPlacement(isSubmenu, list);

  /** The first item that can be chosen, which Enter in the field takes and a keyboard-opened list starts on. */
  const first = usable.find((index) => !(entries[index] as MenuItem).disabled);
  /** A top-level list takes focus without highlighting a row; a keyboard-opened nested list selects its first row. */
  useEffect(() => {
    if (search) return;
    if (autoFocus) buttons.current[first ?? -1]?.focus();
    else if (!isSubmenu) list.current?.focus();
  }, [autoFocus, first, isSubmenu, list, search]);
  /** A searchable list opens with the caret in its field, once, however the items change under it. */
  const searchable = Boolean(search);
  useEffect(() => { if (searchable) field.current?.focus(); }, [searchable]);

  function move(delta: number) {
    if (!usable.length) return;
    const at = usable.indexOf(buttons.current.findIndex((button) => button === document.activeElement));
    /** Above the first item is the field, and the field goes down to the first item. */
    if (search && ((at === 0 && delta < 0) || (at < 0 && delta < 0 && document.activeElement === field.current))) {
      field.current?.focus();
      return;
    }
    const next = at < 0 ? usable[delta > 0 ? 0 : usable.length - 1]! : usable[(at + delta + usable.length) % usable.length]!;
    buttons.current[next]?.focus();
  }

  function openSubmenu(index: number, focus: boolean) {
    const entry = entries[index];
    if (sub?.index !== index && entry !== "separator") entry?.onOpen?.();
    setSub({ index, focus });
  }

  function hover(index: number, button: HTMLButtonElement) {
    const entry = entries[index];
    if (entry === "separator") return intent.cancel();
    intent.schedule(() => {
      if (!entry.disabled && (entry.items?.length || entry.panel)) openSubmenu(index, false);
      else setSub(null);
      button.focus();
    }, Boolean(sub && sub.index !== index));
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const focused = buttons.current.findIndex((button) => button === document.activeElement);
    const entry = entries[focused];
    /** Keys from a submenu drawn inside this list belong to that submenu. */
    const own = event.target === list.current || focused >= 0;
    if (own && (event.key === "Home" || event.key === "End") && usable.length) {
      event.preventDefault();
      event.stopPropagation();
      buttons.current[usable[event.key === "Home" ? 0 : usable.length - 1]!]?.focus();
    } else if (own && typeahead(event, buttons.current)) {
      return;
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      move(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "ArrowRight" && entry && entry !== "separator" && !entry.disabled && (entry.items?.length || entry.panel)) {
      event.preventDefault();
      event.stopPropagation();
      openSubmenu(focused, true);
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
      /** The pointer reached the open submenu, so the sibling it crossed on the way does not take over. */
      onMouseOver={(event) => { if ((event.target as Element).closest(".menu-popover") !== list.current) intent.cancel(); }}
    >
      {search && <MenuSearch search={search} field={field} onSubmit={() => { if (first !== undefined) buttons.current[first]?.click(); }} />}
      {search && !usable.length && <p className="menu-empty">No matches</p>}
      {entries.map((entry, index) => {
        if (entry === "separator") return <div key={`separator-${index}`} className="menu-separator" role="separator" />;
        const nested = Boolean(entry.items?.length || entry.panel);
        return (
          <Fragment key={`${index}-${entry.label}`}>
            <button
              ref={(node) => { buttons.current[index] = node; }}
              type="button"
              role={entry.checked === undefined ? "menuitem" : "menuitemcheckbox"}
              aria-checked={entry.checked}
              aria-haspopup={nested ? "menu" : undefined}
              aria-expanded={nested ? sub?.index === index : undefined}
              className={[entry.danger ? "danger-menu-item" : "", entry.className].filter(Boolean).join(" ") || undefined}
              data-tip={entry.title}
              aria-disabled={entry.disabled || undefined}
              data-default={search && index === first ? "" : undefined}
              /** The pointer highlights what it is over, which is the same highlight the keyboard moves. */
              onMouseEnter={(event) => hover(index, event.currentTarget)}
              onClick={() => {
                if (entry.disabled) return;
                if (nested) return openSubmenu(index, true);
                onClose();
                if (entry.onSelect) entry.onSelect();
                else if (entry.command) controls.dispatch(entry.command);
              }}
            >
              <span className="menu-tick" aria-hidden="true">{entry.checked && <Check size={12} />}</span>
              <span className="menu-label">{entry.label}</span>
              {(entry.shortcut ?? entry.detail) && <span className="menu-shortcut">{entry.shortcut ?? entry.detail}</span>}
              {nested && <ChevronRight className="menu-chevron" size={12} aria-hidden="true" />}
            </button>
            {entry.panel && sub?.index === index && <SubmenuPanel top={(buttons.current[index]?.offsetTop ?? 0) - 4} autoFocus={sub.focus} onLeave={() => {
              setSub(null);
              buttons.current[index]?.focus();
            }}>{entry.panel}</SubmenuPanel>}
            {!entry.panel && nested && sub?.index === index && (
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

/**
 * Draws a top-level list against the window instead of inside an ancestor that can crop it. The
 * list follows its row while the window or any scrolling container moves, and never grows past the
 * room on the side it opens toward.
 */
export function AnchoredMenuList({ entries, onClose, className, anchor, menuRef, search, align = "end" }: Pick<MenuListProps, "entries" | "onClose" | "className" | "search"> & {
  anchor: HTMLElement;
  menuRef: RefObject<HTMLDivElement | null>;
  /** Which of the row's edges the list lines up with. */
  align?: "start" | "end";
}) {
  const [style, setStyle] = useState<{ left: number; top: number; room: number } | null>(null);

  useLayoutEffect(() => {
    const place = () => {
      const box = menuRef.current?.getBoundingClientRect();
      if (!box) return;
      const row = anchor.getBoundingClientRect();
      const below = innerHeight - row.bottom - ANCHOR_GAP;
      const above = row.top - ANCHOR_GAP;
      const top = below >= box.height || below >= above
        ? row.bottom + ANCHOR_GAP
        : row.top - box.height - ANCHOR_GAP;
      const left = align === "start" ? row.left : row.right - box.width;
      const next = {
        left: Math.max(EDGE, Math.min(left, innerWidth - box.width - EDGE)),
        top: Math.max(EDGE, Math.min(top, innerHeight - box.height - EDGE)),
        room: Math.max(below, above) - EDGE,
      };
      setStyle((current) => current && current.left === next.left && current.top === next.top && current.room === next.room ? current : next);
    };
    place();
    const observer = new ResizeObserver(place);
    if (menuRef.current) observer.observe(menuRef.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [align, anchor, menuRef]);

  return createPortal(
    <MenuList
      entries={entries}
      onClose={onClose}
      className={`anchored-menu-popover ${className ?? ""}`.trimEnd()}
      menuRef={menuRef}
      search={search}
      style={{
        left: style?.left ?? 0,
        top: style?.top ?? 0,
        ...(style ? { "--menu-room": `${style.room}px` } as CSSProperties : { visibility: "hidden" }),
      }}
    />,
    document.body,
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
  /** Draws the list against the window when a scrolling or rounded ancestor would crop it. */
  anchored?: boolean;
  /** Makes the whole row the trigger: drawn inside it, with a chevron in place of the ellipsis. */
  children?: ReactNode;
};

/**
 * An ellipsis trigger, or a whole row, and the list it opens. The reducer owns which menu is open, so the only
 * state here is the comparison; the shared dismissible layer handles outside presses and Escape,
 * and focus leaving closes it here.
 */
export function PopoverMenu({ id, openMenu, onSetOpenMenu, items, label, className, popoverClassName, anchored, children }: PopoverMenuProps) {
  const open = openMenu === id;
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useDismissibleLayer(open, anchored ? [root, menu] : [root], () => onSetOpenMenu(null), trigger);
  return (
    <div
      ref={root}
      className={`${className} ${open ? "open" : ""}`.trimEnd()}
      data-popover-menu
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget) && !menu.current?.contains(event.relatedTarget)) onSetOpenMenu(null);
      }}
    >
      <button
        ref={trigger}
        className="menu-trigger"
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tip={children || open ? undefined : label}
        onClick={() => onSetOpenMenu(open ? null : id)}
      >
        {children}
        {children ? <ChevronDown className="menu-trigger-chevron" size={14} aria-hidden="true" /> : <Ellipsis size={16} />}
      </button>
      {open && anchored && root.current
        ? <AnchoredMenuList entries={items} onClose={() => onSetOpenMenu(null)} className={popoverClassName} anchor={root.current} menuRef={menu} />
        : open && <MenuList entries={items} onClose={() => onSetOpenMenu(null)} className={popoverClassName} />}
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

  /** What the menu acts on stays marked while it is open. */
  useLayoutEffect(() => {
    const target = returnFocus?.current;
    if (!target) return;
    target.setAttribute("data-menu-target", "");
    return () => target.removeAttribute("data-menu-target");
  }, [returnFocus]);

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
