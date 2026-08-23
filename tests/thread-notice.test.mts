import assert from "node:assert/strict";
import { test, afterAll, beforeAll } from "vitest";
import { isThreadNotice, type DesktopAPI, type ThreadNotice } from "../src/contracts/ipc.ts";
import type { WorkspaceInput } from "../src/application/workspace-reducer.ts";
import { registered, startMainProcess, type MainHarness } from "./support/electron-harness.mjs";

let main: MainHarness;
beforeAll(async () => { main = await startMainProcess(null, "aicodingtool-notice-"); });
afterAll(async () => { await main?.dispose(); });

const NOTICE: ThreadNotice = { taskId: "task-datadog", title: "Datadog watch", headline: "5xx on checkout since 02:10" };

const announce = (notice: unknown, sender: unknown = main.trusted) => {
  registered<(sender: unknown, notice: unknown) => void>(main.listeners, "thread:announce")(sender, notice);
};

test("a notice raised while the user is elsewhere is carried by the desktop", () => {
  announce(NOTICE);

  const raised = main.notifications.at(-1);
  assert.ok(raised);
  assert.equal(raised.options.title, "Datadog watch");
  assert.equal(raised.options.body, "5xx on checkout since 02:10");
  assert.equal(raised.options.silent, true);
  assert.equal(raised.shown, true);
});

test("clicking the notification brings the window back on the thread that raised it", () => {
  const revealed: unknown[] = [];
  const focus = main.app.focus;
  main.app.focus = (options?: unknown) => { revealed.push(options); };
  try {
    announce(NOTICE);
    const notification = main.notifications.at(-1);
    assert.ok(notification);
    notification.click();
  } finally {
    main.app.focus = focus;
  }

  assert.deepEqual(revealed, [{ steal: true }]);
  assert.equal(main.sentOn("window:open-thread").at(-1), "task-datadog");
});

test("a window the user is already looking at announces nothing", () => {
  main.window.focused = true;
  const before = main.notifications.length;
  try {
    announce(NOTICE);
  } finally {
    main.window.focused = false;
  }

  assert.equal(main.notifications.length, before, "the thread is already in front of the user");
});

test("notices from anywhere but the window are ignored, and so are malformed ones", () => {
  const before = main.notifications.length;
  announce(NOTICE, main.untrusted);
  for (const notice of [
    null,
    "found something",
    { ...NOTICE, taskId: "" },
    { ...NOTICE, title: 7 },
    { taskId: NOTICE.taskId, title: NOTICE.title },
    { ...NOTICE, headline: "x".repeat(1_001) },
  ]) announce(notice);

  assert.equal(main.notifications.length, before);
});

test("a notice is a thread, a name to show it under, and a line", () => {
  assert.equal(isThreadNotice(NOTICE), true);
  assert.equal(isThreadNotice({ ...NOTICE, headline: "x".repeat(1_000) }), true);
  assert.equal(isThreadNotice({ ...NOTICE, headline: "" }), false);
  assert.equal(isThreadNotice({ ...NOTICE, taskId: undefined }), false);
  assert.equal(isThreadNotice(undefined), false);
});

test("the window answers a clicked notification by selecting that thread", async () => {
  const listeners = new Map<string, unknown>();
  let openThread: Parameters<DesktopAPI["onOpenThread"]>[0] | undefined;
  const desktop = {
    onOpenProject(listener: Parameters<DesktopAPI["onOpenProject"]>[0]) {
      listeners.set("onOpenProject", listener);
      return () => { listeners.delete("onOpenProject"); };
    },
    onWindowScreenshot(listener: Parameters<DesktopAPI["onWindowScreenshot"]>[0]) {
      listeners.set("onWindowScreenshot", listener);
      return () => { listeners.delete("onWindowScreenshot"); };
    },
    onOpenThread(listener: Parameters<DesktopAPI["onOpenThread"]>[0]) {
      listeners.set("onOpenThread", listener);
      openThread = listener;
      return () => { listeners.delete("onOpenThread"); openThread = undefined; };
    },
  } satisfies Pick<DesktopAPI, "onOpenProject" | "onWindowScreenshot" | "onOpenThread">;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { desktop } });
  try {
    const { subscribeToDesktop } = await import("../src/renderer/task-workspace/desktop-subscriptions.ts");
    const dispatched: WorkspaceInput[] = [];
    const stop = subscribeToDesktop((input) => { dispatched.push(input); });

    assert.ok(openThread);
    openThread("task-datadog");
    assert.deepEqual(dispatched, [{ type: "task.select", taskId: "task-datadog" }]);

    stop();
    assert.equal(listeners.size, 0, "the window drops every subscription at once");
  } finally {
    Reflect.deleteProperty(globalThis, "window");
  }
});
