/** Whether the window is drawn on macOS, which is the only thing shortcut text needs to know. */
export const MAC = typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent);
