import { LuChevronLeft as ChevronLeft, LuQrCode as QrCode, LuX as X } from "react-icons/lu";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MobileCommand, MobileDraftView, MobileThreadView } from "../contracts/mobile";
import type { MobileConnectionState } from "../domain/mobile";
import { useMobileClient } from "./client/useMobileClient";
import { ApprovalSheet } from "./components/ApprovalSheet";
import { Composer } from "./components/Composer";
import { Conversation } from "./components/Conversation";
import { ThreadList } from "./components/ThreadList";
import { ThreadSettings } from "./components/ThreadSettings";

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

function ThreadScreen({ thread, connection, waiting, send }: {
  thread: MobileThreadView;
  connection: MobileConnectionState;
  waiting: number;
  send: (command: MobileCommand) => void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const running = thread.status === "running";
  return (
    <>
      <Conversation thread={thread} />
      {thread.approval && <ApprovalSheet approval={thread.approval} onDecide={(allow) => send({ type: "run.decide", taskId: thread.id, allow })} />}
      <Composer
        running={running}
        waiting={waiting}
        settings={thread.settings}
        onSend={(text) => send({ type: "task.send", taskId: thread.id, text })}
        onStop={() => send({ type: "run.cancel", taskId: thread.id })}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      {settingsOpen && <ThreadSettings
        settings={thread.settings}
        locked
        onClose={() => setSettingsOpen(false)}
        onPolicy={(policy) => send({ type: "task.set-policy", taskId: thread.id, policy })}
        onModel={(engine, model) => send({ type: "task.set-model", taskId: thread.id, engine, model })}
        onEffort={(engine, effort) => send({ type: "task.set-effort", taskId: thread.id, engine, effort })}
      />}
      {connection !== "live" && <span className="sr-only" role="status">{CONNECTION_LABELS[connection]}</span>}
    </>
  );
}

/**
 * The thread the user has asked for and not yet started. The Mac makes a thread out of the message
 * that starts it, and it starts one from its own draft, so the text is put in the draft and then
 * sent. The screen it turns into arrives as the thread the Mac has open.
 */
function DraftScreen({ draft, waiting, send }: {
  draft: MobileDraftView;
  waiting: number;
  send: (command: MobileCommand) => void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
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
        onOpenSettings={() => setSettingsOpen(true)}
      />
      {settingsOpen && <ThreadSettings
        settings={draft.settings}
        locked={false}
        onClose={() => setSettingsOpen(false)}
        onPolicy={(policy) => send({ type: "task.set-policy", policy })}
        onModel={(engine, model) => send({ type: "task.set-model", engine, model })}
        onEffort={(engine, effort) => send({ type: "task.set-effort", engine, effort })}
      />}
    </>
  );
}

/** Relative times are only ever minutes coarse, so the clock they read wakes twice a minute. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * A notice takes the bar's title slot until it is tapped away, so it covers no row and moves none.
 *
 * The conversation is the one the desktop has open, because the desktop's selection is the only one
 * there is. So the phone asks for a thread and then shows whichever one arrives rather than waiting
 * for the one it named: the Mac's own user, or a second phone, may have moved it, and a screen that
 * waited for a thread nobody is going to open would never come back.
 */
export function App() {
  const { state, send, dismissNotice } = useMobileClient();
  const [reading, setReading] = useState(false);
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

  useEffect(() => {
    if (!opening) return;
    if (current !== opening.was || current === opening.want) {
      setOpening(null);
      return;
    }
    const timer = setTimeout(() => setOpening(null), 3000);
    return () => clearTimeout(timer);
  }, [opening, current]);

  const openThread = useCallback((taskId: string, title: string, project: string | null) => {
    setOpening({ title, project, want: taskId, was: current });
    setReading(true);
    send({ type: "task.select", taskId });
  }, [send, current]);

  const newThread = useCallback((projectId: string | null, project: string | null) => {
    setOpening({ title: "New thread", project, want: "draft", was: current });
    setReading(true);
    send({ type: "task.new", ...(projectId ? { projectId } : {}) });
  }, [send, current]);

  const back = useCallback(() => {
    setOpening(null);
    setReading(false);
  }, []);

  if (state.entry === "blocked" && !state.credential) return <Gate notice={state.notice} />;

  const pending = opening !== null && current === opening.was && current !== opening.want;
  const title = !reading ? "Threads" : pending ? opening.title : thread ? thread.title : draft ? "New thread" : "Opening";
  const project = pending ? opening.project : thread ? thread.projectName : draft ? draft.projectName : undefined;
  const subtitle = reading && project !== undefined ? project ?? "No project" : null;

  return (
    <div className="app">
      <header className="bar">
        {reading
          ? <button type="button" className="ghost icon" onClick={back} aria-label="Back to threads"><ChevronLeft size={22} /></button>
          : <span className="bar-spacer" />}
        {notice
          ? <button type="button" className="banner" role="status" onClick={dismissNotice}><span>{notice}</span><X size={15} aria-hidden="true" /></button>
          : <div className="bar-title">
            <h1>{title}</h1>
            {subtitle && <p>{subtitle}</p>}
          </div>}
        <ConnectionMark connection={state.connection} />
      </header>
      {reading
        ? thread && !pending
          ? <ThreadScreen thread={thread} connection={state.connection} waiting={waiting} send={send} />
          : draft && !pending
            ? <DraftScreen draft={draft} waiting={waiting} send={send} />
            : <div className="empty"><p>Opening the thread…</p></div>
        : <ThreadList
          groups={state.view.groups}
          now={now}
          initialScrollTop={listScroll.current}
          onScroll={(top) => { listScroll.current = top; }}
          onOpen={openThread}
          onNew={newThread}
        />}
    </div>
  );
}
