import assert from "node:assert/strict";
import React, { act } from "react";
import { test, vi } from "vitest";
import { mount } from "../../support/renderer-dom.mts";
import { fakeDesktop } from "../../support/desktop-api.mts";
import { settleUntil } from "../../support/settle.mts";
import { useComposerAttachments, type ComposerAttachments } from "../../../src/renderer/components/ComposerAttachments.tsx";
import type { RunAttachment, StagedImage } from "../../../src/domain/conversation.ts";
import type { ScreenshotContext } from "../../../src/domain/screenshot-context.ts";

vi.mock("../../../src/renderer/components/ImageAnnotator.tsx", () => ({ ImageAnnotator: () => null, renderAnnotatedSource: async () => "data:image/png;base64,AQID" }));

const context: ScreenshotContext = { version: 1, platform: "linux-hyprland", app: "Editor", title: "Draft", capturedAt: 123, accessibility: { status: "captured", text: "Document ready", truncated: false } };

test("annotating and recalling a screenshot preserves its context and original capture time", async () => {
  const saved: Array<{ data: string; original?: string }> = [];
  const reads: string[] = [];
  window.desktop = fakeDesktop({
    readAttachmentContext: async (path) => { reads.push(path); return context; },
    saveAttachment: async (data, original) => { saved.push({ data, original }); return "/tmp/annotated.png"; },
  });
  let controller: ComposerAttachments;
  function Harness({ images }: { images: StagedImage[] }) {
    controller = useComposerAttachments(images);
    return null;
  }
  const view = await mount(React.createElement(Harness, { images: [{ id: "shot", path: "/tmp/shot.png", label: "Editor" }] }));
  await settleUntil(() => controller.items.length === 1);
  await act(async () => controller.applyAnnotations("shot", [{ kind: "box", x: 0.1, y: 0.1, width: 0.3, height: 0.2, text: "Fix this" }], "data:image/png;base64,AQID"));
  let sent: RunAttachment[] = [];
  await act(async () => controller.send((attachments) => { sent = attachments; }, false));
  assert.deepEqual(saved, [{ data: "AQID", original: "/tmp/shot.png" }]);
  assert.deepEqual(sent, [{ path: "/tmp/annotated.png", labels: ["Fix this"], context }]);
  await view.render(React.createElement(Harness, { images: [{ id: "recalled", path: "/tmp/annotated.png", label: "" }] }));
  await settleUntil(() => controller.items.length === 1);
  await act(async () => controller.send((attachments) => { sent = attachments; }, false));
  assert.deepEqual(sent, [{ path: "/tmp/annotated.png", labels: [], context }]);
  assert.deepEqual(reads, ["/tmp/shot.png", "/tmp/annotated.png"]);
  assert.equal(saved.length, 1, "recalling does not replace the capture or resave its pixels");
  await view.unmount();
});

test("an unavailable metadata read never prevents attaching or sending the image", async () => {
  window.desktop = fakeDesktop({ readAttachmentContext: async () => { throw new Error("Unavailable"); } });
  let controller: ComposerAttachments;
  const images = [{ id: "shot", path: "/tmp/shot.png", label: "Editor" }];
  function Harness() { controller = useComposerAttachments(images); return null; }
  const view = await mount(React.createElement(Harness));
  await settleUntil(() => controller.items.length === 1);
  let sent: RunAttachment[] = [];
  await act(async () => controller.send((attachments) => { sent = attachments; }, false));
  assert.deepEqual(sent, [{ path: "/tmp/shot.png", labels: [] }]);
  await view.unmount();
});
