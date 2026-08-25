import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import type { MessageLinkActions } from "../../../src/renderer/components/MarkdownMessage.tsx";

import { dom, mount, query } from "../../support/renderer-dom.mts";

const { MarkdownMessage, MessageLinkProvider } = await import("../../../src/renderer/components/MarkdownMessage.tsx");

test("assistant markdown renders GFM without executing raw HTML", async () => {
  const view = await mount(React.createElement(MarkdownMessage, null, "## Heading\n\n**Bold**\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n- [x] Done\n\n<script>bad()</script>"));

  assert.equal(view.container.querySelector("h2")?.textContent, "Heading");
  assert.equal(view.container.querySelector("strong")?.textContent, "Bold");
  assert.equal(view.container.querySelector("table td")?.textContent, "1");
  assert.equal(view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked, true);
  assert.equal(view.container.querySelector("script"), null);
  await view.unmount();
});

test("assistant markdown preserves nested, quoted, linked, and fenced structures", async () => {
  const markdown = [
    "> **Quoted** guidance",
    ">",
    "> - Parent",
    ">   - Child",
    "",
    "A [safe link](https://example.com) and ~~obsolete text~~.",
    "",
    "```typescript",
    "const first = 1;",
    "",
    "const second = 2;",
    "```",
  ].join("\n");
  const view = await mount(React.createElement(MarkdownMessage, null, markdown));

  assert.equal(view.container.querySelector("blockquote strong")?.textContent, "Quoted");
  assert.equal(view.container.querySelector("blockquote ul ul li")?.textContent, "Child");
  assert.equal(view.container.querySelector("a")?.target, "_blank");
  assert.equal(view.container.querySelector("a")?.rel, "noreferrer");
  assert.equal(view.container.querySelector("del")?.textContent, "obsolete text");
  assert.match(view.container.querySelector("pre code.language-typescript")?.textContent ?? "", /first = 1;\n\nconst second = 2;/);
  await view.unmount();
});

function mountMessage(markdown: string, actions: MessageLinkActions = {}) {
  return mount(React.createElement(MessageLinkProvider, { actions, children: React.createElement(MarkdownMessage, null, markdown) }));
}

test("a thread link opens that thread in place, and nothing else under the scheme is a link", async () => {
  const selected: string[] = [];
  const markdown = [
    "See [the sidebar work](aicodingtool://thread/task-9) for how it went.",
    "",
    "Not [an archive](aicodingtool://archive/task-9) and not [the docs](https://example.com).",
  ].join("\n");
  const view = await mountMessage(markdown, { selectTask: (taskId) => selected.push(taskId) });

  const links = [...view.container.querySelectorAll("a")];
  assert.deepEqual(links.map((link) => link.textContent), ["the sidebar work", "the docs"], "an unknown aicodingtool:// path stays plain text");
  assert.match(view.container.textContent, /Not an archive and not the docs/);

  await act(async () => { links[0].click(); });
  assert.deepEqual(selected, ["task-9"]);
  assert.equal(links[0].target, "", "an in-app link does not open a browser tab");

  await act(async () => { links[1].click(); });
  assert.deepEqual(selected, ["task-9"], "an ordinary link still just follows its href");
  assert.equal(links[1].target, "_blank");
  await view.unmount();
});

test("a thread link is plain text where no thread can be selected", async () => {
  const view = await mountMessage("See [the sidebar work](aicodingtool://thread/task-9).");

  assert.equal(view.container.querySelector("a"), null);
  assert.match(view.container.textContent, /See the sidebar work\./);
  await view.unmount();
});

test("only Markdown file links open a file, at the line they name", async () => {
  const opened: Array<[string, number | null]> = [];
  const markdown = [
    "Plain src/renderer/App.tsx:42 and `AGENTS.md` stay plain.",
    "",
    "Open [the app](/checkout/src/renderer/App.tsx:42), [the notes](docs/My%20Notes.md:7:3) or [the readme](README.md).",
  ].join("\n");
  const view = await mountMessage(markdown, { openFile: (path, line) => opened.push([path, line]) });

  const links = [...view.container.querySelectorAll("a")];
  assert.deepEqual(links.map((link) => link.textContent), ["the app", "the notes", "the readme"]);
  assert.match(view.container.textContent, /Plain src\/renderer\/App\.tsx:42 and AGENTS\.md stay plain\./);

  for (const link of links) await act(async () => { link.click(); });
  assert.deepEqual(opened, [
    ["/checkout/src/renderer/App.tsx", 42],
    ["docs/My Notes.md", 7],
    ["README.md", null],
  ], "the line comes through separately, and the column is dropped");
  await view.unmount();
});

test("a web link opens externally by default and offers the browser panel on right click", async () => {
  const opened: string[] = [];
  const view = await mountMessage("Read https://example.com/docs for the rest.", { openUrlInApp: (url) => opened.push(url) });

  const link = query<HTMLAnchorElement>(view.container, "a");
  assert.equal(link.target, "_blank", "the main process hands an ordinary click to the default browser");
  await act(async () => { link.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, clientX: 50, clientY: 60 })); });
  const menuItem = query<HTMLButtonElement>(document, ".context-menu-popover button");
  assert.equal(menuItem.textContent, "Open in AI Coding Tool");
  await act(async () => { menuItem.click(); });
  assert.deepEqual(opened, ["https://example.com/docs"]);
  await view.unmount();
});
