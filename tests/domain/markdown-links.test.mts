import assert from "node:assert/strict";
import { test } from "vitest";
import { parseFileHref } from "../../src/domain/markdown-links.ts";

test("a file URL names the same file as its bare path", () => {
  assert.deepEqual(parseFileHref("file:///tmp/mock%20up.html"), { file: "/tmp/mock up.html", line: null });
  assert.deepEqual(parseFileHref("file://localhost/tmp/app.ts:12"), { file: "/tmp/app.ts", line: 12 });
  assert.deepEqual(parseFileHref("file:///C:/work/page.html"), { file: "C:/work/page.html", line: null });
});

test("a web link is not a file", () => {
  assert.equal(parseFileHref("https://example.com/page.html"), null);
  assert.equal(parseFileHref("file://server/share/page.html"), null);
});
