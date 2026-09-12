import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { test, afterAll, beforeAll } from "vitest";
import { registered, startMainProcess, tick, waitFor, type MainHarness } from "../support/electron-harness.mjs";
import type { ChangedFilesResult, ShortcutInvocation, StartRunCommand } from "../../src/contracts/ipc.js";
import type { WorkspaceCommandResult, WorkspaceInput } from "../../src/application/workspace-reducer.js";
import type { ThreadRequest } from "../../src/contracts/threads.js";
import type { BrowserBounds, BrowserInspectionResult, BrowserSnapshot } from "../../src/domain/browser.js";
import { cliConfiguration, type CliStatus } from "../../src/domain/cli.js";
import type { KeyInput } from "../../src/domain/shortcuts.js";
import type { WorkspaceRecord } from "../../src/domain/workspace.js";

let main: MainHarness;
beforeAll(async () => { main = await startMainProcess(null, "aicodingtool-main-", { computerUse: { computerUseForRun: async () => ({ status: "unavailable", message: "test" }), computerUsePermissions: async () => ({ accessibility: false, screenRecording: false }), requestComputerUsePermission: async () => ({ accessibility: false, screenRecording: false }), stopComputerUse: async () => {}, resumeComputerUse: () => {} } }); });
afterAll(async () => { await main?.dispose(); });

type Registered = (...args: never[]) => unknown;
type IpcEvent = { sender: unknown };
type MaybePromise<T> = T | Promise<T>;

const handler = <T extends Registered>(name: string) => registered<T>(main.handlers, name);
const listener = <T extends Registered>(name: string) => registered<T>(main.listeners, name);
const appListener = <T extends Registered>(name: string) => registered<T>(main.appListeners, name);
const protocolHandler = <T extends Registered>(name: string) => registered<T>(main.protocolHandlers, name);

test("capture context survives annotated copies and rejects invalid attachment references", async () => {
  const save = handler<(event: IpcEvent, data: string, original?: unknown) => Promise<string>>("attachment:save");
  const read = handler<(event: IpcEvent, file: unknown) => Promise<unknown>>("attachment:context");
  const original = await save(main.trusted, "AQID");
  const context = { version: 1, platform: "linux-hyprland", app: "Editor", title: "Draft", capturedAt: 123, accessibility: { status: "captured", text: "Document ready", truncated: false } };
  await writeFile(`${original}.context.json`, JSON.stringify(context));
  assert.deepEqual(await read(main.trusted, original), context);
  const annotated = await save(main.trusted, "AQIE", original);
  assert.notEqual(annotated, original);
  assert.deepEqual(await read(main.trusted, annotated), context);
  assert.equal(await read(main.trusted, await save(main.trusted, "AQIF")), null);
  await assert.rejects(read(main.untrusted, original), /Untrusted/);
  await assert.rejects(read(main.trusted, "/etc/passwd"), /not one/);
  await assert.rejects(save(main.trusted, "AQIG", "/etc/passwd"), /not one/);
  await writeFile(`${original}.context.json`, "broken JSON");
  assert.equal(await read(main.trusted, original), null);
  await writeFile(`${original}.context.json`, "x".repeat(128_001));
  assert.equal(await read(main.trusted, original), null);
  assert.deepEqual(await read(main.trusted, annotated), context, "the annotated image owns its metadata copy");
});

test("the main window sends ordinary web links to the default browser", async () => {
  const open = main.window.webContents.windowOpenHandler;
  assert.ok(open);
  assert.deepEqual(open({ url: "https://example.com/docs" }), { action: "deny" });
  await tick();
  assert.deepEqual(main.externalUrls, ["https://example.com/docs"]);

  assert.deepEqual(open({ url: "file:///etc/passwd" }), { action: "deny" });
  await tick();
  assert.deepEqual(main.externalUrls, ["https://example.com/docs"], "non-web targets stay closed");
});

