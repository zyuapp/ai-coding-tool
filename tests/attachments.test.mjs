import assert from "node:assert/strict";
import test from "node:test";
import { promptWithAttachments, taskTitleFor } from "../dist/main/application/attachments.js";

test("prompt is unchanged when nothing is attached", () => {
  assert.equal(promptWithAttachments("Fix the header", []), "Fix the header");
});

test("attachment paths and labels are appended with matching box numbers", () => {
  const prompt = promptWithAttachments("Fix the header", [
    { path: "/tmp/a.png", labels: ["button overlaps", "", "text is clipped"] },
    { path: "/tmp/b.png", labels: [] },
  ]);
  assert.match(prompt, /^Fix the header\n\n/);
  assert.match(prompt, /\/tmp\/a\.png\n {2}1\. button overlaps\n {2}3\. text is clipped\n\/tmp\/b\.png$/);
});

test("an image-only send still produces a prompt", () => {
  assert.equal(
    promptWithAttachments("", [{ path: "/tmp/a.png", labels: [] }]).startsWith("Attached screenshots"),
    true,
  );
});

test("title falls back to the attachment count when there is no text", () => {
  assert.equal(taskTitleFor("", [{ path: "/tmp/a.png", labels: [] }]), "Screenshot");
  assert.equal(taskTitleFor("", [{ path: "/a.png", labels: [] }, { path: "/b.png", labels: [] }]), "2 screenshots");
  assert.equal(taskTitleFor("Fix it", [{ path: "/a.png", labels: [] }]), "Fix it");
});
