import assert from "node:assert/strict";
import { test } from "vitest";
import type { EffectHost } from "../../src/host/effect-host.ts";
import { runEffects } from "../../src/host/run-effects.ts";

function host(preserved: unknown[][]) {
  return { desktop: { preserveMessageImages: async (...args: unknown[]) => { preserved.push(args); } } } as unknown as EffectHost;
}

test("a message's local images are preserved under it, and a message without any asks for nothing", async () => {
  const preserved: unknown[][] = [];
  await runEffects["preserve-message-images"]({ type: "preserve-message-images", text: "See [Shot](/tmp/shot.png).", root: "/repo", messageId: "answer" }, host(preserved));
  await runEffects["preserve-message-images"]({ type: "preserve-message-images", text: "No images here.", root: "/repo", messageId: "plain" }, host(preserved));
  assert.deepEqual(preserved, [[["/tmp/shot.png"], "/repo", "answer"]]);
});
