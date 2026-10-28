import { useId } from "react";
import { LuCheck as Check, LuChevronDown as ChevronDown, LuChevronRight as ChevronRight, LuCirclePlus as CirclePlus, LuFolderGit2 as FolderGit2, LuMessageSquare as MessageSquare, LuRefreshCw as RefreshCw } from "react-icons/lu";
import type { WorktreeSettingsPage, WorktreeSettingsView } from "../../application/worktree-settings";
import type { WorktreeCommand } from "../../contracts/commands";
import { WorktreeDeleteDialog } from "./WorktreeDeleteDialog";
import { SpinningIcon } from "./SpinningIcon";
import { CopyButton } from "./CopyButton";

type Dispatch = (command: WorktreeCommand) => void;

export type WorktreeSettingsProps = {
  page: WorktreeSettingsPage;
  error: string | null;
  notice: string | null;
  dispatch: Dispatch;
};

function WorktreeStatus({ worktree }: { worktree: WorktreeSettingsView }) {
  if (!worktree.available) return null;
  if (!worktree.repository) return <span className="worktree-status-warning">Git repository unavailable</span>;
  const { changedFiles, comparison } = worktree.status;
  let changes = "Working tree status unavailable";
  if (changedFiles === 0) changes = "No uncommitted changes";
  if (changedFiles !== null && changedFiles > 0) changes = `${changedFiles} changed ${changedFiles === 1 ? "file" : "files"}`;
  let commits = "Commit comparison unavailable";
  if (comparison) {
    commits = comparison.ahead === 0
      ? `All commits in ${comparison.branch}`
      : `${comparison.ahead} ${comparison.ahead === 1 ? "commit" : "commits"} not in ${comparison.branch}`;
  }
  return <>
    {!worktree.branch && <span>Detached</span>}
    <span className={changedFiles === 0 ? "worktree-status-clean" : "worktree-status-warning"}>
      {changedFiles === 0 ? <Check size={14} aria-hidden="true" /> : <CirclePlus size={14} aria-hidden="true" />}{changes}
    </span>
    <span>{commits}</span>
  </>;
}

function WorktreeThreads({ worktree, expanded, dispatch }: { worktree: WorktreeSettingsView; expanded: boolean; dispatch: Dispatch }) {
  const id = useId();
  if (!worktree.threads.length) return <p className="worktree-no-threads">No linked threads</p>;
  const single = worktree.threads.length === 1;
  return <div className="worktree-threads">
    {!single && <button className="worktree-thread-link worktree-threads-toggle" type="button" aria-expanded={expanded} aria-controls={id} onClick={() => dispatch({ type: "worktree.set-threads-open", root: worktree.root, open: !expanded })}>
      <ChevronRight size={14} className={expanded ? "expanded" : ""} aria-hidden="true" />{worktree.threads.length} linked threads
    </button>}
    <div id={id} className={single ? "worktree-thread-list single" : "worktree-thread-list"} hidden={!single && !expanded}>
      {worktree.threads.map((thread) => <button className="worktree-thread-link" type="button" key={thread.id} onClick={() => dispatch({ type: "worktree.open-thread", taskId: thread.id })}>
        <MessageSquare size={14} aria-hidden="true" />
        <span>{!worktree.available && single ? "Open thread" : thread.title}</span>
        {thread.archived && <small>Archived</small>}
      </button>)}
    </div>
  </div>;
}

