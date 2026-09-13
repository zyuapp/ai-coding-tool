import { LuCheck as Check, LuChevronDown as ChevronDown, LuFolderGit2 as FolderGit2, LuFolderSymlink as FolderSymlink, LuGitBranch as GitBranch, LuSearch as Search, LuX as X } from "react-icons/lu";
import { useRef, useState } from "react";
import type { DraftBranch } from "../../application/workspace-state";
import type { ThreadHost } from "../../application/computers";
import { BranchMenu, useBranches } from "./BranchMenu";
import { projectName, type Project } from "../../domain/project";
import { moveListFocus, useDismissibleLayer } from "../focus";

/** Which projects a typed query keeps, matched on the name, path, and computer shown. */
export function matchProjects(projects: Project[], query: string, projectHosts?: ReadonlyMap<string, ThreadHost>) {
  const needle = query.trim().toLowerCase();
  if (!needle) return projects;
  const localHostName = projects.some((project) => projectHosts?.has(project.id)) ? "This computer" : "";
  return projects.filter((project) => `${projectName(project)} ${project.root} ${projectHosts?.get(project.id)?.name ?? localHostName}`.toLowerCase().includes(needle));
}

/** Keep each computer's project order, with this computer before the paired computers by name. */
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
  return [...groups.values()].sort((a, b) => {
    if (!a.host) return -1;
    if (!b.host) return 1;
    return a.host.name.localeCompare(b.host.name) || a.host.id.localeCompare(b.host.id);
  });
}

export type ThreadModeSwitchProps = {
  projects: Project[];
  projectId: string | null;
  /** No project starts the thread as a chat, in a scratch workspace of its own. */
  onSelectProject: (projectId?: string) => void;
};

/**
 * Chat or work: the shape of the thread, asked once and above everything work goes on to ask.
 */
export function ThreadModeSwitch({ projects, projectId, onSelectProject }: ThreadModeSwitchProps) {
  /** With nothing to work in, a thread can only be a chat, and there is nothing to ask. */
  if (!projects.length) return null;

  const chat = !projectId;
  return (
    <div className="thread-mode" role="radiogroup" aria-label="Mode">
      <button type="button" role="radio" aria-checked={chat} onClick={() => { if (!chat) onSelectProject(undefined); }}>Chat</button>
      <button type="button" role="radio" aria-checked={!chat} onClick={() => { if (chat) onSelectProject(projects[0]?.id); }}>Work</button>
    </div>
  );
}

export type ThreadStartOptionsProps = {
  projects: Project[];
  projectHosts?: ReadonlyMap<string, ThreadHost>;
  projectId: string | null;
  /** The project's registered workspace, which is what the branches are read from. */
  workspaceId?: string;
  branch: DraftBranch | null;
  worktree: boolean;
  /** Names the checkout the thread starts in when the user picked one the project already has. */
  startsInWorktree?: string;
  /** No project starts the thread as a chat, in a scratch workspace of its own. */
  onSelectProject: (projectId?: string) => void;
  /** `create` names a branch the repository does not have yet, made when the thread starts. */
  onSelectBranch: (branch: string | null, create?: boolean) => void;
  onSetWorktree: (worktree: boolean) => void;
};

/**
 * What work the user is about to start still needs to know: which project, which branch it starts
 * from, and whether it gets a checkout of its own. Nothing here touches disk — the first message does
 * that.
 */
export function ThreadStartOptions({ projects, projectHosts, projectId, workspaceId, branch, worktree, startsInWorktree, onSelectProject, onSelectBranch, onSetWorktree }: ThreadStartOptionsProps) {
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
  /** Until the user picks one, the thread starts from wherever the checkout already is. */
  const selected = branch?.name ?? current;

  /** A chat has no project, so there is nothing left for it to answer. */
  if (!project) return null;
  const host = projectHosts?.get(project.id);
  const showComputers = projects.some((item) => projectHosts?.has(item.id));

  return (
    <div className="thread-start" aria-label="How this thread starts">
      <div className={`thread-start-field ${projectsOpen ? "open" : ""}`} ref={projectRef}>
        <button ref={projectTrigger} type="button" aria-label={showComputers ? `${projectName(project)} on ${host?.name ?? "This computer"}` : "Project"} aria-haspopup="listbox" aria-expanded={projectsOpen} onClick={() => { setProjectQuery(""); setProjectsOpen(!projectsOpen); }}>
          <FolderGit2 size={14} />
          <span>{projectName(project)}</span>
          {showComputers && <span className={`project-host${host?.offline ? " offline" : ""}`}>{host?.name ?? "This computer"}</span>}
          <ChevronDown size={14} />
        </button>
        {projectsOpen && <div className="thread-start-popover" onKeyDown={moveListFocus}>
          <label className="thread-start-search-field">
            <Search size={13} aria-hidden="true" />
            <input
              className="thread-start-search"
              aria-label="Search projects"
              placeholder="Search projects"
              autoFocus
              value={projectQuery}
              onInput={(event) => setProjectQuery(event.currentTarget.value)}
            />
          </label>
          <div role="listbox" aria-label="Projects">
            {matched.length === 0 && <p className="thread-start-empty">No project matches</p>}
            {groupProjects(matched, projectHosts).map(({ host, projects: grouped }) => (
              <div key={host ? `remote:${host.id}` : "local"} role={showComputers ? "group" : undefined} aria-label={showComputers ? host?.name ?? "This computer" : undefined}>
                {showComputers && <div className="thread-start-group-heading" aria-hidden="true">{host?.name ?? "This computer"}</div>}
                {grouped.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-label={showComputers ? `${projectName(item)} on ${host?.name ?? "This computer"}` : undefined}
                    aria-selected={item.id === projectId}
                    onClick={() => {
                      setProjectsOpen(false);
                      onSelectProject(item.id);
                    }}
                  >
                    <span>{projectName(item)}</span>
                    {item.id === projectId && <Check size={14} />}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>}
      </div>

      {/** A checkout that already exists is entered as it stands, so there is no branch left to pick
        *  and no second checkout to ask for. Clearing it puts the thread back in the project. */}
      {startsInWorktree ? (
        <div className="thread-start-worktree">
          <FolderSymlink size={15} />
          <span>{startsInWorktree}</span>
          <button type="button" aria-label={`Leave ${startsInWorktree}`} onClick={() => onSetWorktree(false)}><X size={13} /></button>
        </div>
      ) : (<>
      <div className={`thread-start-field ${branchesOpen ? "open" : ""}`} ref={branchRef}>
        <button ref={branchTrigger} type="button" aria-label="Starting branch" aria-haspopup="listbox" aria-expanded={branchesOpen} disabled={!workspaceId} onClick={() => setBranchesOpen(!branchesOpen)}>
          <GitBranch size={14} />
          <span>{selected ?? (branches?.status === "error" ? "No branches" : "Current branch")}</span>
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

      <button type="button" className="thread-start-toggle" aria-pressed={worktree} onClick={() => onSetWorktree(!worktree)}>
        <FolderSymlink size={14} />
        <span>Worktree</span>
      </button>
      </>)}
    </div>
  );
}
