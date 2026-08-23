import assert from "node:assert/strict";
import { test } from "vitest";
import { appCandidates, externalApps } from "../src/domain/external-apps.ts";
import type { Platform } from "../src/domain/editors.ts";

const HOME = "/Users/dev";

test("each platform offers the applications that exist there", () => {
  const ids = (platform: Platform | "freebsd") => externalApps(platform as Platform).map((app) => app.id);

  assert.ok(ids("darwin").includes("iterm"), "macOS has iTerm");
  assert.ok(!ids("linux").includes("iterm"), "Linux has no iTerm");
  assert.ok(ids("win32").includes("windows-terminal"));
  assert.deepEqual(ids("freebsd"), [], "an unknown platform has nothing to open");
});

test("every platform offers exactly one file manager, under its own name", () => {
  for (const [platform, label] of [["darwin", "Finder"], ["win32", "File Explorer"], ["linux", "File manager"]] as const) {
    const files = externalApps(platform).filter((app) => app.kind === "files");
    assert.deepEqual(files.map((app) => app.label), [label]);
  }
});

test("a macOS bundle is looked for in every standard folder and in the user's own", () => {
  const probes = appCandidates("cursor", "darwin", HOME, "/repo").map((candidate) => candidate.probe);

  assert.deepEqual(probes, [
    "/Applications/Cursor.app",
    "/System/Applications/Cursor.app",
    "/System/Applications/Utilities/Cursor.app",
    "/Users/dev/Applications/Cursor.app",
  ]);
});

test("a macOS bundle opens the folder through the bundle it was found in", () => {
  const [first] = appCandidates("zed", "darwin", HOME, "/repo");

  assert.deepEqual(first, {
    id: "zed",
    probe: "/Applications/Zed.app",
    icon: "/Applications/Zed.app",
    command: "open",
    args: ["-a", "/Applications/Zed.app", "/repo"],
  });
});

test("a launcher on PATH carries the folder in whatever form its application takes", () => {
  const args = (id: string, platform: Platform) => appCandidates(id, platform, HOME, "/repo").map((candidate) => candidate.args);

  assert.deepEqual(args("vscode", "linux"), [["/repo"]]);
  assert.deepEqual(args("kitty", "linux"), [["--directory", "/repo"]]);
  assert.deepEqual(args("wezterm", "linux"), [["start", "--cwd", "/repo"]]);
  assert.deepEqual(args("windows-terminal", "win32"), [["-d", "/repo"]]);
});

test("a launcher looked up on PATH has nothing to probe", () => {
  const [linux] = appCandidates("vscode", "linux", HOME, "/repo");

  assert.equal(linux.probe, null, "PATH decides whether it is there");
  assert.equal(linux.icon, null, "a launcher on PATH carries no icon of its own");
});

test("Finder takes its icon from the bundle rather than from the launcher", () => {
  const [finder] = appCandidates("finder", "darwin", HOME, "/repo");

  assert.deepEqual(finder.args, ["/repo"]);
  assert.equal(finder.icon, "/System/Library/CoreServices/Finder.app");
});

test("an application the catalog does not know has nowhere to open", () => {
  assert.deepEqual(appCandidates("emacs", "darwin", HOME, "/repo"), []);
});