function WorktreeRow({ worktree, expanded, dispatch }: { worktree: WorktreeSettingsView; expanded: boolean; dispatch: Dispatch }) {
  const busyId = useId();
  return <article className={`worktree-setting-row${worktree.available ? "" : " missing"}`} aria-label={worktree.title}>
    <span className="worktree-setting-icon" aria-hidden="true"><FolderGit2 size={16} /></span>
    <div className="worktree-setting-copy">
      <div className="worktree-title"><h4>{worktree.title}</h4>{worktree.busy && <span className="worktree-busy" id={busyId}>Run active</span>}</div>
      <div className="worktree-path"><code>{worktree.root}</code><CopyButton text={worktree.root} label="Copy path" /></div>
      <div className="worktree-metadata"><span>{worktree.project}</span><WorktreeStatus worktree={worktree} /></div>
      <WorktreeThreads worktree={worktree} expanded={expanded} dispatch={dispatch} />
    </div>
    <div className="worktree-row-actions">
      {worktree.available && <button type="button" className="worktree-reveal" onClick={() => dispatch({ type: "worktree.reveal", root: worktree.root })}>
        {window.desktop.platform === "macos" ? "Reveal in Finder" : "Show in file manager"}
      </button>}
      {worktree.deleting
        ? <span className="text-sweep" role="status">{worktree.available ? "Deleting…" : "Forgetting…"}</span>
        : <button type="button" className="worktree-delete" aria-disabled={worktree.busy || undefined} aria-describedby={worktree.busy ? busyId : undefined} data-tip={worktree.busy ? "Wait for the active run to finish" : undefined} onClick={() => { if (!worktree.busy) dispatch({ type: "worktree.confirm-delete", root: worktree.root }); }}>
          {worktree.available ? "Delete…" : "Forget…"}
        </button>}
    </div>
  </article>;
}

export function WorktreeSettings({ page, error, notice, dispatch }: WorktreeSettingsProps) {
  const missingId = useId();
  const expanded = new Set(page.expandedThreads);
  return (
    <main className="settings-main worktree-settings">
      <div className="settings-page-heading">
        <h2>Worktrees</h2>
        <p>Folders where threads work on their own copy of a project, apart from its checkout.</p>
      </div>
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
              <button type="button" disabled={page.loading} aria-busy={page.loading || undefined} data-tip="Compares commits with local Git refs. Fetch first for the latest." onClick={() => dispatch({ type: "worktree.refresh" })}>
                <SpinningIcon icon={RefreshCw} spinning={page.loading} size={14} aria-hidden="true" />{page.loading ? "Reading…" : "Refresh"}
              </button>
            </div>
          </div>
        </div>
        {error && <p className="settings-error" role="alert">{error}</p>}
        {notice && <p className="settings-notice" role="status">{notice}</p>}
        {page.loading && <p className="settings-empty" role="status">Reading worktrees…</p>}
        {!page.loading && !error && !page.available.length && <p className="settings-empty">{page.project
          ? <>No worktrees on this device for this project. <button type="button" className="settings-empty-action" onClick={() => dispatch({ type: "worktree.filter-project", project: null })}>Show all projects</button></>
          : "No worktrees on this device."}</p>}
        {page.available.map((worktree) => <WorktreeRow worktree={worktree} expanded={expanded.has(worktree.root)} dispatch={dispatch} key={worktree.root} />)}
      </section>
      {page.missing.length > 0 && <section className="worktree-missing">
        <button type="button" className="worktree-missing-toggle" aria-expanded={page.missingOpen} aria-controls={missingId} onClick={() => dispatch({ type: "worktree.set-missing-open", open: !page.missingOpen })}>
          <ChevronRight size={14} className={page.missingOpen ? "expanded" : ""} aria-hidden="true" />Missing folders <span className="worktree-count missing">{page.missing.length}</span>
        </button>
        <div id={missingId} hidden={!page.missingOpen}>
          <p className="worktree-missing-description">These folders are already gone. Forgetting them keeps your thread history.</p>
          {page.missing.map((worktree) => <WorktreeRow worktree={worktree} expanded={expanded.has(worktree.root)} dispatch={dispatch} key={worktree.root} />)}
        </div>
      </section>}
      {page.confirmation && <WorktreeDeleteDialog worktree={page.confirmation} dispatch={dispatch} />}
    </main>
  );
}
