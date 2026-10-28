import { LuChevronLeft as ChevronLeft, LuEllipsis as Ellipsis, LuQrCode as QrCode, LuSquarePen as SquarePen, LuX as X } from "react-icons/lu";
import { useCallback, useEffect, useMemo, useRef, useState, type TouchEvent } from "react";
import type { MobileCommand, MobileDraftView, MobileProjectGroup, MobileThreadView } from "../contracts/mobile";
import { defaultModelFor, type AgentEngine } from "../domain/agent-engine";
import { SETTINGS_PAGE_LABELS, settingControl } from "../domain/settings-catalog";
import type { MobileConnectionState } from "../domain/mobile";
import { useMobileClient } from "./client/useMobileClient";
import type { ReturnedCommand } from "./client/protocol";
import { readListMode, writeListMode, type MobileListMode } from "./client/storage";
import { ApprovalSheet } from "./components/ApprovalSheet";
import { Changes } from "./components/Changes";
import { Composer, type ReturnedToComposer } from "./components/Composer";
import { Conversation } from "./components/Conversation";
import { LocationSheet } from "./components/LocationSheet";
import { ProjectSheet } from "./components/ProjectSheet";
import { RenameSheet } from "./components/RenameSheet";
import { Segmented } from "./components/Segmented";
import { StartOptions } from "./components/StartOptions";
import { ThreadList } from "./components/ThreadList";
import { ThreadMenu } from "./components/ThreadMenu";
import { ThreadSettings } from "./components/ThreadSettings";
import { locationLabel } from "./format";
import { paintMobileTheme, resolveMobileTheme, writeStoredTheme } from "./theme";

const CONNECTION_LABELS: Record<MobileConnectionState, string> = {
  offline: "Offline",
  connecting: "Connecting",
  resuming: "Catching up",
  live: "Live",
};

/** Quiet until it matters: a live line says nothing, and everything else says one word. */
function ConnectionMark({ connection }: { connection: MobileConnectionState }) {
  if (connection === "live") return null;
  return <span className="line-mark" data-connection={connection}>{CONNECTION_LABELS[connection]}</span>;
}

/** Where the desktop shows its pairing QR code. */
const PAIRING_PATH = ["Settings", SETTINGS_PAGE_LABELS.phone, settingControl("phone.pairing").label].join(" › ");

/** A phone with no token and no code can do nothing but be shown one. */
function Gate({ notice }: { notice: string | null }) {
  return (
    <div className="gate">
      <QrCode size={44} strokeWidth={1.4} aria-hidden="true" />
      <h1>AI Coding Tool</h1>
      <p>{notice ?? "Scan the QR code on your computer to connect this phone."}</p>
      <p className="gate-path">{PAIRING_PATH}</p>
    </div>
  );
}

/** How long Undo stays offered after a thread is archived, counted again once a finger lets go of it. */
const UNDO_MS = 9000;

/** The thread just archived, with Undo, at the foot of the list it left for. */
function ArchivedToast({ title, onUndo, onDone }: { title: string; onUndo: () => void; onDone: () => void }) {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (held) return;
    const timer = setTimeout(onDone, UNDO_MS);
    return () => clearTimeout(timer);
  }, [onDone, held]);
  const release = () => setHeld(false);
  return (
    <div className="undo-toast" role="status" onPointerDown={() => setHeld(true)} onPointerUp={release} onPointerCancel={release} onPointerLeave={release}>
      <span>Archived <strong>{title}</strong></span>
      <button type="button" onClick={onUndo}>Undo</button>
    </div>
  );
}

const LIST_MODES: { value: MobileListMode; label: string }[] = [{ value: "projects", label: "Projects" }, { value: "activity", label: "Activity" }];

/** Which sheet the thread has up, at most one at a time. */
type ThreadSheet = "settings" | "menu" | "location" | "rename" | "project" | null;

/** Relative times are only ever minutes coarse, so the clock they read wakes twice a minute. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The phone follows the desktop's theme, and on "auto" its own appearance within the desktop's family. */
function useDesktopTheme(theme: { dark: string; light: string; mode: "dark" | "light" | "auto" } | null) {
  useEffect(() => {
    if (!theme) return;
    writeStoredTheme(window.localStorage, theme);
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const paint = () => paintMobileTheme(resolveMobileTheme(theme, scheme.matches));
    paint();
    scheme.addEventListener("change", paint);
    return () => scheme.removeEventListener("change", paint);
  }, [theme]);
}

/** How near the left edge a swipe back has to start, and how far right it has to travel. */
const EDGE_PX = 24;
const SWIPE_PX = 72;

