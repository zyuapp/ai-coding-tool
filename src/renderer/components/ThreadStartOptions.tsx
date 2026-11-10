import { LuCircleAlert as CircleAlert, LuClock as Clock, LuFolderGit2 as FolderGit2, LuFolderSymlink as FolderSymlink, LuGitBranch as GitBranch, LuMessageCircle as MessageCircle, LuPlus as Plus, LuWaypoints as Waypoints, LuX as X } from "react-icons/lu";
import { Fragment, useRef, useState } from "react";
import type { DraftBranch } from "../../application/workspace-state";
import type { ThreadHost } from "../../application/computers";
import type { MobileWorktreeChoice } from "../../contracts/mobile";
import { HostMark } from "./HostMark";
import { BranchMenu } from "./BranchMenu";
import { useBranches } from "../use-branches";
import { folderName, projectName, type Project } from "../../domain/project";
import { useDismissibleLayer } from "../focus";
import { MenuEdgeAction, MenuGroup, MenuItem, MenuNote, MenuScroll, MenuSearch, MenuSeparator, MenuSurface, MenuTrigger, useListKeys } from "../ui/Menu";
import { Button, IconButton, ToggleButton } from "../ui/Button";
import { Chip } from "../ui/Chip";
import "../ui/glass.css";

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
  projectsOpen: boolean;
  /** Each new value opens the project list afresh, with an empty search holding the keys. */
  projectsToken?: number;
  onSetProjectsOpen: (open: boolean) => void;
  /** Project ids last picked here, newest first. Ids with no project are skipped. */
  recentProjectIds?: readonly string[];
  /** The project's registered workspace, which is what the branches are read from. */
  workspaceId?: string;
  branch: DraftBranch | null;
  worktree: boolean;
  /** Names the checkout the thread starts in when the user picked one the project already has. */
  startsInWorktree?: string;
  /** No project starts the thread as a chat, in a scratch workspace of its own. Every pick is reported, the current one included. */
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
  const listKeys = useListKeys();
  useDismissibleLayer(open, [root], () => setOpen(false), trigger);
  if (!choices.length || !onStartIn) {
    return <ToggleButton className="thread-start-toggle" tone="accent" pressed={worktree} icon={<FolderSymlink size={14} />} onClick={() => onSetWorktree(!worktree)}>Worktree</ToggleButton>;
  }
  const pick = (act: () => void) => () => { setOpen(false); act(); };
  return (
    <div className="thread-start-field" ref={root}>
      <MenuTrigger ref={trigger} variant="field" chosen={worktree} icon={<FolderSymlink size={14} />} aria-label={`Worktree: ${worktree ? "New worktree" : "None"}`} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{worktree ? "New worktree" : "Worktree"}</span>
      </MenuTrigger>
      {open && <MenuSurface checkable scroll className="picker-popover thread-start-popover" onKeyDown={listKeys}>
        <div role="listbox" aria-label="Worktree">
          <MenuItem role="option" checked={!worktree} onClick={pick(() => { if (worktree) onSetWorktree(false); })}>No worktree</MenuItem>
          <MenuItem role="option" checked={worktree} onClick={pick(() => { if (!worktree) onSetWorktree(true); })}>New worktree</MenuItem>
          <MenuGroup label="Existing worktrees">
            {choices.map((choice) => (
              <MenuItem key={choice.id} role="option" checked={false} detail={choice.branch ?? "Detached"} onClick={pick(() => onStartIn(choice.id))}>{choice.name}</MenuItem>
            ))}
          </MenuGroup>
        </div>
      </MenuSurface>}
    </div>
  );
}

function CoordinatorToggle({ coordinator, onSetCoordinator }: Pick<ThreadStartOptionsProps, "coordinator" | "onSetCoordinator">) {
  return (
    <ToggleButton className="thread-start-toggle thread-start-coordinator" tone="accent" pressed={coordinator} icon={<Waypoints size={14} />} onClick={() => onSetCoordinator(!coordinator)}>Coordinator</ToggleButton>
  );
}

type ProjectPickerProps = Pick<ThreadStartOptionsProps, "projects" | "projectHosts" | "projectId" | "onAddProject"> & {
  recentProjectIds: readonly string[];
  onPick: (projectId?: string) => void;
};

