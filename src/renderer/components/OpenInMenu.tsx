import { LuCode as Code, LuExternalLink as ExternalLink, LuFolder as Folder, LuSquareTerminal as SquareTerminal } from "react-icons/lu";
import { Fragment, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { InstalledApp } from "../../contracts/ipc";
import type { ExternalAppKind } from "../../domain/external-apps";
import { moveListFocus, useDismissibleLayer } from "../focus";
import { useAnchoredStyle } from "./BranchMenu";
import { useTypeahead } from "./PopoverMenu";

export const OPEN_IN_MENU = "workspace:open-in";
export const PROJECT_OPEN_IN_MENU = "workspace:open-in:project";

/** The heading each kind sits under, in the order the list draws them. */
const GROUPS: { kind: ExternalAppKind; label: string }[] = [
  { kind: "editor", label: "Editors" },
  { kind: "terminal", label: "Terminals" },
  { kind: "files", label: "Files" },
];

/** What a row shows when the platform keeps the application's own icon somewhere unreadable. */
const KIND_ICONS = {
  editor: Code,
  terminal: SquareTerminal,
  files: Folder,
} as const;

export type OpenInMenuProps = {
  openMenu: string | null;
  onSetOpenMenu: (menu: string | null) => void;
  /** Why the thread has no checkout to hand over yet, such as a worktree still being made; null when it has one. */
  blocked: string | null;
  /**
   * The applications this machine has, or null before any have been found. The main process scans
   * again once its answer is old enough, so one installed during the session turns up here.
   */
  apps: InstalledApp[] | null;
  onListApps: () => void;
  onOpenInApp: (appId: string) => void;
  /** Draws the trigger as the heading's project name, with the list hung beneath it. */
  crumb?: { label: string; tip: string };
};

/** The topbar button that hands the thread's checkout to another application on the machine. */
export function OpenInMenu({ openMenu, onSetOpenMenu, blocked, apps, onListApps, onOpenInApp, crumb }: OpenInMenuProps) {
  const id = crumb ? PROJECT_OPEN_IN_MENU : OPEN_IN_MENU;
  const open = openMenu === id && !blocked;
  const root = useRef<HTMLDivElement>(null);
  const crumbRoot = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useDismissibleLayer(open, [crumb ? crumbRoot : root, list], () => onSetOpenMenu(null), trigger);
  const typeahead = useTypeahead();
  const anchored = useAnchoredStyle(crumb && open ? trigger : null, 208, 320);
  useEffect(() => { if (open) onListApps(); }, [open]);
  /** The list itself takes focus, not a row, so it opens with nothing highlighted and still hears the arrow keys. */
  useEffect(() => { if (open) list.current?.focus(); }, [open]);
  const groups = GROUPS
    .map((group) => ({ ...group, apps: (apps ?? []).filter((app) => app.kind === group.kind) }))
    .filter((group) => group.apps.length > 0);

  const triggerProps = {
    ref: trigger,
    type: "button" as const,
    "aria-haspopup": "menu" as const,
    "aria-expanded": open,
    "aria-disabled": blocked ? "true" as const : undefined,
    onClick: () => { if (!blocked) onSetOpenMenu(open ? null : id); },
  };

  const popover = open && (
    <div ref={list} className={`menu-popover open-in-popover ${crumb ? "anchored" : ""}`.trimEnd()} style={crumb ? (anchored ? { ...anchored, width: undefined } : { visibility: "hidden" }) : undefined} data-popover-menu role="menu" tabIndex={-1} onKeyDown={(event) => {
      const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
      if ((event.key === "Home" || event.key === "End") && rows.length) {
        event.preventDefault();
        rows[event.key === "Home" ? 0 : rows.length - 1]!.focus();
      } else if (!typeahead(event, rows)) moveListFocus(event);
    }}>
      {!apps && <p className="open-in-empty" role="status">Looking for applications…</p>}
      {apps && groups.length === 0 && <p className="open-in-empty">No application found</p>}
      {groups.map((group) => (
        <Fragment key={group.kind}>
          <p className="open-in-group">{group.label}</p>
          {group.apps.map((app) => {
            const Icon = KIND_ICONS[app.kind];
            return (
              <button
                key={app.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  onSetOpenMenu(null);
                  onOpenInApp(app.id);
                }}
              >
                <span className="open-in-icon">
                  {app.icon ? <img src={app.icon} alt="" width={20} height={20} /> : <Icon size={20} />}
                </span>
                <span>{app.label}</span>
              </button>
            );
          })}
        </Fragment>
      ))}
    </div>
  );

  if (crumb) {
    return (
      <span ref={crumbRoot} className={`heading-project ${open ? "open" : ""}`.trimEnd()}>
        <button {...triggerProps} data-tip={blocked ? `${crumb.tip} · ${blocked}` : crumb.tip}>{crumb.label}</button>
        {popover && createPortal(popover, document.body)}
      </span>
    );
  }

  return (
    <div ref={root} className={`open-in ${open ? "open" : ""}`.trimEnd()} data-popover-menu>
      <button
        {...triggerProps}
        className={`session-toggle ${open ? "active" : ""}`}
        aria-label="Open this folder in another application"
        data-tip={blocked ? `Open in… · ${blocked}` : "Open in…"}
      >
        <ExternalLink size={18} aria-hidden="true" />
      </button>
      {popover}
    </div>
  );
}
