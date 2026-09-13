import assert from "node:assert/strict";
import { test } from "vitest";
import type { KeyValueStorage } from "../../src/application/task-store.ts";
import { createDraftPersistence, DRAFT_PROMPTS_KEY } from "../../src/host/draft-persistence.ts";
import { PROJECT, workspace } from "../application/workspace-reducer-fixtures.mts";

function memory(entries: Record<string, string>): KeyValueStorage {
  const held = new Map(Object.entries(entries));
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => { held.set(key, value); },
  };
}

test("restored drafts keep every thread's text, since its thread may be on a computer yet to answer, and drop only a folder that is gone", async () => {
  const storage = memory({ [DRAFT_PROMPTS_KEY]: JSON.stringify({ "remote-thread": "typed for elsewhere", "draft:": "loose", "draft:gone": "for a folder removed", [`draft:${PROJECT.id}`]: "for a folder here" }) });
  let state = workspace({ projects: [PROJECT] });
  const drafts = createDraftPersistence(storage, () => state, async (input) => {
    if (input.type !== "view.set-prompt" || input.taskId === undefined) return;
    state = { ...state, prompts: { ...state.prompts, [input.taskId]: input.prompt } };
  });
  await drafts.restore();
  assert.deepEqual(state.prompts, { "remote-thread": "typed for elsewhere", "draft:": "loose", [`draft:${PROJECT.id}`]: "for a folder here" });
});
