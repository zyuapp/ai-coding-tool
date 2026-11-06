import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { test } from "vitest";
import { engineBinaryPath } from "../../../src/main/agent/engine-binary.mts";
import { isOlderThan, readVersion } from "../../../src/domain/engine-version.ts";
import { startOpenCodeServer } from "../../../src/main/opencode/opencode-server.mts";
import { OPENCODE_BASELINE_VERSION } from "../../../src/main/opencode/opencode-services.mts";

/** The OpenCode on this machine, when it is one the app speaks to; the test that needs it is skipped otherwise. */
function installed() {
  const binary = engineBinaryPath("opencode");
  if (!binary) return null;
  try {
    const version = readVersion(execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 10_000 }));
    return isOlderThan(version, OPENCODE_BASELINE_VERSION) ? null : version;
  } catch {
    return null;
  }
}

const version = installed();

test.skipIf(!version)(`the installed OpenCode ${version ?? ""} starts the way the app reads it, answers, and stops`, async () => {
  const client = await startOpenCodeServer({ cwd: os.tmpdir() });
  try {
    const models = await client.request<unknown[]>("GET", "/api/model");
    assert.ok(Array.isArray(models), "the server answered behind the password it made up");
  } finally {
    await client.close();
  }
  const exit = await client.exited;
  assert.ok(exit.code !== undefined, "the server is gone once closed");
}, 60_000);
