import assert from "node:assert/strict";
import { test } from "vitest";
import { parseServeArguments } from "../../src/main/serve.ts";

test("a source checkout can serve the installed app's data, and pair against it", () => {
  assert.deepEqual(parseServeArguments(["serve", "--dev", "--installed"]), { command: "serve", dev: true, installed: true, local: false });
  assert.deepEqual(parseServeArguments(["pair", "--dev", "--installed"]), { command: "pair", dev: true, installed: true, local: false });
  assert.deepEqual(parseServeArguments(["serve", "--dev", "--local", "--port", "0"]), { command: "serve", dev: true, installed: false, local: true, port: 0 });
});
