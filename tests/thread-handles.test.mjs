import assert from "node:assert/strict";
import test from "node:test";
import { expandThreadHandles, handleTokenAt, rankThreadHandles, threadHandles, threadLink, threadReference, threadSlug } from "../dist/main/domain/thread-handles.js";

function option(id, title, overrides = {}) {
  return { id, title, project: "app", inScope: true, running: false, lastActivityAt: 0, ...overrides };
}

test("a title becomes a short slug, and a title with nothing to slug still names something", () => {
  assert.equal(threadSlug("Sink the mode choices into a track"), "sink-the-mode-choices");
  assert.equal(threadSlug("Widen the dock's resize handle"), "widen-the-docks-resize");
  assert.equal(threadSlug("  "), "thread");
  assert.equal(threadSlug("!!!"), "thread");
});

test("an @ only opens the menu after whitespace, which keeps addresses and emails out", () => {
  assert.deepEqual(handleTokenAt("@sink", 5), { query: "sink", start: 0 });
  assert.deepEqual(handleTokenAt("compare with @si", 16), { query: "si", start: 13 });
  assert.deepEqual(handleTokenAt("@", 1), { query: "", start: 0 });
  assert.equal(handleTokenAt("mail me at zhuocheng@gmail.com", 30), null);
  assert.equal(handleTokenAt("nothing here", 12), null);
  /** The caret behind the token is not in it. */
  assert.equal(handleTokenAt("@sink and more", 14), null);
});

test("a handle qualifies a thread from another project, and a shared slug is broken by id", () => {
  const handles = threadHandles([
    option("t-1", "Sink the mode choices", { lastActivityAt: 3 }),
    option("t-9f2c", "Sink the mode choices", { lastActivityAt: 1 }),
    option("t-3", "Sink the mode choices", { project: "site", inScope: false, lastActivityAt: 2 }),
  ]);

  assert.deepEqual(handles.map((handle) => handle.handle), [
    "sink-the-mode-choices",
    "site/sink-the-mode-choices",
    "sink-the-mode-choices-9f2c",
  ]);
});

test("browsing stays in the project, and a query reaches past it with home rows first", () => {
  const options = threadHandles([
    option("here", "Raise the dock", { lastActivityAt: 2 }),
    option("away", "Raise the panel", { project: "site", inScope: false, lastActivityAt: 3 }),
  ]);

  assert.deepEqual(rankThreadHandles(options, "").map((option) => option.id), ["here"]);
  assert.deepEqual(rankThreadHandles(options, "raise").map((option) => option.id), ["here", "away"]);
  assert.deepEqual(rankThreadHandles(options, "panel").map((option) => option.id), ["away"]);
  assert.deepEqual(rankThreadHandles(options, "nothing").map((option) => option.id), []);
});

test("a handle expands to a link, keeps its punctuation, and is left alone when it names nothing", () => {
  const options = threadHandles([option("t-1", "Sink the mode choices")]);

  assert.equal(
    expandThreadHandles("compare with @sink-the-mode-choices, please", options),
    "compare with [Sink the mode choices](aicodingtool://thread/t-1), please",
  );
  assert.equal(expandThreadHandles("@sink-the-mode-choices", options), "[Sink the mode choices](aicodingtool://thread/t-1)");
  assert.equal(expandThreadHandles("ask @nobody about it", options), "ask @nobody about it");
  assert.equal(expandThreadHandles("mail zhuocheng@gmail.com", options), "mail zhuocheng@gmail.com");
  assert.equal(expandThreadHandles("nothing to expand", options), "nothing to expand");
});

test("a reference reads as the thread's name, and a link without one is still clickable", () => {
  assert.equal(threadReference({ id: "t-1", title: "Sink [the] mode" }), "[Sink the mode](aicodingtool://thread/t-1)");
  assert.equal(threadLink("t-1"), "<aicodingtool://thread/t-1>");
});
