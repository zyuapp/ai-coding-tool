import assert from "node:assert/strict";
import { test } from "vitest";
import { BUILT_IN_MODELS, capabilitiesFor, catalogHasModel, contextWindowLimit, defaultEffortFor, defaultModelFor, effortForModel, effortsFor, engineCatalog, engineHasEffort, engineHasModel, isAgentEffort, isAgentEngine, isModelId, modelDelegable, modelEngine, modelLabel, modelSupportsManualCompaction, modelTakesEffort, modelsFor, resolveModel, type AgentEngine, type EngineStatus, type ModelSpec } from "../../src/domain/agent-engine.js";

const catalog = BUILT_IN_MODELS;

const engines: AgentEngine[] = ["claude", "codex"];

test("every engine defaults to a model and an effort it offers", () => {
  for (const engine of engines) {
    assert.ok(isAgentEngine(engine));
    assert.ok(engineHasModel(catalog, engine, defaultModelFor(engine)!));
    assert.ok(engineHasEffort(catalog, engine, defaultEffortFor(engine)));
    for (const model of modelsFor(catalog, engine)) {
      for (const spec of effortsFor(catalog, engine, model.id)) assert.ok(isAgentEffort(spec.id));
    }
  }
});

test("models belong to their own engine and efforts may be shared", () => {
  assert.equal(engineHasModel(catalog, "codex", "opus"), false);
  assert.equal(engineHasModel(catalog, "claude", "gpt-6.1-sol"), false);
  assert.equal(engineHasEffort(catalog, "claude", "ultra"), false);
  assert.equal(engineHasEffort(catalog, "codex", "ultra"), true);
  assert.equal(engineHasEffort(catalog, "codex", "max"), true);
  assert.equal(engineHasEffort(catalog, "claude", "max"), true);
});

test("only catalogued ids pass the guards", () => {
  assert.equal(isAgentEngine("gpt"), false);
  assert.equal(isAgentEngine("constructor"), false);
  assert.equal(catalogHasModel(catalog, "claude-opus-4"), false);
  assert.equal(catalogHasModel(catalog, "constructor"), false);
  assert.equal(catalogHasModel(catalog, "opus"), true);
});

