import { LuChevronDown as ChevronDown, LuChevronLeft as ChevronLeft, LuCloudOff as CloudOff, LuEllipsis as Ellipsis, LuQrCode as QrCode, LuSquarePen as SquarePen, LuX as X } from "react-icons/lu";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type TouchEvent } from "react";
import type { MobileCommand, MobileDraftView, MobileProjectGroup, MobileThreadEntry, MobileThreadView, MobileUndo } from "../contracts/mobile";
import { defaultModelFor, type AgentEngine } from "../domain/agent-engine";
import { SETTINGS_PAGE_LABELS, settingControl } from "../domain/settings-catalog";
import { PAIRING_CODE_LENGTH, type MobileConnectionState } from "../domain/mobile";
import { useMobileClient } from "./client/useMobileClient";
import type { ReturnedCommand } from "./client/protocol";
import { readActivityProject, readListMode, readPairingCode, writeListMode, type MobileListMode } from "./client/storage";
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
import { ThreadMenu, ThreadRowMenu } from "./components/ThreadMenu";
import { ThreadSettings } from "./components/ThreadSettings";
import { locationLabel, relativeTime } from "./format";
import { paintMobileTheme, resolveMobileTheme, writeStoredTheme } from "./theme";

const CONNECTION_LABELS: Record<MobileConnectionState, string> = {
  offline: "Offline",
  connecting: "Connecting",
  resuming: "Catching up",
  live: "Live",
};

/**
 * Quiet until it matters: a live line says nothing, a dead one shows a struck cloud, and one on its
 * way a turning ring. A line down for a minute or more says for how long. The region stays mounted
 * on every screen so a reader hears each change.
 */
function ConnectionMark({ connection, now }: { connection: MobileConnectionState; now: number }) {
  const down = connection !== "live";
  const [since, setSince] = useState(() => Date.now());
  useEffect(() => {
    if (down) setSince(Date.now());
  }, [down]);
  const long = down && now - since >= 60_000;
  return (
    <span className="line-status" role="status">
      {down && (
        <span className="line-mark" data-connection={connection}>
          {connection === "offline" ? <CloudOff size={14} strokeWidth={2.2} aria-hidden="true" /> : <span className="line-spin" aria-hidden="true" />}
          {CONNECTION_LABELS[connection]}
          {long && <span className="line-since" aria-hidden="true">{relativeTime(since, now)}</span>}
        </span>
      )}
    </span>
  );
}

/** Where the desktop shows its pairing QR code. */
const PAIRING_PATH = ["Settings", SETTINGS_PAGE_LABELS.phone, settingControl("phone.pairing").label].join(" › ");

/** This page's address carrying `code`, as the QR code would have opened it. */
function pairingAddress(code: string): string {
  const url = new URL(window.location.href);
  url.hash = `pair=${code.trim().toUpperCase()}`;
  return url.href;
}

/** Letters a pairing code never uses, read as the digits they are mistaken for, as Crockford base32 reads them. */
const LOOKALIKES: Record<string, string> = { O: "0", I: "1", L: "1" };

/** What was typed or pasted, as a code: upper case, without spaces or dashes, and no longer than a code. */
function typedCode(text: string): string {
  return text.toUpperCase().replace(/[\s-]/g, "").replace(/[OIL]/g, (letter) => LOOKALIKES[letter]!).slice(0, PAIRING_CODE_LENGTH);
}

