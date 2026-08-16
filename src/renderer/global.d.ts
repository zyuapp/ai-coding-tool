import type { DesktopAPI } from "../contracts/ipc";

declare global {
  interface Window {
    desktop: DesktopAPI;
  }
}

export {};
