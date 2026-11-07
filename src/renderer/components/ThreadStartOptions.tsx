import { LuChevronDown as ChevronDown, LuCircleAlert as CircleAlert, LuClock as Clock, LuFolderGit2 as FolderGit2, LuFolderSymlink as FolderSymlink, LuGitBranch as GitBranch, LuMessageCircle as MessageCircle, LuPlus as Plus, LuWaypoints as Waypoints, LuX as X } from "react-icons/lu";
import { useRef, useState } from "react";
import type { DraftBranch } from "../../application/workspace-state";
import type { ThreadHost } from "../../application/computers";
import type { MobileWorktreeChoice } from "../../contracts/mobile";
import { HostMark } from "./HostMark";
import { BranchMenu, useBranches } from "./BranchMenu";
import { folderName, projectName, type Project } from "../../domain/project";
import { useDismissibleLayer } from "../focus";
import { PickerOption, PickerPopover, PickerSearch } from "./Picker";

/** Which projects a typed query keeps, matched on the name, path, and computer shown. */
export function matchProjects(projects: Project[], query: string, projectHosts?: ReadonlyMap<string, ThreadHost>) {
  const needle = query.trim().toLowerCase();
  if (!needle) return projects;
  const localHostName = projects.some((project) => projectHosts?.has(project.id)) ? "This computer" : "";
  return projects.filter((project) => `${projectName(project)} ${project.root} ${projectHosts?.get(project.id)?.name ?? localHostName}`.toLowerCase().includes(needle));
}

/** The recently picked projects that still exist, newest first. */
export function recentProjects(projects: Project[], recentIds: readonly string[]) {
  const byId = new Map(projects.map((project) => [project.id, project]));
  return recentIds.flatMap((id) => byId.get(id) ?? []);
}

/** Projects named like another on the same computer, which their parent folder tells apart. */
function namesakes(projects: Project[], projectHosts?: ReadonlyMap<string, ThreadHost>) {
  const key = (project: Project) => `${projectHosts?.get(project.id)?.id ?? ""}\0${projectName(project)}`;
  const counts = new Map<string, number>();
  for (const project of projects) counts.set(key(project), (counts.get(key(project)) ?? 0) + 1);
  return new Set(projects.filter((project) => (counts.get(key(project)) ?? 0) > 1).map((project) => project.id));
}

function parentFolder(root: string) {
  const trimmed = root.replace(/\/+$/, "");
  return folderName(trimmed.slice(0, trimmed.lastIndexOf("/")) || "/");
}

/** Each computer's projects by name, with this computer before the paired computers by name. */
function groupProjects(projects: Project[], projectHosts?: ReadonlyMap<string, ThreadHost>) {
  const groups = new Map<string | null, { host: ThreadHost | undefined; projects: Project[] }>();
  for (const project of projects) {
    const host = projectHosts?.get(project.id);
    const id = host?.id ?? null;
    let group = groups.get(id);
    if (!group) {
      group = { host, projects: [] };
      groups.set(id, group);
    }
    group.projects.push(project);
  }
  for (const group of groups.values()) group.projects.sort((a, b) => projectName(a).localeCompare(projectName(b)) || a.root.localeCompare(b.root));
  return [...groups.values()].sort((a, b) => {
    if (!a.host) return -1;
    if (!b.host) return 1;
    return a.host.name.localeCompare(b.host.name) || a.host.id.localeCompare(b.host.id);
  });
}

