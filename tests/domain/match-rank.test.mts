import assert from "node:assert/strict";
import { test } from "vitest";
import { rankedMatches } from "../../src/domain/match-rank.ts";

test("a search ranks a name that starts with the query above one that only contains it, and keeps order within a rank", () => {
  const items = [{ name: "billing-api", host: undefined }, { name: "web-app", host: undefined }, { name: "api-gateway", host: undefined }, { name: "ml-pipeline", host: "linux-box" }];
  const names = (item: typeof items[number]) => [item.name, item.host];
  assert.deepEqual(rankedMatches(items, "API", names).map((item) => item.name), ["api-gateway", "billing-api"]);
  assert.deepEqual(rankedMatches(items, "linux", names).map((item) => item.name), ["ml-pipeline"], "a second name finds it too");
  assert.deepEqual(rankedMatches(items, "  ", names), items, "a blank query keeps everything where it was");
  assert.deepEqual(rankedMatches(items, "zzz", names), []);
});
