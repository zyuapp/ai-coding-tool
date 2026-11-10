import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { LuChevronDown as ChevronDown, LuEllipsis as Ellipsis } from "react-icons/lu";
import { useDismissibleLayer } from "../focus";
import { useCommandControls } from "./CommandControl";
import type { AppCommand } from "../../contracts/commands";
import { REMOTE_UNSUPPORTED } from "../../contracts/computer-capabilities";
import { MenuGroup, MenuItem as MenuRow, MenuNote, MenuSearch, MenuSeparator, MenuSurface, useMenuAnchor, useTypeahead } from "../ui/Menu";

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
  icon?: ReactNode;
  /** A second line under the label. */
  description?: string;
  /** Opens beside the item. An item with a list of its own chooses nothing itself. */
  items?: MenuItem[];
  /** A submenu with its own search field or virtual list. */
  panel?: ReactNode;
  onOpen?: () => void;
};

/** Items under a label naming what they are. */
export type MenuSection = { group: string; items: MenuItem[] };

/** A rule between two groups of items. */
export type MenuEntry = MenuItem | "separator";

/** What a list draws: items, rules, and labelled groups. */
export type MenuListEntry = MenuEntry | MenuSection;

function isItem(entry: MenuListEntry): entry is MenuItem {
  return entry !== "separator" && !("group" in entry);
}

/** How close to the window's edge a menu may be drawn. */
const EDGE = 8;

/** How long the pointer may rest on a sibling before an open submenu gives way to it, so a diagonal path into the submenu keeps it. */
const SUBMENU_INTENT_MS = 220;

