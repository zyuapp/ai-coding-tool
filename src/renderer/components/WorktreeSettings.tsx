import { useId } from "react";
import { LuCheck as Check, LuChevronDown as ChevronDown, LuChevronRight as ChevronRight, LuCircleAlert as CircleAlert, LuFolderGit2 as FolderGit2, LuFolderOpen as FolderOpen, LuMessageSquare as MessageSquare, LuRefreshCw as RefreshCw, LuTrash2 as Trash } from "react-icons/lu";
import type { WorktreeSettingsPage, WorktreeSettingsView } from "../../application/worktree-settings";
import type { WorktreeCommand } from "../../contracts/commands";
import { WorktreeBulkDeleteDialog, WorktreeDeleteDialog } from "./WorktreeDeleteDialog";
import { SpinningIcon } from "./SpinningIcon";
import { CopyButton } from "./CopyButton";

type Dispatch = (command: WorktreeCommand) => void;

export type WorktreeSettingsProps = {
  page: WorktreeSettingsPage;
  error: string | null;
  notice: string | null;
  dispatch: Dispatch;
};

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

/** What deleting would cost, in a word or two, with the full reading as the tip. */
function safety(worktree: WorktreeSettingsView): { tone: "safe" | "warning" | "busy" | "unknown"; label: string; tip: string } {
  if (worktree.busy) return { tone: "busy", label: "Run active", tip: "Wait for the active run to finish" };
  if (!worktree.repository) return { tone: "warning", label: "Not a Git checkout", tip: "Deleting removes every file in the folder" };
  const { changedFiles, comparison } = worktree.status;
  const changes = changedFiles === null ? "Working tree status unavailable" : changedFiles === 0 ? "No uncommitted changes" : `${plural(changedFiles, "uncommitted file")}`;
  const commits = comparison === null ? "Commit comparison unavailable" : comparison.ahead === 0 ? `All commits in ${comparison.branch}` : `${plural(comparison.ahead, "commit")} not in ${comparison.branch}`;
  const tip = `${changes}. ${commits}.`;
  if (worktree.safe) return { tone: "safe", label: "Safe to delete", tip };
  const risks = [
    changedFiles ? plural(changedFiles, "uncommitted file") : null,
    comparison?.ahead ? `${plural(comparison.ahead, "unmerged commit")}` : null,
  ].filter((risk): risk is string => risk !== null);
  if (risks.length) return { tone: "warning", label: risks.join(" · "), tip };
  return { tone: "unknown", label: "Status unknown", tip };
}

function SafetyBadge({ worktree, id }: { worktree: WorktreeSettingsView; id: string }) {
  if (!worktree.available) return null;
  const { tone, label, tip } = safety(worktree);
  return <span className={`worktree-safety ${tone}`} id={id} data-tip={tip}>
    {tone === "safe" ? <Check size={12} aria-hidden="true" /> : tone === "busy" ? <span className="worktree-safety-dot" aria-hidden="true" /> : <CircleAlert size={12} aria-hidden="true" />}
    {label}
  </span>;
}

function WorktreeThreads({ worktree, expanded, dispatch, listId }: { worktree: WorktreeSettingsView; expanded: boolean; dispatch: Dispatch; listId: string }) {
  if (!worktree.threads.length) return <span className="worktree-thread-count none">No threads</span>;
  return <button className="worktree-thread-count" type="button" aria-expanded={expanded} aria-controls={listId} onClick={() => dispatch({ type: "worktree.set-threads-open", root: worktree.root, open: !expanded })}>
    <MessageSquare size={12} aria-hidden="true" />{plural(worktree.threads.length, "thread")}<ChevronRight size={12} className={expanded ? "expanded" : ""} aria-hidden="true" />
  </button>;
}

function WorktreeRow({ worktree, expanded, dispatch }: { worktree: WorktreeSettingsView; expanded: boolean; dispatch: Dispatch }) {
  const statusId = useId();
  const listId = useId();
  return <article className={`worktree-setting-row${worktree.available ? "" : " missing"}`} aria-label={worktree.title}>
    <span className="worktree-setting-icon" aria-hidden="true"><FolderGit2 size={16} /></span>
    <div className="worktree-setting-copy">
      <h4 data-tip={worktree.title} data-tip-overflow>{worktree.title}</h4>
      <div className="worktree-metadata">
        <WorktreeThreads worktree={worktree} expanded={expanded} dispatch={dispatch} listId={listId} />
        {worktree.branch && <code className="worktree-branch">{worktree.branch}</code>}
        <span className="worktree-path"><code data-tip={worktree.root}>{worktree.name}</code><CopyButton text={worktree.root} label="Copy path" /></span>
      </div>
    </div>
    <SafetyBadge worktree={worktree} id={statusId} />
    <div className="worktree-row-actions">
      {worktree.available && <button type="button" className="worktree-icon-button" aria-label={window.desktop.platform === "macos" ? "Reveal in Finder" : "Show in file manager"} data-tip={window.desktop.platform === "macos" ? "Reveal in Finder" : "Show in file manager"} onClick={() => dispatch({ type: "worktree.reveal", root: worktree.root })}>
        <FolderOpen size={16} aria-hidden="true" />
      </button>}
      {worktree.deleting
        ? <span className="text-sweep" role="status">{worktree.available ? "Deleting…" : "Forgetting…"}</span>
        : <button type="button" className="worktree-icon-button worktree-delete" aria-label={worktree.available ? "Delete…" : "Forget…"} data-tip={worktree.busy ? "Wait for the active run to finish" : worktree.available ? "Delete" : "Forget"} aria-disabled={worktree.busy || undefined} aria-describedby={worktree.busy ? statusId : undefined} onClick={() => { if (!worktree.busy) dispatch({ type: "worktree.confirm-delete", root: worktree.root }); }}>
          <Trash size={16} aria-hidden="true" />
        </button>}
    </div>
    {worktree.threads.length > 0 && <div id={listId} className="worktree-thread-list" hidden={!expanded}>
      {worktree.threads.map((thread) => <button className="worktree-thread-link" type="button" key={thread.id} onClick={() => dispatch({ type: "worktree.open-thread", taskId: thread.id })}>
        <span>{thread.title}</span>
        {thread.archived && <small>Archived</small>}
      </button>)}
    </div>}
  </article>;
}