/** Starts a thread through the runtime, the way the window does, and waits for its run to reach an agent process. */
async function startThread(text: string) {
  const request = handler<(event: IpcEvent, input?: WorkspaceInput) => Promise<WorkspaceCommandResult>>("workspace-runtime:request");
  await request(main.trusted, { type: "task.new" });
  await request(main.trusted, { type: "view.set-prompt", prompt: text });
  const sent = await request(main.trusted, { type: "task.send", attachments: [] });
  assert.ok(sent.ok && sent.taskId, sent.ok ? "" : sent.message);
  const taskId = sent.taskId;
  await waitFor(() => main.agents.some((agent) => agent.messages.some((message) => message.type === "start" && message.taskId === taskId)), "the run reaching the agent");
  const agent = main.agents.findLast((each) => each.messages.some((message) => message.type === "start" && message.taskId === taskId))!;
  const start = agent.messages.findLast((message) => message.type === "start" && message.taskId === taskId) as StartRunCommand & { workspaceRoot: string; projectless: boolean };
  return { taskId, agent, start };
}

test("main serves the window's files and refuses what is not its own", async () => {
  const { userData, trusted, untrusted } = main;

  const saveAttachment = handler<(event: IpcEvent, data: unknown) => Promise<string>>("attachment:save");
  const saved = await saveAttachment(trusted, Buffer.from([1, 2, 3]).toString("base64"));
  const downloadImage = handler<(event: IpcEvent, source: unknown) => Promise<void>>("image:download");
  await assert.rejects(downloadImage(untrusted, "attachment://file/image.png"), /Untrusted/);
  await assert.rejects(downloadImage(trusted, "file:///etc/passwd"), /Invalid image reference/);
  assert.equal(path.dirname(saved), path.join(userData, "attachments"));
  await assert.rejects(saveAttachment(untrusted, "AQID"));
  await assert.rejects(saveAttachment(trusted, "not base64!"));

  const serve = protocolHandler<(request: { url: string }) => Promise<Response>>("attachment");
  assert.equal((await serve({ url: `attachment://file/${path.basename(saved)}` })).status, 200);
  assert.equal((await serve({ url: "attachment://file/%2E%2E%2Fworkspaces.v1.json" })).status, 404);

  const projectlessWorkspace = handler<(event: IpcEvent) => Promise<WorkspaceRecord>>("workspace:projectless");
  const changedFiles = handler<(event: IpcEvent, workspaceId: unknown) => Promise<ChangedFilesResult>>("workspace:changed-files");
  const projectless = await projectlessWorkspace(trusted);
  assert.equal((await changedFiles(untrusted, projectless.id)).status, "error");
  assert.equal((await changedFiles(trusted, "")).status, "error");
});

test("a run the runtime starts reaches one agent process, and what the process reports comes back as state", async () => {
  const { userData } = main;
  const { taskId, agent, start } = await startThread("Inspect the checkout");
  assert.equal(start.channel, "main");
  assert.equal(agent.args[0], path.join(userData, "generated-images"));
  assert.match(agent.args[1] ?? "", /app-plugin$/, "the worker is told where the app's plugin is");
  assert.equal(start.projectless, true);
  const state = () => main.runtimeState();

  /** No run gates the set, and the thread keeps it until the agent process that holds the work dies. */
  const shell = { id: "bash-1", kind: "shell", description: "npm run dev" };
  agent.emit("message", { type: "run.started", taskId, runId: start.runId, sequence: 1 });
  agent.emit("message", { type: "background.changed", taskId, processes: [shell] });
  agent.emit("message", { type: "subagent.started", taskId, id: "child-live", description: "Inspect", sessionScoped: true });
  agent.emit("message", { type: "subagent.started", taskId, id: "child-idle", description: "Review", sessionScoped: true });
  agent.emit("message", { type: "subagent.status", taskId, id: "child-idle", status: "idle" });
  agent.emit("message", { type: "subagent.started", taskId, id: "invalid", description: "Invalid", sessionScoped: false });
  await waitFor(async () => (await state()).subagents[taskId]?.length === 2, "the two children the process could describe");
  assert.deepEqual((await state()).backgroundProcesses[taskId], [shell]);

  const runtimeRequest = handler<(event: IpcEvent, input?: WorkspaceInput) => Promise<WorkspaceCommandResult>>("workspace-runtime:request");
  await runtimeRequest(main.trusted, { type: "engine.reload-settings" });
  assert.equal(agent.messages.at(-1)?.type, "reload-settings");
  agent.emit("message", { type: "engine.settings-reload-status", status: "invalid" });
  agent.emit("message", { type: "engine.settings-reload-status", status: "pending" });
  await waitFor(async () => (await state()).agentSettingsReload === "pending", "the reload being reported");
  agent.emit("message", { type: "engine.settings-reload-status", status: "reloaded" });
  await waitFor(async () => (await state()).agentSettingsReload === "reloaded", "the reload finishing");
  await runtimeRequest(main.trusted, { type: "engine.reload-settings" });
  agent.emit("exit", 9);
  await waitFor(async () => (await state()).agentSettingsReload === "failed", "a worker exit releasing the pending UI");
  const after = await state();
  assert.equal(after.threads.find((thread) => thread.id === taskId)?.outcome, "failed");
  assert.deepEqual(after.backgroundProcesses[taskId] ?? [], [], "the processes died with the agent process, and nothing is left to say so");
  assert.deepEqual(after.subagents[taskId]?.map((subagent) => [subagent.id, subagent.status]), [["child-live", "stopped"], ["child-idle", "idle"]], "the process crash settles only the child whose turn was live");

  const next = await startThread("After the crash");
  next.agent.throwOnPost = true;
  await runtimeRequest(main.trusted, { type: "engine.reload-settings" });
  await waitFor(async () => (await state()).agentSettingsReload === "failed", "a send failure releasing the pending UI");
  await runtimeRequest(main.trusted, { type: "run.cancel", taskId: next.taskId });
  await waitFor(async () => (await state()).threads.find((thread) => thread.id === next.taskId)?.outcome === "failed", "a cancel the process could not take failing the run");
  next.agent.throwOnPost = false;
});

