import assert from "node:assert/strict";
import { test } from "vitest";
import { accessibilityFromSnapshot, snapshotWindowAccessibility, type ScreenshotTarget } from "../../src/main/screenshot-context-snapshot.ts";

const target: ScreenshotTarget = { platform: "macos", pid: 42, windowId: 17, app: "Browser", title: "Page" };

function context(tree_markdown: string, platform = target.platform) {
  return accessibilityFromSnapshot({ pid: 42, window_id: 17, window_title: "Page", tree_markdown, elements: [] }, { ...target, platform });
}

test("ordinary page text about passwords does not hide the page", () => {
  const result = context('- AXWindow "Page"\n  - AXWebArea "Reset your password"\n    - AXStaticText = "Password reset instructions"\n    - AXSecureTextField = "private-value"\n    - AXButton "Continue"');
  assert.equal(result.status, "captured");
  if (result.status !== "captured") return;
  assert.match(result.text, /Password reset instructions/);
  assert.match(result.text, /Continue/);
  assert.doesNotMatch(result.text, /private-value/);
});

test("bulleted text inside an accessibility value cannot end its window subtree", () => {
  for (const platform of ["macos", "linux-x11", "linux-hyprland"] as const) {
    const mac = platform === "macos";
    const result = context([
      mac ? '- AXWindow "Page"' : '- frame = "Page"',
      `  - ${mac ? "AXStaticText" : "label"} = "A checklist:`,
      '- keep this paragraph',
      '- preserve this line too"',
      `  - ${mac ? "AXStaticText" : "label"} = "Content after the checklist"`,
    ].join("\n"), platform);
    assert.equal(result.status, "captured");
    if (result.status !== "captured") continue;
    assert.match(result.text, /keep this paragraph/);
    assert.match(result.text, /Content after the checklist/);
  }
});

test("a dialog nested in a Linux page stays inside the captured window", () => {
  const result = context('- frame = "Page"\n  - document web = "Page"\n    - dialog = "Settings"\n      - label = "Choose your language"', "linux-hyprland");
  assert.equal(result.status, "captured");
  if (result.status === "captured") assert.match(result.text, /Choose your language/);
});

test("a large browser toolbar cannot consume the page's text budget", () => {
  const result = context([
    '- AXWindow "Page"',
    ...Array.from({ length: 200 }, (_, i) => `  - AXButton "Bookmark ${i} with a long accessible description ${"x".repeat(80)}"`),
    '  - AXWebArea "Page"',
    '    - AXStaticText = "The document content the user actually captured"',
  ].join("\n"));
  assert.equal(result.status, "captured");
  if (result.status === "captured") assert.match(result.text, /The document content the user actually captured/);
});

test("typed web-content markers retain page text when the driver omits an unnamed document root", () => {
  const tree_markdown = [
    '- AXWindow "Page"',
    ...Array.from({ length: 150 }, (_, i) => `  - AXButton "Bookmark ${i} ${"x".repeat(100)}"`),
    `  - [200] AXStaticText = "Page with no named web-area wrapper ${"document text ".repeat(120)}"`,
  ].join("\n");
  const result = accessibilityFromSnapshot({ pid: 42, window_id: 17, window_title: "Page", tree_markdown,
    elements: [{ element_index: 200, role: "AXStaticText", in_web_content: true }],
  }, target);
  assert.equal(result.status, "captured");
  if (result.status === "captured") assert.ok(result.text.includes("Page with no named web-area wrapper"));
});

test("numeric control values cannot be mistaken for their element index or name", () => {
  const result = accessibilityFromSnapshot({
    pid: 42, window_id: 17, window_title: "Page",
    tree_markdown: '- AXWindow "Page"\n  - [8] AXSlider "Volume 8"',
    elements: [{ element_index: 8, role: "AXSlider", value: "8" }],
  }, target);
  assert.equal(result.status, "captured");
  if (result.status === "captured") assert.match(result.text, /value="8"/);
});

test("a cold browser tree gets one bounded retry for its page content", async () => {
  let reads = 0;
  const partial: unknown[] = [];
  const result = await snapshotWindowAccessibility({ callTool: async () => ({
    isError: false,
    structuredJson: JSON.stringify({ pid: 42, window_id: 17, window_title: "Page", elements: [],
      tree_markdown: ++reads === 1 ? '- AXWindow "Page"\n  - AXButton' : '- AXWindow "Page"\n  - AXWebArea "Page"\n    - AXStaticText = "Loaded page content"',
    }),
  }) }, target, (snapshot) => partial.push(snapshot));
  assert.equal(reads, 2);
  assert.equal(partial.length, 1);
  assert.equal(result.status, "captured");
  if (result.status === "captured") assert.match(result.text, /Loaded page content/);
});