/** The project list, whose search starts empty each time it opens. */
function ProjectPicker({ projects, projectHosts, projectId, recentProjectIds, onPick, onAddProject }: ProjectPickerProps) {
  const [query, setQuery] = useState("");
  const matched = matchProjects(projects, query, projectHosts);
  const showComputers = projects.some((item) => projectHosts?.has(item.id));
  const recent = query.trim() ? [] : recentProjects(projects, recentProjectIds);
  const hostName = (item: Project) => projectHosts?.get(item.id)?.name ?? "This computer";
  const sharedNames = namesakes(projects, projectHosts);
  const listKeys = useListKeys();
  /** Recent rows sit under no computer heading, so they name their computer themselves. */
  const option = (item: Project, showsHost = false) => {
    const itemHost = projectHosts?.get(item.id);
    const parent = sharedNames.has(item.id) ? parentFolder(item.root) : undefined;
    return (
      <MenuItem
        key={item.id}
        role="option"
        aria-label={showComputers || parent ? `${projectName(item)}${parent ? ` in ${parent}` : ""}${showComputers ? ` on ${hostName(item)}` : ""}` : undefined}
        checked={item.id === projectId}
        onClick={() => onPick(item.id)}
      >
        <span className="thread-start-project-name" data-tip={projectName(item)} data-tip-overflow>{projectName(item)}</span>
        {parent && <small data-tip={parent} data-tip-overflow>{parent}</small>}
        {showsHost && showComputers && <HostMark name={hostName(item)} offline={itemHost?.offline} reconnecting={itemHost?.reconnecting} />}
      </MenuItem>
    );
  };
  return (
    <MenuSurface checkable scroll className="picker-popover thread-start-popover" data-keeps-keys onKeyDown={listKeys}>
      <MenuSearch label="Search projects" value={query} onChange={setQuery} autoFocus />
      <MenuScroll role="listbox" aria-label="Projects">
        {/** Leaving the project behind is how a chat is started, so it leads the list, set apart from the projects. */}
        {!query.trim() && <>
          <MenuItem role="option" checked={!projectId} onClick={() => onPick(undefined)}>No project</MenuItem>
          <MenuSeparator />
        </>}
        {recent.length > 0 && (
          <MenuGroup label={<span className="thread-start-group-label"><Clock size={12} />Recent</span>}>
            {recent.map((item) => option(item, true))}
          </MenuGroup>
        )}
        {matched.length === 0 && <MenuNote className="thread-start-empty">No project matches</MenuNote>}
        {/** Below Recent, an unlabelled list would read as more of it, so it is named when no computer names it. */}
        {groupProjects(matched, projectHosts).map(({ host, projects: grouped }) => {
          const key = host ? `remote:${host.id}` : "local";
          if (showComputers) return <MenuGroup key={key} label={<HostMark name={host?.name ?? "This computer"} offline={host?.offline} reconnecting={host?.reconnecting} />}>{grouped.map((item) => option(item))}</MenuGroup>;
          if (recent.length) return <MenuGroup key={key} label="All projects">{grouped.map((item) => option(item))}</MenuGroup>;
          return <Fragment key={key}>{grouped.map((item) => option(item))}</Fragment>;
        })}
      </MenuScroll>
      <MenuEdgeAction className="thread-start-add-project" mark={<Plus size={14} />} onClick={onAddProject}>Add project…</MenuEdgeAction>
    </MenuSurface>
  );
}

/**
 * What the user is about to start still needs to know: which project, if any, which branch it starts
 * from, and whether it gets a checkout of its own. No project makes it a chat. Nothing here touches
 * disk — the first message does that.
 */
