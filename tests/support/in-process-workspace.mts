import type { DesktopAPI } from "../../src/contracts/ipc.ts";
import type { WorkspaceSurfaceEffect } from "../../src/contracts/workspace-runtime.ts";
import { noComputers } from "../../src/host/no-computers.ts";
import { createWorkspaceRuntime } from "../../src/host/workspace-runtime.ts";
import { clearTerminalSearch, disposeTerminalView, searchTerminalView } from "../../src/renderer/task-workspace/terminal-views.ts";

/** The whole fake desktop a test hands the window, which a runtime hosted beside it reads as its own. */
export function hostedDesktop() {
  return { ...(window.desktop as unknown as DesktopAPI), ...noComputers };
}

/** The next paint, or a moment later for a window that has stopped painting. */
function nextFrame(flush: () => void) {
  const frame = requestAnimationFrame(flush);
  const timer = setTimeout(flush, 32);
  return () => {
    cancelAnimationFrame(frame);
    clearTimeout(timer);
  };
}

function performSurface(effect: WorkspaceSurfaceEffect) {
  if (effect.type === "terminal.close") disposeTerminalView(effect.terminalId);
  else if (effect.type === "find-in-terminal") searchTerminalView(effect.terminalId, effect.query, effect.forward);
  else clearTerminalSearch(effect.terminalId);
}

/** Takes the place of the window's connection module: the runtime runs in the window, over the fake desktop. */
export function createWorkspaceConnection() {
  return createWorkspaceRuntime({ desktop: hostedDesktop(), storage: localStorage, viewportWidth: window.innerWidth, surface: performSurface, frame: nextFrame });
}
