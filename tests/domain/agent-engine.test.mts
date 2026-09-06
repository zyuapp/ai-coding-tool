import assert from "node:assert/strict";
import { test } from "vitest";
import { capabilitiesFor, contextWindowLimit, defaultEffortFor, defaultModelFor, effortsFor, engineHasEffort, engineHasModel, engineLabel, isAgentEffort, isAgentEngine, isAgentModel, modelsFor, type AgentEngine } from "../../src/domain/agent-engine.ts";

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

test("Codex exposes its own label, default model, and supported panels", () => {
  assert.equal(engineLabel("codex"), "Codex");
  assert.equal(defaultModelFor("codex"), "gpt-5.6-sol");
  assert.equal(defaultEffortFor("codex"), "high");
  assert.deepEqual(capabilitiesFor("codex"), { workflows: false, subagents: true });
});

test("models belong to their own engine and efforts may be shared", () => {
  assert.equal(engineHasModel("codex", "opus"), false);
  assert.equal(engineHasModel("claude", "gpt-5.6-sol"), false);
  assert.equal(engineHasEffort("claude", "ultra"), false);
  assert.equal(engineHasEffort("codex", "ultra"), true);
  assert.equal(engineHasEffort("codex", "max"), true);
  assert.equal(engineHasEffort("claude", "max"), true);
});

test("the context window limit is the one the model's spec declares", () => {
  for (const engine of engines) {
    for (const spec of modelsFor(engine)) {
      assert.ok(isAgentModel(spec.id));
      assert.equal(contextWindowLimit(engine, spec.id), spec.contextWindow);
    }
  }
  assert.equal(contextWindowLimit("claude", "haiku"), 200_000);
  assert.equal(contextWindowLimit("claude", "opus"), 1_000_000);
  assert.equal(contextWindowLimit("codex", "gpt-5.6-sol"), 272_000);
  assert.equal(contextWindowLimit("codex", "opus"), 272_000, "a foreign model measures against the engine's default");
});

test("only catalogued ids pass the guards", () => {
  assert.equal(isAgentEngine("gpt"), false);
  assert.equal(isAgentEngine("constructor"), false);
  assert.equal(isAgentModel("claude-opus-4"), false);
  assert.equal(isAgentModel(undefined), false);
});
