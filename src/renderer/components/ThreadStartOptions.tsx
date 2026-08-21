import { Check, ChevronDown, FolderGit2, FolderSymlink, GitBranch, X } from "lucide-react";
import { useRef, useState } from "react";
import type { DraftBranch } from "../../application/workspace-state";
import { BranchMenu, useBranches } from "./BranchMenu";
import { projectName, type Project } from "../../domain/task";
import { moveListFocus, useDismissibleLayer } from "../focus";

export type ThreadStartOptionsProps = {
  projects: Project[];
  projectId: string | null;
  /** The project's registered workspace, which is what the branches are read from. */
  workspaceId?: string;
  branch: DraftBranch | null;
  worktree: boolean;
  /** Names the checkout the thread starts in when the user picked one the project already has. */
  startsInWorktree?: string;
  onSelectProject: (projectId: string) => void;
  /** `create` names a branch the repository does not have yet, made when the thread starts. */
  onSelectBranch: (branch: string | null, create?: boolean) => void;
  onSetWorktree: (worktree: boolean) => void;
};

/**
 * How the thread the user is about to start begins: which project, which branch it starts from, and
 * whether it gets a checkout of its own. Nothing here touches disk — the first message does that.
 */
export function ThreadStartOptions({ projects, projectId, workspaceId, branch, worktree, startsInWorktree, onSelectProject, onSelectBranch, onSetWorktree }: ThreadStartOptionsProps) {
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [branchesOpen, setBranchesOpen] = useState(false);
  const projectRef = useRef<HTMLDivElement>(null);
  const projectTrigger = useRef<HTMLButtonElement>(null);
  const branchRef = useRef<HTMLDivElement>(null);
  const branchTrigger = useRef<HTMLButtonElement>(null);
  const branchMenu = useRef<HTMLDivElement>(null);
  useDismissibleLayer(projectsOpen, [projectRef], () => setProjectsOpen(false), projectTrigger);
  useDismissibleLayer(branchesOpen, [branchRef, branchMenu], () => setBranchesOpen(false), branchTrigger);
  const project = projects.find((item) => item.id === projectId);
  const branches = useBranches(workspaceId);

  const current = branches?.status === "available" ? branches.current : null;
  /** Until the user picks one, the thread starts from wherever the checkout already is. */
  const selected = branch?.name ?? current;

  /** A thread with no project is a real choice, so the picker stays even when nothing is picked. */
  if (!projects.length) return null;

  return (
    <div className="thread-start" aria-label="How this thread starts">
      <div className={`thread-start-field ${projectsOpen ? "open" : ""}`} ref={projectRef}>
        <button ref={projectTrigger} type="button" aria-label="Project" aria-haspopup="listbox" aria-expanded={projectsOpen} onClick={() => setProjectsOpen(!projectsOpen)}>
          <FolderGit2 size={15} />
          <span>{project ? projectName(project.root) : "No project"}</span>
          <ChevronDown size={14} />
        </button>
        {projectsOpen && <div className="thread-start-popover" role="listbox" aria-label="Projects" onKeyDown={moveListFocus}>
          {projects.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={item.id === projectId}
              autoFocus={projectId ? item.id === projectId : index === 0}
              onClick={() => {
                setProjectsOpen(false);
                onSelectProject(item.id);
              }}
            >
              <span>{projectName(item.root)}</span>
              {item.id === projectId && <Check size={14} />}
            </button>
          ))}
        </div>}
      </div>

      {/** A checkout that already exists is entered as it stands, so there is no branch left to pick
        *  and no second checkout to ask for. Clearing it puts the thread back in the project. */}
      {/** A branch and a checkout of its own are only questions a project can answer. */}
      {project && (startsInWorktree ? (
        <div className="thread-start-worktree">
          <FolderSymlink size={15} />
          <span>{startsInWorktree}</span>
          <button type="button" aria-label={`Leave ${startsInWorktree}`} onClick={() => onSetWorktree(false)}><X size={13} /></button>
        </div>
      ) : (<>
      <div className={`thread-start-field ${branchesOpen ? "open" : ""}`} ref={branchRef}>
        <button ref={branchTrigger} type="button" aria-label="Starting branch" aria-haspopup="listbox" aria-expanded={branchesOpen} disabled={!workspaceId} onClick={() => setBranchesOpen(!branchesOpen)}>
          <GitBranch size={15} />
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

      <label className="thread-start-check">
        <input type="checkbox" checked={worktree} onChange={(event) => onSetWorktree(event.target.checked)} />
        <span>Worktree</span>
      </label>
      </>))}
    </div>
  );
}