/** A phone with no token and no code is shown where the code is, and may type the one printed beside the QR. */
function Gate({ notice }: { notice: string | null }) {
  const [code, setCode] = useState("");
  const address = pairingAddress(code);
  const ready = readPairingCode(address) !== null;
  const wrong = code.length === PAIRING_CODE_LENGTH && !ready;
  return (
    <div className="gate">
      <QrCode size={44} strokeWidth={1.4} aria-hidden="true" />
      <h1>AI Coding Tool</h1>
      <p>{notice ?? "Scan the QR code on your computer to connect this phone."}</p>
      <p className="gate-path">{PAIRING_PATH}</p>
      <form
        className="gate-code"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          window.location.replace(address);
          window.location.reload();
        }}
      >
        <span className="gate-field">
          <input
            type="text"
            aria-label="Pairing code"
            aria-invalid={wrong || undefined}
            aria-describedby={wrong ? "gate-code-error" : undefined}
            placeholder={`Or type the ${PAIRING_CODE_LENGTH}-character code`}
            value={code}
            autoCapitalize="characters"
            autoComplete="one-time-code"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            onInput={(event) => setCode(typedCode(event.currentTarget.value))}
          />
          {code && <span className="gate-count" aria-hidden="true">{code.length}/{PAIRING_CODE_LENGTH}</span>}
        </span>
        <button type="submit" className="primary" disabled={!ready}>Pair</button>
      </form>
      {wrong && <p id="gate-code-error" className="gate-error" role="alert">Not a pairing code. Check it on your computer.</p>}
    </div>
  );
}

/** A notice under the bar: the words open to their full length, and only the cross puts it away. */
function Banner({ notice, onDismiss }: { notice: string; onDismiss: () => void }) {
  const [open, setOpen] = useState(false);
  /** Whether the shut text is cut short, which is the only time there is more to open. */
  const [clamped, setClamped] = useState(false);
  const words = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const node = words.current;
    if (open || !node) return;
    const measure = () => setClamped(node.scrollHeight > node.clientHeight + 1);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open, notice]);
  const text = <span ref={words} className="banner-words">{notice}</span>;
  return (
    <div className="banner" role="status" data-open={open || undefined}>
      {open || clamped
        ? <button type="button" className="banner-text" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
          {text}
          <span className="banner-more" aria-hidden="true">{open ? "Less" : "More"}<ChevronDown size={14} strokeWidth={2.2} /></span>
        </button>
        : <p className="banner-text">{text}</p>}
      <button type="button" className="banner-close" aria-label="Dismiss" onClick={onDismiss}><X size={16} aria-hidden="true" /></button>
    </div>
  );
}

