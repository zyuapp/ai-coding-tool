import type { BrowserBounds } from "../domain/browser";

/** Hands the keyboard to the page a browser tab shows. */
export function focusBrowserPage(tabId: string) {
  void window.desktop.focusBrowserTab(tabId);
}

/** Where main draws the browser's page, or null to hide it. */
export function placeBrowserPage(bounds: BrowserBounds | null) {
  void window.desktop.setBrowserBounds(bounds);
}
