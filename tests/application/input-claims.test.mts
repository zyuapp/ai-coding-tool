import assert from "node:assert/strict";
import { test } from "vitest";

import { apply, CLAIMS } from "../../src/application/workspace-reducer/dispatch.ts";
import { reduceCli } from "../../src/application/workspace-reducer/cli.ts";
import { reduceSideChats } from "../../src/application/workspace-reducer/side-chats.ts";
import { isComputerInput } from "../../src/application/computer-commands.ts";
import { isEngineInput } from "../../src/application/engine-access.ts";
import { isRemoteInput } from "../../src/application/remote-commands.ts";
import { emptyWorkspaceState } from "../../src/application/workspace-state.ts";

test("every input type is claimed by one reducer only", () => {
  const owners = new Map<string, number>();
  CLAIMS.forEach(({ types }, index) => {
    for (const type of types) {
      assert.equal(owners.has(type), false, `${type} is claimed twice`);
      owners.set(type, index);
    }
  });
});

test("no claimed input belongs to a family answered before the claims", () => {
  for (const { types } of CLAIMS) {
    for (const type of types) {
      assert.equal(isRemoteInput({ type }) || isComputerInput({ type }) || isEngineInput({ type }), false, type);
    }
  }
});

test("an input reaches the reducer that claims it", () => {
  const state = emptyWorkspaceState();
  assert.deepEqual(apply(state, { type: "cli.read" }), reduceCli(state, { type: "cli.read" }));
  assert.deepEqual(apply(state, { type: "side-chat.close", chatId: "c1" }), reduceSideChats(state, { type: "side-chat.close", chatId: "c1" }));
});

test("a lifted limit leaves the state to the reconcilers", () => {
  const state = emptyWorkspaceState();
  const transition = apply(state, { type: "limits.elapsed", at: 1 });
  assert.equal(transition.state, state);
  assert.deepEqual(transition.effects, []);
});
