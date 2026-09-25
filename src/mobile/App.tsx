import { LuChevronLeft as ChevronLeft, LuEllipsis as Ellipsis, LuQrCode as QrCode, LuX as X } from "react-icons/lu";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MobileCommand, MobileDraftView, MobileQuery, MobileThreadView } from "../contracts/mobile";
import type { MobileConnectionState } from "../domain/mobile";
import { useMobileClient } from "./client/useMobileClient";
import { readListMode, writeListMode, type MobileListMode } from "./client/storage";
import { ApprovalSheet } from "./components/ApprovalSheet";
import { Changes } from "./components/Changes";
import { Composer } from "./components/Composer";
import { Conversation } from "./components/Conversation";
import { LocationSheet } from "./components/LocationSheet";
import { RenameSheet } from "./components/RenameSheet";
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

/** A phone with no token and no code can do nothing but be shown one. */
function Gate({ notice }: { notice: string | null }) {
  return (
    <div className="gate">
      <QrCode size={44} strokeWidth={1.4} aria-hidden="true" />
      <h1>AI Coding Tool</h1>
      <p>{notice}</p>
    </div>
  );
}

/** Which sheet the thread has up, at most one at a time. */
type ThreadSheet = "settings" | "menu" | "location" | "rename" | null;

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

/** Where the phone is: the list, the thread the Mac has open, or that thread's changes. */
type Screen = "list" | "thread" | "changes";

/**
 * A notice takes the bar's title slot until it is tapped away, so it covers no row and moves none.
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
  const listScroll = useRef(0);
  const now = useNow();
  const thread = state.view.thread;
  const draft = state.view.draft;
  const waiting = state.outbox.length;
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
  const dismissAll = useCallback(() => send({ type: "task.dismiss-all" }), [send]);

  const back = useCallback(() => {
    setOpening(null);
    setSheet(null);
    setScreen((from) => from === "changes" ? "thread" : "list");
  }, []);

  const chooseListMode = useCallback((mode: MobileListMode) => {
    writeListMode(window.localStorage, mode);
    setListMode(mode);
  }, []);

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
    <div className="app">
      <header className="bar">
        {reading
          ? <button type="button" className="ghost icon" onClick={back} aria-label={screen === "changes" ? "Back to thread" : "Back to threads"}><ChevronLeft size={22} /></button>
          : <span className="bar-spacer" />}
        {notice
          ? <button type="button" className="banner" role="status" onClick={dismissNotice}><span>{notice}</span><X size={15} aria-hidden="true" /></button>
          : !reading
            ? <div className="bar-title bar-switch">
              <h1 className="sr-only">{title}</h1>
              <div className="segmented" role="radiogroup" aria-label="List">
                <button type="button" role="radio" aria-checked={listMode === "projects"} onClick={() => chooseListMode("projects")}>Projects</button>
                <button type="button" role="radio" aria-checked={listMode === "activity"} onClick={() => chooseListMode("activity")}>Activity</button>
              </div>
            </div>
            : <div className="bar-title">
              <h1>{title}</h1>
              {subtitle && <p>{subtitle}</p>}
            </div>}
        {screen === "thread" && thread && !pending && !notice && (
          <button type="button" className="ghost icon bar-action" aria-label="Thread options" aria-haspopup="dialog" onClick={() => setSheet("menu")}><Ellipsis size={20} /></button>
        )}
        <ConnectionMark connection={state.connection} />
      </header>
      {screen === "changes" && thread
        ? <Changes thread={thread} live={state.connection === "live"} query={query} />
        : reading
          ? thread && !pending
            ? <ThreadBody thread={thread} connection={state.connection} waiting={waiting} send={send} sheet={sheet} onSheet={setSheet} onChanges={() => setScreen("changes")} onNewHere={() => newThread(thread.projectId, thread.projectName, thread.worktreeId ?? undefined)} onArchived={back} />
            : draft && !pending
              ? <DraftBody draft={draft} waiting={waiting} send={send} sheet={sheet} onSheet={setSheet} onStartIn={(worktreeId) => newThread(draft.projectId, draft.projectName, worktreeId)} />
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
    </div>
  );
}

function ThreadBody({ thread, connection, waiting, send, sheet, onSheet, onChanges, onNewHere, onArchived }: {
  thread: MobileThreadView;
  connection: MobileConnectionState;
  waiting: number;
  send: (command: MobileCommand) => void;
  sheet: ThreadSheet;
  onSheet: (sheet: ThreadSheet) => void;
  onChanges: () => void;
  onNewHere: () => void;
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
      {thread.approval && <ApprovalSheet approval={thread.approval} onDecide={(approval, allow) => send({ type: "run.decide", taskId: thread.id, runId: approval.runId, approvalId: approval.approvalId, allow })} />}
      <Composer
        running={running}
        waiting={waiting}
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
function DraftBody({ draft, waiting, send, sheet, onSheet, onStartIn }: {
  draft: MobileDraftView;
  waiting: number;
  send: (command: MobileCommand) => void;
  sheet: ThreadSheet;
  onSheet: (sheet: ThreadSheet) => void;
  onStartIn: (worktreeId: string) => void;
}) {
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
        <StartOptions draft={draft} onSetWorktree={(worktree) => send({ type: "task.set-worktree", worktree })} onStartIn={onStartIn} />
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
    </>
  );
}
