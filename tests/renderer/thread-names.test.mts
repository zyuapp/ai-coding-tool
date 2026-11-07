import assert from "node:assert/strict";
import { test } from "vitest";
import type { Thread } from "../../src/domain/thread.ts";
import { resolveThread, threadNamesOf } from "../../src/renderer/thread-names.ts";

const names = new Map([["a1b2c3", "Fix login"], ["a1ffff", "Polish dock"], ["d4e5f6", "Review"]]);

test("a thread is found by its ID, an unambiguous prefix of one, or its exact title", () => {
  assert.deepEqual(resolveThread(names, "d4e5f6"), { id: "d4e5f6", title: "Review" });
  assert.deepEqual(resolveThread(names, "a1b"), { id: "a1b2c3", title: "Fix login" });
  assert.deepEqual(resolveThread(names, "Polish dock"), { id: "a1ffff", title: "Polish dock" });
  assert.equal(resolveThread(names, "a1"), null, "a prefix two threads share names neither");
  assert.equal(resolveThread(names, "zzz"), null);
});

test("titles hand back the same map until a thread or its title changes", () => {
  const threads = [{ id: "t1", title: "One" }, { id: "t2", title: "Two" }] as Thread[];
  const first = threadNamesOf(threads, new Map());
  assert.equal(threadNamesOf([...threads], first), first);
  assert.notEqual(threadNamesOf([threads[0]!, { ...threads[1]!, title: "Renamed" }], first), first);
  assert.notEqual(threadNamesOf(threads.slice(0, 1), first), first);
});
