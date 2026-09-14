import { useEffect, useRef, useState } from "react";
import type { AppCommand } from "../../contracts/commands";
import { mountRemoteBrowser } from "../task-workspace/remote-browser-view";

export function RemoteBrowserSurface({ computerId, tabId, visible, focusToken, dispatch }: {
  computerId?: string; tabId: string; visible: boolean; focusToken: number;
  dispatch: (command: AppCommand) => Promise<void>;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const keyboard = useRef<HTMLTextAreaElement>(null);
  const [status, setStatus] = useState<string | null>("Connecting…");
  useEffect(() => {
    if (!visible || !canvas.current || !keyboard.current) return;
    return mountRemoteBrowser(canvas.current, keyboard.current, tabId, {
      read: () => window.desktop.readRemoteBrowserFrame(computerId, tabId),
      send: dispatch,
      status: setStatus,
    });
  }, [computerId, tabId, visible, dispatch]);
  useEffect(() => { if (visible && focusToken) keyboard.current?.focus({ preventScroll: true }); }, [visible, focusToken]);
  return <div className="browser-viewport remote-browser-viewport">
    <canvas ref={canvas} aria-label="Browser page" />
    <textarea ref={keyboard} className="remote-browser-keyboard" aria-label="Type in remote browser" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
    {status && <p className="remote-browser-status" role="status">{status}</p>}
  </div>;
}
