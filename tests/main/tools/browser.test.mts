import assert from "node:assert/strict";
import { test } from "vitest";
import { browserTools } from "../../../src/main/tools/browser.mts";
import { ThreadChannel } from "../../../src/main/agent/thread-channel.mts";
import type { BrowserBridge } from "../../../src/main/agent/agent-provider.mts";
import type { BrowserRead, BrowserWrite, ThreadRequest } from "../../../src/contracts/threads.js";
import type { BrowserShot, BrowserSnapshot } from "../../../src/domain/browser.js";

const snapshot = (overrides: Partial<BrowserSnapshot> = {}): BrowserSnapshot => ({
  tabId: "tab-1",
  url: "https://example.com/pulls",
  title: "Pull requests",
  loading: false,
  text: "Two open pull requests",
  elements: [
    { ref: "1", role: "input:text", name: "Search", value: "is:open" },
    { ref: "2", role: "button", name: "New pull request" },
  ],
  ...overrides,
});

type BrowserCall = ["command", BrowserWrite] | ["read", BrowserRead];
type FakeBrowserBridge = BrowserBridge & { calls: BrowserCall[] };

function fakeBridge(overrides: Partial<BrowserBridge> = {}): FakeBrowserBridge {
  const calls: BrowserCall[] = [];
  return {
    calls,
    command: async (write) => { calls.push(["command", write]); },
    read: async (read) => { calls.push(["read", read]); return { kind: "snapshot", snapshot: snapshot() }; },
    ...overrides,
  };
}