test("any well-formed model id passes the shape guard, known or not", () => {
  for (const id of ["opus", "gpt-6.1-sol", "anthropic/claude-opus-5-5", "openrouter/meta/llama-4:free", "x".repeat(256)]) assert.equal(isModelId(id), true, id);
  for (const id of [undefined, null, 7, "", " ", "has space", "tab\tid", "line\nid", "nul\u0000id", "x".repeat(257), ["opus"], "constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) assert.equal(isModelId(id), false, String(id));
});

test("a foreign model uses the engine's default context window", () => {
  for (const engine of engines) {
    const foreign = engine === "codex" ? "opus" : "gpt-6.1-sol";
    assert.equal(contextWindowLimit(catalog, engine, foreign), contextWindowLimit(catalog, engine, defaultModelFor(engine)!));
  }
});

test("per-engine settings and operations are catalogue entries", () => {
  const every = ["confirm", "plan", "allow-edits", "autonomous", "bypass"];
  assert.deepEqual(capabilitiesFor("codex"), { fastMode: true, workflows: false, subagents: true, subagentMetadata: true, review: true, chromeBrowser: false, policies: every, unattendedPolicy: "autonomous" });
  assert.deepEqual(capabilitiesFor("claude"), { fastMode: false, workflows: true, subagents: true, subagentMetadata: true, review: false, chromeBrowser: true, policies: every, unattendedPolicy: "autonomous" });
  assert.deepEqual(capabilitiesFor("opencode"), { fastMode: false, workflows: false, subagents: false, subagentMetadata: false, review: false, chromeBrowser: false, policies: ["confirm", "plan", "allow-edits", "bypass"], unattendedPolicy: "bypass" });
});

test("manual compaction belongs to the model and only through the engine that offers it", () => {
  assert.equal(modelSupportsManualCompaction(catalog, "codex", "gpt-6.1-sol"), true);
  assert.equal(modelSupportsManualCompaction(catalog, "codex", "gpt-6-astra"), true);
  assert.equal(modelSupportsManualCompaction(catalog, "claude", "opus"), true);
  assert.equal(modelSupportsManualCompaction(catalog, "claude", "gpt-6.1-sol"), false);
  for (const engine of engines) {
    for (const model of modelsFor(catalog, engine)) assert.equal(modelSupportsManualCompaction(catalog, engine, model.id), model.manualCompaction === true);
  }
});

const high = { id: "high" as const, label: "High" };
const low = { id: "low" as const, label: "Low" };
const named: ModelSpec[] = [
  { id: "openai/gpt-9", label: "GPT-9", description: "Named by the engine", contextWindow: 400_000, efforts: [high, low], manualCompaction: true },
  { id: "local/tiny", label: "Tiny", description: "No effort", contextWindow: 8_000, efforts: [], delegable: false },
];

test("an engine status that names no catalogue leaves the built-in one in place", () => {
  assert.equal(engineCatalog(null), BUILT_IN_MODELS);
  assert.equal(engineCatalog(undefined), BUILT_IN_MODELS);
  assert.equal(engineCatalog({ claude: { access: "ready", models: ["opus"] }, codex: { access: "missing" } }), BUILT_IN_MODELS);
});

test("an engine that names its own models replaces only its own list", () => {
  const status: EngineStatus = { codex: { access: "ready", catalog: named } };
  const own = engineCatalog(status);
  assert.deepEqual(modelsFor(own, "codex").map((spec) => spec.id), ["openai/gpt-9", "local/tiny"]);
  assert.deepEqual(modelsFor(own, "claude"), modelsFor(BUILT_IN_MODELS, "claude"));
  assert.equal(modelEngine(own, "openai/gpt-9"), "codex");
  assert.equal(modelEngine(own, "gpt-6.1-sol"), undefined);
  assert.equal(engineHasModel(own, "codex", "openai/gpt-9"), true);
  assert.equal(engineHasModel(own, "claude", "openai/gpt-9"), false);
  assert.equal(modelLabel(own, "codex", "openai/gpt-9"), "GPT-9");
  assert.equal(modelLabel(own, "codex", "gpt-6.1-sol"), "gpt-6.1-sol");
  assert.equal(contextWindowLimit(own, "codex", "openai/gpt-9"), 400_000);
  assert.equal(modelSupportsManualCompaction(own, "codex", "openai/gpt-9"), true);
  assert.equal(modelSupportsManualCompaction(own, "codex", "local/tiny"), false);
  assert.equal(modelDelegable(own, "codex", "local/tiny"), false);
  assert.equal(modelTakesEffort(own, "codex", "local/tiny"), false);
  assert.equal(effortForModel(own, "codex", "openai/gpt-9", "max"), "high");
  assert.equal(effortForModel(own, "codex", "openai/gpt-9", "medium"), "low");
  assert.equal(engineHasEffort(own, "codex", "ultra"), false);
});

test("a status's catalogue is built once, so pickers read a stable one", () => {
  const status: EngineStatus = { codex: { access: "ready", catalog: named } };
  assert.equal(engineCatalog(status), engineCatalog(status));
  assert.notEqual(engineCatalog({ ...status }), engineCatalog(status));
});

test("a model two engines name is each one's own, listed and run where it was picked", () => {
  const gateway: ModelSpec = { ...named[0]!, id: "opus", label: "Gateway Opus", contextWindow: 64_000, efforts: [low], delegable: false };
  const own = engineCatalog({ codex: { access: "ready", catalog: [gateway, named[0]!, { ...named[0]!, label: "Again" }] } });
  assert.deepEqual(modelsFor(own, "codex").map((spec) => spec.label), ["Gateway Opus", "GPT-9"], "an id named twice by one engine is listed once");
  assert.ok(modelsFor(own, "claude").some((spec) => spec.id === "opus"), "and the engine listed first keeps its own");
  assert.equal(engineHasModel(own, "claude", "opus"), true);
  assert.equal(engineHasModel(own, "codex", "opus"), true);
  assert.deepEqual([modelLabel(own, "claude", "opus"), modelLabel(own, "codex", "opus")], ["Opus", "Gateway Opus"]);
  assert.deepEqual([contextWindowLimit(own, "claude", "opus"), contextWindowLimit(own, "codex", "opus")], [1_000_000, 64_000]);
  assert.deepEqual([modelDelegable(own, "claude", "opus"), modelDelegable(own, "codex", "opus")], [true, false]);
  assert.deepEqual([effortForModel(own, "claude", "opus", "max"), effortForModel(own, "codex", "opus", "max")], ["max", "low"]);
  assert.equal(modelEngine(own, "opus"), "claude", "a model named without its engine reads as the first engine's, as it did when ids were unique");
  assert.equal(modelEngine(own, "opus", "codex"), "codex");
  assert.deepEqual(resolveModel(own, "opus", [], "codex"), { engine: "codex", model: "opus" });
  assert.deepEqual(resolveModel(own, "opus", []), { error: "opus could mean opus on Claude, opus on Codex. Name the engine as well, or pin the one you mean in the model picker." });
  assert.deepEqual(resolveModel(own, "opus", [{ engine: "codex", model: "opus" }]), { engine: "codex", model: "opus" }, "a pin names its engine, so it tells two engines apart");
  assert.deepEqual(resolveModel(own, "gpt-6.1-sol", [], "codex"), { error: "Codex here does not offer the gpt-6.1-sol model. Pick another model." });
});

test("a spec this build cannot read is left out rather than breaking the catalogue", () => {
  const unreadable = [null, 7, { ...named[0]!, id: "two words" }, { ...named[0]!, id: "constructor" }, { ...named[0]!, efforts: undefined }, { ...named[0]!, efforts: [null] }, { ...named[0]!, efforts: [{ id: "galaxy" }] }, { ...named[0]!, efforts: [{ id: "high", label: {} }] }, { ...named[0]!, label: 3 }];
  const own = engineCatalog({ codex: { access: "ready", catalog: [...unreadable, named[1]!] as ModelSpec[] } });
  assert.deepEqual(modelsFor(own, "codex").map((spec) => spec.id), ["local/tiny"]);
  assert.equal(engineCatalog({ codex: { access: "ready", catalog: "none" as never } }), BUILT_IN_MODELS, "a list that is not one leaves the built-in models in place");
});
