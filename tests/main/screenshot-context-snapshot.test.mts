import assert from "node:assert/strict";
import { test } from "vitest";
import { accessibilityFromSnapshot, hyprlandAccessibilityWindowId, snapshotWindowAccessibility, type ScreenshotTarget } from "../../src/main/screenshot-context-snapshot.ts";
import { isScreenshotContext, MAX_SCREENSHOT_CONTEXT_TEXT } from "../../src/domain/screenshot-context.ts";

const target: ScreenshotTarget = { platform: "linux-hyprland", pid: 324, windowId: 0x55aa12345678, app: "Editor", title: "Draft" };
const snapshot = {
  pid: target.pid, window_id: target.windowId, window_title: "Draft",
  tree_markdown: '- frame = "Draft"\n  - label = "Document ready"\n  - [0] check box "Wrap" [actions=[toggle]]\n  - [1] entry "Name" value="Ada" [actions=[]]',
  elements: [
    { element_index: 0, enabled: true, selected: false, frame: { x: 5, y: 10, w: 80, h: 25 } },
    { element_index: 1, value: "Ada", enabled: true },
  ],
};

test("a Hyprland address keeps all bits and is never confused with grim's stableId", () => {
  assert.equal(hyprlandAccessibilityWindowId("0x55aa12345678"), target.windowId);
  assert.equal(hyprlandAccessibilityWindowId("1800000a"), null);
  for (const invalid of [undefined, "0x0", "0x20000000000001", "0x123garbage", 42]) assert.equal(hyprlandAccessibilityWindowId(invalid), null);
});

test("Linux snapshots preserve passive text and typed control state with no live element indices", () => {
  const result = accessibilityFromSnapshot(snapshot, target);
  assert.equal(result.status, "captured");
  if (result.status !== "captured") return;
  assert.match(result.text, /Document ready/);
  assert.match(result.text, /selected=false/);
  assert.match(result.text, /desktop bounds=\[5,10,80,25\]/);
  assert.match(result.text, /value="Ada"/);
  assert.doesNotMatch(result.text, /\[0\]|\[1\]|actions=/);
  assert.equal(result.truncated, false);
});

test("macOS snapshots preserve labels and numeric AX values", () => {
  const result = accessibilityFromSnapshot({
    ...snapshot,
    tree_markdown: '- AXWindow "Draft"\n  - AXStaticText = "Document ready"\n  - [element_index 0] AXSlider "Volume"\n  - [1] AXCheckBox "Wrap"\n- AXMenuBar\n  - AXMenuItem "Private recent document"',
    elements: [{ element_index: 0, value: "8", enabled: true }, { element_index: 1, role: "AXCheckBox", value: "1" }],
  }, { ...target, platform: "macos" });
  assert.equal(result.status, "captured");
  if (result.status !== "captured") return;
  assert.match(result.text, /Document ready/);
  assert.match(result.text, /value="8"/);
  assert.match(result.text, /checked=true/);
  assert.doesNotMatch(result.text, /AXMenuBar|Private recent document/);
  assert.doesNotMatch(result.text, /element_index/);
});

test("mismatched owners, windows, titles, and ambiguous Linux trees cannot supply context", () => {
  for (const platform of ["macos", "linux-x11", "linux-hyprland"] as const) {
    for (const mismatch of [{ pid: 123 }, { window_id: 42 }, { window_title: "Another window" }, { degraded: true, degraded_reason: "accessibility_window_identity_unproven" }]) {
      assert.equal(accessibilityFromSnapshot({ ...snapshot, ...mismatch }, { ...target, platform }).status, "unavailable");
    }
  }
  for (const platform of ["linux-x11", "linux-hyprland"] as const) {
    for (const tree_markdown of [
      '- frame = "Another window"\n  - [0] button "Send"',
      `${snapshot.tree_markdown}\n- frame = "Other"\n  - label = "Private"`,
      `${snapshot.tree_markdown}\n- frame = "Draft"\n  - label = "Private"`,
      '- [0] button "No window root"',
    ]) assert.equal(accessibilityFromSnapshot({ ...snapshot, tree_markdown }, { ...target, platform }).status, "unavailable");
  }
});

