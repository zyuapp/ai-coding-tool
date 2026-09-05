import type { WorkspaceBridge } from "../contracts/workspace-runtime";
import type { DesktopAPI } from "../contracts/ipc";

declare global {
  interface Window {
    desktop: DesktopAPI;
    workspace?: WorkspaceBridge;
  }
}

export {};
