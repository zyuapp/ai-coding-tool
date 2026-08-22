import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startMainProcess, tick, waitFor } from "./support/electron-harness.mjs";

let main;
test.before(async () => { main = await startMainProcess(null, "claudex-main-"); });
test.after(async () => { await main?.dispose(); });

test("the main window sends ordinary web links to the default browser", async () => {
  const open = main.window.webContents.windowOpenHandler;
  assert.deepEqual(open({ url: "https://example.com/docs" }), { action: "deny" });
  await tick();
  assert.deepEqual(main.externalUrls, ["https://example.com/docs"]);

  assert.deepEqual(open({ url: "file:///etc/passwd" }), { action: "deny" });
  await tick();
  assert.deepEqual(main.externalUrls, ["https://example.com/docs"], "non-web targets stay closed");
});

test("main transport validates, correlates, cancels, supersedes per task, and fails runs", async () => {
  const { userData, handlers, listeners, agents, protocolHandlers, window, trusted, untrusted } = main;

  const runCommand = listeners.get("run:command");
  const saved = await handlers.get("attachment:save")(trusted, Buffer.from([1, 2, 3]).toString("base64"));
  assert.equal(path.dirname(saved), path.join(userData, "attachments"));
  await assert.rejects(handlers.get("attachment:save")(untrusted, "AQID"));
  await assert.rejects(handlers.get("attachment:save")(trusted, "not base64!"));

  const serve = protocolHandlers.get("attachment");
  assert.equal((await serve({ url: `attachment://file/${path.basename(saved)}` })).status, 200);
  assert.equal((await serve({ url: "attachment://file/%2E%2E%2Fworkspaces.v1.json" })).status, 404);

  const projectless = await handlers.get("workspace:projectless")(trusted);
  assert.equal((await handlers.get("workspace:changed-files")(untrusted, projectless.id)).status, "error");
  assert.equal((await handlers.get("workspace:changed-files")(trusted, "")).status, "error");

  const command = (taskId, runId) => ({ type: "start", channel: "main", taskId, runId, prompt: "work", workspaceId: projectless.id, policy: "confirm", model: "opus", effort: "high" });
  runCommand(untrusted, command("ignored", "ignored"));
  runCommand(trusted, command("cancelled", "run-cancelled"));
  runCommand(trusted, { type: "cancel", taskId: "cancelled", runId: "run-cancelled" });
  await tick();
  assert.equal(agents[0].messages.some((message) => message.runId === "run-cancelled"), false);

  runCommand(trusted, command("concurrent-a", "run-concurrent-a"));
  runCommand(trusted, command("concurrent-b", "run-concurrent-b"));
  await waitFor(() => ["run-concurrent-a", "run-concurrent-b"].every((runId) => agents[0].messages.some((message) => message.runId === runId)));

  runCommand(trusted, command("resubmitted", "run-old"));
  runCommand(trusted, command("resubmitted", "run-new"));
  await waitFor(() => agents[0].messages.some((message) => message.runId === "run-new"));
  assert.equal(agents[0].messages.some((message) => message.runId === "run-old"), false);
  assert.equal(agents[0].messages.some((message) => message.runId === "run-new"), true);

  runCommand(trusted, { ...command("missing", "run-missing"), workspaceId: "unknown" });
  const sent = () => window.webContents.sent.map(({ event }) => event);
  await waitFor(() => sent().some((event) => event.runId === "run-missing" && event.type === "run.status" && event.status === "failed"));
  assert.deepEqual(sent().filter((event) => event.runId === "run-cancelled" && event.type === "run.status").map((event) => event.status), ["cancelled"]);
  assert.deepEqual(sent().filter((event) => event.runId === "run-old" && event.type === "run.status").map((event) => event.status), ["cancelled"]);
  assert.deepEqual(sent().filter((event) => event.runId === "run-missing" && event.type === "run.status").map((event) => event.status), ["failed"]);

  agents[0].emit("exit", 9);
  assert.deepEqual(sent().filter((event) => event.runId === "run-new" && event.type === "run.status").map((event) => event.status), ["failed"]);

  runCommand(trusted, command("post", "run-post"));
  await waitFor(() => agents[1]?.messages.some((message) => message.runId === "run-post"));
  agents[1].throwOnPost = true;
  runCommand(trusted, { type: "cancel", taskId: "post", runId: "run-post" });
  assert.equal(window.webContents.sent.map(({ event }) => event).some((event) => event.runId === "run-post" && event.type === "run.status" && event.status === "failed"), true);
  agents[1].throwOnPost = false;
});

