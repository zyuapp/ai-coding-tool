import assert from "node:assert/strict";
import { test } from "vitest";
import type { WorkspaceCommandResult, WorkspaceInput } from "../../src/application/workspace-reducer.ts";
import { registered, startMainProcess, waitFor } from "../support/electron-harness.mjs";

type IpcEvent = { sender: unknown };
type MenuEntry = { label?: string; submenu?: MenuEntry[]; click?: () => void };

test.skipIf(process.platform !== "darwin")("closing a view leaves the runtime running for the replacement that connects to it", async (context) => {
  const main = await startMainProcess(context, "aicodingtool-view-lifecycle-");
  const request = registered<(event: IpcEvent, input?: WorkspaceInput) => Promise<WorkspaceCommandResult>>(main.handlers, "workspace-runtime:request");
  const oldSender = main.trusted;
  await request(oldSender, { type: "view.set-prompt", prompt: "Typed before closing" });
  main.window.destroy();

  assert.equal(main.completedQuits(), 0);
  assert.throws(() => request(oldSender, { type: "view.set-prompt", prompt: "From closed view" }), /Untrusted/);

  const menu = main.applicationMenu() as MenuEntry[];
  const licenses = menu.find((entry) => entry.label === "AI Coding Tool")?.submenu?.find((entry) => entry.label === "Open Source Licenses…");
  assert.ok(licenses?.click);
  licenses.click();
  await waitFor(() => main.windows.length === 1, "replacement app window");
  const reopened = main.windows[0];
  assert.notEqual(reopened, main.window);
  assert.throws(() => request(oldSender, { type: "view.mounted" }), /Untrusted/);

  assert.deepEqual((await request({ sender: reopened.webContents }, { type: "view.mounted" })).ok, true);
  const state = await main.runtimeState({ sender: reopened.webContents });
  assert.equal(state.prompts["draft:"], "Typed before closing", "the runtime outlived the window that typed into it");
});
