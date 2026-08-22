import assert from "node:assert/strict";
import test from "node:test";
import { markPrefix, promptWithAttachments, taskTitleFor } from "../dist/main/application/attachments.js";

test("prompt is unchanged when nothing is attached", () => {
  assert.equal(promptWithAttachments("Fix the header", []), "Fix the header");
});

test("attachment paths and labels are appended with matching box numbers", () => {
  const prompt = promptWithAttachments("Fix the header", [
    { path: "/tmp/a.png", labels: ["button overlaps", "", "text is clipped"] },
  ]);
  assert.match(prompt, /^Fix the header\n\n/);
  assert.match(prompt, /\/tmp\/a\.png\n {2}1\. button overlaps\n {2}3\. text is clipped$/);
});

test("a lone screenshot's marks carry no letter", () => {
  assert.equal(markPrefix(0, 1), "");
});

test("marks are lettered by screenshot so the same number on two of them stays apart", () => {
  const prompt = promptWithAttachments("Fix these", [
    { path: "/tmp/a.png", labels: ["text 1", "text 2", "text 3"] },
    { path: "/tmp/b.png", labels: ["text 5"] },
  ]);
  assert.match(prompt, /\/tmp\/a\.png \(marks A1–A3\)\n {2}A1\. text 1\n {2}A2\. text 2\n {2}A3\. text 3\n/);
  assert.match(prompt, /\/tmp\/b\.png \(mark B1\)\n {2}B1\. text 5$/);
});

test("a lettered screenshot with no marks of its own says nothing about them", () => {
  const prompt = promptWithAttachments("", [
    { path: "/tmp/a.png", labels: ["only mark"] },
    { path: "/tmp/b.png", labels: [] },
  ]);
  assert.match(prompt, /\/tmp\/a\.png \(mark A1\)\n {2}A1\. only mark\n\/tmp\/b\.png$/);
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
