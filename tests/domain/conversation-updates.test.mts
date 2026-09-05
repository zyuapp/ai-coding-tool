import assert from "node:assert/strict";
import { test } from "vitest";
import { appendMessages, firstChangedMessage, replaceLastMessage, withdrawMessages } from "../../src/domain/conversation-updates.ts";
import type { ConversationMessage } from "../../src/domain/conversation.ts";

function message(id: string): ConversationMessage {
  return { id, kind: "assistant", text: id, at: 1 };
}

test("coalesced appends and committed tail replacements compare only the changed suffix", () => {
  const before = [message("one"), message("two")];
  const appended = appendMessages(before, [message("three")]);
  const updated = replaceLastMessage(appended, { ...appended[2], text: "three more" });
  const latest = appendMessages(updated, [message("four")]);
  assert.equal(firstChangedMessage(before, latest), 2);
  assert.equal(firstChangedMessage(appended, latest), 2);
  assert.deepEqual(before.map((item) => item.text), ["one", "two"]);
  assert.deepEqual(latest.map((item) => item.text), ["one", "two", "three more", "four"]);
});

test("withdrawal moves the changed boundary back to the start of the quiet run", () => {
  const before = [message("old"), message("run-1"), message("run-2")];
  const appended = appendMessages(before, [message("run-3")]);
  const withdrawn = withdrawMessages(appended, 1);
  assert.equal(firstChangedMessage(before, withdrawn), 1);
  assert.equal(withdrawn[0], before[0]);
  assert.deepEqual(withdrawn.map((item) => Boolean(item.withdrawn)), [false, true, true, true]);
  assert.equal(before[1].withdrawn, undefined);
});

test("untracked edits and divergent histories require comparing the entire conversation", () => {
  const before = [message("one"), message("two")];
  const divergent = appendMessages(before, [message("divergent")]);
  const branch = appendMessages(before, [message("branch")]);
  const earlierEdit = [{ ...before[0], text: "edited" }, before[1]];
  assert.equal(firstChangedMessage(divergent, branch), 0);
  assert.equal(firstChangedMessage(before, appendMessages(earlierEdit, [message("three")])), 0);
  assert.equal(firstChangedMessage(undefined, branch), 0);
  assert.equal(firstChangedMessage(before, before), 2);
});

test("ancestry traversal stays bounded when many writes accumulate", () => {
  const before = [message("one")];
  const versions = [before];
  for (let index = 0; index < 300; index += 1) versions.push(replaceLastMessage(versions.at(-1)!, message(String(index))));
  assert.equal(firstChangedMessage(before, versions.at(-1)!), 0);
});
