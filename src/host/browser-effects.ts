import { reportFailure, type EffectHandlers, type EffectHost } from "./effect-host.js";
import { errorMessage } from "./errors.js";
import type { HostModule } from "./host-module.js";

/** A failed import step is reported beside the import, not in the workspace error banner. */
async function importing(host: EffectHost, work: () => Promise<void>) {
  try {
    await work();
  } catch (error) {
    await host.dispatch({ type: "browser-import.failed", message: errorMessage(error) });
  }
}

/** The browser panel's pages, and the sites copied in from other browsers. */
export const browserHost = {
  effects: {
    "browser.permissions": (effect, host) => reportFailure(host, host.desktop.configureBrowserPermissions(effect.permissions)),

    "browser.open": (effect, host) => reportFailure(host, host.desktop.openBrowserTab(effect.tabId, effect.url, effect.taskId)),

    "browser.navigate": (effect, host) => reportFailure(host, host.desktop.navigateBrowser(effect.tabId, effect.url, effect.taskId)),

    "browser.history": (effect, host) => reportFailure(host, host.desktop.browserHistory(effect.tabId, effect.delta, effect.taskId)),

    "browser.reload": (effect, host) => reportFailure(host, host.desktop.reloadBrowser(effect.tabId, effect.taskId)),

    "browser.close": (effect, host) => reportFailure(host, host.desktop.closeBrowserTab(effect.tabId)),

    "browser.show": (effect, host) => reportFailure(host, host.desktop.showBrowserTab(effect.tabId)),

    "browser.act": (effect, host) => reportFailure(host, host.desktop.actInBrowser(effect.tabId, effect.action, effect.taskId)),

    "browser.clear-data": (_effect, host) => reportFailure(host, host.desktop.clearBrowserData()),

    "focus-browser": (effect, host) => reportFailure(host, host.desktop.focusBrowserTab(effect.tabId)),

    "browser-import.list-sources": (_effect, host) => importing(host, async () => {
      await host.dispatch({ type: "browser-import.sources", sources: await host.desktop.listBrowserImportSources() });
    }),

    "browser-import.list-sites": (effect, host) => importing(host, async () => {
      await host.dispatch({ type: "browser-import.sites", sourceId: effect.sourceId, sites: await host.desktop.listBrowserImportSites(effect.sourceId) });
    }),

    "browser-import.import": (effect, host) => importing(host, async () => {
      const result = await host.desktop.importBrowserSites(effect.sourceId, effect.sites);
      await host.dispatch({ type: "browser-import.done", sourceId: effect.sourceId, sites: effect.sites, result });
    }),
  } satisfies Partial<EffectHandlers>,

  subscribe: (host) => host.desktop.onBrowserEvent((page) => void host.dispatch({ type: "browser.updated", page })),
} satisfies HostModule;