/** A swipe in from the left edge goes back, as it does across iOS. */
function useEdgeSwipe(enabled: boolean, onSwipe: () => void) {
  const start = useRef<{ x: number; y: number } | null>(null);
  return useMemo(() => enabled ? {
    onTouchStart: (event: TouchEvent) => {
      const touch = event.touches[0];
      start.current = event.touches.length === 1 && touch && touch.clientX <= EDGE_PX ? { x: touch.clientX, y: touch.clientY } : null;
    },
    onTouchEnd: (event: TouchEvent) => {
      const from = start.current;
      const touch = event.changedTouches[0];
      start.current = null;
      if (from && touch && touch.clientX - from.x >= SWIPE_PX && Math.abs(touch.clientY - from.y) < SWIPE_PX / 2) onSwipe();
    },
  } : {}, [enabled, onSwipe]);
}

/** Where the phone is: the list, the thread the Mac has open, or that thread's changes. */
type Screen = "list" | "thread" | "changes";

/**
 * A notice sits in a strip under the bar until it is tapped away, so the title and the list switch stay put.
 *
 * The conversation is the one the desktop has open, because the desktop's selection is the only one
 * there is. So the phone asks for a thread and then shows whichever one arrives rather than waiting
 * for the one it named: the Mac's own user, or a second phone, may have moved it, and a screen that
 * waited for a thread nobody is going to open would never come back.
 */
export function App() {
  const { state, send, query, dismissNotice } = useMobileClient();
  const [screen, setScreen] = useState<Screen>("list");
  const [listMode, setListMode] = useState<MobileListMode>(() => readListMode(window.localStorage));
  const [sheet, setSheet] = useState<ThreadSheet>(null);
  /**
   * The thread a tap asked for, held until the Mac opens it or anything else. Until then the screen
   * shows its title over a blank body rather than the thread the Mac still has open from before.
   */
  const [opening, setOpening] = useState<{ title: string; project: string | null; want: string; was: string } | null>(null);
  const [archived, setArchived] = useState<{ id: string; title: string } | null>(null);
  const listScroll = useRef(0);
  const now = useNow();
  const thread = state.view.thread;
  const draft = state.view.draft;
  /** Commands only wait on the line while it is down; on a live one they are simply on their way. */
  const waiting = state.connection === "live" ? 0 : state.outbox.length;
  const notice = state.notice ?? (state.view.error !== state.dismissedError ? state.view.error : null);
  const current = thread ? thread.id : draft ? "draft" : "none";
  const reading = screen !== "list";

  /** Only a theme the Mac has actually sent is worn; the empty view's default is not the Mac's choice. */
  useDesktopTheme(state.build !== null ? state.view.theme : null);

  useEffect(() => {
    if (!opening) return;
    if (current !== opening.was || current === opening.want) {
      setOpening(null);
      return;
    }
    const timer = setTimeout(() => setOpening(null), 3000);
    return () => clearTimeout(timer);
  }, [opening, current]);

  /** The changes screen belongs to one thread; when the Mac moves on, so does the phone. */
  useEffect(() => {
    if (screen === "changes" && !thread) setScreen("thread");
  }, [screen, thread]);

  const openThread = useCallback((taskId: string, title: string, project: string | null) => {
    setOpening({ title, project, want: taskId, was: current });
    setScreen("thread");
    setSheet(null);
    send({ type: "task.select", taskId });
  }, [send, current]);

  const newThread = useCallback((projectId: string | null, project: string | null, worktreeId?: string) => {
    setOpening({ title: "New thread", project, want: "draft", was: current });
    setScreen("thread");
    setSheet(null);
    send({ type: "task.new", ...(projectId ? { projectId } : {}), ...(worktreeId ? { worktreeId } : {}) });
  }, [send, current]);

  const newFromList = useCallback((projectId: string | null, project: string | null) => newThread(projectId, project), [newThread]);

  const rememberScroll = useCallback((top: number) => {
    listScroll.current = top;
  }, []);

  const dismiss = useCallback((taskId: string) => send({ type: "task.dismiss", taskId }), [send]);
  const dismissAll = useCallback((projectId?: string) => send({ type: "task.dismiss-all", ...(projectId ? { projectId } : {}) }), [send]);

  const forgetArchived = useCallback(() => setArchived(null), []);

  const back = useCallback(() => {
    setOpening(null);
    setSheet(null);
    setScreen((from) => from === "changes" ? "thread" : "list");
  }, []);

  const chooseListMode = useCallback((mode: MobileListMode) => {
    writeListMode(window.localStorage, mode);
    setListMode(mode);
  }, []);

  const swipe = useEdgeSwipe(reading && sheet === null, back);

  if (state.entry === "blocked" && !state.credential) return <Gate notice={state.notice} />;

  const pending = opening !== null && current === opening.was && current !== opening.want;
  const title = !reading ? "Threads" : screen === "changes" ? "Changes" : pending ? opening.title : thread ? thread.title : draft ? "New thread" : "Opening";
  const project = pending ? opening.project : thread ? thread.projectName : draft ? draft.projectName : undefined;
  const subtitle = screen === "changes"
    ? thread?.title ?? null
    : reading && project !== undefined
      ? thread && !pending && thread.location.kind !== "local" ? `${project ?? "No project"} · ${locationLabel(thread.location)}` : project ?? "No project"
      : null;

  return (
    <div className="app" {...swipe}>
      <header className="bar">
        {reading
          ? <button type="button" className="ghost icon" onClick={back} aria-label={screen === "changes" ? "Back to thread" : "Back to threads"}><ChevronLeft size={22} /></button>
          : <span className="bar-spacer" />}
        {!reading
          ? <div className="bar-title bar-switch">
            <h1 className="sr-only">{title}</h1>
            <Segmented label="List" segments={LIST_MODES} value={listMode} onChange={chooseListMode} />
          </div>
          : <div className="bar-title">
            <h1>{title}</h1>
            {subtitle && <p>{subtitle}</p>}
          </div>}
        {!reading && (
          <button type="button" className="ghost icon bar-action" aria-label="New thread" onClick={() => newThread(null, null)}><SquarePen size={20} strokeWidth={1.8} /></button>
        )}
        {screen === "thread" && thread && !pending && (
          <button type="button" className="ghost icon bar-action" aria-label="Thread options" aria-haspopup="dialog" onClick={() => setSheet("menu")}><Ellipsis size={20} /></button>
        )}
        <ConnectionMark connection={state.connection} />
      </header>
      {notice && <button type="button" className="banner" onClick={dismissNotice}><span role="status">{notice}</span><X size={16} aria-hidden="true" /></button>}
      {screen === "changes" && thread
        ? <Changes thread={thread} live={state.connection === "live"} query={query} />
        : reading
          ? thread && !pending
            ? <ThreadBody thread={thread} connection={state.connection} waiting={waiting} returned={state.returned} send={send} sheet={sheet} onSheet={setSheet} onChanges={() => setScreen("changes")} onNewHere={() => newThread(thread.projectId, thread.projectName, thread.worktreeId ?? undefined)} onNewWith={(engine) => {
              newThread(thread.projectId, thread.projectName, thread.worktreeId ?? undefined);
              send({ type: "task.set-model", engine, model: defaultModelFor(engine) });
            }} onArchived={() => { setArchived({ id: thread.id, title: thread.title }); back(); }} />
            : draft && !pending
              ? <DraftBody draft={draft} groups={state.view.groups} waiting={waiting} send={send} sheet={sheet} onSheet={setSheet} onProject={newThread} onStartIn={(worktreeId) => newThread(draft.projectId, draft.projectName, worktreeId)} />
              : <div className="empty"><p>Opening the thread…</p></div>
          : <ThreadList
            mode={listMode}
            groups={state.view.groups}
            activity={state.view.activity}
            now={now}
            initialScrollTop={listScroll.current}
            onScroll={rememberScroll}
            onOpen={openThread}
            onNew={newFromList}
            onDismiss={dismiss}
            onDismissAll={dismissAll}
          />}
      {archived && !reading && <ArchivedToast
        key={archived.id}
        title={archived.title}
        onDone={forgetArchived}
        onUndo={() => {
          send({ type: "task.restore", taskId: archived.id });
          setArchived(null);
        }}
      />}
    </div>
  );
}

