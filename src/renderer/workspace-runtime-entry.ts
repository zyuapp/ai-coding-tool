import { createWorkspaceRuntime } from "./task-workspace/workspace-runtime";
import { workspacePatches } from "../application/workspace-patches";
import { errorMessage } from "./task-workspace/errors";

const bridge = window.workspace!;
const runtime = createWorkspaceRuntime();
let previous = runtime.getState();
let revision = 0;
let publishing = false;
function publishPending() {
  publishing = false;
  const state = runtime.getState();
  if (state === previous) return;
  const patches = workspacePatches(previous, state);
  previous = state;
  if (!patches.length) return;
  revision += 1;
  bridge.publish({ revision, patches });
}
runtime.subscribe(() => {
  if (publishing) return;
  publishing = true;
  queueMicrotask(publishPending);
});
bridge.onRequest((request) => {
  void (async () => {
    try {
      if (request.input) {
        const result = await runtime.execute(request.input).completed;
        publishPending();
        bridge.respond({ id: request.id, result: { ...result, revision } });
        return;
      }
      if (request.flush) await runtime.flush();
      publishPending();
      if (!request.flush) bridge.publish({ revision, state: runtime.getState() });
      bridge.respond({ id: request.id, result: { ok: true, revision } });
    } catch (error) {
      publishPending();
      bridge.respond({ id: request.id, result: { ok: false, message: errorMessage(error), revision } });
    }
  })();
});
void runtime.start().then(() => bridge.ready()).catch(async (error) => {
  try {
    await runtime.dispatch({ type: "store.failed", message: errorMessage(error) });
  } catch (failure) {
    console.error("Could not report workspace startup failure:", failure);
  } finally {
    publishPending();
    bridge.ready();
  }
});