type ToolResult = Awaited<ReturnType<ReturnType<typeof browserTools>[number]["handler"]>>;
type TestTool = { handler: (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult> };

function toolNamed(bridge: BrowserBridge, name: string): TestTool {
  const definition = browserTools(bridge).find((entry) => entry.name === name);
  assert.ok(definition, `no ${name} tool`);
  return definition as unknown as TestTool;
}

const textOf = (result: ToolResult) => result.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");

function last<T>(values: T[]): T {
  const value = values.at(-1);
  assert.ok(value);
  return value;
}

test("opening a page loads it and reads back the page it settled on", async () => {
  const bridge = fakeBridge();

  const opened = await toolNamed(bridge, "browser_open").handler({ url: "https://example.com/pulls", waitSeconds: 5 }, {});

  assert.deepEqual(bridge.calls[0], ["command", { type: "browser.open", url: "https://example.com/pulls" }]);
  assert.deepEqual(bridge.calls[1], ["read", { op: "snapshot", timeoutMs: 5_000, textLimit: 4_000 }]);
  const text = textOf(opened);
  assert.match(text, /Pull requests — https:\/\/example\.com\/pulls/);
  assert.match(text, /\[1\] input:text "Search" = "is:open"/);
  assert.match(text, /\[2\] button "New pull request"/);
});

test("a search opens a page that answers one, and reads the results back", async () => {
  const bridge = fakeBridge();

  const searched = await toolNamed(bridge, "browser_search").handler({ query: "weather today", newTab: true }, {});

  assert.deepEqual(bridge.calls[0], ["command", { type: "browser.open", url: "https://duckduckgo.com/?q=weather%20today", newTab: true }]);
  assert.deepEqual(bridge.calls[1], ["read", { op: "snapshot", timeoutMs: 20_000, textLimit: 4_000 }]);
  assert.match(textOf(searched), /Pull requests — https:\/\/example\.com\/pulls/);
});

test("a wait longer than the panel allows is capped rather than passed on", async () => {
  const bridge = fakeBridge();

  await toolNamed(bridge, "browser_read").handler({ waitSeconds: 9_000 }, {});

  const call = last(bridge.calls);
  if (call[0] !== "read" || call[1].op !== "snapshot") assert.fail("expected a snapshot read");
  assert.equal(call[1].timeoutMs, 120_000);
});

test("a page waiting on the user reads as the ask it is, not as an empty page", async () => {
  const bridge = fakeBridge({ read: async () => ({ kind: "awaiting-approval", url: "https://dash.example.com" }) });

  const opened = await toolNamed(bridge, "browser_open").handler({ url: "https://dash.example.com" }, {});

  assert.match(textOf(opened), /asking the user to allow https:\/\/dash\.example\.com/);
  assert.match(textOf(opened), /wait, or ask them to open it themselves/);
});

test("typing names the field, the text, and whether it was submitted, then reads the page", async () => {
  const bridge = fakeBridge();

  await toolNamed(bridge, "browser_type").handler({ ref: "1", text: "is:closed", submit: true, tabId: "tab-2" }, {});

  assert.deepEqual(bridge.calls[0], ["command", {
    type: "browser.act",
    action: { kind: "type", ref: "1", text: "is:closed", submit: true },
    tabId: "tab-2",
  }]);
  const read = bridge.calls[1];
  if (read[0] !== "read" || read[1].op !== "snapshot") assert.fail("expected a snapshot read");
  assert.deepEqual(read[1].tabId, "tab-2");
});

test("listing tabs says so when the panel holds nothing", async () => {
  const listed = await toolNamed(fakeBridge({ read: async () => ({ kind: "tabs", tabs: [] }) }), "browser_tabs").handler({}, {});
  assert.match(textOf(listed), /no tab open/);

  const held = await toolNamed(fakeBridge({
    read: async () => ({ kind: "tabs", tabs: [{ id: "tab-1", url: "https://example.com", title: "Example", loading: true, canGoBack: false, canGoForward: false }] }),
  }), "browser_tabs").handler({}, {});
  assert.match(textOf(held), /Example \[tab-1\] · https:\/\/example\.com · loading/);
});

function capturingBridge(shot: Partial<BrowserShot> = {}): FakeBrowserBridge {
  const bridge = fakeBridge();
  return {
    ...bridge,
    read: async (read) => {
      bridge.calls.push(["read", read]);
      return { kind: "shot", shot: { tabId: "tab-1", url: "https://example.com/", title: "Example", path: "/tmp/shot.png", width: 800, height: 600, ...shot } };
    },
  };
}

test("capturing a tab asks for a picture and reports the file it went to", async () => {
  const bridge = capturingBridge({ url: "https://example.com/pulls", title: "Pull requests", path: "/tmp/aicodingtool-shots-a1/b2.png", width: 1_200, height: 2_400 });

  const captured = await toolNamed(bridge, "browser_screenshot").handler({ tabId: "tab-1", fullPage: true, waitSeconds: 5 }, {});

  assert.deepEqual(bridge.calls, [["read", { op: "screenshot", tabId: "tab-1", fullPage: true, timeoutMs: 5_000 }]]);
  const text = textOf(captured);
  assert.match(text, /Pull requests — https:\/\/example\.com\/pulls/);
  assert.match(text, /Picture saved to \/tmp\/aicodingtool-shots-a1\/b2\.png \(1200x2400\)/);
});

test("a capture of the tab on screen names no tab and asks for no full page", async () => {
  const bridge = capturingBridge();

  await toolNamed(bridge, "browser_screenshot").handler({}, {});

  assert.deepEqual(last(bridge.calls), ["read", { op: "screenshot", timeoutMs: 20_000 }]);
});

test("console and network reads pass cursors and format diagnostics", async () => {
  const reads: BrowserRead[] = [];
  const bridge = fakeBridge({
    read: async (read) => {
      reads.push(read);
      if (read.op === "console") return {
        kind: "console", tabId: "tab-1", url: "https://example.com/app", title: "App", latestSequence: 9, omitted: 0,
        entries: [{ sequence: 9, at: 1, level: "error", message: "render failed", source: "app.js", line: 42 }],
      };
      return {
        kind: "network", tabId: "tab-1", url: "https://example.com/app", title: "App", latestSequence: 5, omitted: 0,
        entries: [{ sequence: 5, startedAt: 1, method: "GET", url: "https://example.com/api", resourceType: "xhr", durationMs: 83, status: 503 }],
      };
    },
  });

  const consoleResult = await toolNamed(bridge, "browser_console").handler({ tabId: "tab-1", since: 4, minimumLevel: "warning" }, {});
  const networkResult = await toolNamed(bridge, "browser_network").handler({ tabId: "tab-1", since: 2, failuresOnly: true }, {});

  assert.deepEqual(reads, [
    { op: "console", tabId: "tab-1", since: 4, minimumLevel: "warning" },
    { op: "network", tabId: "tab-1", since: 2, failuresOnly: true },
  ]);
  assert.match(textOf(consoleResult), /Console cursor: 9[\s\S]*ERROR render failed \(app\.js:42\)/);
  assert.match(textOf(networkResult), /Network cursor: 5[\s\S]*GET 503 83ms xhr https:\/\/example\.com\/api/);
});

test("waiting for a page condition reads the actionable page after it matches", async () => {
  const bridge = fakeBridge({
    read: async (read) => {
      bridge.calls.push(["read", read]);
      return read.op === "wait"
        ? { kind: "wait", tabId: "tab-1", url: "https://example.com/app", title: "App", condition: "text", value: "Ready", matched: true, elapsedMs: 120 }
        : { kind: "snapshot", snapshot: snapshot({ text: "Ready" }) };
    },
  });

  const result = await toolNamed(bridge, "browser_wait").handler({ condition: "text", value: " Ready ", tabId: "tab-1", timeoutSeconds: 5 }, {});

  assert.deepEqual(bridge.calls, [
    ["read", { op: "wait", condition: "text", value: "Ready", tabId: "tab-1", timeoutMs: 5_000 }],
    ["read", { op: "snapshot", tabId: "tab-1", timeoutMs: 0, textLimit: 4_000 }],
  ]);
  assert.match(textOf(result), /Finished waiting for text "Ready"[\s\S]*Ready/);
});

test("a wait rejects a missing target before reaching the browser", async () => {
  const bridge = fakeBridge();

  const result = await toolNamed(bridge, "browser_wait").handler({ condition: "element" }, {});

  assert.equal(result.isError, true);
  assert.match(textOf(result), /element needs a value/);
  assert.deepEqual(bridge.calls, []);
});

test("a browser tool reports what went wrong instead of throwing at the run", async () => {
  const bridge = fakeBridge({ command: async () => { throw new Error("The AICodingTool window is not open."); } });

  const failed = await toolNamed(bridge, "browser_open").handler({ url: "https://example.com" }, {});

  assert.equal(failed.isError, true);
  assert.match(textOf(failed), /Browser error: The AICodingTool window is not open\./);
});

test("the channel stamps the calling thread on every browser command it sends", async () => {
  const posted: ThreadRequest[] = [];
  const channel = new ThreadChannel((request) => posted.push(request), 50);
  const bridge = channel.browserFor("task-7");

  const requests = [
    bridge.command({ type: "browser.open", url: "https://example.com" }).catch(() => undefined),
    bridge.read({ op: "snapshot", timeoutMs: 1_000 }).catch(() => undefined),
  ];
  await new Promise((resolve) => setTimeout(resolve, 0));

  const command = posted[0];
  if (command.op !== "command") assert.fail("expected a command request");
  assert.deepEqual(command.command, { type: "browser.open", url: "https://example.com", taskId: "task-7" });
  assert.equal(command.taskId, "task-7");
  const read = posted[1];
  if (read.op !== "browser") assert.fail("expected a browser request");
  assert.deepEqual(read, { type: "thread.request", requestId: read.requestId, taskId: "task-7", op: "browser", read: { op: "snapshot", timeoutMs: 1_000 } });
  posted.forEach(({ requestId }) => channel.settle({ type: "thread.response", requestId, ok: false, message: "Test complete." }));
  await Promise.all(requests);
});
