import { LuFolderSymlink as FolderSymlink, LuHouse as House } from "react-icons/lu";
import { WORKTREE_MENU, type WorktreeMenuView } from "../../application/worktree-menu";
import type { AppCommand } from "../../contracts/commands";
import { worktreeHue } from "../../domain/worktree";
import { PopoverMenu, type MenuEntry } from "./PopoverMenu";
import { WorktreeMenuChoices } from "./WorktreeMenuChoices";
import "../worktree-menu.css";

export function SessionLocationMenu({ view, openMenu, dispatch }: { view: WorktreeMenuView; openMenu: string | null; dispatch: (command: AppCommand) => void }) {
  const location = view.location;
  const working = location.kind === "creating" || location.kind === "releasing";
  let label = view.worktreeId ? "Worktree" : "Local";
  if (location.kind === "creating") label = "Creating worktree…";
  if (location.kind === "releasing") label = "Removing worktree…";
  const entries: MenuEntry[] = [{ label: "New thread here", disabled: working, onSelect: () => dispatch({ type: "task.new", projectId: view.projectId, worktreeId: view.worktreeId }) }];
  if (view.worktreeId) entries.push({ label: "Threads here", shortcut: String(view.count), disabled: working || !view.count, onOpen: () => dispatch({ type: "worktree.menu-open", list: "threads" }), panel: <WorktreeMenuChoices key={`threads-${view.threadId}`} view={view} list="threads" dispatch={dispatch} /> });
  entries.push("separator", { label: "Move to worktree", disabled: !view.canMove, onOpen: () => dispatch({ type: "worktree.menu-open", list: "destinations" }), panel: <WorktreeMenuChoices key={`destinations-${view.threadId}`} view={view} list="destinations" dispatch={dispatch} /> });
  if (view.worktreeId) entries.push({ label: "Return to local", disabled: !view.canMove, onSelect: () => dispatch({ type: "task.move-worktree", taskId: view.threadId, destination: { kind: "local" } }) });
  if (view.deleteRoot) entries.push("separator", { label: "Delete worktree…", danger: true, disabled: !view.canDelete, shortcut: view.busyCount ? `${view.busyCount} active` : undefined, onSelect: () => dispatch({ type: "worktree.confirm-delete", root: view.deleteRoot }) });
  return <div className="session-location">
    <PopoverMenu id={WORKTREE_MENU} openMenu={openMenu} onSetOpenMenu={(menu) => dispatch({ type: "view.set-menu", menu })} label="Thread options" className="session-row session-location-row" popoverClassName="session-menu-popover" anchored items={entries}>
      <span className={`session-row-icon${view.worktreeId ? ` worktree-mark hue-${worktreeHue(view.worktreeId)}` : ""}`}>{view.worktreeId || working ? <FolderSymlink size={18} /> : <House size={18} />}</span>
      <span className="session-location-name" title={location.kind === "worktree" ? location.worktree.root : undefined}>
        <em className={working ? "text-sweep" : undefined}>{label}</em>
        {view.worktreeId && view.count > 1 && <small>{view.count} threads</small>}
      </span>
    </PopoverMenu>
    {view.error && openMenu !== WORKTREE_MENU && <p className="worktree-menu-error" role="alert">{view.error}</p>}
  </div>;
}
