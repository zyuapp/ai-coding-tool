import { useId, useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef, type ComponentPropsWithRef, type CSSProperties, type ElementType, type KeyboardEvent, type ReactNode, type Ref, type RefObject } from "react";
import { LuCheck as Check, LuChevronDown as ChevronDown, LuChevronRight as ChevronRight } from "react-icons/lu";
import { SearchField } from "./Field";
import "./glass.css";
import "./menu.css";
import "./menu-trigger.css";

const joined = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(" ") || undefined;

export type MenuSurfaceProps = ComponentPropsWithRef<"div"> & {
  /** Reserves the tick column on every row, so ticking one never moves a label. Set whenever any row in the list can be ticked. */
  checkable?: boolean;
  /** Drawn against the window rather than inside its container, as `useMenuAnchor` places it. */
  anchored?: boolean;
  /** Scrolls when taller than `--menu-max-height`, or the room `useMenuAnchor` found. */
  scroll?: boolean;
};

/** The pane every menu and picker is drawn on. */
export function MenuSurface({ checkable, anchored, scroll, className, ...rest }: MenuSurfaceProps) {
  return <div
    data-popover-menu
    {...rest}
    className={joined("glass-popover menu-popover", className)}
    data-checkable={checkable ? "" : undefined}
    data-anchored={anchored ? "" : undefined}
    data-scroll={scroll ? "" : undefined}
  />;
}

/** The part of a surface that scrolls, for a surface whose edge actions stay in view. */
export function MenuScroll({ className, ...rest }: ComponentPropsWithRef<"div">) {
  return <div {...rest} className={joined("menu-scroll", className)} />;
}

export type MenuItemProps = Omit<ComponentPropsWithRef<"button">, "role" | "disabled"> & {
  /** Defaults to menuitem, or menuitemcheckbox once `checked` is given. */
  role?: "menuitem" | "menuitemcheckbox" | "menuitemradio" | "option" | "button";
  /** Draws the tick in the leading column. Undefined for a row that is never ticked. */
  checked?: boolean;
  /** Drawn in the tick column in place of the tick, for an action such as creating what was typed. */
  mark?: ReactNode;
  icon?: ReactNode;
  /** A second line under the label. */
  description?: ReactNode;
  /** Quiet words against the right edge, such as which computer holds the item. */
  detail?: ReactNode;
  /** The keystroke that does the same, in the same place as `detail`. */
  shortcut?: ReactNode;
  danger?: boolean;
  /** Cannot be chosen, but stays reachable by the keyboard so its reason can be read. */
  disabled?: boolean;
  /** The row opens a list of its own. */
  chevron?: boolean;
  /** Wears the pick wash without the pointer or focus, as the row Enter will take. */
  active?: boolean;
};

function checkedState(role: NonNullable<MenuItemProps["role"]>, checked: boolean | undefined) {
  if (checked === undefined || role === "menuitem") return {};
  if (role === "option") return { "aria-selected": checked };
  if (role === "button") return { "aria-pressed": checked };
  return { "aria-checked": checked };
}

/** One row of a menu or picker: tick, icon, label over an optional description, then detail and chevron. */
export function MenuItem({ role, checked, mark, icon, description, detail, shortcut, danger, disabled, chevron, active, className, type = "button", onClick, children, ...rest }: MenuItemProps) {
  const kind = role ?? (checked === undefined ? "menuitem" : "menuitemcheckbox");
  const trailing = shortcut ?? detail;
  return <button
    {...rest}
    {...checkedState(kind, checked)}
    type={type}
    role={kind}
    className={joined("menu-item", className)}
    aria-disabled={disabled || undefined}
    data-danger={danger ? "" : undefined}
    data-active={active ? "" : undefined}
    onClick={disabled ? undefined : onClick}
  >
    <span className="menu-tick" aria-hidden="true">{mark ?? (checked && <Check size={14} />)}</span>
    {icon && <span className="menu-icon" aria-hidden="true">{icon}</span>}
    <span className="menu-copy">
      <span className="menu-label">{children}</span>
      {description && <small className="menu-description">{description}</small>}
    </span>
    {trailing !== undefined && trailing !== null && trailing !== "" && <span className="menu-shortcut">{trailing}</span>}
    {chevron && <ChevronRight className="menu-chevron" size={12} aria-hidden="true" />}
  </button>;
}

