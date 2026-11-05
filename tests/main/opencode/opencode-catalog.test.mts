import assert from "node:assert/strict";
import { test } from "vitest";
import { engineCatalog, modelEngine, modelsFor } from "../../../src/domain/agent-engine.ts";
import { appModelId, modelRef, openCodeCatalog } from "../../../src/main/opencode/opencode-catalog.mts";

const models = [
  { id: "z-ai/glm-5.3-flash", providerID: "openrouter", name: "GLM-5.3-Flash", variants: [{ id: "none" }, { id: "low" }, { id: "max" }, { id: "thinking" }, { id: "high" }], limit: { context: 1_048_576 } },
  { id: "gpt-5.6", providerID: "openai", name: "GPT-5.6", variants: [], limit: { context: 400_000 } },
  { id: "glm-5.3", providerID: "opencode-go", name: "GLM-5.3" },
  { id: "hidden", providerID: "openrouter", enabled: false },
  { id: "two words", providerID: "openrouter" },
];
const providers = [{ id: "openrouter", name: "OpenRouter" }, { id: "openai", name: "OpenAI" }, { id: "opencode-go", name: "OpenCode Go" }];

test("each connected provider's models are listed under the provider's name, with the depths the app also names", () => {
  const catalog = openCodeCatalog(models, providers);
  assert.deepEqual(catalog.map((spec) => spec.id), ["openrouter/z-ai/glm-5.3-flash", "openai/gpt-5.6", "opencode-go/glm-5.3"]);
  assert.deepEqual(catalog[0], {
    id: "openrouter/z-ai/glm-5.3-flash", label: "GLM-5.3-Flash", description: "z-ai/glm-5.3-flash", provider: "OpenRouter",
    contextWindow: 1_048_576, efforts: [{ id: "max", label: "Max" }, { id: "high", label: "High" }, { id: "low", label: "Low" }], manualCompaction: true,
  });
  assert.deepEqual(catalog[1]!.efforts, [], "a model with no variants reasons at one depth");
  assert.equal(catalog[2]!.label, "GLM-5.3");
  assert.equal(catalog[2]!.contextWindow, 0, "a window the server does not name is unknown");
});

test("the server's default model is listed first, which is the one an engine default falls back to", () => {
  const catalog = openCodeCatalog(models, providers, { id: "glm-5.3", providerID: "opencode-go" });
  assert.equal(catalog[0]!.id, "opencode-go/glm-5.3");
  const engines = engineCatalog({ opencode: { access: "ready", catalog } });
  assert.equal(modelEngine(engines, "openrouter/z-ai/glm-5.3-flash"), "opencode");
  assert.equal(modelsFor(engines, "opencode").length, 3);
  assert.deepEqual(modelsFor(engines, "claude").map((spec) => spec.id), ["fable", "opus", "sonnet", "haiku"], "the other engines keep their own models");
});

test("an app model id splits at its first slash into the provider and the provider's own id", () => {
  assert.equal(appModelId({ id: "z-ai/glm-5.3-flash", providerID: "openrouter" }), "openrouter/z-ai/glm-5.3-flash");
  assert.deepEqual(modelRef("openrouter/z-ai/glm-5.3-flash", "high"), { providerID: "openrouter", id: "z-ai/glm-5.3-flash", variant: "high" });
  assert.deepEqual(modelRef("openai/gpt-5.6"), { providerID: "openai", id: "gpt-5.6" });
  for (const id of ["opus", "/gpt", "openai/", ""]) assert.equal(modelRef(id), null, id);
});
