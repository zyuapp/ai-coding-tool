import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ClaudeAgentProvider } from "../dist/main/main/agent/claude-agent-provider.mjs";
import { installPlainEnglishStyle } from "../dist/main/main/agent/output-style-install.mjs";
import { reduce } from "../dist/main/application/workspace-reducer.js";
import { emptyWorkspaceState } from "../dist/main/application/workspace-state.js";
import { PLAIN_ENGLISH_FILE, PLAIN_ENGLISH_STYLE } from "../dist/main/domain/output-style.js";
import { input, poolQueryFactory, poolTurn, queryFactory } from "./support/claude-session.mjs";

const PROJECTLESS = { id: "projectless", kind: "projectless", root: "/tmp" };

/** Sends the draft and settles its workspace, which is what puts a start-run command together. */
function started(state) {
  const sending = reduce(state, { type: "task.send", attachments: [] });
  return reduce(sending.state, { type: "run.resolved", pendingId: sending.effects[0].pendingId, workspace: PROJECTLESS }).effects[0].command;
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
  assert.equal(on.effects[0].preferences.plainEnglish, true);
  assert.deepEqual(reduce(on.state, { type: "view.set-plain-english", enabled: true }).effects, [], "an unchanged choice writes nothing");

  assert.equal(started(on.state).outputStyle, PLAIN_ENGLISH_STYLE);

  const off = reduce(on.state, { type: "view.set-plain-english", enabled: false });
  assert.equal(started(off.state).outputStyle, undefined, "with the setting off a run leaves the user's own style alone");
});

test("a stored setting survives the store loading", () => {
  const restored = reduce(emptyWorkspaceState(), { type: "preferences.loaded", preferences: { sessionPanelOpen: true, sidebarOpen: false, sidebarMode: "projects", plainEnglish: true } }).state;
  assert.equal(restored.plainEnglish, true);
});

test("a run that names a style selects it without replacing the user's own settings", async () => {
  const capture = {};
  const provider = new ClaudeAgentProvider(queryFactory([], capture));
  await provider.execute(input({ outputStyle: PLAIN_ENGLISH_STYLE }));
  assert.deepEqual(capture.options.options.settings, { outputStyle: PLAIN_ENGLISH_STYLE });
  assert.deepEqual(capture.options.options.settingSources, ["user", "project", "local"], "the style layers over the sources rather than replacing them");
});

test("turning the setting on gives the thread a session of its own rather than reusing the warm one", async () => {
  const capture = {};
  const provider = new ClaudeAgentProvider(poolQueryFactory(capture));

  await poolTurn(provider, capture, {});
  await poolTurn(provider, capture, {});
  assert.equal(capture.sessions.length, 1, "the same settings reuse the warm session");

  await poolTurn(provider, capture, { outputStyle: PLAIN_ENGLISH_STYLE });
  assert.equal(capture.sessions.length, 2);
  assert.deepEqual(capture.sessions.at(-1).options.options.settings, { outputStyle: PLAIN_ENGLISH_STYLE });
  provider.closeAll();
});
