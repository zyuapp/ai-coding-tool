import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce } from "../../src/application/workspace-reducer.ts";
import { attachmentSendFor } from "../../src/application/composer-attachments.ts";
import { MAX_ATTACHMENTS, type OutgoingAttachment } from "../../src/domain/conversation.ts";
import { effectAt, run, workspace } from "./workspace-reducer-fixtures.mts";

function image(id: string, path?: string): OutgoingAttachment {
  return { id, source: "data:image/png;base64,AQID", annotations: [], ...(path === undefined ? {} : { path }) };
}

const drafted = () => run(workspace(), [{ type: "view.set-prompt", prompt: "Look at this" }]);

test("a send writes the composer's images out before the run that carries them starts", () => {
  const sending = reduce(drafted(), { type: "attachments.send", attachments: [image("one"), image("two", "/tmp/shot.png")] });

  assert.deepEqual(sending.effects, [{ type: "send-attachments", attachments: [image("one"), image("two", "/tmp/shot.png")] }]);
  assert.equal(attachmentSendFor(sending.state.attachmentSends).busy, true);
  assert.deepEqual(sending.state.pendingRuns, {}, "nothing is started while the images are being written");

  const written = reduce(sending.state, {
    type: "attachments.saved",
    ids: ["one", "two"],
    attachments: [{ path: "/tmp/one.png", labels: [] }, { path: "/tmp/shot.png", labels: [] }],
  });

  const send = attachmentSendFor(written.state.attachmentSends);
  assert.equal(send.busy, false);
  assert.deepEqual(send.sent, ["one", "two"], "the strip is told which images left with the message");
  const started = reduce(written.state, { type: "run.resolved", pendingId: effectAt(written, "resolve-run-workspace").pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });
  assert.deepEqual(started.state.threads[0].messages[0].attachments, ["/tmp/one.png", "/tmp/shot.png"]);
});

test("a send with no images of its own starts the run without writing anything out", () => {
  const sending = reduce(drafted(), { type: "attachments.send", attachments: [] });

  assert.equal(sending.effects.some((effect) => effect.type === "send-attachments"), false);
  assert.equal(effectAt(sending, "resolve-run-workspace").picker, false);
});

test("more images than one message may carry stop the send and say so", () => {
  const tooMany = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_unused, at) => image(`image-${at}`));

  const refused = reduce(drafted(), { type: "attachments.send", attachments: tooMany });

  assert.deepEqual(refused.effects, []);
  assert.equal(attachmentSendFor(refused.state.attachmentSends).error, `You can attach up to ${MAX_ATTACHMENTS} images.`);
  assert.deepEqual(refused.state.pendingRuns, {});
});

test("a second send cannot start on top of the images the first is still writing", () => {
  const sending = reduce(drafted(), { type: "attachments.send", attachments: [image("one")] });

  const again = reduce(sending.state, { type: "attachments.send", attachments: [image("one")] });

  assert.equal(again.state, sending.state);
  assert.deepEqual(again.effects, []);
});

test("an image that could not be written stops the send and gives the composer back", () => {
  const sending = reduce(drafted(), { type: "attachments.send", attachments: [image("one")] });

  const failed = reduce(sending.state, { type: "attachments.failed", message: "The disk is full." });

  const send = attachmentSendFor(failed.state.attachmentSends);
  assert.equal(send.busy, false);
  assert.equal(send.error, "The disk is full.");
  assert.deepEqual(send.sent, [], "nothing left, so the strip keeps every image");
  assert.deepEqual(failed.state.pendingRuns, {});
});

test("a side chat's images are its own, and so is what the strip has to say about them", () => {
  const state = drafted();

  const noticed = reduce(state, { type: "attachments.notice", taskId: "chat", message: "Wait for the screenshots to finish loading." });

  assert.equal(attachmentSendFor(noticed.state.attachmentSends, "chat").error, "Wait for the screenshots to finish loading.");
  assert.equal(attachmentSendFor(noticed.state.attachmentSends).error, null);
  assert.equal(reduce(noticed.state, { type: "attachments.notice", taskId: "chat", message: "Wait for the screenshots to finish loading." }).state, noticed.state);
});
