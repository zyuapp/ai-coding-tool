import assert from "node:assert/strict";
import { test } from "vitest";
import type { WorkspaceCommandResult, WorkspaceInput } from "../../src/application/workspace-reducer.ts";
import type { WorkspaceRequest } from "../../src/contracts/workspace-runtime.ts";
import { registered, startMainProcess, waitFor } from "../support/electron-harness.mjs";

type IpcEvent = { sender: unknown };
type MenuEntry = { label?: string; submenu?: MenuEntry[]; click?: () => void };

test.skipIf(process.platform !== "darwin")("closing a view clears its surfaces while a replacement connects to the same runtime", async (context) => {
  const main = await startMainProcess(context, "aicodingtool-view-lifecycle-");
  const runtime = main.runtimeViews[0];
  const request = registered<(event: IpcEvent, input: WorkspaceInput) => Promise<WorkspaceCommandResult>>(main.handlers, "workspace-runtime:request");
  const oldSender = main.trusted;
  main.window.destroy();

  await waitFor(() => runtime.webContents.sent.some((entry) => entry.channel === "workspace-runtime:request"
    && (entry.event as WorkspaceRequest).input?.type === "view.closed"));
  assert.equal(runtime.webContents.isDestroyed(), false);
  assert.equal(main.completedQuits(), 0);
  assert.throws(() => request(oldSender, { type: "view.set-prompt", prompt: "From closed view" }), /Untrusted/);

  const menu = main.applicationMenu() as MenuEntry[];
  const licenses = menu.find((entry) => entry.label === "AI Coding Tool")?.submenu?.find((entry) => entry.label === "Open Source Licenses…");
  assert.ok(licenses?.click);
  licenses.click();
  await waitFor(() => main.windows.length === 1, "replacement app window");
  const reopened = main.windows[0];
  assert.notEqual(reopened, main.window);
  assert.deepEqual(main.runtimeViews, [runtime]);
  assert.throws(() => request(oldSender, { type: "view.mounted" }), /Untrusted/);

  assert.deepEqual(await request({ sender: reopened.webContents }, { type: "view.mounted" }), { ok: true, revision: 0 });
  const inputs = runtime.webContents.sent.filter((entry) => entry.channel === "workspace-runtime:request")
    .map((entry) => (entry.event as WorkspaceRequest).input?.type);
  assert.ok(inputs.indexOf("view.closed") < inputs.lastIndexOf("view.mounted"));
});
