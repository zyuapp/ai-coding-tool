import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";

// @ts-expect-error The package and Electron Builder run this generator as plain JavaScript.
const { checkLegalNotices, generatedLegalNotices, runtimeLicenseEntries } = await import("../../scripts/generate-legal-notices.mjs");
// @ts-expect-error The release metadata is shared with plain-JavaScript packaging hooks.
const { ANTHROPIC_AGENT_SDK_VERSION, CUA_DRIVER_VERSION, CUA_RELEASE, lockedPackageVersion } = await import("../../scripts/cua-driver-version.mjs");

test("generated notices match the lockfile and committed legal assets", async () => {
  await checkLegalNotices();
  for (const [name, expected] of await generatedLegalNotices()) {
    assert.equal(await readFile(path.resolve("assets/legal", name), "utf8"), expected);
  }
});

test("runtime notices cover the proprietary SDK, direct dependencies, and bundled fonts", async () => {
  const entries = await runtimeLicenseEntries() as Array<{ name: string; version: string }>;
  const packages = new Set<string>(entries.map(({ name, version }) => `${name}@${version}`));
  for (const name of [
    "@anthropic-ai/claude-agent-sdk",
    "@lydell/node-pty",
    "@modelcontextprotocol/sdk",
    "@xterm/headless",
    "croner",
    "electron-updater",
    "qrcode",
    "ws",
    "zod",
    "@fontsource-variable/fira-code",
    "@fontsource-variable/geist",
    "@fontsource-variable/ibm-plex-sans",
    "@fontsource-variable/inter",
    "@fontsource-variable/jetbrains-mono",
    "@fontsource-variable/source-code-pro",
  ]) {
    const id = `${name}@${lockedPackageVersion(name)}`;
    assert.ok(packages.has(id), `Missing runtime notice for ${id}`);
  }

  assert.ok(![...packages].some((name) => name.includes("claude-agent-sdk-darwin-arm64")));
  assert.equal(ANTHROPIC_AGENT_SDK_VERSION, lockedPackageVersion("@anthropic-ai/claude-agent-sdk"));
});

test("CUA release metadata matches the pinned driver", () => {
  assert.equal(CUA_DRIVER_VERSION, lockedPackageVersion("@trycua/cua-driver"));
  assert.equal(CUA_RELEASE.ubjsVersion, lockedPackageVersion("@ubjs/core"));
  assert.match(CUA_RELEASE.sourceCommit, /^[0-9a-f]{40}$/);
  assert.match(CUA_RELEASE.archiveSha256, /^[0-9a-f]{64}$/);
});