test("a tool's question about threads is answered by the runtime, and one nobody can read is refused", async () => {
  const { taskId, agent } = await startThread("Ask about threads");
  const request: ThreadRequest = { type: "thread.request", requestId: "request-1", taskId, op: "list" };

  agent.emit("message", { type: "thread.request", requestId: "malformed", taskId, op: "list", limit: -1 });
  agent.emit("message", request);
  await waitFor(() => agent.messages.filter((message) => message.type === "thread.response").length === 2, "both answers");
  const answered = agent.messages.filter((message) => message.type === "thread.response") as Array<{ requestId: string; ok: boolean; result?: Array<{ id: string }> }>;
  const refused = answered.find((message) => message.requestId === "malformed");
  assert.ok(refused);
  assert.equal(refused.ok, false, "a request no guard could read is refused rather than dropped, which would hang its tool call");
  const listed = answered.find((message) => message.requestId === "request-1");
  assert.ok(listed?.ok);
  assert.ok(listed.result?.some((thread) => thread.id === taskId), "the runtime answers with the threads it holds");
});

test("a bound keystroke is taken from the window's menu and handed to whatever is in front", async () => {
  const { window, trusted, untrusted } = main;

  const beforeInput = registered<(event: { preventDefault(): void }, input: KeyInput & { type: string }) => void>(window.webContents.listeners, "before-input-event");
  /** Whichever key the platform calls its own: ⌘ on macOS, Ctrl everywhere else. */
  const mod = (held: boolean) => process.platform === "darwin" ? { meta: held, control: false } : { control: held, meta: false };
  const press = (code: string, { held = true, shift = false, type = "keyDown" }: { held?: boolean; shift?: boolean; type?: string } = {}) => {
    let prevented = false;
    beforeInput({ preventDefault: () => { prevented = true; } }, { type, key: code.slice(-1).toLowerCase(), code, alt: false, shift, ...mod(held) });
    return prevented;
  };
  const shortcuts = () => main.sentOn<ShortcutInvocation>("window:shortcut");
  const captured = () => main.sentOn<string | null>("window:shortcut-captured");
  const setShortcuts = listener<(event: IpcEvent, overrides: unknown) => void>("shortcuts:set");
  const captureShortcuts = listener<(event: IpcEvent, capturing: unknown) => void>("shortcuts:capture");
  const closeWindow = listener<(event: IpcEvent) => void>("window:close");

  assert.equal(press("KeyW"), true, "the window must not act on the close keystroke before the app has");
  assert.deepEqual(shortcuts(), [{ action: "tab.close", surface: "any" }]);

  assert.equal(press("KeyW", { shift: true }), false, "adding a modifier makes it somebody else's keystroke");
  assert.equal(press("KeyY"), false, "an unbound keystroke is nobody's");
  assert.equal(press("KeyW", { held: false }), false);
  assert.equal(press("KeyW", { type: "keyUp" }), false);
  assert.equal(shortcuts().length, 1);

  assert.equal(press("KeyR"), false, "reloading belongs to a page in the panel, not to the window");

  assert.equal(press("KeyA", { shift: true }), true, "answering an approval is bound where the user can move it");

  setShortcuts(untrusted, { "run.allow": "Mod+E" });
  assert.equal(press("KeyA", { shift: true }), true, "an untrusted sender cannot rebind anything");
  setShortcuts(trusted, { "run.allow": "Mod+E" });
  assert.equal(press("KeyA", { shift: true }), false, "the keystroke it used to hold is free again");
  assert.equal(press("KeyE"), true);
  assert.deepEqual(shortcuts().at(-1), { action: "run.allow", surface: "any" });

  setShortcuts(trusted, { "run.allow": "Mod+W" });
  assert.equal(press("KeyW"), true);
  assert.deepEqual(shortcuts().at(-1), { action: "tab.close", surface: "any" }, "a keystroke the app answers itself is not one an override can take");

  captureShortcuts(trusted, true);
  const acted = shortcuts().length;
  assert.equal(press("KeyJ", { shift: true }), true, "while capturing, a keystroke is reported rather than acted on");
  assert.equal(press("KeyJ", { held: false }), false, "a keystroke with no modifier is left to whatever has the keys");
  assert.equal(press("Escape", { held: false }), true);
  assert.deepEqual(captured(), ["Mod+Shift+J", null]);
  assert.equal(shortcuts().length, acted, "nothing fired while settings were listening");
  captureShortcuts(trusted, false);

  let closed = 0;
  window.close = () => { closed += 1; };
  closeWindow(untrusted);
  assert.equal(closed, 0, "only the window's own renderer may close it");
  closeWindow(trusted);
  assert.equal(closed, 1);
});

