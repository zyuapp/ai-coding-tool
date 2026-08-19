import { Check, ChevronDown, FolderGit2, GitBranch, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DraftBranch } from "../../application/workspace-state";
import type { BranchesResult } from "../../contracts/ipc";
import { projectName, type Project } from "../../domain/task";

export type ThreadStartOptionsProps = {
  projects: Project[];
  projectId: string | null;
  /** The project's registered workspace, which is what the branches are read from. */
  workspaceId?: string;
  branch: DraftBranch | null;
  worktree: boolean;
  onSelectProject: (projectId: string) => void;
  /** `create` names a branch the repository does not have yet, made when the thread starts. */
  onSelectBranch: (branch: string | null, create?: boolean) => void;
  onSetWorktree: (worktree: boolean) => void;
};

/**
 * The branch a typed query would make: what the user typed, once it is a name no branch already has.
 * Whitespace is never a branch name, so a query that is only spaces asks for nothing.
 */
export function newBranchName(branches: string[], query: string) {
  const name = query.trim();
  return name && !branches.includes(name) ? name : null;
}

/** Which branches a typed query keeps, matched loosely so a fragment of a name is enough. */
export function matchBranches(branches: string[], query: string) {
  const needle = query.trim().toLowerCase();
  return needle ? branches.filter((name) => name.toLowerCase().includes(needle)) : branches;
}

function useOutsideClose(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, close]);
  return ref;
}

/**
 * How the thread the user is about to start begins: which project, which branch it starts from, and
 * whether it gets a checkout of its own. Nothing here touches disk — the first message does that.
 */
export function ThreadStartOptions({ projects, projectId, workspaceId, branch, worktree, onSelectProject, onSelectBranch, onSetWorktree }: ThreadStartOptionsProps) {
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [branchesOpen, setBranchesOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<BranchesResult | null>(null);
  const projectRef = useOutsideClose(projectsOpen, () => setProjectsOpen(false));
  const branchRef = useOutsideClose(branchesOpen, () => {
    setBranchesOpen(false);
    setQuery("");
  });
  const project = projects.find((item) => item.id === projectId);

  useEffect(() => {
    setResult(null);
    if (!workspaceId) return;
    let cancelled = false;
    void window.desktop.branches(workspaceId)
      .then((branches) => { if (!cancelled) setResult(branches); })
      .catch((error) => { if (!cancelled) setResult({ status: "error", message: String(error) }); });
    return () => { cancelled = true; };
  }, [workspaceId]);

  const branches = result?.status === "available" ? result.branches : [];
  /** Until the user picks one, the thread starts from wherever the checkout already is. */
  const selected = branch?.name ?? (result?.status === "available" ? result.current : null);
  const matches = matchBranches(branches, query);
  const naming = newBranchName(branches, query);

  if (!project) return null;

  return (
    <div className="thread-start" aria-label="How this thread starts">
      <div className={`thread-start-field ${projectsOpen ? "open" : ""}`} ref={projectRef}>
        <button type="button" aria-label="Project" aria-expanded={projectsOpen} onClick={() => setProjectsOpen(!projectsOpen)}>
          <FolderGit2 size={15} />
          <span>{projectName(project.root)}</span>
          <ChevronDown size={14} />
        </button>
        {projectsOpen && <div className="thread-start-popover" role="listbox" aria-label="Projects">
          {projects.map((item) => (
            <button
              key={item.id}
              role="option"
              aria-selected={item.id === projectId}
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

      <div className={`thread-start-field ${branchesOpen ? "open" : ""}`} ref={branchRef}>
        <button type="button" aria-label="Starting branch" aria-expanded={branchesOpen} disabled={!workspaceId} onClick={() => setBranchesOpen(!branchesOpen)}>
          <GitBranch size={15} />
          <span>{selected ?? (result?.status === "error" ? "No branches" : "Current branch")}</span>
          {branch?.create && <small>new</small>}
          <ChevronDown size={14} />
        </button>
        {branchesOpen && <div className="thread-start-popover">
          <input
            className="thread-start-search"
            aria-label="Search branches"
            placeholder="Search branches"
            autoFocus
            value={query}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
          <div role="listbox" aria-label="Branches">
            {naming && (
              <button
                role="option"
                aria-selected={false}
                onClick={() => {
                  setBranchesOpen(false);
                  setQuery("");
                  onSelectBranch(naming, true);
                }}
              >
                <span>Create branch “{naming}”</span>
                <Plus size={14} />
              </button>
            )}
            {matches.length === 0 && !naming && <p className="thread-start-empty">{result ? "No branch matches" : "Reading branches…"}</p>}
            {matches.map((name) => (
              <button
                key={name}
                role="option"
                aria-selected={name === selected}
                onClick={() => {
                  setBranchesOpen(false);
                  setQuery("");
                  onSelectBranch(name);
                }}
              >
                <span>{name}</span>
                {name === selected && <Check size={14} />}
              </button>
            ))}
          </div>
        </div>}
      </div>

      <label className="thread-start-check">
        <input type="checkbox" checked={worktree} onChange={(event) => onSetWorktree(event.target.checked)} />
        <span>Worktree</span>
      </label>
    </div>
  );
}
