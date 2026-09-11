import assert from "node:assert/strict";
import { afterAll, beforeAll, test, vi } from "vitest";
import { JSDOM } from "jsdom";
import type { BrowserWindow } from "electron";
import { fakeElectron } from "../support/electron-app-stub.mjs";
import type { BrowserPageEvent } from "../../src/contracts/ipc.js";

const fake = fakeElectron("/tmp/aic-browser-test");
let browser: typeof import("../../src/main/browser-host.ts");
const events: BrowserPageEvent[] = [];
beforeAll(async () => {
  Reflect.set(process.versions, "chrome", "141.0.0.0");
  vi.doMock("electron", () => fake.electron);
  browser = await import("../../src/main/browser-host.ts");
  const window = new fake.electron.BrowserWindow({ show: false });
  browser.startBrowserHost(window as unknown as BrowserWindow, { onPage: (event) => events.push(event), onFind() {}, onKey: (input) => input.key === "Escape" });
});
afterAll(() => { browser?.stopBrowserHost(); Reflect.deleteProperty(process.versions, "chrome"); vi.doUnmock("electron"); });

let counter = 0;
function page(url = "https://allowed.example/", taskId?: string) {
  const id = `tab-${++counter}`;
  browser.configurePermissions({ origins: ["https://allowed.example"], autonomousTaskIds: [] });
  browser.openTab(id, undefined, taskId);
  const view = fake.windows.flatMap((window) => window.children).find((view) => !view.destroyed && !Reflect.has(view, "testClaimed"));
  assert.ok(view);
  Reflect.set(view, "testClaimed", true);
  let current = url;
  view.webContents.getURL = () => current;
  view.webContents.getTitle = () => "Test page";
  return { id, view, move(url: string) { current = url; view.webContents.emit("did-navigate"); } };
}

test("every agent read and action checks the actual native origin", async () => {
  const { id, view } = page("https://private.example/");
  const execute = vi.fn(async () => ({}));
  view.webContents.executeJavaScript = execute;
  await assert.rejects(browser.readPage(id, 1000, 0, "task"), /approval/);
  await assert.rejects(browser.capturePage(id, false, 0, "task"), /approval/);
  for (const inspection of [{ op: "console" }, { op: "network" }, { op: "wait", condition: "url", value: "private", timeoutMs: 0 }] as const) {
    await assert.rejects(browser.inspectPage(id, inspection, "task"), /approval/);
  }
  await assert.rejects(browser.act(id, { kind: "click", ref: "1" }, "task"), /approval/);
  assert.equal(execute.mock.calls.length, 0);
  browser.configurePermissions({ origins: [], autonomousTaskIds: ["task"] });
  assert.equal((await browser.inspectPage(id, { op: "console" }, "task"))?.kind, "console");
  browser.configurePermissions({ origins: [], autonomousTaskIds: [] });
  await assert.rejects(browser.inspectPage(id, { op: "console" }, "task"), /approval/);
  assert.equal((await browser.inspectPage(id, { op: "console" }))?.kind, "console", "user browsing remains available");
});

test("agent redirects, programmatic navigation and popups cannot carry a grant to another site", () => {
  const { id, view } = page("https://allowed.example/", "task");
  for (const event of ["will-navigate", "will-redirect"]) {
    const preventDefault = vi.fn();
    view.webContents.emit(event, { preventDefault }, "https://private.example/", false, true);
    assert.equal(preventDefault.mock.calls.length, 1);
    assert.deepEqual(events.at(-1)?.navigationRequest, { taskId: "task", url: "https://private.example/" });
  }
  assert.equal(view.webContents.windowOpenHandler?.({ url: "https://private.example/popup" }).action, "deny");
  assert.equal(view.webContents.windowOpenHandler?.({ url: "https://allowed.example/popup" }).action, "allow");
  view.webContents.emit("before-mouse-event", {}, { type: "mouseMove" });
  view.webContents.emit("before-mouse-event", {}, { type: "mouseEnter" });
  view.webContents.emit("before-input-event", { preventDefault() {} }, { type: "keyDown", key: "Escape" });
  const callback = vi.fn();
  fake.records.webRequestListeners.get("before-request")?.({ webContentsId: view.webContents.id, resourceType: "mainFrame", url: "https://private.example/" }, callback);
  assert.deepEqual(callback.mock.calls[0], [{ cancel: true }]);
  const preventDefault = vi.fn();
  view.webContents.emit("will-navigate", { preventDefault }, "https://allowed.example/next");
  assert.equal(preventDefault.mock.calls.length, 0);
  view.webContents.emit("before-mouse-event", {}, { type: "mouseDown" });
  assert.equal(view.webContents.windowOpenHandler?.({ url: "https://allowed.example/popup" }).action, "allow");
  view.webContents.emit("will-navigate", { preventDefault }, "https://private.example/");
  assert.equal(preventDefault.mock.calls.length, 0, "native user navigation retains its behavior");
  browser.closeTab(id);
});

test("reads discard a document changed or a grant revoked while awaiting execution", async () => {
  const { id, view, move } = page();
  view.webContents.executeJavaScript = async () => {
    move("https://private.example/");
    return { url: "https://allowed.example/", title: "Old", text: "private text", elements: [] };
  };
  await assert.rejects(browser.readPage(id, 1000, 0, "task"), /approval/);
  move("https://allowed.example/");
  view.webContents.executeJavaScript = async () => {
    browser.configurePermissions({ origins: [], autonomousTaskIds: [] });
    return true;
  };
  await assert.rejects(browser.inspectPage(id, { op: "wait", condition: "element", value: "secret", timeoutMs: 0 }, "task"), /approval/);
});

