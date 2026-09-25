import type { WorkspaceState } from "../application/workspace-state.js";
import type { WorkspaceInput } from "../application/workspace-reducer.js";
import type { WorkspaceExecution } from "../application/workspace-execution.js";
import type { AgentEvent } from "../contracts/ipc.js";
import type { AppCommand } from "../contracts/commands.js";
import type { ThreadRequest } from "../contracts/threads.js";
import { errorMessage } from "./errors.js";
import { subscribeToMobile } from "./mobile-bridge.js";
import type { RuntimeDesktop, WorkspaceRuntimeHost } from "./runtime-desktop.js";
import { answerThreadRequest, type ThreadWaiterList } from "./thread-requests.js";

/** How long a run's reports are gathered where there is no paint to wait for. */
const FLUSH_INTERVAL_MS = 16;

function shortly(flush: () => void) {
  const timer = setTimeout(flush, FLUSH_INTERVAL_MS);
  return () => clearTimeout(timer);
}

export type RuntimeSubscriptionHost = {
  state: () => WorkspaceState;
  dispatch: (input: WorkspaceInput) => Promise<void>;
  execute: (command: AppCommand) => WorkspaceExecution;
  waiters: ThreadWaiterList;
  prepareThreadRequest: (request: ThreadRequest) => Promise<void>;
  desktop: RuntimeDesktop;
  frame?: WorkspaceRuntimeHost["frame"];
};

/** Run and remote subscriptions outlive every mounted view. */
export function subscribeWorkspaceRuntime(host: RuntimeSubscriptionHost) {
  const { desktop } = host;
  const stops: Array<() => void> = [];
  const flushers: Array<() => void> = [];
  function listen(start: () => (() => void) | undefined) {
    const stop = start();
    if (stop) stops.push(stop);
  }
  listen(() => {
    void host.dispatch({ type: "engine.read" });
  });
  listen(() => {
    const schedule = host.frame ?? shortly;
    let waiting: AgentEvent[] = [];
    let cancel: (() => void) | undefined;
    function flush() {
      cancel?.();
      cancel = undefined;
      if (!waiting.length) return;
      const events = waiting;
      waiting = [];
      void host.dispatch({ type: "agent.events", events });
    }
    flushers.push(flush);
    const stopListening = desktop.onAgentEvent((event) => {
      waiting.push(event);
      cancel ??= schedule(flush);
    });
    return () => {
      stopListening();
      flush();
    };
  });
  /** What a run has reported so far is folded in before anything reads or acts on the thread it went to. */
  function flushAll() { for (const flush of flushers) flush(); }
  listen(() => {
    const stopListening = desktop.onThreadRequest((request) => {
      flushAll();
      void host.prepareThreadRequest(request).then(() => answerThreadRequest(host, request))
        .then((response) => desktop.answerThreadRequest(response))
        .catch((error) => desktop.answerThreadRequest({ type: "thread.response", requestId: request.requestId, ok: false, message: errorMessage(error) }));
    });
    return () => {
      stopListening();
      for (const waiter of host.waiters.current) clearTimeout(waiter.timer);
      host.waiters.current = [];
    };
  });
  listen(() => subscribeToMobile(host, desktop));
  listen(() => desktop.onBrowserEvent((page) => void host.dispatch({ type: "browser.updated", page })));
  listen(() => desktop.onTerminalEvent((update) => void host.dispatch({ type: "terminal.updated", update })));
  listen(() => desktop.onBrowserFind(({ tabId, matches, index }) => void host.dispatch({
    type: "find.results",
    target: { kind: "browser", tabId },
    results: { matches, index },
  })));
  listen(() => {
    void desktop.listAutomations()
      .then((automations) => host.dispatch({ type: "automations.changed", automations }))
      .catch((error) => host.dispatch({ type: "action.failed", message: errorMessage(error) }));
    const stopWatching = desktop.onAutomationsChanged((automations) => void host.dispatch({ type: "automations.changed", automations }));
    const stopFiring = desktop.onAutomationFire((fire) => {
      flushAll();
      void host.dispatch({ type: "automation.fired", fire });
    });
    return () => {
      stopWatching();
      stopFiring();
    };
  });
  stops.push(desktop.onOpenProject((workspace) => void host.dispatch({ type: "project.opened", workspace })));
  stops.push(desktop.onComputersChanged((name, links) => void host.dispatch({ type: "computers.changed", name, links })));
  stops.push(desktop.onComputerState((id, state) => void host.dispatch({ type: "computer.state", id, state })));
  stops.push(desktop.onComputerNotice((id, notice) => void host.dispatch({ type: "computer.notice", id, notice })));
  return {
    stop: () => { for (const stop of stops) stop(); },
    flush: flushAll,
  };
}