/** The desktop's Undo for what was last archived, dismissed or moved, which leaves when the desktop's does. */
function UndoToast({ undo, onUndo }: { undo: MobileUndo; onUndo: () => void }) {
  return (
    <div className="undo-toast" role="status">
      <span>{undo.title}</span>
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

/** How near the left edge a swipe back has to start, how far right it has to travel, and how far it moves before the screen follows. */
const EDGE_PX = 24;
const SWIPE_PX = 72;
const FOLLOW_PX = 6;

/**
 * Whether the page runs from the iOS home screen, the one place no browser or system gesture
 * already owns the left edge. Everywhere else that gesture is the browser's back, which the history
 * entries each screen pushes turn into a step back here.
 */
function ownsLeftEdge(): boolean {
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** A swipe in from the left edge drags the screen with the finger and goes back once let go far enough, as across iOS. */
function useEdgeSwipe(enabled: boolean, onSwipe: () => void) {
  const start = useRef<{ x: number; y: number; node: HTMLElement; following: boolean } | null>(null);
  return useMemo(() => {
    if (!enabled || !ownsLeftEdge()) return {};
    /** A swipe that went drops the screen at once, under the list it uncovers; one that did not springs back. */
    const settle = (node: HTMLElement, went: boolean) => {
      if (!went) delete node.dataset.swiping;
      node.style.transform = "";
      if (!went) return;
      void node.offsetWidth;
      delete node.dataset.swiping;
    };
    return {
      onTouchStart: (event: TouchEvent<HTMLElement>) => {
        const touch = event.touches[0];
        start.current = event.touches.length === 1 && touch && touch.clientX <= EDGE_PX ? { x: touch.clientX, y: touch.clientY, node: event.currentTarget, following: false } : null;
      },
      onTouchMove: (event: TouchEvent<HTMLElement>) => {
        const from = start.current;
        const touch = event.touches[0];
        if (!from || !touch) return;
        const [dx, dy] = [touch.clientX - from.x, touch.clientY - from.y];
        if (!from.following) {
          if (Math.abs(dy) > FOLLOW_PX && Math.abs(dy) > dx) {
            start.current = null;
            return;
          }
          if (dx < FOLLOW_PX) return;
          from.following = true;
          from.node.dataset.swiping = "";
        }
        from.node.style.transform = `translateX(${Math.max(0, dx)}px)`;
      },
      onTouchEnd: (event: TouchEvent<HTMLElement>) => {
        const from = start.current;
        const touch = event.changedTouches[0];
        start.current = null;
        if (!from || !touch) return;
        const went = touch.clientX - from.x >= SWIPE_PX && Math.abs(touch.clientY - from.y) < SWIPE_PX / 2;
        settle(from.node, went);
        if (went) onSwipe();
      },
      onTouchCancel: () => {
        const from = start.current;
        start.current = null;
        if (from) settle(from.node, false);
      },
    };
  }, [enabled, onSwipe]);
}

/**
 * Each screen past the list is a history entry, so the browser's own back (Safari's edge swipe,
 * Android's back) steps back a screen instead of leaving the page. Returns what records a step in
 * and what unwinds one the page took itself.
 */
function useScreenHistory(onPopped: () => void) {
  const depth = useRef(0);
  /** Pops the page asked for itself, which have already been acted on. */
  const ownPops = useRef(0);
  const popped = useRef(onPopped);
  popped.current = onPopped;
  useEffect(() => {
    const listener = () => {
      if (ownPops.current > 0) ownPops.current -= 1;
      else {
        depth.current = Math.max(0, depth.current - 1);
        popped.current();
      }
    };
    window.addEventListener("popstate", listener);
    return () => window.removeEventListener("popstate", listener);
  }, []);
  const pushed = useCallback(() => {
    depth.current += 1;
    window.history.pushState(null, "");
  }, []);
  const unwound = useCallback(() => {
    if (!depth.current) return;
    depth.current -= 1;
    ownPops.current += 1;
    window.history.back();
  }, []);
  return useMemo(() => ({ pushed, unwound }), [pushed, unwound]);
}

/** Where the list's New starts a thread: the project the activity list is narrowed to, else the one worked in last. */
function startingProject(groups: MobileProjectGroup[], mode: MobileListMode): MobileProjectGroup | null {
  const narrowed = mode === "activity" ? readActivityProject(window.localStorage) : null;
  const filtered = narrowed ? groups.find((group) => group.projectId === narrowed) : undefined;
  if (filtered) return filtered;
  let latest: { group: MobileProjectGroup; at: number } | null = null;
  for (const group of groups) {
    for (const entry of group.threads) if (!latest || entry.lastActivityAt > latest.at) latest = { group, at: entry.lastActivityAt };
  }
  return latest?.group.projectId ? latest.group : null;
}

/** Where the phone is: the list, the thread the Mac has open, or that thread's changes. */
type Screen = "list" | "thread" | "changes";

/**
 * A notice sits in a strip under the bar until it is put away, so the title and the list switch stay put.
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
  /** The Undo already tapped, kept off screen until the desktop takes it down. */
  const [taken, setTaken] = useState<string | null>(null);
  /** The row a long press opened options for, over the list, and whether its rename is up instead. */
  const [rowMenu, setRowMenu] = useState<RowMenu | null>(null);
  const listScroll = useRef(0);
  const now = useNow();
  const thread = state.view.thread;
  const draft = state.view.draft;
  /** Commands only wait on the line while it is down; on a live one they are simply on their way. */
  const live = state.connection === "live";
  const waiting = live ? 0 : state.outbox.length;
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

  /** The screen as last drawn, which says whether a step goes deeper than the list. */
  const shown = useRef(screen);
  shown.current = screen;

  const stepBack = useCallback(() => {
    setOpening(null);
    setSheet(null);
    setScreen((from) => from === "changes" ? "thread" : "list");
  }, []);

  const screens = useScreenHistory(stepBack);

  /** Goes to `to`, a history entry deeper when it is past where the phone is now. */
  const enter = useCallback((to: Exclude<Screen, "list">) => {
    if (shown.current === "list" || (shown.current === "thread" && to === "changes")) screens.pushed();
    setScreen(to);
  }, [screens]);

  const back = useCallback(() => {
    stepBack();
    screens.unwound();
  }, [stepBack, screens]);

  /** The changes screen belongs to one thread; when the Mac moves on, so does the phone. */
  useEffect(() => {
    if (screen === "changes" && !thread) back();
  }, [screen, thread, back]);

  const openThread = useCallback((taskId: string, title: string, project: string | null) => {
    setRowMenu(null);
    setOpening({ title, project, want: taskId, was: current });
    enter("thread");
    setSheet(null);
    send({ type: "task.select", taskId });
  }, [send, current, enter]);

  const openMenu = useCallback((entry: MobileThreadEntry) => setRowMenu({ thread: entry, renaming: false }), []);

  const newThread = useCallback((projectId: string | null, project: string | null, worktreeId?: string) => {
    setOpening({ title: "New thread", project, want: "draft", was: current });
    enter("thread");
    setSheet(null);
    send({ type: "task.new", ...(projectId ? { projectId } : {}), ...(worktreeId ? { worktreeId } : {}) });
  }, [send, current, enter]);

  const dismiss = useCallback((taskId: string) => send({ type: "task.dismiss", taskId }), [send]);
  const dismissAll = useCallback((projectId?: string) => send({ type: "task.dismiss-all", ...(projectId ? { projectId } : {}) }), [send]);
  const archive = useCallback((taskId: string) => send({ type: "task.archive", taskId }), [send]);

  const newFromList = useCallback((projectId: string | null, project: string | null) => newThread(projectId, project), [newThread]);

  const rememberScroll = useCallback((top: number) => {
    listScroll.current = top;
  }, []);


  const chooseListMode = useCallback((mode: MobileListMode) => {
    writeListMode(window.localStorage, mode);
    setListMode(mode);
  }, []);

  const swipe = useEdgeSwipe(reading && sheet === null, back);
  const undo = state.view.undo;
  const undoKey = undo && `${undo.id}:${JSON.stringify(undo.command)}`;
  const toast = undo && undoKey !== taken && <UndoToast key={undoKey} undo={undo} onUndo={() => {
    setTaken(undoKey);
    send(undo.command);
  }} />;

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
          <button type="button" className="ghost icon bar-action" aria-label="New thread" onClick={() => {
            const start = startingProject(state.view.groups, listMode);
            newThread(start?.projectId ?? null, start?.name ?? null);
          }}><SquarePen size={20} strokeWidth={1.8} /></button>
        )}
        {screen === "thread" && (pending ? opening.want !== "draft" : thread !== null) && (
          <button type="button" className="ghost icon bar-action" aria-label="Thread options" aria-haspopup="dialog" disabled={pending} onClick={() => setSheet("menu")}><Ellipsis size={20} /></button>
        )}
        <ConnectionMark connection={state.connection} now={now} />
      </header>
      {notice && <Banner key={notice} notice={notice} onDismiss={dismissNotice} />}
      {screen === "changes" && thread
        ? <Changes thread={thread} live={live} query={query} />
        : reading
          ? thread && !pending
            ? <ThreadBody thread={thread} live={live} toast={toast} waiting={waiting} returned={state.returned} send={send} sheet={sheet} onSheet={setSheet} onChanges={() => enter("changes")} onNewHere={() => newThread(thread.projectId, thread.projectName, thread.worktreeId ?? undefined)} onNewWith={(engine) => {
              newThread(thread.projectId, thread.projectName, thread.worktreeId ?? undefined);
              send({ type: "task.set-model", engine, model: defaultModelFor(engine) });
            }} onArchive={() => {
              const { id } = thread;
              back();
              archive(id);
            }} />
            : draft && !pending
              ? <DraftBody draft={draft} groups={state.view.groups} live={live} waiting={waiting} send={send} sheet={sheet} onSheet={setSheet} onProject={newThread} onStartIn={(worktreeId) => newThread(draft.projectId, draft.projectName, worktreeId)} />
              : <div className="empty"><p>Opening the thread…</p></div>
          : <ThreadList
            mode={listMode}
            groups={state.view.groups}
            activity={state.view.activity}
            now={now}
            initialScrollTop={listScroll.current}
            onScroll={rememberScroll}
            onOpen={openThread}
            onMenu={openMenu}
            onNew={newFromList}
            onDismiss={dismiss}
            onDismissAll={dismissAll}
          />}
      {!reading && rowMenu && <RowOptions menu={rowMenu} send={send} onMenu={setRowMenu} onOpen={openThread} onDismiss={dismiss} onArchive={archive} />}
      {(!reading || screen === "changes") && toast}
    </div>
  );
}