test("retained diagnostics are filtered by the document that produced them", async () => {
  const { id, view, move } = page("https://private.example/");
  view.webContents.emit("console-message", { level: "info", message: "private token", lineNumber: 0 });
  const requests = fake.records.webRequestListeners;
  requests.get("before-request")?.({ webContentsId: view.webContents.id, id: 42, method: "GET", resourceType: "xhr", url: "https://private.example/token" }, () => {});
  move("https://allowed.example/");
  requests.get("completed")?.({ id: 42, url: "https://private.example/token", statusCode: 200 });
  view.webContents.emit("console-message", { level: "info", message: "allowed log", lineNumber: 0 });
  const console = await browser.inspectPage(id, { op: "console" }, "task");
  assert.ok(console?.kind === "console");
  assert.deepEqual(console.entries.map((entry) => entry.message), ["allowed log"]);
  const network = await browser.inspectPage(id, { op: "network" }, "task");
  assert.ok(network?.kind === "network");
  assert.deepEqual(network.entries, []);
});

test("snapshots and element conditions use labels without exposing password values", async () => {
  const { id, view } = page();
  const dom = new JSDOM('<input type="password" value="hidden-password"><label for="pw">Account password</label><input id="pw" type="PASSWORD" value="another-secret"><input value="ordinary text">', { url: "https://allowed.example/", runScripts: "outside-only" });
  try {
    Object.defineProperty(dom.window.document.body, "innerText", { value: "" });
    for (const input of dom.window.document.querySelectorAll("input")) input.getBoundingClientRect = () => ({ width: 100, height: 20 }) as DOMRect;
    view.webContents.executeJavaScript = async (script) => dom.window.eval(script) as unknown;
    const snapshot = await browser.readPage(id, 1000, 0, "task");
    assert.ok(snapshot);
    assert.doesNotMatch(JSON.stringify(snapshot), /hidden-password|another-secret/);
    assert.deepEqual(Array.from(snapshot.elements, (entry) => entry.name), ["", "Account password", "ordinary text"]);
    for (const value of ["hidden-password", "another-secret", "Account password", "ordinary text"]) {
      const result = await browser.inspectPage(id, { op: "wait", condition: "element", value, timeoutMs: 0 }, "task");
      assert.ok(result?.kind === "wait");
      assert.equal(result.matched, ["Account password", "ordinary text"].includes(value));
    }
    dom.reconfigure({ url: "https://private.example/" });
    await assert.rejects(browser.readPage(id, 1000, 0, "task"), /approval/, "the script checks its document even when the native URL has not caught up");
  } finally { dom.window.close(); }
});


test("screenshot capture discards changed documents and preserves authorized captures", async () => {
  const { id, view, move } = page();
  const bytes = Buffer.alloc(24);
  bytes.writeUInt32BE(100, 16);
  bytes.writeUInt32BE(50, 20);
  let change = false;
  Reflect.set(view.webContents, "debugger", {
    isAttached: () => true,
    sendCommand: async (name: string) => {
      if (name === "Page.getLayoutMetrics") return { cssContentSize: { width: 100, height: 50 }, cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 100, clientHeight: 50 } };
      if (change) move("https://private.example/");
      return { data: bytes.toString("base64") };
    },
  });
  const shot = await browser.capturePage(id, false, 0, "task");
  assert.ok(shot);
  assert.equal(shot.width, 100);
  const { readFile } = await import("node:fs/promises");
  assert.deepEqual(await readFile(shot.path), bytes);
  change = true;
  await assert.rejects(browser.capturePage(id, false, 0, "task"), /approval/);
});


test("approved agent popups retain navigation enforcement and autonomous popups remain usable", () => {
  const { id, view } = page("https://allowed.example/", "task");
  const opened = view.webContents.windowOpenHandler?.({ url: "https://allowed.example/login" }) as Electron.WindowOpenHandlerResponse;
  assert.equal(opened.action, "allow");
  assert.ok(opened.createWindow);
  const popup = opened.createWindow({});
  const native = fake.windows.find((window) => window.webContents.id === popup.id);
  assert.ok(native);
  const preventDefault = vi.fn();
  native.webContents.listeners.get("will-redirect")?.({ preventDefault }, "https://private.example/", false, true);
  assert.equal(preventDefault.mock.calls.length, 1);
  const callback = vi.fn();
  fake.records.webRequestListeners.get("before-request")?.({ webContentsId: popup.id, resourceType: "mainFrame", url: "https://private.example/" }, callback);
  assert.deepEqual(callback.mock.calls[0], [{ cancel: true }]);
  browser.configurePermissions({ origins: [], autonomousTaskIds: ["task"] });
  assert.equal(native.webContents.windowOpenHandler?.({ url: "https://private.example/nested" }).action, "allow");
  browser.configurePermissions({ origins: [], autonomousTaskIds: [] });
  assert.equal(native.webContents.windowOpenHandler?.({ url: "https://private.example/nested" }).action, "deny");
  browser.closeTab(id);
  assert.equal(native.destroyed, true);
});
