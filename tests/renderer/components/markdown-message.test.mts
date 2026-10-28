import assert from "node:assert/strict";
import { test, vi } from "vitest";
import React, { act } from "react";
import type { MessageLinkActions } from "../../../src/renderer/components/MarkdownMessage.tsx";
import { isImageSource } from "../../../src/domain/message-artifacts.ts";

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

test("a web link opens externally by default, and its right-click menu opens it either way or copies it", async () => {
  const opened: string[] = [];
  const external: string[] = [];
  const copied: string[] = [];
  const open = vi.spyOn(dom.window, "open").mockImplementation((url) => { external.push(String(url)); return null; });
  Object.defineProperty(dom.window.navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
  const view = await mountMessage("Read https://example.com/docs for the rest.", { openUrlInApp: (url) => opened.push(url) });

  const link = query<HTMLAnchorElement>(view.container, "a");
  assert.equal(link.target, "_blank", "the main process hands an ordinary click to the default browser");
  const menu = async () => {
    await act(async () => { link.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, clientX: 50, clientY: 60 })); });
    return [...document.querySelectorAll<HTMLButtonElement>(".context-menu-popover button")];
  };
  const named = (items: HTMLButtonElement[], label: string) => items.find((item) => item.textContent?.startsWith(label))!;

  const items = await menu();
  assert.deepEqual(items.map((item) => item.textContent?.replace(/(?:⌘|Ctrl\+)Click$/, "")), ["Open in browser", "Open in AI Coding Tool", "Copy link"]);
  await act(async () => { named(items, "Open in AI Coding Tool").click(); });
  assert.deepEqual(opened, ["https://example.com/docs"]);

  await act(async () => { named(await menu(), "Open in browser").click(); });
  assert.deepEqual(external, ["https://example.com/docs"]);

  await act(async () => { named(await menu(), "Copy link").click(); });
  assert.deepEqual(copied, ["https://example.com/docs"]);
  open.mockRestore();
  await view.unmount();
});

test("a web link opens in the browser panel when clicked with the command key held, and stops naming that click once it is used", async () => {
  const { MAC } = await import("../../../src/renderer/platform.ts");
  const opened: string[] = [];
  const view = await mountMessage("Read https://example.com/docs for the rest.", { openUrlInApp: (url) => opened.push(url) });
  const link = query<HTMLAnchorElement>(view.container, "a");
  const click = (held: boolean) => {
    const event = new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, metaKey: held && MAC, ctrlKey: held && !MAC });
    link.dispatchEvent(event);
    return event.defaultPrevented;
  };

  assert.equal(link.dataset.tip, `Open in app (${MAC ? "⌘" : "Ctrl+"}Click)`);
  await act(async () => { assert.equal(click(false), false, "a plain click still goes to the default browser"); });
  assert.deepEqual(opened, []);
  await act(async () => { assert.equal(click(true), true); });
  assert.deepEqual(opened, ["https://example.com/docs"]);
  assert.equal(link.title, "");
  assert.equal(link.dataset.tip, undefined, "once used, the click is named only in the link's menu");
  await view.unmount();
});

