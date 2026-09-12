import assert from "node:assert/strict";
import { test } from "vitest";
import type { WorkspaceInput, WorkspaceCommandResult } from "../../src/application/workspace-reducer.ts";
import { VIEW_PREFERENCES_KEY } from "../../src/application/view-preferences.ts";
import type { WorkspaceUpdate } from "../../src/contracts/workspace-runtime.ts";
import { registered, startMainProcess } from "../support/electron-harness.mjs";

type IpcEvent = { sender: unknown };
type Result = WorkspaceCommandResult & { revision: number };

test("a view's input runs in the host and the window is handed the difference it made", async (t) => {
  const main = await startMainProcess(t, "aicodingtool-runtime-request-");
  const request = registered<(event: IpcEvent, input?: WorkspaceInput) => Promise<Result>>(main.handlers, "workspace-runtime:request");
  assert.throws(() => request(main.untrusted, { type: "view.set-prompt", prompt: "Stranger" }), /Untrusted/);
  assert.throws(() => request(main.trusted, { type: "nonsense" } as unknown as WorkspaceInput), /Invalid workspace input/);

  const before = main.sentOn<WorkspaceUpdate>("workspace-runtime:update").length;
  const result = await request(main.trusted, { type: "view.set-prompt", prompt: "Working" });
  assert.equal(result.ok, true);
  const updates = main.sentOn<WorkspaceUpdate>("workspace-runtime:update").slice(before);
  const patched = updates.find((update) => "patches" in update && update.patches.some((patch) => patch.path[0] === "prompts"));
  assert.ok(patched, "the window hears about the draft it typed");
  assert.equal(patched.revision, result.revision);
  assert.equal((await main.runtimeState()).prompts["draft:"], "Working");
});

test("a refused input answers with the reducer's own words", async (t) => {
  const main = await startMainProcess(t, "aicodingtool-runtime-refusal-");
  const request = registered<(event: IpcEvent, input?: WorkspaceInput) => Promise<Result>>(main.handlers, "workspace-runtime:request");
  const result = await request(main.trusted, { type: "task.move-worktree", destination: { kind: "local" } });
  assert.equal(result.ok, false);
});

test("closing the runtime settles its outstanding requests and refuses new ones", async (t) => {
  const main = await startMainProcess(t, "aicodingtool-runtime-close-");
  const request = registered<(event: IpcEvent, input?: WorkspaceInput) => Promise<Result>>(main.handlers, "workspace-runtime:request");
  registered<() => void>(main.appListeners, "will-quit")();
  await assert.rejects(request(main.trusted, { type: "view.set-prompt", prompt: "Late" }), /runtime has closed/);
});

test("a window's stored preferences are taken on once, and never over what the host already keeps", async (t) => {
  const main = await startMainProcess(t, "aicodingtool-runtime-migrate-");
  const migrate = registered<(event: IpcEvent, values: unknown) => Promise<void>>(main.handlers, "workspace-runtime:migrate");
  await assert.rejects(migrate(main.untrusted, {}), /Untrusted/);
  await assert.rejects(migrate(main.trusted, { "someone-elses.key": "x" }), /Invalid stored values/);
  await migrate(main.trusted, { [VIEW_PREFERENCES_KEY]: JSON.stringify({ sidebarMode: "activity", conciseReplies: true }) });
  const migrated = await main.runtimeState();
  assert.equal(migrated.sidebarMode, "activity");
  assert.equal(migrated.conciseReplies, true);
  await migrate(main.trusted, { [VIEW_PREFERENCES_KEY]: JSON.stringify({ sidebarMode: "projects", conciseReplies: false }) });
  const kept = await main.runtimeState();
  assert.equal(kept.sidebarMode, "activity", "a second window's values never overwrite what the host keeps");
});
