import assert from "node:assert/strict";
import { test } from "vitest";
import { contextWindowLimit, defaultEffortFor, defaultModelFor, effortsFor, engineHasModel, isAgentEngine, isAgentModel, modelsFor, type AgentEngine } from "../../src/domain/agent-engine.ts";

const engines: AgentEngine[] = ["claude"];

test("every engine defaults to a model and an effort it offers", () => {
  for (const engine of engines) {
    assert.ok(isAgentEngine(engine));
    assert.ok(engineHasModel(engine, defaultModelFor(engine)));
    assert.ok(effortsFor(engine).some((spec) => spec.id === defaultEffortFor(engine)));
  }
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
});

test("only catalogued ids pass the guards", () => {
  assert.equal(isAgentEngine("gpt"), false);
  assert.equal(isAgentEngine("constructor"), false);
  assert.equal(isAgentModel("claude-opus-4"), false);
  assert.equal(isAgentModel(undefined), false);
});
