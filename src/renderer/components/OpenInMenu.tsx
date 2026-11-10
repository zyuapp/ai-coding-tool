import { LuCode as Code, LuFolder as Folder, LuFolderCode as FolderCode, LuSquareTerminal as SquareTerminal } from "react-icons/lu";
import { useEffect, useRef } from "react";
import type { InstalledApp } from "../../contracts/ipc";
import type { ExternalAppKind } from "../../domain/external-apps";
import { useDismissibleLayer } from "../focus";
import { IconButton } from "../ui/Button";
import { MenuNote } from "../ui/Menu";
import { MenuList, type MenuSection } from "./PopoverMenu";

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
};

/** The topbar button that hands the thread's checkout to another application on the machine. */
export function OpenInMenu({ openMenu, onSetOpenMenu, blocked, apps, onListApps, onOpenInApp }: OpenInMenuProps) {
  const open = openMenu === OPEN_IN_MENU && !blocked;
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useDismissibleLayer(open, [root], () => onSetOpenMenu(null), trigger);
  useEffect(() => { if (open) onListApps(); }, [open]);
  const entries: MenuSection[] = GROUPS
    .map((group) => ({
      group: group.label,
      items: (apps ?? []).filter((app) => app.kind === group.kind).map((app) => {
        const Icon = KIND_ICONS[app.kind];
        return {
          label: app.label,
          icon: app.icon ? <img src={app.icon} alt="" width={20} height={20} /> : <Icon size={20} />,
          onSelect: () => onOpenInApp(app.id),
        };
      }),
    }))
    .filter((group) => group.items.length > 0);

  const triggerProps = {
    ref: trigger,
    type: "button" as const,
    "aria-haspopup": "menu" as const,
    "aria-expanded": open,
    "aria-disabled": blocked ? "true" as const : undefined,
    onClick: () => { if (!blocked) onSetOpenMenu(open ? null : OPEN_IN_MENU); },
  };

  const popover = open && (
    <MenuList
      entries={entries}
      onClose={() => onSetOpenMenu(null)}
      className="open-in-popover"
      empty={<MenuNote role={apps ? undefined : "status"}>{apps ? "No application found" : "Looking for applications…"}</MenuNote>}
    />
  );

  return (
    <div ref={root} className={`open-in ${open ? "open" : ""}`.trimEnd()} data-popover-menu>
      <IconButton {...triggerProps} size="lg" label="Open this folder in another application" tip={blocked ? `Open in… · ${blocked}` : "Open in…"}>
        <FolderCode size={18} aria-hidden="true" />
      </IconButton>
      {popover}
    </div>
  );
}
