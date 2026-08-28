import { useEffect } from "react";
import type { WorkspaceState } from "../../application/workspace-state";
import type { WorkspaceInput } from "../../application/workspace-reducer";
import type { AgentEvent } from "../../contracts/ipc";
import { displayShortcut } from "../../domain/shortcuts";
import { MAC } from "../platform";
import { subscribeToDesktop } from "./desktop-subscriptions";
import { errorMessage } from "./errors";
import { subscribeToMobile } from "./mobile-bridge";
import { onTerminalFindResults, onTerminalResize } from "./terminal-views";
import { answerThreadRequest, type ThreadWaiterList } from "./thread-requests";
import { hasPersistenceDelta, persistenceDelta, persistenceState, storeBackfill, type PersistenceQueue } from "./workspace-persistence";

/** The window's state, its door into the reducer, and the two holders a first load writes. */
export type SubscriptionHost = {
  state: () => WorkspaceState;
  dispatch: (input: WorkspaceInput) => Promise<void>;
  waiters: ThreadWaiterList;
  persistence: { current: PersistenceQueue };
  persistenceReady: { current: boolean };
};

/** Which channel the event arrived on: a run's own, or the thread's, which outlives every run. */
function agentEventInput(event: AgentEvent): WorkspaceInput {
  return "runId" in event ? { type: "run.event", event } : { type: "thread.event", event };
}