test("an old reply previews image links, preserves its text, and enlarges in the app", async () => {
  const opened: string[] = [];
  const text = "Verified. [Screenshot](</tmp/old shot.png>)\n\n[Another][shot]\n\n[shot]: /tmp/second.png";
  const view = await mount(React.createElement(MessageLinkProvider, { actions: { openImage: (source) => opened.push(source) },
    children: React.createElement(MessageArtifactScope.Provider, { value: { root: "/linux/repo", taskId: "remote-thread" } },
      React.createElement(MarkdownMessage, { messageId: "old-message", children: text })) }));
  const images = [...view.container.querySelectorAll("img")];
  assert.equal(images.length, 2);
  const thumbnail = new URL(images[0].src);
  assert.equal(thumbnail.searchParams.get("path"), "/tmp/old shot.png");
  assert.equal(thumbnail.searchParams.get("message"), "old-message");
  assert.equal(thumbnail.searchParams.get("thumbnail"), "1");
  assert.equal(thumbnail.searchParams.get("taskId"), "remote-thread");
  assert.equal(thumbnail.searchParams.get("root"), "/linux/repo");
  assert.equal(images[0].getAttribute("loading"), "lazy");
  await act(async () => query<HTMLButtonElement>(view.container, '[aria-label="Enlarge Screenshot"]').click());
  assert.equal(new URL(opened[0]).searchParams.has("thumbnail"), false);
  assert.equal(new URL(opened[0]).searchParams.get("taskId"), "remote-thread");
  assert.equal(isImageSource(opened[0]), true);
  await act(async () => query<HTMLAnchorElement>(view.container, "a").click());
  assert.equal(opened[1], opened[0]);
  await act(async () => images[1].dispatchEvent(new dom.window.Event("error")));
  assert.match(view.container.textContent, /Another · Preview unavailable/);
  assert.equal(view.container.querySelectorAll("a").length, 2, "a missing preview keeps the original links");
  await view.unmount();
});

test("an image whose preview failed opens as a file instead", async () => {
  const files: Array<[string, number | null]> = [];
  const view = await mount(React.createElement(MessageLinkProvider, { actions: { openImage: () => {}, openFile: (path, line) => files.push([path, line]) },
    children: React.createElement(MarkdownMessage, { messageId: "m", children: "[Shot](/tmp/missing.png)" }) }));
  await act(async () => query(view.container, ".message-image-preview img").dispatchEvent(new dom.window.Event("error")));
  const fallback = query<HTMLButtonElement>(view.container, "button.message-image-unavailable");
  assert.match(fallback.textContent, /Shot · Preview unavailable/);
  await act(async () => { fallback.click(); });
  assert.deepEqual(files, [["/tmp/missing.png", null]]);
  await view.unmount();
});

test("generated artifacts remain visible beside the final answer after work folds away", async () => {
  const { groupTimeline } = await import("../../../src/renderer/timeline/grouping.ts");
  const { TimelineRow } = await import("../../../src/renderer/components/TimelineRow.tsx");
  const messages = [
    { id: "tool", kind: "tool" as const, text: "image_generation", at: 1 },
    { id: "image", kind: "assistant" as const, text: "[Generated image](/tmp/cat.png)", artifact: true as const, at: 2 },
    { id: "answer", kind: "assistant" as const, text: "A pixel art cat.", at: 3 },
  ];
  const opened: string[] = [];
  const groups = groupTimeline(messages, { running: false });
  const view = await mount(React.createElement(MessageLinkProvider, { actions: { openImage: (source) => opened.push(source) }, children: groups.map((group, index) =>
    React.createElement(TimelineRow, { key: group.id, engine: "codex", group, index, offset: 0, newest: false, measure: () => {}, onViewAttachment: () => {} })) }));
  assert.equal(view.container.querySelector("details")?.open, false);
  const image = query<HTMLImageElement>(view.container, "img");
  assert.equal(image.closest("details"), null);
  assert.match(view.container.textContent ?? "", /A pixel art cat/);
  await act(async () => query<HTMLButtonElement>(view.container, '[aria-label="Enlarge Generated image"]').click());
  assert.equal(new URL(opened[0]!).searchParams.get("message"), "image");
  await view.unmount();
});