/** Rows under a plain label naming what they are. */
export function MenuGroup({ label, className, children, ...rest }: Omit<ComponentPropsWithRef<"div">, "role"> & { label: ReactNode }) {
  const id = useId();
  return <div {...rest} role="group" aria-labelledby={id} className={joined("menu-group", className)}>
    <div id={id} className="menu-group-label">{label}</div>
    {children}
  </div>;
}

/** The list of options a picker chooses from, below its search field. */
export function MenuOptions({ className, ...rest }: Omit<ComponentPropsWithRef<"div">, "role">) {
  return <div {...rest} role="listbox" className={joined("menu-group", className)} />;
}

/** A label over a whole menu, set like a group's. */
export function MenuHeading({ className, ...rest }: ComponentPropsWithRef<"div">) {
  return <div {...rest} className={joined("menu-group-label", className)} />;
}

export function MenuSeparator({ className }: { className?: string }) {
  return <div className={joined("menu-separator", className)} role="separator" />;
}

/** A line of quiet text in a menu: an empty list, a status, or an error. */
export function MenuNote({ tone = "quiet", className, ...rest }: ComponentPropsWithRef<"p"> & { tone?: "quiet" | "danger" }) {
  return <p {...rest} className={joined("menu-note", className)} data-tone={tone === "quiet" ? undefined : tone} />;
}

/** An action pinned above or below the list, outside what scrolls, ruled off from the rows it shares columns with. */
export function MenuEdgeAction({ edge = "bottom", className, ...item }: MenuItemProps & { edge?: "top" | "bottom" }) {
  const action = <MenuItem {...item} className={joined("menu-edge-action", className)} />;
  return edge === "top" ? <>{action}<MenuSeparator /></> : <><MenuSeparator />{action}</>;
}

export type MenuTriggerProps = Omit<ComponentPropsWithoutRef<"button">, "type"> & {
  ref?: Ref<HTMLElement>;
  /** A summary opens the details it heads, and follows that element's open state. */
  as?: "button" | "summary";
  /** `pill` is a raised capsule of glass; `field` and `ghost` carry no edge, a field showing its value at reading strength and a ghost staying quiet. */
  variant?: "pill" | "field" | "ghost";
  icon?: ReactNode;
  /** The value in the danger hue: one that acts without asking, or that could not be read. */
  tone?: "danger";
  /** Tinted with the accent, as a toggle that is on. */
  chosen?: boolean;
  chevron?: boolean;
};

/** What opens a menu or picker: an optional icon, the current value, and a chevron. Open while `aria-expanded`, or while its details is. */
export function MenuTrigger({ as = "button", variant = "pill", icon, tone, chosen, chevron = true, className, children, ...rest }: MenuTriggerProps) {
  const Tag = as as ElementType;
  return <Tag
    {...(as === "button" ? { type: "button" } : {})}
    {...rest}
    className={joined("menu-opener", className)}
    data-variant={variant}
    data-tone={tone}
    data-chosen={chosen ? "" : undefined}
  >
    {icon}
    {children}
    {chevron && <ChevronDown className="menu-opener-chevron" size={variant === "pill" ? 12 : 14} aria-hidden="true" />}
  </Tag>;
}

export type MenuSearchProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Enter in the field, for a list whose top row is what a typed query means. */
  onSubmit?: () => void;
  placeholder?: string;
  inputRef?: RefObject<HTMLInputElement | null>;
  autoFocus?: boolean;
};

/** The field heading a searchable menu. It stays put while the rows scroll, and Escape empties a typed search before it closes the menu. */
export function MenuSearch({ label, value, onChange, onSubmit, placeholder, inputRef, autoFocus }: MenuSearchProps) {
  return <div className="menu-search">
    <SearchField
      ref={inputRef}
      variant="menu"
      label={label}
      placeholder={placeholder ?? label}
      value={value}
      autoFocus={autoFocus}
      onInput={(event) => onChange(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape" && value) {
          event.stopPropagation();
          onChange("");
        } else if (event.key === "Enter" && onSubmit) onSubmit();
        else return;
        event.preventDefault();
      }}
    />
  </div>;
}

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

