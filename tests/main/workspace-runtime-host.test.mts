import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { WorkspaceInput, WorkspaceCommandResult } from "../../src/application/workspace-reducer.ts";
import type { WorkspaceRequest, WorkspaceResponse } from "../../src/contracts/workspace-runtime.ts";
import { registered, startMainProcess } from "../support/electron-harness.mjs";

type IpcEvent = { sender: unknown };

test("the background workspace receives desktop dimensions before its preferences load", async (t) => {
  const main = await startMainProcess(t, "aicodingtool-runtime-placement-");
  assert.deepEqual(main.runtimeViews[0].loadedBounds, { x: 0, y: 0, width: 1240, height: 820 });
});

test("an accepted command can outlive the readiness deadline and returns its actual result", async (t) => {
  const main = await startMainProcess(t, "aicodingtool-runtime-long-command-");
  const runtime = main.runtimeViews[0];
  const requests: WorkspaceRequest[] = [];
  const send = runtime.webContents.send;
  runtime.webContents.send = (channel, event) => {
    if (channel === "workspace-runtime:request") requests.push(event as WorkspaceRequest);
    else send(channel, event);
  };
  const request = registered<(event: IpcEvent, input: WorkspaceInput) => Promise<WorkspaceCommandResult>>(main.handlers, "workspace-runtime:request");
  const respond = registered<(event: IpcEvent, response: WorkspaceResponse) => void>(main.listeners, "workspace-runtime:response");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    let settled = false;
    const result = request(main.trusted, { type: "view.set-prompt", prompt: "Working" }).then((result) => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(31_000);
    assert.equal(settled, false, "a running effect must not be reported failed while it can still complete");
    assert.equal(requests.length, 1);
    respond({ sender: runtime.webContents }, { id: requests[0].id, result: { ok: false, message: "Operation refused", revision: 0 } });
    assert.deepEqual(await result, { ok: false, message: "Operation refused", revision: 0 });
  } finally {
    vi.useRealTimers();
    runtime.webContents.send = send;
  }
});

test("runtime loss settles outstanding commands and refuses new work until ready again", async (t) => {
  const main = await startMainProcess(t, "aicodingtool-runtime-lost-");
  const runtime = main.runtimeViews[0];
  const send = runtime.webContents.send;
  runtime.webContents.send = () => {};
  const request = registered<(event: IpcEvent, input: WorkspaceInput) => Promise<WorkspaceCommandResult>>(main.handlers, "workspace-runtime:request");
  const pending = request(main.trusted, { type: "view.set-prompt", prompt: "In flight" });
  runtime.webContents.emit("render-process-gone");
  await assert.rejects(pending, /stopped unexpectedly/);
  await assert.rejects(request(main.trusted, { type: "view.set-prompt", prompt: "After failure" }), /stopped unexpectedly/);
  runtime.webContents.send = send;
  registered<(event: IpcEvent) => void>(main.listeners, "workspace-runtime:ready")({ sender: runtime.webContents });
  assert.deepEqual(await request(main.trusted, { type: "view.set-prompt", prompt: "Recovered" }), { ok: true, revision: 0 });
});

test("closing the runtime settles its outstanding requests immediately", async (t) => {
  const main = await startMainProcess(t, "aicodingtool-runtime-close-");
  const runtime = main.runtimeViews[0];
  runtime.webContents.send = () => {};
  const request = registered<(event: IpcEvent, input: WorkspaceInput) => Promise<WorkspaceCommandResult>>(main.handlers, "workspace-runtime:request");
  const pending = request(main.trusted, { type: "view.set-prompt", prompt: "Pending" });
  registered<() => void>(main.appListeners, "will-quit")();
  await assert.rejects(pending, /runtime has closed/);
});
