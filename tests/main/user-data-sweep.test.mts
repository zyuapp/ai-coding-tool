import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { attachmentNames, retireLegacyCodexHome, sweepOrphanAttachments } from "../../src/main/user-data-sweep.ts";

const DAY = 24 * 60 * 60 * 1000;

async function directory() {
  return mkdtemp(path.join(tmpdir(), "aicodingtool-sweep-"));
}

async function aged(file: string, ageMs: number, now: number) {
  await writeFile(file, "png");
  const at = new Date(now - ageMs);
  await utimes(file, at, at);
}

test("only old attachments nothing names go, with their context sidecars", async () => {
  const attachments = await directory();
  const now = Date.now();
  await aged(path.join(attachments, "kept.png"), 30 * DAY, now);
  await aged(path.join(attachments, "kept.png.context.json"), 30 * DAY, now);
  await aged(path.join(attachments, "orphan.png"), 30 * DAY, now);
  await aged(path.join(attachments, "orphan.png.context.json"), 30 * DAY, now);
  await aged(path.join(attachments, "stray.png.context.json"), 30 * DAY, now);
  await aged(path.join(attachments, "fresh.png"), 1 * DAY, now);
  await aged(path.join(attachments, "notes.txt"), 30 * DAY, now);
  await mkdir(path.join(attachments, "folder.png"));

  const referenced = attachmentNames([path.join("/elsewhere", "kept.png")]);
  const swept = await sweepOrphanAttachments(attachments, referenced, { now, minAgeMs: 7 * DAY });

  assert.deepEqual(swept, { files: 3, bytes: 9 });
  assert.deepEqual((await readdir(attachments)).sort(), ["folder.png", "fresh.png", "kept.png", "kept.png.context.json", "notes.txt"]);
});

test("a missing attachments directory sweeps nothing", async () => {
  const swept = await sweepOrphanAttachments(path.join(await directory(), "missing"), new Set(), { now: Date.now(), minAgeMs: DAY });
  assert.deepEqual(swept, { files: 0, bytes: 0 });
});

test("the retired Codex home is handed over once and never when absent", async () => {
  const userData = await directory();
  const discarded: string[] = [];
  const discard = async (target: string) => { discarded.push(target); };
  assert.equal(await retireLegacyCodexHome(userData, discard), false);
  await writeFile(path.join(userData, "codex"), "a file, not the old home");
  assert.equal(await retireLegacyCodexHome(userData, discard), false);
  await mkdir(path.join(userData, "codex-private"), { recursive: true });
  assert.equal(await retireLegacyCodexHome(userData, discard), false);
  const home = path.join(await directory(), "codex");
  await mkdir(home);
  assert.equal(await retireLegacyCodexHome(path.dirname(home), discard), true);
  assert.deepEqual(discarded, [home]);
});