/**
 * Keys for a flat list of rows, set on the element holding them: the arrows walk the rows and wrap,
 * Home and End reach the ends, letters jump by name, and the list's search field sits above the first
 * row. A disabled row stays reachable so its reason can be read.
 */
export function useListKeys() {
  const typeahead = useTypeahead();
  return (event: KeyboardEvent<HTMLElement>) => {
    const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".menu-item:not(:disabled)")];
    const field = event.currentTarget.querySelector<HTMLInputElement>(".menu-search input");
    const inField = field !== null && event.target === field;
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    let next: HTMLElement | null | undefined;
    if (event.key === "ArrowDown") next = at < 0 ? rows[0] : rows[(at + 1) % rows.length];
    else if (event.key === "ArrowUp") {
      if (inField) return;
      next = at === 0 && field ? field : at < 0 ? rows.at(-1) : rows[(at - 1 + rows.length) % rows.length];
    } else if ((event.key === "Home" || event.key === "End") && !inField) next = event.key === "Home" ? rows[0] : rows.at(-1);
    else if (!inField) {
      typeahead(event, rows);
      return;
    } else return;
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    next.focus();
  };
}

/** How close to the window's edge a menu may be drawn. */
const EDGE = 8;
/** The gap between a row and a menu hung off it. */
const ANCHOR_GAP = 4;

export type MenuAnchorOptions = {
  /** Which of the anchor's edges the menu lines up with. */
  align?: "start" | "end";
  /** Sizes the menu to the anchor, kept between these widths; without it the menu takes its own width. */
  minWidth?: number;
  maxWidth?: number;
};

/**
 * Places an anchored surface against the window beside `anchor`, on whichever side has more room
 * unless it fits below, and slides it back inside the window. It follows the anchor while the window
 * or any scrolling container moves, and sets `--menu-room` to the height it may grow to. Hidden until placed.
 */
export function useMenuAnchor(anchor: HTMLElement | null | undefined, menu: RefObject<HTMLElement | null>, { align = "start", minWidth, maxWidth = Infinity }: MenuAnchorOptions = {}): CSSProperties {
  const [placed, setPlaced] = useState<{ left: number; top?: number; bottom?: number; width?: number; room: number } | null>(null);

  useLayoutEffect(() => {
    if (!anchor) return;
    const place = () => {
      const row = anchor.getBoundingClientRect();
      const box = menu.current?.getBoundingClientRect();
      const below = innerHeight - row.bottom - ANCHOR_GAP - EDGE;
      const above = row.top - ANCHOR_GAP - EDGE;
      const down = (box !== undefined && below >= box.height) || below >= above;
      const width = minWidth === undefined ? undefined : Math.min(Math.max(row.width, minWidth), maxWidth, innerWidth - EDGE * 2);
      const drawn = width ?? box?.width ?? 0;
      const start = align === "start" ? row.left : row.right - drawn;
      const next = {
        left: Math.max(EDGE, Math.min(start, innerWidth - drawn - EDGE)),
        top: down ? row.bottom + ANCHOR_GAP : undefined,
        bottom: down ? undefined : innerHeight - row.top + ANCHOR_GAP,
        width,
        room: Math.max(0, down ? below : above),
      };
      setPlaced((current) => current && current.left === next.left && current.top === next.top && current.bottom === next.bottom && current.width === next.width && current.room === next.room ? current : next);
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(anchor);
    if (anchor.parentElement) observer.observe(anchor.parentElement);
    if (menu.current) observer.observe(menu.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, menu, align, minWidth, maxWidth]);

  if (!placed) return { visibility: "hidden", left: 0, top: 0 };
  return { left: placed.left, top: placed.top, bottom: placed.bottom, width: placed.width, "--menu-room": `${placed.room}px` } as CSSProperties;
}