function SubmenuPanel({ children, top, autoFocus, onLeave }: { children: ReactNode; top: number; autoFocus: boolean; onLeave: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const place = () => {
      const box = element.getBoundingClientRect();
      const parent = element.parentElement!.getBoundingClientRect();
      let left = parent.right + 3;
      if (left + box.width + EDGE > innerWidth) left = parent.left - box.width - 3;
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
  return <MenuSurface ref={root} className="menu-submenu" style={placement ?? { top }} onKeyDown={(event) => {
    if (event.key === "Escape" || event.key === "ArrowLeft" && (event.target as HTMLElement).tagName !== "INPUT") {
      event.preventDefault();
      event.stopPropagation();
      onLeave();
    }
  }}>{children}</MenuSurface>;
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
  entries: MenuListEntry[];
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
  /** Reserves the tick column. Defaults to whether any item given can be ticked; set it for a list a search may empty of those. */
  checkable?: boolean;
  /** What the list says while it has no items. A searched list says there are no matches. */
  empty?: ReactNode;
  anchored?: boolean;
};

/** Items in the order they are drawn, groups opened up. */
function itemsOf(entries: MenuListEntry[]): MenuItem[] {
  return entries.flatMap((entry) => entry === "separator" ? [] : isItem(entry) ? [entry] : entry.items);
}

/** Choosing an item always closes the menu, so no item has to remember to. */
export function MenuList({ entries: supplied, onClose, className, style, menuRef, autoFocus, onLeave, search, checkable, empty, anchored }: MenuListProps) {
  const controls = useCommandControls();
  const remote = (item: MenuItem): MenuItem => item.command && !controls.available(item.command)
    ? { ...item, disabled: true, title: REMOTE_UNSUPPORTED, shortcut: undefined, detail: "Not on remote" } : item;
  const entries = supplied.map((entry) => entry === "separator" ? entry : isItem(entry) ? remote(entry) : { ...entry, items: entry.items.map(remote) });
  /** Every item the keyboard can rest on. A disabled item stays reachable so its reason can be read. */
  const items = itemsOf(entries);
  const typeahead = useTypeahead();
  const intent = useHoverIntent();
  /** Which item's own list is open, and whether the keyboard asked for it, which is what focuses it. */
  const [sub, setSub] = useState<{ index: number; focus: boolean } | null>(null);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const field = useRef<HTMLInputElement>(null);
  const fallback = useRef<HTMLDivElement>(null);
  const list = menuRef ?? fallback;
  const isSubmenu = Boolean(onLeave);
  const placement = useSubmenuPlacement(isSubmenu, list);

  /** The first item that can be chosen, which Enter in the field takes and a keyboard-opened list starts on. */
  const first = items.findIndex((item) => !item.disabled);
  /** A top-level list takes focus without highlighting a row; a keyboard-opened nested list selects its first row. */
  useEffect(() => {
    if (search) return;
    if (autoFocus) buttons.current[first]?.focus();
    else if (!isSubmenu) list.current?.focus();
  }, [autoFocus, first, isSubmenu, list, search]);
  /** A searchable list opens with the caret in its field, once, however the items change under it. */
  const searchable = Boolean(search);
  useEffect(() => { if (searchable) field.current?.focus(); }, [searchable]);

  function move(delta: number) {
    if (!items.length) return;
    const at = buttons.current.findIndex((button) => button === document.activeElement);
    /** Above the first item is the field, and the field goes down to the first item. */
    if (search && delta < 0 && (at === 0 || (at < 0 && document.activeElement === field.current))) {
      field.current?.focus();
      return;
    }
    const next = at < 0 ? (delta > 0 ? 0 : items.length - 1) : (at + delta + items.length) % items.length;
    buttons.current[next]?.focus();
  }

  function openSubmenu(index: number, focus: boolean) {
    if (sub?.index !== index) items[index]?.onOpen?.();
    setSub({ index, focus });
  }

  function hover(index: number, button: HTMLButtonElement) {
    const item = items[index]!;
    intent.schedule(() => {
      if (!item.disabled && (item.items?.length || item.panel)) openSubmenu(index, false);
      else setSub(null);
      button.focus();
    }, Boolean(sub && sub.index !== index));
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const focused = buttons.current.findIndex((button) => button === document.activeElement);
    const item = items[focused];
    /** Keys from a submenu drawn inside this list belong to that submenu. */
    const own = event.target === list.current || focused >= 0;
    if (own && (event.key === "Home" || event.key === "End") && items.length) {
      event.preventDefault();
      event.stopPropagation();
      buttons.current[event.key === "Home" ? 0 : items.length - 1]?.focus();
    } else if (own && typeahead(event, buttons.current.slice(0, items.length))) {
      return;
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      move(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "ArrowRight" && item && !item.disabled && (item.items?.length || item.panel)) {
      event.preventDefault();
      event.stopPropagation();
      openSubmenu(focused, true);
    } else if (event.key === "ArrowLeft" && onLeave) {
      event.preventDefault();
      event.stopPropagation();
      onLeave();
    }
  }

  function leave(index: number) {
    setSub(null);
    buttons.current[index]?.focus();
  }

  function row(item: MenuItem, index: number) {
    const nested = Boolean(item.items?.length || item.panel);
    const open = sub?.index === index;
    return (
      <Fragment key={`${index}-${item.label}`}>
        <MenuRow
          ref={(node) => { buttons.current[index] = node; }}
          checked={item.checked}
          aria-haspopup={nested ? "menu" : undefined}
          aria-expanded={nested ? open : undefined}
          className={item.className}
          icon={item.icon}
          description={item.description}
          shortcut={item.shortcut ?? item.detail}
          chevron={nested}
          danger={item.danger}
          data-tip={item.title}
          disabled={item.disabled}
          data-default={search && index === first ? "" : undefined}
          /** The pointer highlights what it is over, which is the same highlight the keyboard moves. */
          onMouseEnter={(event) => hover(index, event.currentTarget)}
          onClick={() => {
            if (nested) return openSubmenu(index, true);
            onClose();
            if (item.onSelect) item.onSelect();
            else if (item.command) controls.dispatch(item.command);
          }}
        >
          {item.label}
        </MenuRow>
        {item.panel && open && <SubmenuPanel top={(buttons.current[index]?.offsetTop ?? 0) - 4} autoFocus={sub.focus} onLeave={() => leave(index)}>{item.panel}</SubmenuPanel>}
        {!item.panel && nested && open && (
          <MenuList
            entries={item.items!}
            onClose={onClose}
            onLeave={() => leave(index)}
            autoFocus={sub.focus}
            className="menu-submenu"
            style={{ top: (buttons.current[index]?.offsetTop ?? 0) - 4 }}
          />
        )}
      </Fragment>
    );
  }

  let next = 0;
  const content = entries.map((entry, at) => {
    if (entry === "separator") return <MenuSeparator key={`separator-${at}`} />;
    if (isItem(entry)) return row(entry, next++);
    return <MenuGroup key={`group-${entry.group}`} label={entry.group}>{entry.items.map((item) => row(item, next++))}</MenuGroup>;
  });

  return (
    <MenuSurface
      ref={list}
      className={["menu-list", placement.flipped && "menu-flipped", className].filter(Boolean).join(" ")}
      role="menu"
      tabIndex={isSubmenu ? undefined : -1}
      checkable={checkable ?? items.some((item) => item.checked !== undefined)}
      anchored={anchored}
      style={placement.lift && typeof style?.top === "number" ? { ...style, top: style.top - placement.lift } : style}
      onKeyDown={onKeyDown}
      /** The pointer reached the open submenu, so the sibling it crossed on the way does not take over. */
      onMouseOver={(event) => { if ((event.target as Element).closest(".menu-popover") !== list.current) intent.cancel(); }}
    >
      {search && <MenuSearch label={search.label} value={search.value} onChange={search.onChange} inputRef={field} onSubmit={() => { if (first >= 0) buttons.current[first]?.click(); }} />}
      {!items.length && (empty ?? (search && <MenuNote>No matches</MenuNote>))}
      {content}
    </MenuSurface>
  );
}

/**
 * Draws a top-level list against the window instead of inside an ancestor that can crop it. The
 * list follows its row while the window or any scrolling container moves, and never grows past the
 * room on the side it opens toward.
 */
export function AnchoredMenuList({ anchor, menuRef, align = "end", className, ...list }: Pick<MenuListProps, "entries" | "onClose" | "className" | "search" | "checkable" | "empty"> & {
  anchor: HTMLElement;
  menuRef: RefObject<HTMLDivElement | null>;
  /** Which of the row's edges the list lines up with. */
  align?: "start" | "end";
}) {
  const style = useMenuAnchor(anchor, menuRef, { align });
  return createPortal(
    <MenuList {...list} className={`anchored-menu-popover ${className ?? ""}`.trimEnd()} menuRef={menuRef} anchored style={style} />,
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
 * An ellipsis trigger, or a whole row, and the list it opens on a click or a right-click. The reducer owns which menu is open, so the only
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
        onContextMenu={(event) => {
          event.preventDefault();
          onSetOpenMenu(id);
        }}
      >
        {children}
        {children ? <ChevronDown className="menu-trigger-chevron" size={14} aria-hidden="true" /> : <Ellipsis size={16} />}
      </button>
      {open && anchored && root.current
        ? <AnchoredMenuList entries={items} onClose={() => onSetOpenMenu(null)} className={popoverClassName} anchor={root.current} menuRef={menu} />
        : open && <MenuList entries={items} onClose={() => onSetOpenMenu(null)} className={`menu-dropdown ${popoverClassName ?? ""}`.trimEnd()} />}
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
      anchored
      /** Hidden until it has been measured, so it is never seen at the place it was measured from. */
      style={{ left: placed?.left ?? at.x, top: placed?.top ?? at.y, ...(placed ? {} : { visibility: "hidden" }) }}
    />,
    document.body,
  );
}
