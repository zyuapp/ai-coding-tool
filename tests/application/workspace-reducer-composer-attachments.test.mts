import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce } from "../../src/application/workspace-reducer.ts";
import { attachmentSendFor } from "../../src/application/composer-attachments.ts";
import { imagesFor } from "../../src/application/composer-drafts.ts";
import { NEW_THREAD_DRAFT } from "../../src/application/state/composer.ts";
import { MAX_ATTACHMENTS, type OutgoingAttachment } from "../../src/domain/conversation.ts";
import { effectAt, run, task, workspace } from "./workspace-reducer-fixtures.mts";

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

test("a phone's images carry its own words, leaving whatever the desktop's composer holds", () => {
  const sending = reduce(drafted(), { type: "attachments.send", text: "From my phone", attachments: [image("one")] });
  assert.deepEqual(sending.effects, [{ type: "send-attachments", text: "From my phone", attachments: [image("one")] }]);

  const written = reduce(sending.state, { type: "attachments.saved", text: "From my phone", ids: ["one"], attachments: [{ path: "/tmp/one.jpg", labels: [] }] });
  const started = reduce(written.state, { type: "run.resolved", pendingId: effectAt(written, "resolve-run-workspace").pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });
  const sent = started.state.threads[0].messages[0];
  assert.equal(sent.text, "From my phone");
  assert.deepEqual(sent.attachments, ["/tmp/one.jpg"]);
});

const projectless = { id: "projectless", kind: "projectless", root: "/tmp" } as const;

function stagedSend(writtenTo: string) {
  const state = run(drafted(), [{ type: "image.add", path: "/tmp/shot.png", label: "Shot" }]);
  const id = imagesFor(state, NEW_THREAD_DRAFT)[0]!.id;
  const sending = reduce(state, { type: "attachments.send", attachments: [image(id, "/tmp/shot.png")] });
  return reduce(sending.state, { type: "attachments.saved", ids: [id], attachments: [{ path: writtenTo, labels: [] }] });
}

for (const [kind, writtenTo] of [["unmarked", "/tmp/shot.png"], ["marked", "/tmp/marked-copy.png"]] as const) {
  test(`a staged ${kind} image leaves the draft once the run that carries it starts`, () => {
    const written = stagedSend(writtenTo);
    assert.equal(imagesFor(written.state, NEW_THREAD_DRAFT).length, 1, "the draft holds it until the run starts");

    const started = reduce(written.state, { type: "run.resolved", pendingId: effectAt(written, "resolve-run-workspace").pendingId, workspace: projectless });

    assert.deepEqual(imagesFor(started.state, NEW_THREAD_DRAFT), []);
    assert.deepEqual(started.state.threads[0].messages[0].attachments, [writtenTo]);
  });
}

test("a staged image stays in the draft when its run cannot start", () => {
  const written = stagedSend("/tmp/marked-copy.png");

  const dropped = reduce(written.state, { type: "run.unresolved", pendingId: effectAt(written, "resolve-run-workspace").pendingId, message: "No folder." });

  assert.deepEqual(imagesFor(dropped.state, NEW_THREAD_DRAFT).map((item) => item.path), ["/tmp/marked-copy.png"]);
});

test("a second send cannot start while the first is waiting on its run", () => {
  const written = stagedSend("/tmp/marked-copy.png");

  const again = reduce(written.state, { type: "attachments.send", attachments: [image("two")] });

  assert.equal(again.state, written.state);
  assert.deepEqual(again.effects, []);
});

test("a send with no images of its own starts the run without writing anything out", () => {
  const sending = reduce(drafted(), { type: "attachments.send", attachments: [] });

  assert.equal(sending.effects.some((effect) => effect.type === "send-attachments"), false);
  assert.equal(effectAt(sending, "resolve-run-workspace").picker, false);
});

test("more images than one message may carry stop the send and say so", () => {
  const tooMany = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_unused, at) => image(`image-${at}`));

  const refused = reduce(drafted(), { type: "attachments.send", attachments: tooMany });

  assert.equal(refused.result?.ok, false);
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

  assert.deepEqual(failed.result, { ok: false, message: "The disk is full." });
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

test("images written after the composer moved to another thread still go to the thread they left from", () => {
  const base = { ...workspace(), threads: [task("task-a"), task("task-b")], currentId: "task-a" };
  const drafted = run(base, [{ type: "view.set-prompt", prompt: "For A" }]);
  const sending = reduce(drafted, { type: "attachments.send", attachments: [image("one")] });
  const moved = reduce(sending.state, { type: "task.select", taskId: "task-b" }).state;

  const written = reduce(moved, { type: "attachments.saved", ids: ["one"], attachments: [{ path: "/tmp/one.png", labels: [] }] });
  const pending = Object.values(written.state.pendingRuns).map(({ taskId, draftKey, text, attachments }) => ({ taskId, draftKey, text, attachments }));
  assert.deepEqual(pending, [{ taskId: "task-a", draftKey: "task-a", text: "For A", attachments: ["/tmp/one.png"] }], "nothing is sent from task-b");
  assert.deepEqual(attachmentSendFor(written.state.attachmentSends).sent, ["one"]);
});

test("images written after the composer left the new-thread draft wait there and say so", () => {
  const base = { ...workspace(), threads: [task("task-b")], currentId: null };
  const drafted = run(base, [{ type: "view.set-prompt", prompt: "A new thread" }]);
  const sending = reduce(drafted, { type: "attachments.send", attachments: [image("one")] });
  const moved = reduce(sending.state, { type: "task.select", taskId: "task-b" }).state;

  const written = reduce(moved, { type: "attachments.saved", ids: ["one"], attachments: [{ path: "/tmp/one.png", labels: [] }] });
  assert.equal(written.result?.ok, false);
  assert.equal(attachmentSendFor(written.state.attachmentSends).busy, false);
  assert.deepEqual(attachmentSendFor(written.state.attachmentSends).sent, [], "the strip keeps the image to send again");
  assert.equal(written.state.prompts[NEW_THREAD_DRAFT], "A new thread");
  assert.equal(written.state.threads[0]!.messages.length, 0);
});
