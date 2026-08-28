import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { suggestCodexTitle, type CodexExec } from "../../../src/main/codex/codex-title-writer.mts";

type Capture = { args?: readonly string[]; input?: string; cwd?: string };

/** Stands in for the binary: records the call and writes what the last message would have been. */
function exec(lastMessage: string | null, capture: Capture = {}): CodexExec {
  return async (args, input, cwd) => {
    capture.args = args;
    capture.input = input;
    capture.cwd = cwd;
    const output = args[args.indexOf("--output-last-message") + 1]!;
    if (lastMessage !== null) await writeFile(output, lastMessage);
  };
}

test("naming a thread on Codex runs one read-only, ephemeral exec held to a title schema", async () => {
  const capture: Capture = {};
  const title = await suggestCodexTitle("Inspect the app and tell me what breaks", [], exec('{"title":"App breakage review."}', capture));
  assert.equal(title, "App breakage review");

  const args = capture.args!;
  assert.deepEqual(args.slice(0, 4), ["exec", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check"]);
  assert.equal(args[args.indexOf("-s") + 1], "read-only");
  assert.equal(args[args.indexOf("-m") + 1], "gpt-5.6-terra");
  assert.equal(args[args.indexOf("-c") + 1], 'model_reasoning_effort="low"');
  assert.equal(args.at(-1), "-", "the prompt goes in on stdin");
  assert.equal(args.includes("-i"), false);
  assert.match(capture.input!, /^You name chat threads\./);
  assert.match(capture.input!, /<message>\nInspect the app and tell me what breaks\n<\/message>/);
  const schema = JSON.parse(await readFile(args[args.indexOf("--output-schema") + 1]!, "utf8").catch(() => "null"));
  assert.equal(schema, null, "the schema and the answer are cleaned up with the run");
  assert.equal(capture.cwd, path.dirname(args[args.indexOf("--output-schema") + 1]!), "the run happens in its own scratch folder");
});

test("a long message is cut before it is sent, and a long answer is cut to a title", async () => {
  const capture: Capture = {};
  const title = await suggestCodexTitle("x".repeat(5_000), [], exec(`{"title":"${"A".repeat(80)}"}`, capture));
  assert.ok(title && title.length < 80);
  assert.ok(capture.input!.length < 2_300);
});

test("nothing usable comes back as no title, so the thread keeps the name it has", async () => {
  assert.equal(await suggestCodexTitle("hi", [], exec('{"title":"   "}')), null);
  assert.equal(await suggestCodexTitle("hi", [], exec("not json")), null);
  assert.equal(await suggestCodexTitle("hi", [], exec('{"name":"x"}')), null);
  assert.equal(await suggestCodexTitle("hi", [], exec(null)), null, "an exec that wrote nothing");
  assert.equal(await suggestCodexTitle("hi", [], async () => { throw new Error("spawn ENOENT"); }), null);
  assert.equal(await suggestCodexTitle("   ", [], exec('{"title":"x"}')), null, "nothing to name from");
});

test("screenshots ride along as images, skipping ones that are missing or too big", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-title-"));
  const shot = path.join(directory, "shot.png");
  await writeFile(shot, Buffer.from("png"));
  const oversized = path.join(directory, "big.png");
  await writeFile(oversized, Buffer.alloc(1024 * 1024 + 1));
  const capture: Capture = {};
  const title = await suggestCodexTitle("", [shot, path.join(directory, "missing.png"), oversized], exec('{"title":"Sidebar overlap"}', capture));
  assert.equal(title, "Sidebar overlap");
  const args = capture.args!;
  assert.deepEqual(args.filter((_arg, index) => args[index - 1] === "-i"), [shot]);
  assert.match(capture.input!, /Name this thread from the screenshots it starts with\./);
});
