import { LuSquarePen as SquarePen } from "react-icons/lu";
import { useLayoutEffect, useRef, useState } from "react";
import type { MobileProjectGroup, MobileThreadEntry } from "../../contracts/mobile";
import { readFolded, writeFolded } from "../client/storage";
import { groupMark, threadMeta } from "../format";

function ThreadRow({ thread, now, onOpen }: { thread: MobileThreadEntry; now: number; onOpen: () => void }) {
  return (
    <button type="button" className="thread-row" data-status={thread.status} data-unread={thread.unread || undefined} onClick={onOpen}>
      <span className="thread-text">
        <span className="thread-title">{thread.title}</span>
        <span className="thread-meta">{threadMeta(thread, now)}</span>
      </span>
      <span className="thread-mark" aria-hidden="true" />
      {thread.unread && <span className="sr-only">Unread</span>}
    </button>
  );
}

function groupKey(group: MobileProjectGroup): string {
  return group.projectId ?? "recents";
}

export function ThreadList({ groups, now, initialScrollTop, onScroll, onOpen, onNew }: {
  groups: MobileProjectGroup[];
  now: number;
  /** Where the list was when it was last left, so coming back from a thread lands on the same rows. */
  initialScrollTop: number;
  onScroll: (top: number) => void;
  /** Names the thread and its project as the row shows them, so the screen can carry them before the Mac answers. */
  onOpen: (threadId: string, title: string, project: string | null) => void;
  onNew: (projectId: string | null, project: string | null) => void;
}) {
  const [folded, setFolded] = useState(() => readFolded(localStorage));
  /** A list with nothing in it keeps its groups, which are how a project is started into, under one plain way to start. */
  const bare = !groups.some((group) => group.threads.length);
  const scroller = useRef<HTMLDivElement>(null);
  const restore = useRef(initialScrollTop);
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = restore.current;
  }, []);
  function toggle(key: string) {
    const next = new Set(folded);
    if (!next.delete(key)) next.add(key);
    writeFolded(localStorage, next);
    setFolded(next);
  }

  return (
    <div className="thread-list" ref={scroller} onScroll={(event) => onScroll(event.currentTarget.scrollTop)}>
      {groups.map((group) => {
        const key = groupKey(group);
        const open = !folded.has(key);
        const mark = open ? null : groupMark(group.threads);
        const project = group.projectId ? group.name : null;
        return (
          <section key={key} className="thread-group">
            <header className="group-header">
              <button type="button" className="section-toggle" aria-expanded={open} onClick={() => toggle(key)}>
                <span>{group.name}</span>
                <span className="section-chevron" aria-hidden="true" />
                {mark && <span className="section-mark" data-kind={mark} />}
                {mark === "needs-you" && <span className="sr-only">Needs you</span>}
              </button>
              <button type="button" className="section-action" aria-label={`New thread in ${group.name}`} onClick={() => onNew(group.projectId, project)}>
                <SquarePen size={16} strokeWidth={1.8} />
              </button>
            </header>
            {open && group.threads.map((thread) => (
              <ThreadRow key={thread.id} thread={thread} now={now} onOpen={() => onOpen(thread.id, thread.title, project)} />
            ))}
            {open && !group.threads.length && !bare && <p className="group-empty">No threads yet</p>}
          </section>
        );
      })}
      {bare && (
        <div className="empty">
          <p>No threads yet</p>
          <button type="button" className="primary" onClick={() => onNew(null, null)}>Start a thread</button>
        </div>
      )}
    </div>
  );
}
