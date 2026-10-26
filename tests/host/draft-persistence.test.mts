import assert from "node:assert/strict";
import { test } from "vitest";
import type { KeyValueStorage } from "../../src/application/task-store.ts";
import type { WorkspaceState } from "../../src/application/workspace-state.ts";
import { createDraftPersistence, DRAFT_PROMPTS_KEY } from "../../src/host/draft-persistence.ts";
import { PROJECT, task, workspace } from "../application/workspace-reducer-fixtures.mts";

function memory(entries: Record<string, string>) {
  const held = new Map(Object.entries(entries));
  const storage: KeyValueStorage = {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => { held.set(key, value); },
  };
  return { storage, saved: () => JSON.parse(held.get(DRAFT_PROMPTS_KEY) ?? "{}") as Record<string, string> };
}

const DRAFTS = { "remote-thread": "typed for elsewhere", "gone-thread": "for a thread deleted", "draft:": "loose" };

async function restored(initial: WorkspaceState, drafts: Record<string, string> = DRAFTS) {
  const { storage, saved } = memory({ [DRAFT_PROMPTS_KEY]: JSON.stringify(drafts) });
  let state = initial;
  const persistence = createDraftPersistence(storage, () => state, async (input) => {
    if (input.type !== "view.set-prompt" || input.taskId === undefined) return;
    state = { ...state, prompts: { ...state.prompts, [input.taskId]: input.prompt } };
  });
  await persistence.restore();
  return { drafts: persistence, saved, state: () => state };
}

const linux = { id: "linux", name: "linux", host: "linux.tail.ts.net", status: "connected" as const, error: null, pairedAt: 1 };

test("every draft comes back, and one nobody owns is dropped at the next save once every computer has answered", async () => {
  const alone = await restored(workspace({ projects: [PROJECT] }));
  assert.deepEqual(alone.state().prompts, DRAFTS);
  alone.drafts.flush();
  assert.deepEqual(alone.saved(), { "draft:": "loose" });

  const waiting = await restored({ ...workspace({ projects: [PROJECT] }), computers: { ...workspace().computers, paired: [{ ...linux, state: null }] } });
  waiting.drafts.flush();
  assert.deepEqual(waiting.saved(), DRAFTS, "with a computer yet to answer, no draft is known to be nobody's");

  const remote = workspace({ threads: [task("remote-thread")] });
  const answered = await restored({ ...workspace({ projects: [PROJECT] }), computers: { ...workspace().computers, paired: [{ ...linux, state: remote }] } });
  answered.drafts.flush();
  assert.deepEqual(answered.saved(), { "remote-thread": "typed for elsewhere", "draft:": "loose" });
});

test("new-thread drafts saved per project come back as the one new-thread draft", async () => {
  const legacy = await restored(workspace({ projects: [PROJECT] }), { [`draft:${PROJECT.id}`]: "for a folder here", "draft:gone": "for a folder removed" });
  assert.deepEqual(legacy.state().prompts, { "draft:": "for a folder here" });
  const empty = await restored(workspace({ projects: [PROJECT] }), { "draft:": "", [`draft:${PROJECT.id}`]: "for a folder here" });
  assert.deepEqual(empty.state().prompts, { "draft:": "for a folder here" });
});