/**
 * What the composer of one thread gets back from a command the computer turned down: the words of a
 * message, to type again, and which question's answer to let go of, to answer again.
 */
function returnedTo(returned: ReturnedCommand | null, taskId: string): ReturnedToComposer | null {
  const command = returned?.command;
  if (!returned || !command || !("taskId" in command) || command.taskId !== taskId) return null;
  if (command.type === "task.send" && command.text) return { id: returned.requestId, text: command.text };
  if (command.type === "question.answer") return { id: returned.requestId, answer: command.questionId };
  return null;
}

function ThreadBody({ thread, connection, waiting, returned, send, sheet, onSheet, onChanges, onNewHere, onNewWith, onArchived }: {
  thread: MobileThreadView;
  connection: MobileConnectionState;
  waiting: number;
  returned: ReturnedCommand | null;
  send: (command: MobileCommand) => void;
  sheet: ThreadSheet;
  onSheet: (sheet: ThreadSheet) => void;
  onChanges: () => void;
  onNewHere: () => void;
  /** Starts a thread in the same place on another engine, which an existing thread cannot switch to. */
  onNewWith: (engine: AgentEngine) => void;
  /** The thread is gone from the list, so the screen goes back to it. */
  onArchived: () => void;
}) {
  const running = thread.status === "running";
  const close = () => onSheet(null);
  return (
    <>
      <Conversation
        thread={thread}
        onSteerQueued={(messageId) => send({ type: "task.steer-queued", taskId: thread.id, messageId })}
        onDropQueued={(messageId) => send({ type: "task.drop-queued", taskId: thread.id, messageId })}
      />
      {thread.approval && <ApprovalSheet approval={thread.approval} refused={returned?.command.type === "run.decide" ? returned.requestId : null} onDecide={(approval, allow) => send({ type: "run.decide", taskId: approval.taskId, runId: approval.runId, approvalId: approval.approvalId, allow })} />}
      <Composer
        running={running}
        waiting={waiting}
        returned={returnedTo(returned, thread.id)}
        settings={thread.settings}
        question={thread.question}
        onAnswerQuestion={(question, text) => send({ type: "question.answer", taskId: thread.id, runId: question.runId, requestId: question.requestId, questionId: question.questionId, text })}
        onSend={(text) => send({ type: "task.send", taskId: thread.id, text })}
        onSteer={(text) => send({ type: "task.send", taskId: thread.id, text, steer: true })}
        onStop={() => send({ type: "run.cancel", taskId: thread.id })}
        onOpenSettings={() => onSheet("settings")}
      />
      {sheet === "settings" && <ThreadSettings
        settings={thread.settings}
        locked
        onNewWith={onNewWith}
        onClose={close}
        onPolicy={(policy) => send({ type: "task.set-policy", taskId: thread.id, policy })}
        onModel={(engine, model) => send({ type: "task.set-model", taskId: thread.id, engine, model })}
        onFastMode={(fastMode) => send({ type: "task.set-fast-mode", taskId: thread.id, fastMode })}
        onEffort={(engine, effort) => send({ type: "task.set-effort", taskId: thread.id, engine, effort })}
      />}
      {sheet === "menu" && <ThreadMenu
        thread={thread}
        onClose={close}
        onChanges={onChanges}
        onLocation={() => onSheet("location")}
        onNewHere={onNewHere}
        onFork={(worktree) => send({ type: "task.fork", taskId: thread.id, ...(worktree ? { worktree } : {}) })}
        onRename={() => onSheet("rename")}
        onArchive={() => { send({ type: "task.archive", taskId: thread.id }); onArchived(); }}
      />}
      {sheet === "location" && <LocationSheet thread={thread} onClose={close} onMove={(destination) => send({ type: "task.move-worktree", taskId: thread.id, destination })} />}
      {sheet === "rename" && <RenameSheet title={thread.title} onClose={close} onRename={(title) => send({ type: "task.rename", taskId: thread.id, title })} />}
      {connection !== "live" && <span className="sr-only" role="status">{CONNECTION_LABELS[connection]}</span>}
    </>
  );
}