export type ThreadStartOptionsProps = {
  projects: Project[];
  projectHosts?: ReadonlyMap<string, ThreadHost>;
  projectId: string | null;
  /** Project ids last picked here, newest first. Ids with no project are skipped. */
  recentProjectIds?: readonly string[];
  /** The project's registered workspace, which is what the branches are read from. */
  workspaceId?: string;
  branch: DraftBranch | null;
  worktree: boolean;
  /** Names the checkout the thread starts in when the user picked one the project already has. */
  startsInWorktree?: string;
  /** No project starts the thread as a chat, in a scratch workspace of its own. */
  onSelectProject: (projectId?: string) => void;
  onAddProject: () => void;
  /** `create` names a branch the repository does not have yet, made when the thread starts. */
  onSelectBranch: (branch: string | null, create?: boolean) => void;
  onSetWorktree: (worktree: boolean) => void;
  /** The project's existing checkouts, any of which the thread can start in instead of a new one. */
  worktreeChoices?: readonly MobileWorktreeChoice[];
  onStartInWorktree?: (worktreeId: string) => void;
  /** Whether the thread starts as a coordinator, which a chat can be too. */
  coordinator: boolean;
  onSetCoordinator: (coordinator: boolean) => void;
};

const NO_CHOICES: readonly MobileWorktreeChoice[] = [];

/**
 * Where in the project the thread works: the project itself, a new checkout, or one the project
 * already has. With no checkout yet it is a plain toggle for a new one.
 */
