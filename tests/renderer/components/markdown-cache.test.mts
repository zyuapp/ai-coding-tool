import assert from "node:assert/strict";
import React from "react";
import { test, vi } from "vitest";
import { mount } from "../../support/renderer-dom.mts";

/** Every parse attaches GFM once, so the count is how many times Markdown was parsed. */
const parses = vi.hoisted(() => ({ count: 0 }));
vi.mock("remark-gfm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("remark-gfm")>();
  return {
    default: function (this: unknown, ...args: Parameters<typeof actual.default>) {
      parses.count += 1;
      return actual.default.apply(this as never, args);
    },
  };
});

const { MarkdownMessage } = await import("../../../src/renderer/components/MarkdownMessage.tsx");
const { StreamingText } = await import("../../../src/renderer/components/StreamingText.tsx");

async function mountTwice(element: React.ReactElement) {
  const first = await mount(element);
  const html = first.container.innerHTML;
  await first.unmount();
  const second = await mount(element);
  assert.equal(second.container.innerHTML, html, "a remount draws the same document");
  await second.unmount();
}

test("a finished answer is parsed once however often it mounts", async () => {
  const before = parses.count;
  await mountTwice(React.createElement(StreamingText, { committed: "## Cached\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n[docs](https://example.com)" }));
  assert.equal(parses.count - before, 1);
});

test("text that is not marked for caching, or still streaming, is parsed on every mount", async () => {
  let before = parses.count;
  await mountTwice(React.createElement(MarkdownMessage, null, "Uncached **text**."));
  assert.equal(parses.count - before, 2);

  before = parses.count;
  await mountTwice(React.createElement(MarkdownMessage, { animate: true, cache: true, children: "Live words still arriving" }));
  assert.equal(parses.count - before, 2, "an animated document is never kept");

  before = parses.count;
  await mountTwice(React.createElement(StreamingText, { committed: "Settled block.\n\n", tail: "and more", streaming: true }));
  assert.equal(parses.count - before, 4, "a streamed prefix is not kept");
});

test("a cached document keeps the links and HTML handling of a fresh parse", async () => {
  const markdown = "See [a thread](aicodingtool://thread/t9) and [bad](javascript:alert(1)).\n\n<script>bad()</script>";
  const fresh = await mount(React.createElement(MarkdownMessage, null, markdown));
  const html = fresh.container.innerHTML;
  await fresh.unmount();
  await mountTwice(React.createElement(MarkdownMessage, { cache: true, children: markdown }));
  const cached = await mount(React.createElement(MarkdownMessage, { cache: true, children: markdown }));
  assert.equal(cached.container.innerHTML, html);
  assert.equal(cached.container.querySelector("script"), null);
  await cached.unmount();
});
