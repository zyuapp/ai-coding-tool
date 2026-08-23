import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import { isFindingNotice } from "../dist/main/contracts/ipc.js";
import { startMainProcess } from "./support/electron-harness.mjs";

let main;
test.before(async () => { main = await startMainProcess(null, "aicodingtool-finding-"); });
test.after(async () => { await main?.dispose(); });

const FINDING = { taskId: "task-datadog", title: "Datadog watch", headline: "5xx on checkout since 02:10" };

const announce = (notice, sender = main.trusted) => main.listeners.get("finding:announce")(sender, notice);

test("a finding raised while the user is elsewhere is carried by the desktop", () => {
  announce(FINDING);

  const raised = main.notifications.at(-1);
  assert.equal(raised.options.title, "Datadog watch");
  assert.equal(raised.options.body, "5xx on checkout since 02:10");
  assert.equal(raised.options.silent, true);
  assert.equal(raised.shown, true);
});

test("clicking the notification brings the window back on the thread that raised the finding", () => {
  const revealed = [];
  const focus = main.app.focus;
  main.app.focus = (options) => revealed.push(options);
  try {
    announce(FINDING);
    main.notifications.at(-1).click();
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
    announce(FINDING);
  } finally {
    main.window.focused = false;
  }

  assert.equal(main.notifications.length, before, "the finding is already in front of the user");
});

test("findings from anywhere but the window are ignored, and so are malformed ones", () => {
  const before = main.notifications.length;
  announce(FINDING, main.untrusted);
  for (const notice of [
    null,
    "found something",
    { ...FINDING, taskId: "" },
    { ...FINDING, title: 7 },
    { taskId: FINDING.taskId, title: FINDING.title },
    { ...FINDING, headline: "x".repeat(1_001) },
  ]) announce(notice);

  assert.equal(main.notifications.length, before);
});

test("a notice is a thread, a name to show it under, and a line", () => {
  assert.equal(isFindingNotice(FINDING), true);
  assert.equal(isFindingNotice({ ...FINDING, headline: "x".repeat(1_000) }), true);
  assert.equal(isFindingNotice({ ...FINDING, headline: "" }), false);
  assert.equal(isFindingNotice({ ...FINDING, taskId: undefined }), false);
  assert.equal(isFindingNotice(undefined), false);
});

test("the window answers a clicked notification by selecting that thread", async () => {
  const vite = await createServer({ logLevel: "silent", server: { middlewareMode: true }, appType: "custom" });
  const listeners = new Map();
  const desktop = {};
  for (const name of ["onOpenProject", "onWindowScreenshot", "onOpenThread"]) {
    desktop[name] = (listener) => {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    };
  }
  globalThis.window = { desktop };
  try {
    const { subscribeToDesktop } = await vite.ssrLoadModule("/src/renderer/task-workspace/desktop-subscriptions.ts");
    const dispatched = [];
    const stop = subscribeToDesktop((input) => dispatched.push(input));

    listeners.get("onOpenThread")("task-datadog");
    assert.deepEqual(dispatched, [{ type: "task.select", taskId: "task-datadog" }]);

    stop();
    assert.equal(listeners.size, 0, "the window drops every subscription at once");
  } finally {
    delete globalThis.window;
    await vite.close();
  }
});
