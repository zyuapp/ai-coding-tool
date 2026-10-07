import { temporaryDirectory } from "../support/temporary-directory.mts";
import os from "node:os";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { readAppLaunch } from "../../src/main/app-launch.ts";

test("only the first launch of a new version counts as an update", async () => {
  const userData = await temporaryDirectory(path.join(os.tmpdir(), "app-launch-"));
  assert.equal(readAppLaunch(userData, "0.7.2"), null, "a brand new profile has not been updated");
  assert.equal(await readFile(path.join(userData, "launched-version"), "utf8"), "0.7.2");
  assert.equal(readAppLaunch(userData, "0.7.2"), null, "launching the same version again is not an update");
  assert.equal(readAppLaunch(userData, "0.8.0"), "0.8.0");
  assert.equal(readAppLaunch(userData, "0.8.0"), null, "the update is told once");
});

test("a profile from before the record was kept counts as updated", async () => {
  const userData = await temporaryDirectory(path.join(os.tmpdir(), "app-launch-"));
  await writeFile(path.join(userData, "window.v1.json"), "{}");
  assert.equal(readAppLaunch(userData, "0.8.0"), "0.8.0");
});

test("going back to an older build is recorded without counting as an update", async () => {
  const userData = await temporaryDirectory(path.join(os.tmpdir(), "app-launch-"));
  readAppLaunch(userData, "0.8.0");
  assert.equal(readAppLaunch(userData, "0.7.2"), null);
  assert.equal(readAppLaunch(userData, "0.8.0"), "0.8.0", "moving forward again is an update");
});
