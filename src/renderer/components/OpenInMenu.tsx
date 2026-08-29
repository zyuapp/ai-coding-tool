import { LuCode as Code, LuExternalLink as ExternalLink, LuFolder as Folder, LuSquareTerminal as SquareTerminal } from "react-icons/lu";
import { Fragment, useEffect, useRef, useState } from "react";
import type { InstalledApp } from "../../contracts/ipc";
import type { ExternalAppKind } from "../../domain/external-apps";
import { moveListFocus, useDismissibleLayer } from "../focus";

export const OPEN_IN_MENU = "workspace:open-in";

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

/**
 * The applications this machine has, read while the list is open. The main process scans again once
 * its answer is old enough, so an application installed during the session turns up here.
 */
export function useInstalledApps(enabled: boolean) {
  const [apps, setApps] = useState<InstalledApp[] | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void window.desktop.listApps()
      .then((found) => { if (!cancelled) setApps(found); })
      .catch(() => { if (!cancelled) setApps([]); });
    return () => { cancelled = true; };
  }, [enabled]);

  return apps;
}

export type OpenInMenuProps = {
  openMenu: string | null;
  onSetOpenMenu: (menu: string | null) => void;
  /** False while the thread has no checkout to hand over, such as a worktree still being made. */
  enabled: boolean;
  onOpenInApp: (appId: string) => void;
};

/** The topbar button that hands the thread's checkout to another application on the machine. */
export function OpenInMenu({ openMenu, onSetOpenMenu, enabled, onOpenInApp }: OpenInMenuProps) {
  const open = openMenu === OPEN_IN_MENU;
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useDismissibleLayer(open, [root], () => onSetOpenMenu(null), trigger);
  const apps = useInstalledApps(open);
  /** The list itself takes focus, not a row, so it opens with nothing highlighted and still hears the arrow keys. */
  useEffect(() => { if (open) list.current?.focus(); }, [open]);
  const groups = GROUPS
    .map((group) => ({ ...group, apps: (apps ?? []).filter((app) => app.kind === group.kind) }))
    .filter((group) => group.apps.length > 0);

  return (
    <div ref={root} className={`open-in ${open ? "open" : ""}`.trimEnd()} data-popover-menu>
      <button
        ref={trigger}
        className={`session-toggle ${open ? "active" : ""}`}
        type="button"
        aria-label="Open this folder in another application"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!enabled}
        onClick={() => onSetOpenMenu(open ? null : OPEN_IN_MENU)}
      >
        <ExternalLink size={19} aria-hidden="true" />
      </button>
      {open && (
        <div ref={list} className="menu-popover open-in-popover" data-popover-menu role="menu" tabIndex={-1} onKeyDown={moveListFocus}>
          {!apps && <p className="open-in-empty">Looking for applications…</p>}
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
      )}
    </div>
  );
}
