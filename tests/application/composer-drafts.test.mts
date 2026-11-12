import assert from "node:assert/strict";
import { test } from "vitest";
import { textAfterSend } from "../../src/application/composer-drafts.ts";

test("a sent draft leaves what was typed after it and what was handed back ahead of it", () => {
  assert.equal(textAfterSend("mine and more", "mine"), "and more");
  assert.equal(textAfterSend("handed back\n\nmine", "mine"), "handed back");
  assert.equal(textAfterSend("handed back\n\nmine and more", "mine"), "handed back\n\nand more");
  assert.equal(textAfterSend("rewritten", "mine"), "rewritten");
});
