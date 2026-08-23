import assert from "node:assert/strict";
import test from "node:test";
import { browserTools } from "../dist/main/main/agent/browser-tools.mjs";
import { ThreadChannel } from "../dist/main/main/agent/thread-channel.mjs";

const snapshot = (overrides = {}) => ({
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

function fakeBridge(overrides = {}) {
  const calls = [];
  return {
    calls,
    command: async (write) => { calls.push(["command", write]); },
    read: async (read) => { calls.push(["read", read]); return { kind: "snapshot", snapshot: snapshot() }; },
    ...overrides,
  };
}

function toolNamed(bridge, name) {
  const definition = browserTools(bridge).find((entry) => entry.name === name);
  assert.ok(definition, `no ${name} tool`);
  return definition;
}

const textOf = (result) => result.content.map((block) => block.text).join("");

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

  assert.equal(bridge.calls.at(-1)[1].timeoutMs, 120_000);
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
  assert.deepEqual(bridge.calls[1][1].tabId, "tab-2");
});

test("listing tabs says so when the panel holds nothing", async () => {
  const listed = await toolNamed(fakeBridge({ read: async () => ({ kind: "tabs", tabs: [] }) }), "browser_tabs").handler({}, {});
  assert.match(textOf(listed), /no tab open/);

  const held = await toolNamed(fakeBridge({
    read: async () => ({ kind: "tabs", tabs: [{ id: "tab-1", url: "https://example.com", title: "Example", loading: true, canGoBack: false, canGoForward: false }] }),
  }), "browser_tabs").handler({}, {});
  assert.match(textOf(held), /Example \[tab-1\] · https:\/\/example\.com · loading/);
});

test("a browser tool reports what went wrong instead of throwing at the run", async () => {
  const bridge = fakeBridge({ command: async () => { throw new Error("The AICodingTool window is not open."); } });

  const failed = await toolNamed(bridge, "browser_open").handler({ url: "https://example.com" }, {});

  assert.equal(failed.isError, true);
  assert.match(textOf(failed), /Browser error: The AICodingTool window is not open\./);
});

test("the channel stamps the calling thread on every browser command it sends", async () => {
  const posted = [];
  const channel = new ThreadChannel((request) => posted.push(request), 50);
  const bridge = channel.browserFor("task-7");

  const requests = [
    bridge.command({ type: "browser.open", url: "https://example.com" }).catch(() => undefined),
    bridge.read({ op: "snapshot", timeoutMs: 1_000 }).catch(() => undefined),
  ];
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(posted[0].command, { type: "browser.open", url: "https://example.com", taskId: "task-7" });
  assert.equal(posted[0].taskId, "task-7");
  assert.deepEqual(posted[1], { type: "thread.request", requestId: posted[1].requestId, taskId: "task-7", op: "browser", read: { op: "snapshot", timeoutMs: 1_000 } });
  posted.forEach(({ requestId }) => channel.settle({ type: "thread.response", requestId, ok: false, message: "Test complete." }));
  await Promise.all(requests);
});
