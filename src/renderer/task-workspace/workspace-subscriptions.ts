import { useEffect } from "react";
import type { WorkspaceInput } from "../../application/workspace-reducer";
import { displayShortcut } from "../../domain/shortcuts";
import { MAC } from "../platform";
import { onTerminalFindResults, onTerminalResize } from "./terminal-views";

export type SubscriptionHost = {
  restored: boolean;
  dispatch: (input: WorkspaceInput) => Promise<void>;
};

/** DOM focus and terminal views belong to the window displaying the workspace. */
export function useWorkspaceSubscriptions(host: SubscriptionHost) {
  useEffect(() => {
    const onFocus = () => void host.dispatch({ type: "view.set-focused", focused: true });
    const onBlur = () => void host.dispatch({ type: "view.set-focused", focused: false });
    if (typeof document !== "undefined") void host.dispatch({ type: "view.set-focused", focused: document.hasFocus() });
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
  useEffect(() => {
    const stopReporting = onTerminalFindResults((terminalId, results) => void host.dispatch({ type: "find.results", target: { kind: "terminal", terminalId }, results }));
    const stopSizing = onTerminalResize((terminalId, cols, rows) => void host.dispatch({ type: "terminal.resize", terminalId, cols, rows }));
    return () => {
      stopReporting();
      stopSizing();
    };
  }, []);
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
    const stopListening = window.desktop.onShortcut(({ action, surface }) => void host.dispatch({ type: "view.shortcut", action, surface }));
    const stopCapturing = window.desktop.onShortcutCaptured((binding) => void host.dispatch({ type: "shortcut.captured", binding }));
    const stopRefusals = window.desktop.onDesktopShortcutRefused((refusal) => void host.dispatch(refusal.reason === "unsupported"
      ? { type: "shortcut.unavailable", refusal }
      : { type: "action.failed", message: `${displayShortcut(refusal.binding, MAC)} belongs to another app, so grabbing a window has no shortcut.` }));
    return () => {
      stopListening();
      stopCapturing();
      stopRefusals();
    };
  }, []);
  useEffect(() => {
    if (host.restored) void host.dispatch({ type: "view.mounted" });
  }, [host.restored]);
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
    const stops = [
      window.desktop.onWindowScreenshot((shot) => void host.dispatch({ type: "image.add", path: shot.path, label: shot.title ? `${shot.app} — ${shot.title}` : shot.app })),
      window.desktop.onOpenThread((taskId) => void host.dispatch({ type: "task.select", taskId })),
    ];
    return () => { for (const stop of stops) stop(); };
  }, []);
}
