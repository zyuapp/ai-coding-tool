import { LuCheck as Check, LuChevronDown as ChevronDown, LuFolder as Folder, LuSquarePen as SquarePen } from "react-icons/lu";
import { memo, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import type { MobileActivity, MobileProjectGroup, MobileThreadEntry } from "../../contracts/mobile";
import { readActivityProject, readFolded, writeActivityProject, writeFolded, type MobileListMode } from "../client/storage";
import { activityMeta, groupMark, threadMeta } from "../format";
import { ProjectSheet } from "./ProjectSheet";

/** How long a finger rests on a row before it asks for the thread's options, and how far it may drift meanwhile. */
const LONG_PRESS_MS = 480;
const LONG_PRESS_SLOP_PX = 10;

/** A press held on a row, or the context menu a keyboard or a mouse asks for, opens the thread's options. */
function useLongPress(onLongPress: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  /** Set once the press has opened the options, so the tap its release makes does not also open the thread. */
  const fired = useRef(false);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  };
  return {
    onPointerDown: (event: PointerEvent) => {
      fired.current = false;
      if (event.pointerType === "mouse") return;
      cancel();
      origin.current = { x: event.clientX, y: event.clientY };
      timer.current = setTimeout(() => {
        timer.current = null;
        fired.current = true;
        navigator.vibrate?.(8);
        onLongPress();
      }, LONG_PRESS_MS);
    },
    onPointerMove: (event: PointerEvent) => {
      const from = origin.current;
      if (from && Math.hypot(event.clientX - from.x, event.clientY - from.y) > LONG_PRESS_SLOP_PX) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onContextMenu: (event: MouseEvent) => {
      event.preventDefault();
      if (fired.current) return;
      cancel();
      onLongPress();
    },
    onClickCapture: (event: MouseEvent) => {
      if (!fired.current) return;
      fired.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}

function ThreadRow({ thread, meta, onOpen, onMenu, onDismiss }: {
  thread: MobileThreadEntry;
  meta: string;
  onOpen: () => void;
  onMenu: () => void;
  /** Present on a Priority row the user may file away, which takes the mark's place. */
  onDismiss?: () => void;
}) {
  const press = useLongPress(onMenu);
  return (
    <div className="thread-row" data-status={thread.status} data-unread={thread.unread || undefined} data-waiting={thread.waiting}>
      <button type="button" className="thread-open" onClick={onOpen} {...press}>
        <span className="thread-title">{thread.title}</span>
        {thread.headline && <span className="thread-headline">{thread.headline}</span>}
        <span className="thread-meta">{meta}</span>
        {thread.waiting && thread.status !== "awaiting-approval" && <span className="sr-only">Needs you</span>}
        {thread.unread && <span className="sr-only">Unread</span>}
      </button>
      {/** A row that needs the user keeps saying so beside Dismiss, which takes the mark's place otherwise. */}
      {(!onDismiss || thread.status === "awaiting-approval" || thread.waiting) && <span className="thread-mark" aria-hidden="true" />}
      {onDismiss && <button type="button" className="thread-dismiss" aria-label={`Dismiss ${thread.title}`} onClick={onDismiss}><span className="thread-dismiss-disc"><Check size={14} strokeWidth={2.4} /></span></button>}
    </div>
  );
}

function groupKey(group: MobileProjectGroup): string {
  return group.projectId ?? "recents";
}

type Section = { key: string; label: string; threads: MobileThreadEntry[] };

function narrowActivity(activity: MobileActivity, projectId: string): MobileActivity {
  const keep = (thread: MobileThreadEntry) => thread.projectId === projectId;
  return { priority: activity.priority.filter(keep), running: activity.running.filter(keep), threads: activity.threads.filter(keep), snoozed: activity.snoozed.filter(keep) };
}

/** The activity list's sections, drawn in the order the desktop draws them. */
const ACTIVITY_SECTIONS: ReadonlyArray<{ key: keyof MobileActivity; label: string }> = [
  { key: "priority", label: "Priority" },
  { key: "running", label: "Running" },
  { key: "threads", label: "Threads" },
  { key: "snoozed", label: "Snoozed" },
];

export const ThreadList = memo(function ThreadList({ mode, groups, activity, filing, now, initialScrollTop, onScroll, onOpen, onMenu, onNew, onDismiss, onDismissAll }: {
  mode: MobileListMode;
  groups: MobileProjectGroup[];
  activity: MobileActivity;
  /** Priority rows already dismissed while Undo is still offered, which Priority no longer shows. */
  filing: ReadonlySet<string>;
  now: number;
  /** Where the list was when it was last left, so coming back from a thread lands on the same rows. */
  initialScrollTop: number;
  onScroll: (top: number) => void;
  /** Names the thread and its project as the row shows them, so the screen can carry them before the Mac answers. */
  onOpen: (threadId: string, title: string, project: string | null) => void;
  /** Opens the thread with its options up. */
  onMenu: (threadId: string, title: string, project: string | null) => void;
  onNew: (projectId: string | null, project: string | null) => void;
  onDismiss: (threadId: string, title: string) => void;
  /** Files away the Priority rows shown, named as the toast names them, in `projectId` or every project. */
  onDismissAll: (threadIds: string[], title: string, projectId?: string) => void;
}) {
  const [folded, setFolded] = useState(() => readFolded(localStorage));
  const [chosenProject, setChosenProject] = useState(() => readActivityProject(localStorage));
  const [picking, setPicking] = useState(false);
  const projects = useMemo(() => groups.filter((group) => group.projectId !== null), [groups]);
  /** A project the Mac no longer lists narrows nothing, so the list is never emptied by one that is gone. */
  const narrowed = projects.find((group) => group.projectId === chosenProject);
  const project = narrowed?.projectId ?? null;
  const shown = useMemo(() => {
    const narrowedTo = project ? narrowActivity(activity, project) : activity;
    return filing.size ? { ...narrowedTo, priority: narrowedTo.priority.filter((thread) => !filing.has(thread.id)) } : narrowedTo;
  }, [activity, project, filing]);
  const dismissable = shown.priority.filter((thread) => thread.attention);
  /** A list with nothing in it keeps its groups, which are how a project is started into, under one plain way to start. */
  const bare = !groups.some((group) => group.threads.length);
  const scroller = useRef<HTMLDivElement>(null);
  const restore = useRef(initialScrollTop);
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = restore.current;
  }, []);
  function chooseProject(projectId: string | null) {
    writeActivityProject(localStorage, projectId);
    setChosenProject(projectId);
  }

  function toggle(key: string) {
    const next = new Set(folded);
    if (!next.delete(key)) next.add(key);
    writeFolded(localStorage, next);
    setFolded(next);
  }

  function section({ key, label, threads }: Section, extra: { action?: React.ReactNode; empty?: string; meta: (thread: MobileThreadEntry) => string; dismissable?: boolean; project: (thread: MobileThreadEntry) => string | null }) {
    const open = !folded.has(key);
    const mark = open ? null : groupMark(threads);
    return (
      <section key={key} className="thread-group" aria-live={key === "priority" ? "polite" : undefined}>
        <header className="group-header">
          <button type="button" className="section-toggle" aria-expanded={open} onClick={() => toggle(key)}>
            <span>{label}</span>
            {!open && threads.length > 0 && <span className="section-count">{threads.length}</span>}
            <span className="section-chevron" aria-hidden="true" />
            {mark && <span className="section-mark" data-kind={mark} />}
            {mark === "needs-you" && <span className="sr-only">Needs you</span>}
          </button>
          {extra.action}
        </header>
        {open && threads.map((thread) => (
          <ThreadRow
            key={thread.id}
            thread={thread}
            meta={extra.meta(thread)}
            onOpen={() => onOpen(thread.id, thread.title, extra.project(thread))}
            onMenu={() => onMenu(thread.id, thread.title, extra.project(thread))}
            {...(extra.dismissable && thread.attention ? { onDismiss: () => onDismiss(thread.id, thread.title) } : {})}
          />
        ))}
        {open && !threads.length && extra.empty && <p className="group-empty">{extra.empty}</p>}
      </section>
    );
  }

  return (
    <div className="thread-list" ref={scroller} onScroll={(event) => onScroll(event.currentTarget.scrollTop)}>
      {mode === "projects" && groups.map((group) => {
        const project = group.projectId ? group.name : null;
        return section({ key: groupKey(group), label: group.name, threads: group.threads }, {
          action: <button type="button" className="section-action" aria-label={`New thread in ${group.name}`} onClick={() => onNew(group.projectId, project)}><SquarePen size={18} strokeWidth={1.8} /></button>,
          empty: bare ? undefined : "No threads yet",
          meta: (thread) => threadMeta(thread, now),
          project: () => project,
        });
      })}
      {mode === "activity" && projects.length > 0 && (
        <button type="button" className="list-filter" data-narrowed={narrowed ? true : undefined} aria-haspopup="dialog" onClick={() => setPicking(true)}>
          <Folder size={16} strokeWidth={1.8} aria-hidden="true" />
          <span>{narrowed?.name ?? "All projects"}</span>
          <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
        </button>
      )}
      {/** Snoozed only shows while something is in it, as on the desktop. */}
      {mode === "activity" && ACTIVITY_SECTIONS.filter(({ key }) => key !== "snoozed" || shown.snoozed.length).map(({ key, label }) => section({ key: `activity:${key}`, label, threads: shown[key] }, {
        action: key === "priority" && dismissable.length
          ? <button type="button" className="section-text-action" onClick={() => onDismissAll(dismissable.map((thread) => thread.id), dismissable.length === 1 ? dismissable[0]!.title : `${dismissable.length} threads`, project ?? undefined)}>Dismiss all</button>
          : undefined,
        empty: key === "priority" ? "Nothing waiting" : undefined,
        meta: (thread) => activityMeta(thread, now),
        dismissable: key === "priority",
        project: (thread) => thread.projectName,
      }))}
      {picking && <ProjectSheet projects={projects} selected={project} onClose={() => setPicking(false)} onSelect={chooseProject} />}
      {bare && (
        <div className="empty">
          <p>No threads yet</p>
          <button type="button" className="primary" onClick={() => onNew(null, null)}>Start a thread</button>
        </div>
      )}
    </div>
  );
});