test("a folder the aic command names is registered and handed to the window that asks for it", async () => {
  const { trusted, untrusted } = main;
  const folder = await realpath(await mkdtemp(path.join(os.tmpdir(), "aicodingtool-cli-open-")));
  const url = `aicodingtool://open?path=${Buffer.from(folder, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_")}`;
  const opened = async () => (await main.runtimeState()).projects;
  const openUrl = appListener<(event: { preventDefault(): void }, url: string) => void>("open-url");
  const secondInstance = appListener<(event: unknown, argv: string[]) => void>("second-instance");
  const cliStatus = handler<(event: IpcEvent) => Promise<CliStatus>>("cli:status");
  const installCli = handler<(event: IpcEvent) => Promise<CliStatus>>("cli:install");
  const uninstallCli = handler<(event: IpcEvent) => Promise<CliStatus>>("cli:uninstall");
  try {
    openUrl({ preventDefault() {} }, url);
    await waitFor(async () => (await opened()).length === 1, "the folder landing in the runtime");
    assert.equal((await opened())[0].root, folder);

    secondInstance({}, ["/Applications/AI Coding Tool.app", url]);
    await tick();
    assert.equal((await opened()).length, 1, "the same folder keeps the project it already had");

    openUrl({ preventDefault() {} }, "aicodingtool://open?path=bm90LWFic29sdXRl");
    await tick();
    assert.equal((await opened()).length, 1, "a URL that names no absolute folder opens nothing");

    await assert.rejects(cliStatus(untrusted));
    assert.equal((await cliStatus(trusted)).path, cliConfiguration(process.platform, os.homedir())?.installPath ?? "/usr/local/bin/aic");
    await assert.rejects(installCli(untrusted));
    await assert.rejects(uninstallCli(untrusted));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("a page the panel is not showing belongs to a window of its own", async () => {
  const { window, windows, trusted } = main;
  const panel: BrowserBounds = { x: 40, y: 60, width: 900, height: 700 };
  const view = () => windows.flatMap((each) => each.children)[0];
  const openBrowser = handler<(event: IpcEvent, tabId: unknown, url: unknown) => MaybePromise<void>>("browser:open");
  const setBrowserBounds = handler<(event: IpcEvent, bounds: unknown) => MaybePromise<void>>("browser:bounds");
  const showBrowser = handler<(event: IpcEvent, tabId: unknown) => MaybePromise<void>>("browser:show");
  const closeBrowser = handler<(event: IpcEvent, tabId: unknown) => MaybePromise<void>>("browser:close");
  const readBrowser = handler<(event: IpcEvent, tabId: unknown, textLimit: unknown, timeoutMs: unknown) => MaybePromise<BrowserSnapshot | null>>("browser:read");

  await openBrowser(trusted, "tab-parked", "https://example.com/");
  assert.equal(window.children.length, 0, "a page nobody is showing is not in the app's window");
  const page = view();
  assert.ok(page, "the page is parked in a window all the same");
  assert.deepEqual(page.bounds, { x: 0, y: 0, width: 1200, height: 800 }, "and is given a viewport to lay out in");
  page.webContents.executeJavaScript = async (script) => runInNewContext(script, {
    document: {
      title: "Large page",
      body: { innerText: "" },
      querySelectorAll: () => Array.from({ length: 1_001 }, () => ({
        tagName: "BUTTON",
        getBoundingClientRect: () => ({ width: 1, height: 1 }),
        getAttribute: (name: string) => name === "aria-label" ? "Action" : null,
        setAttribute() {},
      })),
    },
    getComputedStyle: () => ({ visibility: "visible", opacity: "1" }),
    location: { href: "https://example.com/" },
  });
  assert.equal((await readBrowser(trusted, "tab-parked", 4_000, 0))?.elements.length, 1_000, "an untrusted page cannot grow a snapshot without limit");
  const parking = windows.find((each) => each.children.includes(page));
  assert.ok(parking);
  assert.notEqual(parking, window);
  assert.equal(parking.isVisible(), false, "nothing ever shows it");

  await setBrowserBounds(trusted, panel);
  await showBrowser(trusted, "tab-parked");
  assert.deepEqual(window.children, [page], "the page the panel shows is the app window's own");
  assert.deepEqual(page.bounds, panel);

  await setBrowserBounds(trusted, null);
  assert.equal(window.children.length, 0, "a closed panel puts the page back where it cannot take the keyboard");
  assert.deepEqual(parking.children, [page]);

  await closeBrowser(trusted, "tab-parked");
  assert.equal(windows.flatMap((each) => each.children).length, 0);
});

test("a page keeps bounded developer diagnostics and waits for page conditions", async () => {
  const { trusted, untrusted, windows, webRequestListeners } = main;
  const openBrowser = handler<(event: IpcEvent, tabId: unknown, url: unknown) => MaybePromise<void>>("browser:open");
  const closeBrowser = handler<(event: IpcEvent, tabId: unknown) => MaybePromise<void>>("browser:close");
  const inspectBrowser = handler<(event: IpcEvent, tabId: unknown, inspection: unknown) => MaybePromise<BrowserInspectionResult | null>>("browser:inspect");

  await openBrowser(trusted, "tab-diagnostics", "https://example.com/app");
  const page = windows.flatMap((window) => window.children).find((view) => view.webContents.getURL() === "")!;
  page.webContents.getURL = () => "https://example.com/app";
  page.webContents.getTitle = () => "Example app";
  for (let index = 0; index < 205; index += 1) {
    page.webContents.emit("console-message", { level: "info", message: `render ${index}`, sourceId: "app.js", lineNumber: index + 1 });
  }
  page.webContents.emit("console-message", { level: "error", message: "render failed", sourceId: "app.js", lineNumber: 42 });

  const beforeRequest = registered<(details: Record<string, unknown>, callback: (answer: object) => void) => void>(webRequestListeners, "before-request");
  const completed = registered<(details: Record<string, unknown>) => void>(webRequestListeners, "completed");
  beforeRequest({ id: 7, webContentsId: page.webContents.id, method: "GET", url: "https://example.com/api/items", resourceType: "xhr" }, () => {});
  completed({ id: 7, url: "https://example.com/api/items", statusCode: 503, fromCache: false });

  const consoleResult = await inspectBrowser(trusted, "tab-diagnostics", { op: "console", minimumLevel: "warning" });
  assert.equal(consoleResult?.kind, "console");
  if (consoleResult?.kind === "console") {
    assert.equal(consoleResult.latestSequence, 206);
    assert.deepEqual(consoleResult.entries.map((entry) => [entry.level, entry.message, entry.line]), [["error", "render failed", 42]]);
  }
  const retainedConsole = await inspectBrowser(trusted, "tab-diagnostics", { op: "console", limit: 200 });
  if (retainedConsole?.kind === "console") assert.equal(retainedConsole.entries.length, 200, "a noisy page cannot grow console history without limit");

  const networkResult = await inspectBrowser(trusted, "tab-diagnostics", { op: "network", failuresOnly: true });
  assert.equal(networkResult?.kind, "network");
  if (networkResult?.kind === "network") assert.deepEqual(networkResult.entries.map((entry) => [entry.method, entry.status, entry.resourceType]), [["GET", 503, "xhr"]]);

  page.webContents.executeJavaScript = async (script) => runInNewContext(script, { document: { body: { innerText: "Ready" } } });
  const waited = await inspectBrowser(trusted, "tab-diagnostics", { op: "wait", condition: "text", value: "Ready", timeoutMs: 100 });
  assert.equal(waited?.kind, "wait");
  if (waited?.kind === "wait") assert.equal(waited.matched, true);

  await assert.rejects(async () => await inspectBrowser(untrusted, "tab-diagnostics", { op: "console" }));
  await closeBrowser(trusted, "tab-diagnostics");
});

type MenuEntry = { label?: string; role?: string; type?: string; submenu?: MenuEntry[]; click?: () => void };

test("the app menu sends help actions through the window command path", async () => {
  listener<(event: IpcEvent) => void>("workspace-view:ready")(main.trusted);
  const menu = main.applicationMenu() as MenuEntry[] | null;
  assert.ok(menu, "the app sets its own menu");
  const appMenu = menu.find((entry) => entry.label === "AI Coding Tool");
  if (process.platform === "darwin") {
    assert.ok(appMenu?.submenu, "the first menu is the app's own");
    assert.deepEqual(
      appMenu.submenu.map((entry) => entry.type ?? entry.role ?? entry.label),
      ["about", "separator", "Check for Updates…", "Open Source Licenses…", "separator", "services", "separator", "hide", "hideOthers", "unhide", "separator", "quit"],
      "every role macOS puts there stays where the user looks for it",
    );
    assert.deepEqual(menu.slice(1).map((entry) => entry.role), ["fileMenu", "editMenu", "viewMenu", "windowMenu"]);
  } else {
    assert.equal(appMenu, undefined);
    assert.deepEqual(menu.slice(0, 4).map((entry) => entry.role), ["fileMenu", "editMenu", "viewMenu", "windowMenu"]);
  }

  const check = menu.flatMap((entry) => entry.submenu ?? []).find((entry) => entry.label === "Check for Updates…");
  assert.ok(check?.click);
  check.click();
  assert.deepEqual(main.sentOn<ShortcutInvocation>("window:shortcut").at(-1), { action: "app.check-for-updates", surface: "any" });

  const licenses = menu.flatMap((entry) => entry.submenu ?? []).find((entry) => entry.label === "Open Source Licenses…");
  assert.ok(licenses?.click);
  licenses.click();
  assert.deepEqual(main.sentOn<ShortcutInvocation>("window:shortcut").at(-1), { action: "app.open-source-licenses", surface: "any" });

  const openLicenses = handler<(event: IpcEvent) => Promise<void>>("licenses:open");
  await assert.rejects(openLicenses(main.untrusted));
  await openLicenses(main.trusted);
  const viewer = main.windows.find((window) => window.loadedURL === "aicodingtool-licenses://notices/");
  assert.ok(viewer, "licenses open inside the app without an external text editor");
  assert.equal(viewer.visible, true);
  assert.equal(viewer.menuBarVisible, false);
  await openLicenses(main.trusted);
  assert.equal(main.windows.filter((window) => window.loadedURL === viewer.loadedURL).length, 1);
  assert.equal(viewer.focused, true, "another click brings the existing reader forward");
  viewer.close();
});
