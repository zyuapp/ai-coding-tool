import type { BrowserWindow } from "electron";
import type { DesktopEvents } from "./desktop-events.js";
import type { KeyboardBridge } from "./keyboard-host.js";

/** What a capability is handed as a window opens. */
export type WindowCapabilityContext = {
  window: BrowserWindow;
  /** Pushes on a channel to the app's current window, dropped when there is none or it is destroyed. */
  send: (channel: string, payload: unknown) => void;
  events: DesktopEvents;
  keyboard: Pick<KeyboardBridge, "handleKey">;
};

/** A capability's part in the main process's lifecycle. */
export type WindowCapability = {
  /** Runs as each window opens. */
  start(context: WindowCapabilityContext): void;
  /** Runs once that window has closed. */
  stopWithWindow?(): void;
  /** Runs as the app quits, with or without a window. */
  stopAtQuit?(): void;
};