test("multiline browser labels retain the page subtree on macOS and Linux", () => {
  for (const platform of ["macos", "linux-x11", "linux-hyprland"] as const) {
    const mac = platform === "macos";
    const tree_markdown = [
      mac ? '- AXWindow "Draft"' : '- frame = "Draft"',
      mac ? '  - [0] AXPopUpButton (Extension' : '  - [0] push button "Extension',
      mac ? 'Has access to this site) [actions=[press,showmenu]]' : 'Has access to this site" [actions=[press,showmenu]]',
      mac ? '  - AXWebArea "Page"' : '  - document web = "Page"',
      `    - ${mac ? "AXStaticText" : "label"} = "Page text`,
      'with a second line"',
      `    - ${mac ? "AXSecureTextField" : "password text"} = "secret`,
      'secret-continuation"',
      `    - ${mac ? "AXStaticText" : "label"} = "Below the viewport"`,
      mac ? '- AXMenuBar' : '- menu bar = "Application"',
      mac ? '  - AXMenuItem "Private recent document"' : '  - menu item = "Private recent document"',
    ].join("\n");
    const result = accessibilityFromSnapshot({ ...snapshot, tree_markdown }, { ...target, platform });
    assert.equal(result.status, "captured");
    if (result.status !== "captured") continue;
    assert.match(result.text, /Extension\\nHas access to this site/);
    assert.match(result.text, /Page text\\nwith a second line/);
    assert.match(result.text, /Below the viewport/);
    assert.doesNotMatch(result.text, /actions=|secret|Private recent document/);
  }
});

test("native truncation is reported even when few visited nodes are actionable", () => {
  const result = accessibilityFromSnapshot({
    ...snapshot,
    element_count: 12, total_element_count: 12,
    tree_markdown: `${snapshot.tree_markdown}\n⚠️  AX tree truncated at 400 nodes (app has a very large accessibility tree). Use pixel clicks.`,
  }, target);
  assert.equal(result.status, "captured");
  if (result.status !== "captured") return;
  assert.equal(result.truncated, true);
  assert.doesNotMatch(result.text, /Use pixel clicks|AX tree truncated/);
});

test("long and protected content is bounded before it reaches the main process or prompt", () => {
  const tree_markdown = [
    '- frame = "Draft"',
    '  - [0] password text "Secret" value="do-not-send"',
    '    - label = "secret-child"',
    ...Array.from({ length: 500 }, (_, index) => `  - label = "Line ${index}: ${"a".repeat(2000)}"`),
  ].join("\n");
  const result = accessibilityFromSnapshot({ ...snapshot, tree_markdown }, target);
  assert.equal(result.status, "captured");
  if (result.status !== "captured") return;
  assert.doesNotMatch(result.text, /do-not-send|secret-child/);
  assert.ok(result.text.length <= MAX_SCREENSHOT_CONTEXT_TEXT);
  assert.match(result.text, /Line 0/);
  assert.equal(result.truncated, true);
});

test("the driver read is window-specific, bounded, and skips the duplicate screenshot", async () => {
  const calls: unknown[] = [];
  const result = await snapshotWindowAccessibility({
    async callTool(name, input) {
      calls.push([name, JSON.parse(input)]);
      return { isError: false, structuredJson: JSON.stringify(snapshot) };
    },
  }, target);
  assert.equal(result.status, "captured");
  assert.deepEqual(calls, [["get_window_state", { pid: 324, window_id: target.windowId, include_screenshot: false, max_elements: 2000, max_depth: 50 }]]);
});

test("persisted and external context validates bounded text and real timestamps", () => {
  const context = { version: 1, platform: "macos", app: "Editor", title: "Draft", capturedAt: 123, accessibility: { status: "captured", text: "Content", truncated: false } };
  assert.equal(isScreenshotContext(context), true);
  assert.equal(isScreenshotContext({ ...context, capturedAt: Number.MAX_VALUE }), false);
  assert.equal(isScreenshotContext({ ...context, accessibility: { ...context.accessibility, text: "a".repeat(MAX_SCREENSHOT_CONTEXT_TEXT + 1) } }), false);
  assert.equal(isScreenshotContext({ ...context, accessibility: { status: "unavailable", reason: {} } }), false);
});
