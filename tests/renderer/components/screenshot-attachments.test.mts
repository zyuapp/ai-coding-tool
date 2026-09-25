import assert from "node:assert/strict";
import React, { act } from "react";
import { test, vi } from "vitest";
import { mount } from "../../support/renderer-dom.mts";
import { fakeDesktop } from "../../support/desktop-api.mts";
import { settleUntil } from "../../support/settle.mts";
import { useComposerAttachments, type ComposerAttachments } from "../../../src/renderer/components/ComposerAttachments.tsx";
import { useSavingOutbox } from "../../support/composer-outbox.mts";
import type { RunAttachment, StagedImage } from "../../../src/domain/conversation.ts";
import type { ScreenshotContext } from "../../../src/domain/screenshot-context.ts";

vi.mock("../../../src/renderer/components/ImageAnnotator.tsx", () => ({ ImageAnnotator: () => null }));
vi.mock("../../../src/renderer/annotate/marks.ts", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  renderAnnotatedSource: async () => "data:image/png;base64,AQID",
}));

const context: ScreenshotContext = { version: 1, platform: "linux-hyprland", app: "Editor", title: "Draft", capturedAt: 123, accessibility: { status: "captured", text: "Document ready", truncated: false } };

test("annotating and recalling a screenshot preserves its context and original capture time", async () => {
  const saved: Array<{ data: string; original?: string }> = [];
  const reads: string[] = [];
  window.desktop = fakeDesktop({
    readAttachmentContext: async (path) => { reads.push(path); return context; },
    saveAttachment: async (data, original) => { saved.push({ data, original }); return "/tmp/annotated.png"; },
  });
  let controller: ComposerAttachments;
  let sent: RunAttachment[] = [];
  function Harness({ images }: { images: StagedImage[] }) {
    controller = useComposerAttachments(images, useSavingOutbox((attachments) => { sent = attachments; }));
    return null;
  }
  const view = await mount(React.createElement(Harness, { images: [{ id: "shot", path: "/tmp/shot.png", label: "Editor" }] }));
  await settleUntil(() => controller.items.length === 1);
  await act(async () => controller.applyAnnotations("shot", [{ kind: "box", x: 0.1, y: 0.1, width: 0.3, height: 0.2, text: "Fix this" }], "data:image/png;base64,AQID"));
  await act(async () => controller.send(false));
  assert.deepEqual(saved, [{ data: "AQID", original: "/tmp/shot.png" }]);
  assert.deepEqual(sent, [{ path: "/tmp/annotated.png", labels: ["Fix this"], context }]);
  await view.render(React.createElement(Harness, { images: [{ id: "recalled", path: "/tmp/annotated.png", label: "" }] }));
  await settleUntil(() => controller.items.length === 1);
  await act(async () => controller.send(false));
  assert.deepEqual(sent, [{ path: "/tmp/annotated.png", labels: [], context }]);
  assert.deepEqual(reads, ["/tmp/shot.png", "/tmp/annotated.png"]);
  assert.equal(saved.length, 1, "recalling does not replace the capture or resave its pixels");
  await view.unmount();
});

test("an unavailable metadata read never prevents attaching or sending the image", async () => {
  window.desktop = fakeDesktop({ readAttachmentContext: async () => { throw new Error("Unavailable"); } });
  let controller: ComposerAttachments;
  const images = [{ id: "shot", path: "/tmp/shot.png", label: "Editor" }];
  let sent: RunAttachment[] = [];
  function Harness() { controller = useComposerAttachments(images, useSavingOutbox((attachments) => { sent = attachments; })); return null; }
  const view = await mount(React.createElement(Harness));
  await settleUntil(() => controller.items.length === 1);
  await act(async () => controller.send(false));
  assert.deepEqual(sent, [{ path: "/tmp/shot.png", labels: [] }]);
  await view.unmount();
});

test("a second capture arriving during the first context read retains both screenshots", async () => {
  const pending = new Map<string, (value: ScreenshotContext) => void>();
  window.desktop = fakeDesktop({ readAttachmentContext: (path) => new Promise((resolve) => pending.set(path, resolve)) });
  let controller!: ComposerAttachments;
  let sent: RunAttachment[] = [];
  function Harness({ images }: { images: StagedImage[] }) { controller = useComposerAttachments(images, useSavingOutbox((attachments) => { sent = attachments; })); return null; }
  const first = { id: "first", path: "/tmp/first.png", label: "First" };
  const second = { id: "second", path: "/tmp/second.png", label: "Second" };
  const view = await mount(React.createElement(Harness, { images: [first] }));
  try {
    await view.render(React.createElement(Harness, { images: [first, second] }));
    await act(async () => {
      pending.get(first.path)!(context);
      pending.get(second.path)!({ ...context, title: "Second" });
    });
    assert.deepEqual(controller.items.map((image) => image.id), ["first", "second"]);
    await act(async () => controller.send(false));
    assert.deepEqual(sent.map(({ path, context }) => [path, context?.title]), [[first.path, "Draft"], [second.path, "Second"]]);
  } finally {
    await view.unmount();
  }
});

test("sending during metadata loading cannot silently omit the staged screenshot", async () => {
  let resolve!: (value: ScreenshotContext) => void;
  window.desktop = fakeDesktop({ readAttachmentContext: () => new Promise((done) => { resolve = done; }) });
  let controller!: ComposerAttachments;
  const images = [{ id: "shot", path: "/tmp/shot.png", label: "Capture" }];
  const sends: RunAttachment[][] = [];
  function Harness() { controller = useComposerAttachments(images, useSavingOutbox((attachments) => sends.push(attachments))); return null; }
  const view = await mount(React.createElement(Harness));
  try {
    assert.equal(controller.sending, true);
    await act(async () => controller.send(false));
    assert.equal(sends.length, 0);
    await act(async () => resolve(context));
    assert.equal(controller.sending, false);
    assert.equal(controller.error, null);
    await act(async () => controller.send(false));
    assert.deepEqual(sends, [[{ path: "/tmp/shot.png", labels: [], context }]]);
  } finally { await view.unmount(); }
});

test("changing threads while context loads cannot restore an old thread's screenshot", async () => {
  const pending = new Map<string, Array<(value: ScreenshotContext) => void>>();
  window.desktop = fakeDesktop({ readAttachmentContext: (path) => new Promise((resolve) => pending.set(path, [...(pending.get(path) ?? []), resolve])) });
  let controller!: ComposerAttachments;
  function Harness({ images }: { images: StagedImage[] }) { controller = useComposerAttachments(images, useSavingOutbox(() => {})); return null; }
  const first = { id: "first", path: "/tmp/first.png", label: "First" };
  const second = { id: "second", path: "/tmp/second.png", label: "Second" };
  const view = await mount(React.createElement(React.StrictMode, null, React.createElement(Harness, { images: [first] })));
  try {
    await view.render(React.createElement(React.StrictMode, null, React.createElement(Harness, { images: [second] })));
    await act(async () => {
      for (const resolve of pending.get(second.path) ?? []) resolve({ ...context, title: "Second" });
      for (const resolve of pending.get(first.path) ?? []) resolve(context);
    });
    assert.deepEqual(controller.items.map(({ id, context }) => [id, context?.title]), [["second", "Second"]]);
  } finally { await view.unmount(); }
});
