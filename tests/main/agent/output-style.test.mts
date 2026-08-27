import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { ClaudeAgentProvider } from "../../../src/main/agent/claude-agent-provider.mts";
import { installPlainEnglishStyle } from "../../../src/main/agent/output-style-install.mts";
import { reduce } from "../../../src/application/workspace-reducer.ts";
import { emptyWorkspaceState, type WorkspaceState } from "../../../src/application/workspace-state.ts";
import { viewPreferences } from "../../../src/application/view-preferences.ts";
import { PLAIN_ENGLISH_FILE, PLAIN_ENGLISH_STYLE } from "../../../src/domain/output-style.ts";
import type { WorkspaceRecord } from "../../../src/domain/workspace.ts";
import { input, poolQueryFactory, poolTurn, queryFactory, type PoolCapture, type QueryCapture } from "../../support/claude-session.mjs";

const PROJECTLESS = { id: "projectless", kind: "projectless", root: "/tmp" } satisfies WorkspaceRecord;

/** Sends the draft and settles its workspace, which is what puts a start-run command together. */
function started(state: WorkspaceState) {
  const sending = reduce(state, { type: "task.send", attachments: [] });
  const pending = sending.effects.find((effect) => effect.type === "resolve-run-workspace");
  assert.ok(pending);
  const start = reduce(sending.state, { type: "run.resolved", pendingId: pending.pendingId, workspace: PROJECTLESS }).effects.find((effect) => effect.type === "start-run");
  assert.ok(start);
  return start.command;
}

const styles = () => mkdtemp(path.join(os.tmpdir(), "styles-"));

test("the style is written where Claude Code looks for it, under a name a run can select", async () => {
  const dir = path.join(await styles(), "output-styles");
  await installPlainEnglishStyle(PLAIN_ENGLISH_STYLE, dir);

  const written = await readFile(path.join(dir, PLAIN_ENGLISH_FILE), "utf8");
  assert.match(written, new RegExp(`^name: ${PLAIN_ENGLISH_STYLE}$`, "m"), "the frontmatter name is what the outputStyle setting resolves against");
  assert.match(written, /^keep-coding-instructions: true$/m, "swapping the style must not take the coding instructions with it");
  assert.match(written, /ASD-STE100/);
});

test("a style the user has edited is left as they wrote it", async () => {
  const dir = path.join(await styles(), "output-styles");
  await installPlainEnglishStyle(PLAIN_ENGLISH_STYLE, dir);
  await writeFile(path.join(dir, PLAIN_ENGLISH_FILE), "mine");

  await installPlainEnglishStyle(PLAIN_ENGLISH_STYLE, dir);
  assert.equal(await readFile(path.join(dir, PLAIN_ENGLISH_FILE), "utf8"), "mine");
});

test("a run that names no style, or another one, writes nothing", async () => {
  const root = await styles();
  const dir = path.join(root, "output-styles");
  await installPlainEnglishStyle(undefined, dir);
  await installPlainEnglishStyle("Concise", dir);
  assert.deepEqual(await readdir(root), []);
});

test("the setting is remembered and names the style every run answers in", () => {
  const drafted = reduce(emptyWorkspaceState(), { type: "view.set-prompt", prompt: "Inspect the app" }).state;

  const on = reduce(drafted, { type: "view.set-plain-english", enabled: true });
  assert.equal(on.state.plainEnglish, true);
  assert.deepEqual(on.effects.map((effect) => effect.type), ["persist-preferences"]);
  const persisted = on.effects.find((effect) => effect.type === "persist-preferences");
  assert.ok(persisted);
  assert.equal(persisted.preferences.plainEnglish, true);
  assert.deepEqual(reduce(on.state, { type: "view.set-plain-english", enabled: true }).effects, [], "an unchanged choice writes nothing");

  assert.equal(started(on.state).claude?.outputStyle, PLAIN_ENGLISH_STYLE);

  const off = reduce(on.state, { type: "view.set-plain-english", enabled: false });
  assert.equal(started(off.state).claude?.outputStyle, undefined, "with the setting off a run leaves the user's own style alone");
});

test("a stored setting survives the store loading", () => {
  const preferences = { ...viewPreferences(emptyWorkspaceState()), sessionPanelOpen: true, sidebarOpen: false, sidebarMode: "projects" as const, plainEnglish: true };
  const restored = reduce(emptyWorkspaceState(), { type: "preferences.loaded", preferences }).state;
  assert.equal(restored.plainEnglish, true);
});

test("a run that names a style selects it without replacing the user's own settings", async () => {
  const capture: QueryCapture = {};
  const provider = new ClaudeAgentProvider(queryFactory([], capture));
  await provider.execute(input({ claude: { outputStyle: PLAIN_ENGLISH_STYLE } }));
  assert.ok(capture.options?.options);
  assert.deepEqual(capture.options.options.settings, { outputStyle: PLAIN_ENGLISH_STYLE });
  assert.deepEqual(capture.options.options.settingSources, ["user", "project", "local"], "the style layers over the sources rather than replacing them");
});

test("turning the setting on gives the thread a session of its own rather than reusing the warm one", async () => {
  const capture: PoolCapture = { sessions: [] };
  const provider = new ClaudeAgentProvider(poolQueryFactory(capture));

  await poolTurn(provider, capture, {});
  await poolTurn(provider, capture, {});
  assert.equal(capture.sessions.length, 1, "the same settings reuse the warm session");

  await poolTurn(provider, capture, { claude: { outputStyle: PLAIN_ENGLISH_STYLE } });
  assert.equal(capture.sessions.length, 2);
  assert.deepEqual(capture.sessions.at(-1)?.options.options?.settings, { outputStyle: PLAIN_ENGLISH_STYLE });
  provider.closeAll();
});
