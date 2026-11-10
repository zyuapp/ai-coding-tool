import { reportFailure, type EffectHandlers } from "./effect-host.js";
import type { HostModule } from "./host-module.js";

/** Find in what holds its own text: a page counts its matches in main, a shell's view counts its own. */
export const findHost = {
  effects: {
    "find-in-page": (effect, host) => reportFailure(host, host.desktop.findInPage(effect.tabId, effect.query, effect.forward, effect.findNext)),

    "stop-find-in-page": (effect, host) => reportFailure(host, host.desktop.stopFindInPage(effect.tabId)),

    "find-in-terminal": (effect, host) => { host.surface?.(effect); },

    "stop-find-in-terminal": (effect, host) => { host.surface?.(effect); },
  } satisfies Partial<EffectHandlers>,

  subscribe: (host) => host.desktop.onBrowserFind(({ tabId, matches, index }) => void host.dispatch({
    type: "find.results",
    target: { kind: "browser", tabId },
    results: { matches, index },
  })),
} satisfies HostModule;