/**
 * The thread the user has asked for and not yet started. The Mac makes a thread out of the message
 * that starts it, and it starts one from its own draft, so the text is put in the draft and then
 * sent. The screen it turns into arrives as the thread the Mac has open.
 */
function DraftBody({ draft, groups, waiting, send, sheet, onSheet, onProject, onStartIn }: {
  draft: MobileDraftView;
  groups: MobileProjectGroup[];
  waiting: number;
  send: (command: MobileCommand) => void;
  sheet: ThreadSheet;
  onSheet: (sheet: ThreadSheet) => void;
  /** Starts the draft over in another project, or in none. */
  onProject: (projectId: string | null, project: string | null) => void;
  onStartIn: (worktreeId: string) => void;
}) {
  const projects = useMemo(() => groups.filter((group) => group.projectId !== null), [groups]);
  return (
    <>
      <div className="empty" />
      <Composer
        running={false}
        waiting={waiting}
        settings={draft.settings}
        onSend={(text) => {
          send({ type: "view.set-prompt", prompt: text });
          send({ type: "task.send" });
        }}
        onOpenSettings={() => onSheet("settings")}
      >
        <StartOptions draft={draft} onPickProject={projects.length ? () => onSheet("project") : undefined} onSetWorktree={(worktree) => send({ type: "task.set-worktree", worktree })} onStartIn={onStartIn} />
      </Composer>
      {sheet === "settings" && <ThreadSettings
        settings={draft.settings}
        locked={false}
        onClose={() => onSheet(null)}
        onPolicy={(policy) => send({ type: "task.set-policy", policy })}
        onModel={(engine, model) => send({ type: "task.set-model", engine, model })}
        onFastMode={(fastMode) => send({ type: "task.set-fast-mode", fastMode })}
        onEffort={(engine, effort) => send({ type: "task.set-effort", engine, effort })}
      />}
      {sheet === "project" && <ProjectSheet
        projects={projects}
        selected={draft.projectId}
        none="No project"
        label="Start in"
        onClose={() => onSheet(null)}
        onSelect={(projectId) => {
          if (projectId !== draft.projectId) onProject(projectId, projects.find((group) => group.projectId === projectId)?.name ?? null);
        }}
      />}
    </>
  );
}