type RowMenu = { thread: MobileThreadEntry; renaming: boolean };

/** A list row's options, or its rename, over the list. */
function RowOptions({ menu: { thread, renaming }, send, onMenu, onOpen, onDismiss, onArchive }: {
  menu: RowMenu;
  send: (command: MobileCommand) => void;
  onMenu: (menu: RowMenu | null) => void;
  onOpen: (taskId: string, title: string, project: string | null) => void;
  onDismiss: (taskId: string) => void;
  onArchive: (taskId: string) => void;
}) {
  const close = () => onMenu(null);
  if (renaming) return <RenameSheet title={thread.title} onClose={close} onRename={(title) => send({ type: "task.rename", taskId: thread.id, title })} />;
  return (
    <ThreadRowMenu
      thread={thread}
      onClose={close}
      onOpen={() => onOpen(thread.id, thread.title, thread.projectName)}
      onRename={() => onMenu({ thread, renaming: true })}
      onFork={() => send({ type: "task.fork", taskId: thread.id })}
      {...(thread.attention ? { onDismiss: () => onDismiss(thread.id) } : {})}
      onArchive={() => onArchive(thread.id)}
    />
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

function ThreadBody({ thread, live, toast, waiting, returned, send, sheet, onSheet, onChanges, onNewHere, onNewWith, onArchive }: {
  thread: MobileThreadView;
  live: boolean;
  /** The Undo on offer, held above the composer. */
  toast: ReactNode;
  waiting: number;
  returned: ReturnedCommand | null;
  send: (command: MobileCommand) => void;
  sheet: ThreadSheet;
  onSheet: (sheet: ThreadSheet) => void;
  onChanges: () => void;
  onNewHere: () => void;
  /** Starts a thread in the same place on another engine, which an existing thread cannot switch to. */
  onNewWith: (engine: AgentEngine) => void;
  /** Archives the thread, which is gone from the list, so the screen goes back to it. */
  onArchive: () => void;
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
      {toast && <div className="toast-dock">{toast}</div>}
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
        live={live}
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
        onArchive={onArchive}
      />}
      {sheet === "location" && <LocationSheet thread={thread} onClose={close} onMove={(destination) => send({ type: "task.move-worktree", taskId: thread.id, destination })} />}
      {sheet === "rename" && <RenameSheet title={thread.title} onClose={close} onRename={(title) => send({ type: "task.rename", taskId: thread.id, title })} />}
    </>
  );
}

/**
 * The thread the user has asked for and not yet started. The Mac makes a thread out of the message
 * that starts it, and it starts one from its own draft, so the text is put in the draft and then
 * sent. The screen it turns into arrives as the thread the Mac has open.
 */
function DraftBody({ draft, groups, live, waiting, send, sheet, onSheet, onProject, onStartIn }: {
  draft: MobileDraftView;
  groups: MobileProjectGroup[];
  live: boolean;
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
        live={live}
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