test("thread requests are relayed to the window and only its answers reach the agent", async () => {
  const { listeners, agents, window, trusted, untrusted } = main;
  const agent = agents.at(-1);
  const request = { type: "thread.request", requestId: "request-1", taskId: "task-caller", op: "list" };

  agent.emit("message", { type: "thread.request", requestId: "malformed", taskId: "task-caller", op: "list", limit: -1 });
  agent.emit("message", request);
  await tick();
  const relayed = window.webContents.sent.filter(({ channel }) => channel === "thread:request").map(({ event }) => event);
  assert.deepEqual(relayed, [request], "only the valid request reached the window");

  const answer = listeners.get("thread:answer");
  answer(untrusted, { type: "thread.response", requestId: "request-1", ok: true, result: [] });
  answer(trusted, { type: "thread.response", requestId: "unknown", ok: true, result: [] });
  answer(trusted, { type: "thread.response", requestId: "request-1", ok: true, result: [{ id: "task-1" }] });
  answer(trusted, { type: "thread.response", requestId: "request-1", ok: true, result: [{ id: "task-1" }] });

  const answered = agent.messages.filter((message) => message.type === "thread.response");
  const refused = answered.find((message) => message.requestId === "malformed");
  assert.equal(refused.ok, false, "a request no guard could read is refused rather than dropped, which would hang its tool call");
  assert.deepEqual(answered.filter((message) => message.requestId === "request-1").map((message) => message.result), [[{ id: "task-1" }]], "an answer settles its request once");
});

test("a bound keystroke is taken from the window's menu and handed to whatever is in front", async () => {
  const { window, listeners, trusted, untrusted } = main;

  const beforeInput = window.webContents.listeners.get("before-input-event");
  /** Whichever key the platform calls its own: ⌘ on macOS, Ctrl everywhere else. */
  const mod = (held) => process.platform === "darwin" ? { meta: held, control: false } : { control: held, meta: false };
  const press = (code, { held = true, shift = false, type = "keyDown" } = {}) => {
    let prevented = false;
    beforeInput({ preventDefault: () => { prevented = true; } }, { type, key: code.slice(-1).toLowerCase(), code, alt: false, shift, ...mod(held) });
    return prevented;
  };
  const shortcuts = () => window.webContents.sent.filter((message) => message.channel === "window:shortcut").map(({ event }) => event);
  const captured = () => window.webContents.sent.filter((message) => message.channel === "window:shortcut-captured").map(({ event }) => event);

  assert.equal(press("KeyW"), true, "the window must not act on the close keystroke before the app has");
  assert.deepEqual(shortcuts(), [{ action: "tab.close", surface: "any" }]);

  assert.equal(press("KeyW", { shift: true }), false, "adding a modifier makes it somebody else's keystroke");
  assert.equal(press("KeyY"), false, "an unbound keystroke is nobody's");
  assert.equal(press("KeyW", { held: false }), false);
  assert.equal(press("KeyW", { type: "keyUp" }), false);
  assert.equal(shortcuts().length, 1);

  assert.equal(press("KeyR"), false, "reloading belongs to a page in the panel, not to the window");

  assert.equal(press("KeyA", { shift: true }), true, "answering an approval is bound where the user can move it");

  listeners.get("shortcuts:set")(untrusted, { "run.allow": "Mod+E" });
  assert.equal(press("KeyA", { shift: true }), true, "an untrusted sender cannot rebind anything");
  listeners.get("shortcuts:set")(trusted, { "run.allow": "Mod+E" });
  assert.equal(press("KeyA", { shift: true }), false, "the keystroke it used to hold is free again");
  assert.equal(press("KeyE"), true);
  assert.deepEqual(shortcuts().at(-1), { action: "run.allow", surface: "any" });

  listeners.get("shortcuts:set")(trusted, { "run.allow": "Mod+W" });
  assert.equal(press("KeyW"), true);
  assert.deepEqual(shortcuts().at(-1), { action: "tab.close", surface: "any" }, "a keystroke the app answers itself is not one an override can take");

  listeners.get("shortcuts:capture")(trusted, true);
  const acted = shortcuts().length;
  assert.equal(press("KeyJ", { shift: true }), true, "while capturing, a keystroke is reported rather than acted on");
  assert.equal(press("KeyJ", { held: false }), false, "a keystroke with no modifier is left to whatever has the keys");
  assert.equal(press("Escape", { held: false }), true);
  assert.deepEqual(captured(), ["Mod+Shift+J", null]);
  assert.equal(shortcuts().length, acted, "nothing fired while settings were listening");
  listeners.get("shortcuts:capture")(trusted, false);

  let closed = 0;
  window.close = () => { closed += 1; };
  listeners.get("window:close")(untrusted);
  assert.equal(closed, 0, "only the window's own renderer may close it");
  listeners.get("window:close")(trusted);
  assert.equal(closed, 1);
});

