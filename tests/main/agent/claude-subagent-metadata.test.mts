import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { claudeTranscriptMetadata, readClaudeSubagentMetadata } from "../../../src/main/agent/claude-subagent-metadata.mts";

const reply = (fields = {}) => ({ type: "assistant", agentId: "child", sessionId: "session", message: { model: "claude-opus-5" }, effort: "medium", ...fields });

test("saved Claude metadata uses the latest real child request, including per-turn effort", () => {
  for (const effort of ["low", "medium", "high", "xhigh", "max", 64]) {
    const rows = [reply(), reply({ perTurnEffort: effort }), reply({ agentId: "other", effort: "high" }), reply({ sessionId: "other" }), reply({ message: { model: "<synthetic>" } })];
    assert.deepEqual(claudeTranscriptMetadata(rows.map((row) => JSON.stringify(row)).join("\n") + '\n{"unfinished":', "child", "session"), { model: "claude-opus-5", effort: String(effort) });
  }
  assert.deepEqual(claudeTranscriptMetadata(JSON.stringify(reply({ effort: undefined })), "child", "session"), { model: "claude-opus-5" });
});

test("Claude recovery locates a saved child, bounds large transcript reads, and tolerates missing data", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-metadata-"));
  try {
    const dir = join(root, "projects", "encoded-project", "session", "subagents");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "agent-child.jsonl");
    await writeFile(path, JSON.stringify({ ignored: "x".repeat(3 * 1024 * 1024) }) + "\n" + JSON.stringify(reply()) + "\n");
    assert.deepEqual(await readClaudeSubagentMetadata("child", "session", root), { model: "claude-opus-5", effort: "medium" });
    await writeFile(path, JSON.stringify(reply({ effort: "max" })));
    assert.equal((await readClaudeSubagentMetadata("child", "session", root)).effort, "max");
    assert.deepEqual(await readClaudeSubagentMetadata("missing", "session", root), {});
    assert.deepEqual(await readClaudeSubagentMetadata("child", undefined, root), {});
    assert.deepEqual(await readClaudeSubagentMetadata("../child", "session", root), {});
    assert.deepEqual(await readClaudeSubagentMetadata("child", "../session", root), {});
  } finally { await rm(root, { recursive: true, force: true }); }
});
