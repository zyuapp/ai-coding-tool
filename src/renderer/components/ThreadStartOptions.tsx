import { LuCheck as Check, LuChevronDown as ChevronDown, LuFolderGit2 as FolderGit2, LuFolderSymlink as FolderSymlink, LuGitBranch as GitBranch, LuSearch as Search, LuX as X } from "react-icons/lu";
import { useRef, useState } from "react";
import type { DraftBranch } from "../../application/workspace-state";
import { BranchMenu, useBranches } from "./BranchMenu";
import { projectName, type Project } from "../../domain/task";
import { moveListFocus, useDismissibleLayer } from "../focus";

/** Which projects a typed query keeps, matched on the name shown and on the path behind it. */
export function matchProjects(projects: Project[], query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return projects;
  return projects.filter((project) => `${projectName(project)} ${project.root}`.toLowerCase().includes(needle));
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
export function ThreadStartOptions({ projects, projectId, workspaceId, branch, worktree, startsInWorktree, onSelectProject, onSelectBranch, onSetWorktree }: ThreadStartOptionsProps) {
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
  const matched = matchProjects(projects, projectQuery);
  const branches = useBranches(workspaceId);

  const current = branches?.status === "available" ? branches.current : null;
  /** Until the user picks one, the thread starts from wherever the checkout already is. */
  const selected = branch?.name ?? current;

  /** A chat has no project, so there is nothing left for it to answer. */
  if (!project) return null;

  return (
    <div className="thread-start" aria-label="How this thread starts">
      <div className={`thread-start-field ${projectsOpen ? "open" : ""}`} ref={projectRef}>
        <button ref={projectTrigger} type="button" aria-label="Project" aria-haspopup="listbox" aria-expanded={projectsOpen} onClick={() => { setProjectQuery(""); setProjectsOpen(!projectsOpen); }}>
          <FolderGit2 size={14} />
          <span>{projectName(project)}</span>
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
            {matched.map((item) => (
              <button
                key={item.id}
                type="button"
                role="option"
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
