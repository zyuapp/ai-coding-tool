import { FolderGit2, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { WorktreeSettingsView } from "../../application/workspace-state";

export type WorktreeSettingsProps = {
  worktrees: WorktreeSettingsView[] | null;
  error: string | null;
  notice: string | null;
  onRefresh: () => void;
  onReveal: (root: string) => void;
  onDelete: (root: string) => void;
};

function threadLabel(worktree: WorktreeSettingsView) {
  if (!worktree.threads.length) return "No linked threads";
  const archived = worktree.threads.filter((thread) => thread.archived).length;
  return `${worktree.threads.length} linked ${worktree.threads.length === 1 ? "thread" : "threads"}${archived ? `, ${archived} archived` : ""}`;
}

export function WorktreeSettings({ worktrees, error, notice, onRefresh, onReveal, onDelete }: WorktreeSettingsProps) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const deleteButtons = useRef(new Map<string, HTMLButtonElement>());
  const confirmation = useRef<HTMLButtonElement>(null);

  useEffect(() => { if (confirming) confirmation.current?.focus(); }, [confirming]);

  function cancel(root: string) {
    setConfirming(null);
    requestAnimationFrame(() => deleteButtons.current.get(root)?.focus());
  }

  return (
    <main className="settings-main" onKeyDown={(event) => {
      if (event.key !== "Escape" || !confirming) return;
      event.preventDefault();
      event.stopPropagation();
      cancel(confirming);
    }}>
      <div className="settings-page-heading">
        <h2>Worktrees</h2>
        <p>Checkouts AI Coding Tool keeps outside your projects. They stay until you delete them.</p>
      </div>

      <section className="settings-group" aria-labelledby="worktrees-heading" aria-live="polite">
        <div className="settings-group-heading">
          <div>
            <h3 id="worktrees-heading">Managed worktrees</h3>
            <p>Deletion snapshots loose work first. AI Coding Tool never removes these during startup.</p>
          </div>
          <div className="settings-group-action">
            {worktrees && <span>{worktrees.length} {worktrees.length === 1 ? "worktree" : "worktrees"}</span>}
            <button type="button" onClick={onRefresh}><RefreshCw size={13} aria-hidden="true" />Refresh</button>
          </div>
        </div>

        {error && <p className="settings-error" role="alert">{error}</p>}
        {notice && <p className="settings-notice" role="status">{notice}</p>}
        {worktrees === null
          ? <p className="settings-empty">Reading app-owned worktrees…</p>
          : worktrees.length === 0
            ? <p className="settings-empty">No managed worktrees.</p>
            : worktrees.map((worktree) => {
                const status = !worktree.available
                  ? "Missing from disk"
                  : worktree.repository === null
                    ? "Git repository unavailable"
                    : worktree.branch ?? "Detached";
                const deleting = confirming === worktree.root;
                return (
                  <div className="setting-row worktree-setting-row" key={worktree.root}>
                    <span className={`setting-status ${worktree.available ? "granted" : "archived"}`}><FolderGit2 size={13} /></span>
                    <div className="worktree-setting-copy">
                      <strong>{worktree.name}</strong>
                      <p>{[worktree.project, status, threadLabel(worktree)].filter(Boolean).join(" · ")}</p>
                      <code title={worktree.root}>{worktree.root}</code>
                      {deleting && worktree.repository === null && worktree.available && <small>This directory is not connected to a Git repository, so Git cannot preserve its contents.</small>}
                    </div>
                    <div className="setting-row-action">
                      {deleting
                        ? <>
                            <button ref={confirmation} className="danger" type="button" onClick={() => {
                              setConfirming(null);
                              onDelete(worktree.root);
                            }}>{worktree.available ? "Delete worktree" : "Remove record"}</button>
                            <button type="button" onClick={() => cancel(worktree.root)}>Cancel</button>
                          </>
                        : <>
                            {worktree.available && <button type="button" onClick={() => onReveal(worktree.root)}>Reveal in Finder</button>}
                            {worktree.busy
                              ? <em>Run active</em>
                              : <button ref={(button) => {
                                  if (button) deleteButtons.current.set(worktree.root, button);
                                  else deleteButtons.current.delete(worktree.root);
                                }} type="button" onClick={() => setConfirming(worktree.root)}>{worktree.available ? "Delete…" : "Remove record…"}</button>}
                          </>}
                    </div>
                  </div>
                );
              })}
      </section>
    </main>
  );
}