export function ThreadStartOptions({ projects, projectHosts, projectId, projectsOpen, projectsToken, onSetProjectsOpen, recentProjectIds = [], workspaceId, branch, worktree, startsInWorktree, onSelectProject, onAddProject, onSelectBranch, onSetWorktree, worktreeChoices = NO_CHOICES, onStartInWorktree, coordinator, onSetCoordinator }: ThreadStartOptionsProps) {
  const [branchesOpen, setBranchesOpen] = useState(false);
  const projectRef = useRef<HTMLDivElement>(null);
  const projectTrigger = useRef<HTMLButtonElement>(null);
  const branchRef = useRef<HTMLDivElement>(null);
  const branchTrigger = useRef<HTMLButtonElement>(null);
  const branchMenu = useRef<HTMLDivElement>(null);
  useDismissibleLayer(projectsOpen, [projectRef], () => onSetProjectsOpen(false), projectTrigger);
  useDismissibleLayer(branchesOpen, [branchRef, branchMenu], () => setBranchesOpen(false), branchTrigger);
  const project = projects.find((item) => item.id === projectId);
  const branches = useBranches(workspaceId);

  const current = branches?.status === "available" ? branches.current : null;
  const unreadable = branches?.status === "error" && !branch;
  /** Until the user picks one, the thread starts from wherever the checkout already is. */
  const selected = branch?.name ?? current;
  const branchLabel = selected ?? (unreadable ? "Branches unavailable" : "Current branch");

  /** With nowhere to work a thread can only be a chat, so all it has left to answer is whether it coordinates. */
  if (!projects.length) {
    return (
      <div className="thread-start glass-pane" aria-label="How this thread starts">
        <div className="thread-start-git">
          <Button variant="ghost" icon={<Plus size={14} />} onClick={onAddProject}>Add project</Button>
          <CoordinatorToggle coordinator={coordinator} onSetCoordinator={onSetCoordinator} />
        </div>
      </div>
    );
  }
  const host = project && projectHosts?.get(project.id);
  const showComputers = projects.some((item) => projectHosts?.has(item.id));
  const label = project ? projectName(project) : "No project";

  return (
    <div className="thread-start glass-pane" aria-label="How this thread starts">
      <div className="thread-start-field thread-start-project" ref={projectRef}>
        <MenuTrigger ref={projectTrigger} variant="field" icon={project ? <FolderGit2 size={14} /> : <MessageCircle size={14} />} aria-label={`Project: ${label}${showComputers && project ? ` on ${host?.name ?? "This computer"}` : ""}`} aria-haspopup="listbox" aria-expanded={projectsOpen} onClick={() => onSetProjectsOpen(!projectsOpen)}>
          <span className="thread-start-project-label">
            <span>{label}</span>
            {showComputers && project && <HostMark name={host?.name ?? "This computer"} offline={host?.offline} reconnecting={host?.reconnecting} />}
          </span>
        </MenuTrigger>
        {projectsOpen && <ProjectPicker
          key={projectsToken}
          projects={projects}
          projectHosts={projectHosts}
          projectId={project?.id ?? null}
          recentProjectIds={recentProjectIds}
          onPick={(id) => { onSetProjectsOpen(false); onSelectProject(id); }}
          onAddProject={() => { onSetProjectsOpen(false); onAddProject(); }}
        />}
      </div>

      <div className="thread-start-git">
        {/** A checkout that already exists is entered as it stands, so there is no branch left to pick
          *  and no second checkout to ask for. Clearing it puts the thread back in the project. A chat
          *  has neither. */}
        {!project ? null : startsInWorktree ? (
          <div className="thread-start-worktree glass-chip">
            <FolderSymlink size={16} />
            <span data-tip={startsInWorktree} data-tip-overflow>{startsInWorktree}</span>
            <IconButton size="xs" label={`Leave ${startsInWorktree}`} tip="Start in the project instead" onClick={() => onSetWorktree(false)}><X size={14} /></IconButton>
          </div>
        ) : (<>
        <div className="thread-start-field" ref={branchRef}>
          <MenuTrigger ref={branchTrigger} variant="field" tone={unreadable ? "danger" : undefined} icon={unreadable ? <CircleAlert size={14} /> : <GitBranch size={14} />} aria-label={`Starting branch: ${branchLabel}${branch?.create ? " (new)" : ""}`} aria-haspopup="listbox" aria-expanded={branchesOpen} aria-disabled={!workspaceId || undefined} tabIndex={workspaceId ? undefined : -1} data-tip={!workspaceId ? "Starts from the project's current branch" : unreadable ? branches.message : undefined} onClick={() => { if (workspaceId) setBranchesOpen(!branchesOpen); }}>
            <span>{branchLabel}</span>
            {branch?.create && <Chip variant="tag">new</Chip>}
          </MenuTrigger>
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
