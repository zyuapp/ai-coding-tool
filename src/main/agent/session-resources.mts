import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type { SessionResourceMessage } from "../../contracts/session-resources.js";

type Scope = { taskId: string; sessionId: string; released: boolean };
const scope = new AsyncLocalStorage<Scope>();
let report: (event: SessionResourceMessage) => void = () => {};
export function reportSessionResources(send: typeof report) { report = send; }
export function resourceScope(taskId: string): Scope { return { taskId, sessionId: randomUUID(), released: false }; }
export function inResourceScope<T>(owner: Scope, act: () => T): T { return scope.run(owner, act); }
export function releaseResourceScope(owner: Scope) {
  if (owner.released) return;
  owner.released = true;
  report({ type: "session.released", taskId: owner.taskId, sessionId: owner.sessionId });
}
export function reportResourceBusy(owner: Scope, busy: boolean) {
  if (!owner.released) report({ type: "session.state", taskId: owner.taskId, sessionId: owner.sessionId, busy });
}

/** Register only conversation engines. Discovery and shared authentication run outside ownership. */
export function registerSessionProcess(child: ChildProcess) {
  const owner = scope.getStore();
  if (!owner) return;
  const register = () => {
    if (child.pid) report({ type: "session.process", taskId: owner.taskId, sessionId: owner.sessionId, pid: child.pid });
    if (owner.released) report({ type: "session.released", taskId: owner.taskId, sessionId: owner.sessionId });
  };
  if (child.pid) register(); else child.once("spawn", register);
}
