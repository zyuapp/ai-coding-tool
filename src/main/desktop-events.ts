import type { WorkspaceState } from "../application/workspace-state.js";
import type { ThreadNotice } from "../contracts/ipc.js";
import type { AgentEvent, AutomationFire, BrowserFindEvent, BrowserPageEvent } from "../contracts/ipc.js";
import type { ComputerLink } from "../domain/computers.js";
import type { MobileRequest } from "../contracts/mobile.js";
import type { ThreadRequest } from "../contracts/threads.js";
import type { AutomationView } from "../domain/automation.js";
import type { MobileServerState } from "../domain/mobile.js";
import type { TerminalUpdate } from "../domain/terminal.js";
import type { WorkspaceRecord } from "../domain/workspace.js";

/** Everything main pushes at the runtime, named by the channel each one travelled on when the runtime was a window. */
export type DesktopEventMap = {
  "run:event": AgentEvent;
  "automation:fire": AutomationFire;
  "automation:changed": AutomationView[];
  "thread:request": ThreadRequest;
  "mobile:changed": MobileServerState;
  "mobile:request": MobileRequest;
  "browser:event": BrowserPageEvent;
  "browser:find": BrowserFindEvent;
  "terminal:event": TerminalUpdate;
  "workspace:open-project": WorkspaceRecord;
  "computers:changed": { name: string; links: ComputerLink[] };
  "computer:state": { id: string; state: WorkspaceState };
  "computer:notice": { id: string; notice: ThreadNotice };
};

export type DesktopEvents = ReturnType<typeof createDesktopEvents>;

/** The runtime's subscriptions, in one process with what raises them. */
export function createDesktopEvents() {
  const listeners = new Map<keyof DesktopEventMap, Set<(payload: never) => void>>();
  return {
    on<Name extends keyof DesktopEventMap>(name: Name, listener: (payload: DesktopEventMap[Name]) => void): () => void {
      let held = listeners.get(name);
      if (!held) listeners.set(name, held = new Set());
      held.add(listener);
      return () => { held.delete(listener); };
    },
    /** Whether anyone heard it. A push nobody is listening for is what a request has to be refused over. */
    emit<Name extends keyof DesktopEventMap>(name: Name, payload: DesktopEventMap[Name]): boolean {
      const held = listeners.get(name);
      if (!held?.size) return false;
      for (const listener of held) (listener as (payload: DesktopEventMap[Name]) => void)(payload);
      return true;
    },
  };
}