/** Rows arrive sorted by project, so each run of one project becomes its group. */
function byProject(worktrees: WorktreeSettingsView[]) {
  const groups: Array<{ key: string; name: string; worktrees: WorktreeSettingsView[] }> = [];
  for (const worktree of worktrees) {
    const last = groups.at(-1);
    if (last?.key === worktree.projectKey) last.worktrees.push(worktree);
    else groups.push({ key: worktree.projectKey, name: worktree.project, worktrees: [worktree] });
  }
  return groups;
}

function WorktreeGroups({ worktrees, expanded, dispatch }: { worktrees: WorktreeSettingsView[]; expanded: Set<string>; dispatch: Dispatch }) {
  return <>{byProject(worktrees).map((group) => <section className="worktree-project-group" key={group.key} aria-label={group.name}>
    <h5>{group.name}<span className="worktree-count">{group.worktrees.length}</span></h5>
    {group.worktrees.map((worktree) => <WorktreeRow worktree={worktree} expanded={expanded.has(worktree.root)} dispatch={dispatch} key={worktree.root} />)}
  </section>)}</>;
}

export function WorktreeSettings({ page, error, notice, dispatch }: WorktreeSettingsProps) {
  const missingId = useId();
  const expanded = new Set(page.expandedThreads);
  const safe = page.safe.length;
  return (
    <main className="settings-main worktree-settings">
      <div className="settings-page-heading"><h2>Worktrees</h2></div>
      <section className="worktree-settings-list" aria-labelledby="worktrees-heading" aria-busy={page.loading}>
        <div className="worktree-toolbar">
          <h3 id="worktrees-heading">On this device{!page.loading && <span className="worktree-count">{page.available.length}</span>}</h3>
          <div className="worktree-controls">
            {page.projects.length > 1 && <div className="worktree-project-select">
              <select aria-label="Filter by project" value={page.project ?? ""} disabled={page.loading} onChange={(event) => dispatch({ type: "worktree.filter-project", project: event.target.value || null })}>
                <option value="">All projects{!page.loading && ` · ${page.total}`}</option>
                {page.projects.map((project) => <option value={project.key} key={project.key}>{project.name}{!page.loading && ` · ${project.count}`}</option>)}
              </select>
              <ChevronDown size={14} aria-hidden="true" />
            </div>}
            <div className="settings-group-action">
              <button type="button" disabled={page.loading} aria-busy={page.loading || undefined} onClick={() => dispatch({ type: "worktree.refresh" })}>
                <SpinningIcon icon={RefreshCw} spinning={page.loading} size={14} aria-hidden="true" />{page.loading ? "Reading…" : "Refresh"}
              </button>
              <button type="button" className="danger" disabled={page.loading || !safe} onClick={() => dispatch({ type: "worktree.confirm-delete-safe", open: true })}>
                <Trash size={14} aria-hidden="true" />{safe ? `Delete ${safe} safe` : "None safe to delete"}
              </button>
            </div>
          </div>
        </div>
        {error && <p className="settings-error" role="alert">{error}</p>}
        {notice && <p className="settings-notice" role="status">{notice}</p>}
        {page.loading && !page.available.length && <p className="settings-empty" role="status">Reading worktrees…</p>}
        {!page.loading && !error && !page.available.length && <p className="settings-empty">{page.project ? "No worktrees on this device for this project." : "No worktrees on this device."}</p>}
        <WorktreeGroups worktrees={page.available} expanded={expanded} dispatch={dispatch} />
      </section>
      {page.missing.length > 0 && <section className="worktree-missing">
        <button type="button" className="worktree-missing-toggle" aria-expanded={page.missingOpen} aria-controls={missingId} onClick={() => dispatch({ type: "worktree.set-missing-open", open: !page.missingOpen })}>
          <ChevronRight size={14} className={page.missingOpen ? "expanded" : ""} aria-hidden="true" />Missing folders <span className="worktree-count missing">{page.missing.length}</span>
        </button>
        <div id={missingId} hidden={!page.missingOpen}>
          <p className="worktree-missing-description">These folders are already gone. Forgetting them keeps your thread history.</p>
          <WorktreeGroups worktrees={page.missing} expanded={expanded} dispatch={dispatch} />
        </div>
      </section>}
      {page.confirmation && <WorktreeDeleteDialog worktree={page.confirmation} dispatch={dispatch} />}
      {page.safeConfirmation && <WorktreeBulkDeleteDialog worktrees={page.safeConfirmation} dispatch={dispatch} />}
    </main>
  );
}
