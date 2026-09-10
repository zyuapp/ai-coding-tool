import { useEffect, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import { LuCheck as Check, LuChevronLeft as ChevronLeft, LuChevronRight as ChevronRight, LuSearch as Search } from "react-icons/lu";
import type { DiffCommitHistory } from "../../application/workspace-diff";
import { COMMIT_QUERY_LIMIT } from "../../domain/commit-history";
import { useAnchoredStyle } from "./BranchMenu";
import { moveListFocus } from "../focus";

const dateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

function commitDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : dateFormat.format(date);
}

export type CommitMenuProps = {
  anchor: RefObject<HTMLButtonElement | null>;
  menuRef: RefObject<HTMLDivElement | null>;
  history: DiffCommitHistory | undefined;
  selected: string | null;
  onSearch: (query: string) => void;
  onPage: (direction: -1 | 1) => void;
  onPick: (commit: string) => void;
};

/** Git returns at most one page, so both the DOM and retained metadata stay bounded. */
export function CommitMenu({ anchor, menuRef, history, selected, onSearch, onPage, onPick }: CommitMenuProps) {
  const style = useAnchoredStyle(anchor, 360, 420);
  const list = useRef<HTMLDivElement>(null);
  const page = history?.result?.status === "available" ? history.result : null;
  const commits = page?.commits ?? [];
  const query = history?.request.query ?? "";
  const error = history?.result?.status === "error" ? history.result.message : null;
  const loading = !history || history.loading;
  useEffect(() => { if (list.current) list.current.scrollTop = 0; }, [history?.requestId]);

  return createPortal(
    <div ref={menuRef} className="commit-menu" style={style ?? undefined} role="dialog" aria-label="Choose a commit" data-popover-menu onKeyDown={moveListFocus}>
      <label className="branch-menu-field">
        <Search size={13} aria-hidden="true" />
        <input
          className="branch-menu-search"
          autoFocus
          aria-label="Search commit messages or SHA"
          placeholder="Search message or SHA"
          maxLength={COMMIT_QUERY_LIMIT}
          value={query}
          onInput={(event) => onSearch(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && commits.length === 1 && !loading) { event.preventDefault(); onPick(commits[0].sha); }
          }}
        />
      </label>
      <div ref={list} className="commit-menu-list" role="listbox" aria-label="Commits" aria-busy={loading}>
        {commits.map((commit) => (
          <button className="commit-menu-option" key={commit.sha} type="button" role="option" aria-selected={Boolean(selected && commit.sha.startsWith(selected))} title={commit.subject} onClick={() => onPick(commit.sha)}>
            <span className="commit-menu-copy"><span className="commit-menu-subject">{commit.subject || "Untitled commit"}</span><span className="commit-menu-meta"><code>{commit.sha.slice(0, 7)}</code><span>· {commit.author} · {commitDate(commit.committedAt)}</span></span></span>
            {selected && commit.sha.startsWith(selected) && <Check size={14} aria-hidden="true" />}
          </button>
        ))}
        {commits.length === 0 && <p className="commit-menu-empty" role="status">{loading ? "Reading commits…" : error ?? (query ? "No matching commits" : "No commits yet")}</p>}
      </div>
      {error ? <div className="commit-menu-footer"><button type="button" onClick={() => onSearch(query)}>Try again</button></div> : page && commits.length > 0 && (
        <div className="commit-menu-footer">
          <span>{page.offset + 1}–{page.offset + commits.length}</span>
          <button type="button" aria-label="Newer commits" data-tip="Newer commits" disabled={page.offset === 0} onClick={() => onPage(-1)}><ChevronLeft size={15} /></button>
          <button type="button" aria-label="Older commits" data-tip="Older commits" disabled={!page.hasMore} onClick={() => onPage(1)}><ChevronRight size={15} /></button>
        </div>
      )}
    </div>, document.body,
  );
}
