import type { WorkspaceBridge } from "../application/workspace-runtime";
import type { WindowDesktopAPI } from "../contracts/ipc";

declare global {
  interface Window {
    desktop: WindowDesktopAPI;
    workspace: WorkspaceBridge;
  }
}

export {};
