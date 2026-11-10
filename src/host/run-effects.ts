import { errorMessage } from "./errors.js";
import { saveViewPreferences } from "./view-preferences-store.js";
import { resolveRunWorkspace } from "./resolve-run-workspace.js";
import type { EffectHandlers } from "./effect-host.js";
import { isSubagentEvent, type AgentEvent } from "../contracts/ipc.js";
import type { HostModule } from "./host-module.js";
import type { RuntimeSubscriptionHost } from "./runtime-subscriptions.js";
import { answerThreadRequest } from "./thread-requests.js";

/** Loaded on first use, since its markdown parser is a large part of main's startup otherwise. */
let images: Promise<typeof import("../application/message-images.js")> | undefined;

/** What a run takes to start, what it is told while it runs, what is read back about it, and what its messages leave behind. */
export const runEffects = {
  "persist-preferences": (effect, host) => {
    saveViewPreferences(host.storage, effect.preferences);
  },

  "load-subagent-activity": async (effect, { dispatch, desktop }) => {
    try {
      const activity = await desktop.loadSubagentActivity(effect.taskId, effect.subagentId);
      if (activity.length) await dispatch({ type: "subagent.activity.loaded", taskId: effect.taskId, subagentId: effect.subagentId, activity });
    } catch (error) {
      await dispatch({ type: "action.failed", message: errorMessage(error) });
    }
  },

  "load-subagent-metadata": async (effect, { dispatch, desktop }) => {
    const metadata = await desktop.loadSubagentMetadata(effect.engine, effect.subagentId, effect.sessionId).catch(() => ({}));
    const event = { ...metadata, type: "subagent.metadata" as const, taskId: effect.taskId, id: effect.subagentId };
    if (isSubagentEvent(event) && (event.model || event.effort)) await dispatch({ type: "thread.event", event });
  },

  "resolve-run-workspace": async (effect, { dispatch, desktop }) => {
    await dispatch(await resolveRunWorkspace(effect, desktop));
  },

  "start-run": (effect, { desktop }) => {
    desktop.send(effect.command);
  },

  "send-run-command": (effect, { desktop }) => {
    desktop.send(effect.command);
  },

  /** A title costs a model turn, so it lands on its own rather than holding back the send that asked for it. */
  "suggest-title": (effect, { dispatch, desktop }) => {
    void (async () => {
      const title = await desktop.suggestTaskTitle(effect.text, effect.attachments, effect.engine, effect.model).catch(() => null);
      if (title) await dispatch({ type: "title.suggested", taskId: effect.taskId, title });
    })();
  },

  "preserve-message-images": async (effect, { desktop }) => {
    const { messageImages } = await (images ??= import("../application/message-images.js"));
    const files = messageImages(effect.text).map((image) => image.path);
    if (files.length) await desktop.preserveMessageImages(files, effect.root, effect.messageId);
  },
} satisfies Partial<EffectHandlers>;

/** How long a run's reports are gathered where there is no paint to wait for. */
const FLUSH_INTERVAL_MS = 16;

function shortly(flush: () => void) {
  const timer = setTimeout(flush, FLUSH_INTERVAL_MS);
  return () => clearTimeout(timer);
}

/** A run's reports, folded in a frame at a time. */
function batchAgentEvents(host: RuntimeSubscriptionHost, holdReports: (flush: () => void) => void) {
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
  holdReports(flush);
  const stopListening = host.desktop.onAgentEvent((event) => {
    waiting.push(event);
    cancel ??= schedule(flush);
  });
  return () => {
    stopListening();
    flush();
  };
}

/** A thread request is answered from state, after what runs have reported so far is folded in. */
function answerThreadRequests(host: RuntimeSubscriptionHost, flushAll: () => void) {
  const { desktop } = host;
  const stopListening = desktop.onThreadRequest((request) => {
    flushAll();
    void host.prepareThreadRequest(request).then((prepared) => answerThreadRequest(host, request, prepared))
      .then((response) => desktop.answerThreadRequest(response))
      .catch((error) => desktop.answerThreadRequest({ type: "thread.response", requestId: request.requestId, ok: false, message: errorMessage(error) }));
  });
  return () => {
    stopListening();
    for (const waiter of host.waiters.current) clearTimeout(waiter.timer);
    host.waiters.current = [];
  };
}

export const runHost = {
  effects: runEffects,
  subscribe: (host, runs) => {
    const stopEvents = batchAgentEvents(host, runs.holdReports);
    const stopRequests = answerThreadRequests(host, runs.flushAll);
    return () => {
      stopEvents();
      stopRequests();
    };
  },
} satisfies HostModule;