/** The store the window loads once, and everything main says about runs, threads and phones. */
function useDesktopSubscriptions(host: SubscriptionHost) {
  useEffect(() => {
    const onFocus = () => void host.dispatch({ type: "view.set-focused", focused: true });
    const onBlur = () => void host.dispatch({ type: "view.set-focused", focused: false });
    if (typeof document !== "undefined" && !document.hasFocus()) onBlur();
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.desktop.loadTaskStore().then(async (data) => {
      if (cancelled) return;
      if (data) {
        await host.dispatch({ type: "store.loaded", data });
        const current = persistenceState(host.state());
        const backfill = storeBackfill(data, current);
        if (hasPersistenceDelta(backfill)) await window.desktop.persistTaskStore(backfill);
      } else {
        await host.dispatch({ type: "store.absent" });
        await window.desktop.persistTaskStore(persistenceDelta(null, persistenceState(host.state())));
      }
      host.persistence.current.persisted = persistenceState(host.state());
      host.persistenceReady.current = true;
    }).catch((error) => {
      if (cancelled) return;
      void host.dispatch({ type: "store.failed", message: errorMessage(error) });
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!("desktop" in window)) return;
    return window.desktop.onAgentEvent((event) => void host.dispatch(agentEventInput(event)));
  }, []);

  useEffect(() => {
    if (!("desktop" in window)) return;
    const stopListening = window.desktop.onThreadRequest((request) => {
      void answerThreadRequest(host, request).then((response) => window.desktop.answerThreadRequest(response));
    });
    return () => {
      stopListening();
      for (const waiter of host.waiters.current) window.clearTimeout(waiter.timer);
      host.waiters.current = [];
    };
  }, []);

  useEffect(() => {
    if (!("desktop" in window)) return;
    return subscribeToMobile(host, window.desktop);
  }, []);
}

/** The panels' own events, the keystrokes main matches, and the schedules that fire without one. */
function useSurfaceSubscriptions(host: SubscriptionHost) {
  useEffect(() => {
    if (!("desktop" in window)) return;
    return window.desktop.onBrowserEvent((page) => void host.dispatch({ type: "browser.updated", page }));
  }, []);

  useEffect(() => {
    if (!("desktop" in window)) return;
    return window.desktop.onTerminalEvent((update) => void host.dispatch({ type: "terminal.updated", update }));
  }, []);

  useEffect(() => {
    if (!("desktop" in window)) return;
    return window.desktop.onBrowserFind(({ tabId, matches, index }) => void host.dispatch({
      type: "find.results",
      target: { kind: "browser", tabId },
      results: { matches, index },
    }));
  }, []);

  useEffect(() => {
    const stopReporting = onTerminalFindResults((terminalId, results) => void host.dispatch({ type: "find.results", target: { kind: "terminal", terminalId }, results }));
    const stopSizing = onTerminalResize((terminalId, cols, rows) => void host.dispatch({ type: "terminal.resize", terminalId, cols, rows }));
    return () => {
      stopReporting();
      stopSizing();
    };
  }, []);

  /**
   * Which dock tab the keyboard is in, read from where the caret actually is: focus moving out of one
   * view and into another fires twice, so the answer is settled once a frame from `document.activeElement`.
   */
  useEffect(() => {
    let frame = 0;
    const look = () => {
      frame = 0;
      const tab = document.activeElement?.closest("[data-dock-tab]")?.getAttribute("data-dock-tab") ?? null;
      void host.dispatch({ type: "view.dock-keys", tab });
    };
    const settle = () => { frame ||= requestAnimationFrame(look); };
    window.addEventListener("focusin", settle);
    window.addEventListener("focusout", settle);
    return () => {
      window.removeEventListener("focusin", settle);
      window.removeEventListener("focusout", settle);
      cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    if (!("desktop" in window)) return;
    /** Preferences are read before the first render, so the bindings they hold reach main from here. */
    window.desktop.setShortcuts(host.state().shortcuts);
    window.desktop.setCaptureOptions({ sound: host.state().captureSound, focus: host.state().captureFocus });
    const stopListening = window.desktop.onShortcut(({ action, surface }) => void host.dispatch({ type: "view.shortcut", action, surface }));
    const stopCapturing = window.desktop.onShortcutCaptured((binding) => void host.dispatch({ type: "shortcut.captured", binding }));
    const stopRefusals = window.desktop.onDesktopShortcutRefused((binding) => void host.dispatch({
      type: "action.failed",
      message: `${displayShortcut(binding, MAC)} belongs to another app, so grabbing a window has no shortcut.`,
    }));
    return () => {
      stopListening();
      stopCapturing();
      stopRefusals();
    };
  }, []);

  /** The two side buttons on a mouse mean what the back and forward keystrokes mean. */
  useEffect(() => {
    function navigate(event: MouseEvent) {
      if (event.button !== 3 && event.button !== 4) return;
      /** Chromium walks its own session history on the press, which would take the window off the app. */
      event.preventDefault();
      if (event.type !== "mouseup") return;
      void host.dispatch({ type: "view.shortcut", action: event.button === 3 ? "nav.back" : "nav.forward", surface: "any" });
    }
    window.addEventListener("mousedown", navigate);
    window.addEventListener("mouseup", navigate);
    return () => {
      window.removeEventListener("mousedown", navigate);
      window.removeEventListener("mouseup", navigate);
    };
  }, []);

  useEffect(() => {
    if (!("desktop" in window)) return;
    return subscribeToDesktop((input) => void host.dispatch(input));
  }, []);

  /** Which engines can take a run, asked once; a sign-in answers with the status after it. */
  useEffect(() => {
    if (!("desktop" in window)) return;
    let cancelled = false;
    void window.desktop.engineStatus()
      .then((status) => { if (!cancelled) return host.dispatch({ type: "engine.status", status }); })
      .catch((error) => { if (!cancelled) return host.dispatch({ type: "action.failed", message: errorMessage(error) }); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!("desktop" in window)) return;
    void window.desktop.listAutomations()
      .then((automations) => host.dispatch({ type: "automations.changed", automations }))
      .catch((error) => host.dispatch({ type: "action.failed", message: errorMessage(error) }));
    const stopWatching = window.desktop.onAutomationsChanged((automations) => void host.dispatch({ type: "automations.changed", automations }));
    const stopFiring = window.desktop.onAutomationFire((fire) => void host.dispatch({ type: "automation.fired", fire }));
    return () => {
      stopWatching();
      stopFiring();
    };
  }, []);
}

/** Everything the window listens to for as long as it is open, opened in one place and in one order. */
export function useWorkspaceSubscriptions(host: SubscriptionHost) {
  useDesktopSubscriptions(host);
  useSurfaceSubscriptions(host);
}
