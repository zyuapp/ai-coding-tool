import { ChevronLeft, QrCode } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { MobileCommand, MobileThreadView } from "../contracts/mobile";
import type { MobileConnectionState } from "../domain/mobile";
import { useMobileClient } from "./client/useMobileClient";
import { ApprovalSheet } from "./components/ApprovalSheet";
import { Composer } from "./components/Composer";
import { Conversation } from "./components/Conversation";
import { ThreadList } from "./components/ThreadList";
import { ThreadSettings } from "./components/ThreadSettings";
import { statusLabel } from "./format";

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
        settingsLabel={`${thread.settings.model} · ${thread.settings.effort} · ${thread.settings.policy}`}
        onSend={(text) => send({ type: "task.send", taskId: thread.id, text })}
        onStop={() => send({ type: "run.cancel", taskId: thread.id })}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      {settingsOpen && <ThreadSettings
        settings={thread.settings}
        onClose={() => setSettingsOpen(false)}
        onPolicy={(policy) => send({ type: "task.set-policy", taskId: thread.id, policy })}
        onModel={(model) => send({ type: "task.set-model", taskId: thread.id, model })}
        onEffort={(effort) => send({ type: "task.set-effort", taskId: thread.id, effort })}
      />}
      {connection !== "live" && <span className="sr-only" role="status">{CONNECTION_LABELS[connection]}</span>}
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
 * The conversation is the one the desktop has open, because the desktop's selection is the only one
 * there is. So the phone asks for a thread and then shows whichever one arrives rather than waiting
 * for the one it named: the Mac's own user, or a second phone, may have moved it, and a screen that
 * waited for a thread nobody is going to open would never come back.
 */
export function App() {
  const { state, send, dismissNotice } = useMobileClient();
  const [reading, setReading] = useState(false);
  const now = useNow();
  const thread = state.view.thread;
  const waiting = state.outbox.length;
  const notice = state.notice ?? state.view.error;

  const openThread = useCallback((taskId: string) => {
    setReading(true);
    send({ type: "task.select", taskId });
  }, [send]);

  const newThread = useCallback((projectId: string | null) => {
    setReading(true);
    send({ type: "task.new", ...(projectId ? { projectId } : {}) });
  }, [send]);

  if (state.entry === "blocked" && !state.credential) return <Gate notice={state.notice} />;

  return (
    <div className="app">
      <header className="bar">
        {reading
          ? <button type="button" className="ghost icon" onClick={() => setReading(false)} aria-label="Back to threads"><ChevronLeft size={22} /></button>
          : <span className="bar-spacer" />}
        <div className="bar-title">
          <h1>{!reading ? "Threads" : thread?.title ?? "Opening"}</h1>
          {thread && reading && <p>{thread.projectName ?? "No project"} · {statusLabel(thread.status)}</p>}
        </div>
        <ConnectionMark connection={state.connection} />
      </header>
      {notice && <button type="button" className="banner" onClick={dismissNotice}>{notice}</button>}
      {reading
        ? thread
          ? <ThreadScreen thread={thread} connection={state.connection} waiting={waiting} send={send} />
          : <div className="empty"><p>Opening the thread…</p></div>
        : <ThreadList groups={state.view.groups} now={now} onOpen={openThread} onNew={newThread} />}
    </div>
  );
}
