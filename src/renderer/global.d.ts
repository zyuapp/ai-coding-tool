import type { WorkspaceBridge } from "../contracts/workspace-runtime";
import type { WindowDesktopAPI } from "../contracts/ipc";

declare global {
  interface Window {
    desktop: WindowDesktopAPI;
    workspace: WorkspaceBridge;
  }
}

export {};
