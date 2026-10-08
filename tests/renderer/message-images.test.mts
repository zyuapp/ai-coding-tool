import assert from "node:assert/strict";
import { test } from "vitest";
import { messageImages } from "../../src/application/message-images.ts";

test("image destinations follow Markdown escaping, references, and inline images", () => {
  const text = '[Before](</tmp/before view.png>) ![After](/tmp/after\\(1\\).jpg)\n\n[Again][before]\n\n[before]: </tmp/before view.png>\n\n`[Example](/tmp/example.png)`\n\n[Website](https://example.com/image.png)';
  assert.deepEqual(messageImages(text), [
    { path: "/tmp/before view.png", label: "Before" },
    { path: "/tmp/after(1).jpg", label: "After" },
  ]);
});

test("repeated lookups of the same text return the same image list", () => {
  const text = "[Shot](/tmp/shot.webp)";
  const first = messageImages(text);
  assert.equal(messageImages(text), first);
  const large = `![Big](/tmp/big.png)\n\n${"x".repeat(70 * 1024)}`;
  assert.deepEqual(messageImages(large), [{ path: "/tmp/big.png", label: "Big" }]);
  assert.deepEqual(messageImages(large), [{ path: "/tmp/big.png", label: "Big" }]);
});
