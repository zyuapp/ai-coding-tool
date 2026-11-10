import { browserCapability } from "./browser-host.js";
import { dictationCapability } from "./desktop-dictation.js";
import { simulatorCapability } from "./simulator-host.js";
import { terminalCapability } from "./terminal-host.js";
import type { WindowCapability, WindowCapabilityContext } from "./window-capability.js";

/** Started in this order as a window opens, and stopped in this order when it closes or the app quits. */
export const WINDOW_CAPABILITIES: readonly WindowCapability[] = [browserCapability, terminalCapability, simulatorCapability, dictationCapability];

export function startWindowCapabilities(context: WindowCapabilityContext) {
  for (const capability of WINDOW_CAPABILITIES) capability.start(context);
}

export function stopWindowCapabilities() {
  for (const capability of WINDOW_CAPABILITIES) capability.stopWithWindow?.();
}

export function stopCapabilitiesAtQuit() {
  for (const capability of WINDOW_CAPABILITIES) capability.stopAtQuit?.();
}
