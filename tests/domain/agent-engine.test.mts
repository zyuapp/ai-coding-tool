import assert from "node:assert/strict";
import { test } from "vitest";
import { capabilitiesFor, contextWindowLimit, defaultEffortFor, defaultModelFor, effortsFor, engineHasEffort, engineHasModel, isAgentEffort, isAgentEngine, isAgentModel, modelSupportsManualCompaction, modelsFor, type AgentEngine } from "../../src/domain/agent-engine.ts";

const engines: AgentEngine[] = ["claude", "codex"];

test("every engine defaults to a model and an effort it offers", () => {
  for (const engine of engines) {
    assert.ok(isAgentEngine(engine));
    assert.ok(engineHasModel(engine, defaultModelFor(engine)));
    assert.ok(engineHasEffort(engine, defaultEffortFor(engine)));
    for (const model of modelsFor(engine)) {
      for (const spec of effortsFor(model.id)) assert.ok(isAgentEffort(spec.id));
    }
  }
});

test("models belong to their own engine and efforts may be shared", () => {
  assert.equal(engineHasModel("codex", "opus"), false);
  assert.equal(engineHasModel("claude", "gpt-5.6-sol"), false);
  assert.equal(engineHasEffort("claude", "ultra"), false);
  assert.equal(engineHasEffort("codex", "ultra"), true);
  assert.equal(engineHasEffort("codex", "max"), true);
  assert.equal(engineHasEffort("claude", "max"), true);
});

test("only catalogued ids pass the guards", () => {
  assert.equal(isAgentEngine("gpt"), false);
  assert.equal(isAgentEngine("constructor"), false);
  assert.equal(isAgentModel("claude-opus-4"), false);
  assert.equal(isAgentModel(undefined), false);
});

test("a foreign model uses the engine's default context window", () => {
  for (const engine of engines) {
    const foreign = engine === "codex" ? "opus" : "gpt-5.6-sol";
    assert.equal(contextWindowLimit(engine, foreign), contextWindowLimit(engine, defaultModelFor(engine)));
  }
});

test("per-engine settings and operations are catalogue entries", () => {
  assert.deepEqual(capabilitiesFor("codex"), { fastMode: true, workflows: false, subagents: true, review: true });
  assert.deepEqual(capabilitiesFor("claude"), { fastMode: false, workflows: true, subagents: true, review: false });
});

test("manual compaction belongs to the model and only through the engine that offers it", () => {
  assert.equal(modelSupportsManualCompaction("codex", "gpt-5.6-sol"), true);
  assert.equal(modelSupportsManualCompaction("codex", "gpt-5.6-terra"), false);
  assert.equal(modelSupportsManualCompaction("claude", "gpt-5.6-sol"), false);
  for (const engine of engines) {
    for (const model of modelsFor(engine)) assert.equal(modelSupportsManualCompaction(engine, model.id), model.manualCompaction === true);
  }
});
