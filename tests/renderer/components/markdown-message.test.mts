import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import type { MessageLinkActions } from "../../../src/renderer/components/MarkdownMessage.tsx";

import { dom, mount, query } from "../../support/renderer-dom.mts";

const { MarkdownMessage, MessageLinkProvider, MessageArtifactScope } = await import("../../../src/renderer/components/MarkdownMessage.tsx");

test("assistant markdown renders GFM without executing raw HTML", async () => {
  const view = await mount(React.createElement(MarkdownMessage, null, "## Heading\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n- [x] Done\n\n```typescript\nconst first = 1;\n\nconst second = 2;\n```\n\n<script>bad()</script>"));

  assert.equal(view.container.querySelector("h2")?.textContent, "Heading");
  assert.match(view.container.querySelector("pre code.language-typescript")?.textContent ?? "", /first = 1;\n\nconst second = 2;/);
  assert.equal(view.container.querySelector("table td")?.textContent, "1");
  assert.equal(view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked, true);
  assert.equal(view.container.querySelector("script"), null);
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
  const view = await mountMessage(markdown, { selectThread: (taskId) => selected.push(taskId) });

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

test("an old reply previews image links, preserves its text, and enlarges in the app", async () => {
  const opened: string[] = [];
  const text = "Verified. [Screenshot](</tmp/old shot.png>)\n\n[Another][shot]\n\n[shot]: /tmp/second.png";
  const view = await mount(React.createElement(MessageLinkProvider, { actions: { openImage: (source) => opened.push(source) },
    children: React.createElement(MarkdownMessage, { messageId: "old-message", children: text }) }));
  const images = [...view.container.querySelectorAll("img")];
  assert.equal(images.length, 2);
  const thumbnail = new URL(images[0].src);
  assert.equal(thumbnail.searchParams.get("path"), "/tmp/old shot.png");
  assert.equal(thumbnail.searchParams.get("message"), "old-message");
  assert.equal(thumbnail.searchParams.get("thumbnail"), "1");
  assert.equal(images[0].getAttribute("loading"), "lazy");
  await act(async () => query<HTMLButtonElement>(view.container, '[aria-label="Enlarge Screenshot"]').click());
  assert.equal(new URL(opened[0]).searchParams.has("thumbnail"), false);
  await act(async () => query<HTMLAnchorElement>(view.container, "a").click());
  assert.equal(opened[1], opened[0]);
  await act(async () => images[1].dispatchEvent(new dom.window.Event("error")));
  assert.match(view.container.textContent, /Another · Preview unavailable/);
  assert.equal(view.container.querySelectorAll("a").length, 2, "a missing preview keeps the original links");
  await view.unmount();
});

test("commit hashes in inline code open that transcript's commit, while fenced code stays code", async () => {
  const opened: Array<[string, string | undefined]> = [];
  const view = await mount(React.createElement(MessageLinkProvider, { actions: { openCommit: (hash, taskId) => opened.push([hash, taskId]) },
    children: React.createElement(MessageArtifactScope.Provider, { value: { root: "/repo", taskId: "old-thread" } },
      React.createElement(MarkdownMessage, { children: "Committed as `60cceb8`.\n\n```\n60cceb8\n```" })) }));
  assert.equal(view.container.querySelectorAll(".message-commit").length, 1);
  await act(async () => query<HTMLButtonElement>(view.container, ".message-commit").click());
  assert.deepEqual(opened, [["60cceb8", "old-thread"]]);
  assert.equal(view.container.querySelector("pre code")?.textContent, "60cceb8\n");
  await view.unmount();
});
