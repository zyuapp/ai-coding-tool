import type { WorkspaceState } from "../../application/workspace-state";
import type { WorkspaceInput } from "../../application/workspace-reducer";
import type { WorkspaceExecution } from "../../application/workspace-execution";
import type { AgentEvent } from "../../contracts/ipc";
import type { AppCommand } from "../../contracts/commands";
import type { ThreadRequest } from "../../contracts/threads";
import { errorMessage } from "./errors";
import { subscribeToMobile } from "./mobile-bridge";
import { answerThreadRequest, type ThreadWaiterList } from "./thread-requests";

const FLUSH_FALLBACK_MS = 32;
export type RuntimeSubscriptionHost = {
  state: () => WorkspaceState;
  dispatch: (input: WorkspaceInput) => Promise<void>;
  execute: (command: AppCommand) => WorkspaceExecution;
  waiters: ThreadWaiterList;
  prepareThreadRequest: (request: ThreadRequest) => Promise<void>;
};

/** Run and remote subscriptions outlive every mounted view. */
export function subscribeWorkspaceRuntime(host: RuntimeSubscriptionHost) {
  const stops: Array<() => void> = [];
  const flushers: Array<() => void> = [];
  function listen(start: () => (() => void) | undefined) {
    const stop = start();
    if (stop) stops.push(stop);
  }
  listen(() => {
    if (!("desktop" in window)) return;
    void host.dispatch({ type: "engine.read" });
  });
  listen(() => {
    if (!("desktop" in window)) return;
    let waiting: AgentEvent[] = [];
    let scheduled = false;
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function flush() {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      scheduled = false;
      if (!waiting.length) return;
      const events = waiting;
      waiting = [];
      void host.dispatch({ type: "agent.events", events });
    }
    flushers.push(flush);
    const stopListening = window.desktop.onAgentEvent((event) => {
      waiting.push(event);
      if (scheduled) return;
      scheduled = true;
      frame = requestAnimationFrame(flush);
      timer = setTimeout(flush, FLUSH_FALLBACK_MS);
    });
    return () => {
      stopListening();
      flush();
    };
  });
  listen(() => {
    if (!("desktop" in window)) return;
    const stopListening = window.desktop.onThreadRequest((request) => {
      void host.prepareThreadRequest(request).then(() => answerThreadRequest(host, request))
        .then((response) => window.desktop.answerThreadRequest(response))
        .catch((error) => window.desktop.answerThreadRequest({ type: "thread.response", requestId: request.requestId, ok: false, message: errorMessage(error) }));
    });
    return () => {
      stopListening();
      for (const waiter of host.waiters.current) window.clearTimeout(waiter.timer);
      host.waiters.current = [];
    };
  });
  listen(() => {
    if (!("desktop" in window)) return;
    return subscribeToMobile(host, window.desktop);
  });
  listen(() => {
    if (!("desktop" in window)) return;
    return window.desktop.onBrowserEvent((page) => void host.dispatch({ type: "browser.updated", page }));
  });
  listen(() => {
    if (!("desktop" in window)) return;
    return window.desktop.onTerminalEvent((update) => void host.dispatch({ type: "terminal.updated", update }));
  });
  listen(() => {
    if (!("desktop" in window)) return;
    return window.desktop.onBrowserFind(({ tabId, matches, index }) => void host.dispatch({
      type: "find.results",
      target: { kind: "browser", tabId },
      results: { matches, index },
    }));
  });
  listen(() => {
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
  });
  stops.push(window.desktop.onOpenProject((workspace) => void host.dispatch({ type: "project.opened", workspace })));
  return {
    stop: () => { for (const stop of stops) stop(); },
    flush: () => { for (const flush of flushers) flush(); },
  };
}