test("a folder the claudex command names is registered and handed to the window that asks for it", async () => {
  const { appListeners, handlers, listeners, trusted, untrusted, sentOn } = main;
  const folder = await realpath(await mkdtemp(path.join(os.tmpdir(), "claudex-cli-open-")));
  const url = `claudex://open?path=${Buffer.from(folder, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_")}`;
  const opened = () => sentOn("workspace:open-project");
  try {
    appListeners.get("open-url")({ preventDefault() {} }, url);
    await tick();
    assert.deepEqual(opened(), [], "the folder waits while the window is still coming up");

    listeners.get("workspace:open-project-ready")(untrusted);
    await tick();
    assert.deepEqual(opened(), [], "only the window's own renderer can ask for it");

    listeners.get("workspace:open-project-ready")(trusted);
    await waitFor(() => opened().length === 1);
    assert.equal(opened()[0].root, folder);
    assert.equal(opened()[0].kind, "project");

    appListeners.get("second-instance")({}, ["/Applications/Claudex.app", url]);
    await waitFor(() => opened().length === 2);
    assert.equal(opened()[1].id, opened()[0].id, "the same folder keeps the workspace it already had");

    appListeners.get("open-url")({ preventDefault() {} }, "claudex://open?path=bm90LWFic29sdXRl");
    await tick();
    assert.equal(opened().length, 2, "a URL that names no absolute folder opens nothing");

    await assert.rejects(handlers.get("cli:status")(untrusted));
    assert.equal((await handlers.get("cli:status")(trusted)).path, "/usr/local/bin/claudex");
    await assert.rejects(handlers.get("cli:install")(untrusted));
    await assert.rejects(handlers.get("cli:uninstall")(untrusted));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("a page the panel is not showing belongs to a window of its own", async () => {
  const { handlers, window, windows, trusted } = main;
  const panel = { x: 40, y: 60, width: 900, height: 700 };
  const view = () => windows.flatMap((each) => each.children)[0];

  await handlers.get("browser:open")(trusted, "tab-parked", "https://example.com/");
  assert.equal(window.children.length, 0, "a page nobody is showing is not in the app's window");
  const page = view();
  assert.ok(page, "the page is parked in a window all the same");
  assert.deepEqual(page.bounds, { x: 0, y: 0, width: 1200, height: 800 }, "and is given a viewport to lay out in");
  const parking = windows.find((each) => each.children.includes(page));
  assert.notEqual(parking, window);
  assert.equal(parking.isVisible(), false, "nothing ever shows it");

  await handlers.get("browser:bounds")(trusted, panel);
  await handlers.get("browser:show")(trusted, "tab-parked");
  assert.deepEqual(window.children, [page], "the page the panel shows is the app window's own");
  assert.deepEqual(page.bounds, panel);

  await handlers.get("browser:bounds")(trusted, null);
  assert.equal(window.children.length, 0, "a closed panel puts the page back where it cannot take the keyboard");
  assert.deepEqual(parking.children, [page]);

  await handlers.get("browser:close")(trusted, "tab-parked");
  assert.equal(windows.flatMap((each) => each.children).length, 0);
});