test("commit hashes the thread's checkout holds open its commit, while other hashes and fenced code stay code", async () => {
  const asked: Array<[string, string[]]> = [];
  window.desktop = { commits: async (workspaceId: string, hashes: string[]) => {
    asked.push([workspaceId, hashes]);
    return hashes.filter((hash) => hash === "60cceb8");
  } } as unknown as typeof window.desktop;
  const opened: Array<[string, string | undefined]> = [];
  const view = await mount(React.createElement(MessageLinkProvider, { actions: { openCommit: (hash, taskId) => opened.push([hash, taskId]) },
    children: React.createElement(MessageArtifactScope.Provider, { value: { root: "/repo", taskId: "old-thread", workspaceId: "commit-checkout" } },
      React.createElement(MarkdownMessage, { children: "Committed as `60cceb8`, and pushed `35995b7` to another repository.\n\n```\n60cceb8\n```" })) }));
  await act(async () => {});
  assert.deepEqual(asked, [["commit-checkout", ["60cceb8", "35995b7"]]], "one read asks about every hash in the reply");
  assert.equal(view.container.querySelectorAll(".message-commit").length, 1);
  await act(async () => query<HTMLButtonElement>(view.container, ".message-commit").click());
  assert.deepEqual(opened, [["60cceb8", "old-thread"]]);
  assert.match(view.container.textContent ?? "", /pushed 35995b7 to/);
  assert.equal(view.container.querySelector("pre code")?.textContent, "60cceb8\n");
  await view.unmount();
});

test("a visual fence becomes a sandboxed frame once it has closed, and an oversized one stays code", async () => {
  const fence = "```visual\n<div id=\"viz-a\">Hi</div>\n```";
  const settled = await mount(React.createElement(MarkdownMessage, null, fence));
  const frame = settled.container.querySelector("iframe");
  assert.equal(frame?.getAttribute("sandbox"), "allow-scripts", "the frame gets scripts and nothing else");
  assert.equal(frame?.getAttribute("src"), "aicodingtool-visual://frame/");
  assert.equal(settled.container.querySelector("pre"), null);
  await settled.unmount();

  const streaming = await mount(React.createElement(MarkdownMessage, { animate: true, children: "```visual\n<div id=\"viz-a\">" }));
  assert.equal(streaming.container.querySelector("iframe"), null, "a fence still being written is not run");
  assert.match(streaming.container.textContent, /Drawing visual/);
  await streaming.unmount();

  const oversized = await mount(React.createElement(MarkdownMessage, null, `\`\`\`visual\n${"x".repeat(1_000_001)}\n\`\`\``));
  assert.equal(oversized.container.querySelector("iframe"), null);
  assert.ok(oversized.container.querySelector("pre code.language-visual"));
  await oversized.unmount();
});

test("a visual that never reports its size shows that it is drawing, then that it failed", async (t) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  t.onTestFinished(() => { vi.useRealTimers(); });
  const { VISUAL_TIMEOUT_MS } = await import("../../../src/renderer/components/VisualBlock.tsx");
  const view = await mount(React.createElement(MarkdownMessage, null, "```visual\n<div id=\"viz-stuck\">Hi</div>\n```"));
  assert.ok(view.container.querySelector("iframe"));
  assert.match(query(view.container, ".visual-loading-over").textContent, /Drawing visual/);
  assert.equal(view.container.querySelector(".visual-error"), null);
  await act(async () => { vi.advanceTimersByTime(VISUAL_TIMEOUT_MS); });
  assert.equal(view.container.querySelector(".visual-loading-over"), null);
  assert.match(query(view.container, ".visual-error").textContent, /did not finish drawing/);
  await view.unmount();
});

test("links into the app and the checkout carry a glyph and name where they go", async () => {
  const markdown = "See [the work](aicodingtool://thread/task-9), [the app](src/App.tsx:42) and [the docs](https://example.com).";
  const view = await mountMessage(markdown, { selectThread: () => {}, openFile: () => {}, openUrlInApp: () => {} });
  const [thread, file, web] = [...view.container.querySelectorAll<HTMLAnchorElement>("a")];
  assert.ok(thread.querySelector(".message-link-glyph"));
  assert.equal(thread.textContent, "the work", "the glyph adds no words to the link");
  assert.ok(file.querySelector(".message-link-glyph"));
  assert.equal(file.dataset.tip, "src/App.tsx:42");
  assert.equal(web.querySelector(".message-link-glyph"), null, "a web link reads as an ordinary link");
  await view.unmount();

  const bare = await mountMessage("Read [the docs](https://example.com).");
  assert.equal(query<HTMLAnchorElement>(bare.container, "a").dataset.tip, undefined, "nothing to open in the app, nothing to name");
  await bare.unmount();
});
