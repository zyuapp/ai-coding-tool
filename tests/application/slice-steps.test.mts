import assert from "node:assert/strict";
import { test } from "vitest";

import { applied, inTurn } from "../../src/application/workspace-reducer/slice.ts";
import { composerOf, withPromptIn } from "../../src/application/composer-drafts.ts";
import { workspace } from "./workspace-reducer-fixtures.mts";

test("steps that change an owner and then put it back still leave a new state", () => {
  const state = workspace({ prompts: { "task-a": "kept" } });
  const steps = inTurn(state, {}, [
    (next) => ({ edits: [withPromptIn(composerOf(next), "task-a", "typed")] }),
    (next) => ({ edits: [withPromptIn(composerOf(next), "task-b", "other")] }),
    () => ({ edits: [composerOf(state)] }),
  ]);
  const after = applied(state, steps).state;
  assert.notEqual(after, state);
  assert.equal(after.prompts, state.prompts);
});
