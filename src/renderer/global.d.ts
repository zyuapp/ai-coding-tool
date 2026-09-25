import type { WorkspaceBridge } from "../contracts/workspace-runtime";
import type { DesktopAPI } from "../contracts/ipc";

declare global {
  interface Window {
    desktop: DesktopAPI;
    /** Absent where the window hosts the runtime itself, which only a test does. */
    workspace?: WorkspaceBridge;
  }
}

export {};