function WorktreeField({ worktree, choices, onSetWorktree, onStartIn }: { worktree: boolean; choices: readonly MobileWorktreeChoice[]; onSetWorktree: (worktree: boolean) => void; onStartIn?: (worktreeId: string) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useDismissibleLayer(open, [root], () => setOpen(false), trigger);
  if (!choices.length || !onStartIn) {
    return (
      <button type="button" className="thread-start-toggle" aria-pressed={worktree} onClick={() => onSetWorktree(!worktree)}>
        <FolderSymlink size={14} />
        <span>Worktree</span>
      </button>
    );
  }
  const pick = (act: () => void) => () => { setOpen(false); act(); };
  return (
    <div className={`thread-start-field thread-start-worktrees ${open ? "open" : ""}`} ref={root}>
      <button ref={trigger} type="button" className={worktree ? "chosen" : undefined} aria-label={`Worktree: ${worktree ? "New worktree" : "None"}`} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>
        <FolderSymlink size={14} />
        <span>{worktree ? "New worktree" : "Worktree"}</span>
        <ChevronDown size={14} />
      </button>
      {open && <PickerPopover className="thread-start-popover">
        <div role="listbox" aria-label="Worktree">
          <PickerOption selected={!worktree} onClick={pick(() => { if (worktree) onSetWorktree(false); })}>No worktree</PickerOption>
          <PickerOption selected={worktree} onClick={pick(() => { if (!worktree) onSetWorktree(true); })}>New worktree</PickerOption>
          <div role="group" aria-label="Existing worktrees">
            <div className="thread-start-group-heading" aria-hidden="true"><span className="thread-start-group-label"><span>Existing</span></span></div>
            {choices.map((choice) => (
              <PickerOption key={choice.id} selected={false} onClick={pick(() => onStartIn(choice.id))}>
                {choice.name}<small>{choice.branch ?? "Detached"}</small>
              </PickerOption>
            ))}
          </div>
        </div>
      </PickerPopover>}
    </div>
  );
}

function CoordinatorToggle({ coordinator, onSetCoordinator }: Pick<ThreadStartOptionsProps, "coordinator" | "onSetCoordinator">) {
  return (
    <button type="button" className="thread-start-toggle thread-start-coordinator" aria-pressed={coordinator} onClick={() => onSetCoordinator(!coordinator)}>
      <Waypoints size={14} />
      <span>Coordinator</span>
    </button>
  );
}

/**
 * What the user is about to start still needs to know: which project, if any, which branch it starts
 * from, and whether it gets a checkout of its own. No project makes it a chat. Nothing here touches
 * disk — the first message does that.
 */
export function ThreadStartOptions({ projects, projectHosts, projectId, recentProjectIds = [], workspaceId, branch, worktree, startsInWorktree, onSelectProject, onAddProject, onSelectBranch, onSetWorktree, worktreeChoices = NO_CHOICES, onStartInWorktree, coordinator, onSetCoordinator }: ThreadStartOptionsProps) {
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [projectQuery, setProjectQuery] = useState("");
  const [branchesOpen, setBranchesOpen] = useState(false);
  const projectRef = useRef<HTMLDivElement>(null);
  const projectTrigger = useRef<HTMLButtonElement>(null);
  const branchRef = useRef<HTMLDivElement>(null);
  const branchTrigger = useRef<HTMLButtonElement>(null);
  const branchMenu = useRef<HTMLDivElement>(null);
  useDismissibleLayer(projectsOpen, [projectRef], () => setProjectsOpen(false), projectTrigger);
  useDismissibleLayer(branchesOpen, [branchRef, branchMenu], () => setBranchesOpen(false), branchTrigger);
  const project = projects.find((item) => item.id === projectId);
  const matched = matchProjects(projects, projectQuery, projectHosts);
  const branches = useBranches(workspaceId);

  const current = branches?.status === "available" ? branches.current : null;
  const unreadable = branches?.status === "error" && !branch;
  /** Until the user picks one, the thread starts from wherever the checkout already is. */
  const selected = branch?.name ?? current;
  const branchLabel = selected ?? (unreadable ? "Branches unavailable" : "Current branch");

  /** With nowhere to work a thread can only be a chat, so all it has left to answer is whether it coordinates. */
  if (!projects.length) {
    return (
      <div className="thread-start" aria-label="How this thread starts">
        <div className="thread-start-git">
          <button type="button" className="thread-start-toggle" onClick={onAddProject}><Plus size={14} /><span>Add project</span></button>
          <CoordinatorToggle coordinator={coordinator} onSetCoordinator={onSetCoordinator} />
        </div>
      </div>
    );
  }
  const host = project && projectHosts?.get(project.id);
  const showComputers = projects.some((item) => projectHosts?.has(item.id));
  const label = project ? projectName(project) : "No project";
  const recent = projectQuery.trim() ? [] : recentProjects(projects, recentProjectIds);
  const hostName = (item: Project) => projectHosts?.get(item.id)?.name ?? "This computer";
  const sharedNames = namesakes(projects, projectHosts);
  /** Recent rows sit under no computer heading, so they name their computer themselves. */
  const option = (item: Project, showsHost = false) => {
    const itemHost = projectHosts?.get(item.id);
    const parent = sharedNames.has(item.id) ? parentFolder(item.root) : undefined;
    return (
      <PickerOption
        key={item.id}
        aria-label={showComputers || parent ? `${projectName(item)}${parent ? ` in ${parent}` : ""}${showComputers ? ` on ${hostName(item)}` : ""}` : undefined}
        selected={item.id === projectId}
        onClick={() => {
          setProjectsOpen(false);
          onSelectProject(item.id);
        }}
      >
        {projectName(item)}
        {parent && <small>{parent}</small>}
        {showsHost && showComputers && <HostMark name={hostName(item)} offline={itemHost?.offline} reconnecting={itemHost?.reconnecting} />}
      </PickerOption>
    );
  };

  return (
    <div className="thread-start" aria-label="How this thread starts">
      <div className={`thread-start-field thread-start-project ${projectsOpen ? "open" : ""}`} ref={projectRef}>
        <button ref={projectTrigger} type="button" aria-label={`Project: ${label}${showComputers && project ? ` on ${host?.name ?? "This computer"}` : ""}`} aria-haspopup="listbox" aria-expanded={projectsOpen} onClick={() => { setProjectQuery(""); setProjectsOpen(!projectsOpen); }}>
          {project ? <FolderGit2 size={14} /> : <MessageCircle size={14} />}
          <span className="thread-start-project-label">
            <span>{label}</span>
            {showComputers && project && <HostMark name={host?.name ?? "This computer"} offline={host?.offline} reconnecting={host?.reconnecting} />}
          </span>
          <ChevronDown size={14} />
        </button>
        {projectsOpen && <PickerPopover className="thread-start-popover">
          <PickerSearch label="Search projects" value={projectQuery} onChange={setProjectQuery} />
          <div role="listbox" aria-label="Projects">
            {/** Leaving the project behind is how a chat is started, so it leads the list rather than hiding in it. */}
            {!projectQuery.trim() && <PickerOption className="thread-start-no-project" selected={!project} onClick={() => { setProjectsOpen(false); if (project) onSelectProject(undefined); }}>No project</PickerOption>}
            {recent.length > 0 && (
              <div role="group" aria-label="Recent">
                <div className="thread-start-group-heading" aria-hidden="true"><span className="thread-start-group-label"><Clock size={12} /><span>Recent</span></span></div>
                {recent.map((item) => option(item, true))}
              </div>
            )}
            {matched.length === 0 && <p className="thread-start-empty">No project matches</p>}
            {/** Below Recent, an unlabelled list would read as more of it, so it is named when no computer names it. */}
            {groupProjects(matched, projectHosts).map(({ host, projects: grouped }) => (
              <div key={host ? `remote:${host.id}` : "local"} role={showComputers || recent.length ? "group" : undefined} aria-label={showComputers ? host?.name ?? "This computer" : recent.length ? "All projects" : undefined}>
                {showComputers
                  ? <div className="thread-start-group-heading" aria-hidden="true"><HostMark name={host?.name ?? "This computer"} offline={host?.offline} reconnecting={host?.reconnecting} /></div>
                  : recent.length > 0 && <div className="thread-start-group-heading" aria-hidden="true"><span className="thread-start-group-label"><span>All projects</span></span></div>}
                {grouped.map((item) => option(item))}
              </div>
            ))}
          </div>
          <button type="button" className="picker-option thread-start-add-project" onClick={() => { setProjectsOpen(false); onAddProject(); }}>
            <span className="picker-mark" aria-hidden="true"><Plus size={14} /></span>
            <span className="picker-label">Add project…</span>
          </button>
        </PickerPopover>}
      </div>

      <div className="thread-start-git">
        {/** A checkout that already exists is entered as it stands, so there is no branch left to pick
          *  and no second checkout to ask for. Clearing it puts the thread back in the project. A chat
          *  has neither. */}
        {!project ? null : startsInWorktree ? (
          <div className="thread-start-worktree">
            <FolderSymlink size={16} />
            <span data-tip={startsInWorktree} data-tip-overflow>{startsInWorktree}</span>
            <button type="button" aria-label={`Leave ${startsInWorktree}`} data-tip="Start in the project instead" onClick={() => onSetWorktree(false)}><X size={14} /></button>
          </div>
        ) : (<>
        <div className={`thread-start-field ${branchesOpen ? "open" : ""}`} ref={branchRef}>
          <button ref={branchTrigger} type="button" className={unreadable ? "error" : undefined} aria-label={`Starting branch: ${branchLabel}${branch?.create ? " (new)" : ""}`} aria-haspopup="listbox" aria-expanded={branchesOpen} aria-disabled={!workspaceId || undefined} tabIndex={workspaceId ? undefined : -1} data-tip={!workspaceId ? "Starts from the project's current branch" : unreadable ? branches.message : undefined} onClick={() => { if (workspaceId) setBranchesOpen(!branchesOpen); }}>
            {unreadable ? <CircleAlert size={14} /> : <GitBranch size={14} />}
            <span>{branchLabel}</span>
            {branch?.create && <small>new</small>}
            <ChevronDown size={14} />
          </button>
          {branchesOpen && (
            <BranchMenu
              menuRef={branchMenu}
              branches={branches}
              selected={selected}
              onPick={(name, create) => {
                setBranchesOpen(false);
                /** The branch the checkout is already on asks for nothing, so nothing is moved onto it. */
                onSelectBranch(!create && name === current ? null : name, create);
              }}
            />
          )}
        </div>

        <WorktreeField worktree={worktree} choices={worktreeChoices} onSetWorktree={onSetWorktree} onStartIn={onStartInWorktree} />
        </>)}
        <CoordinatorToggle coordinator={coordinator} onSetCoordinator={onSetCoordinator} />
      </div>
    </div>
  );
}
