import assert from "node:assert/strict";
import { test } from "vitest";
import { editorCandidates, editorLaunch, textHandlerLaunch, type Platform } from "../../src/domain/editors.ts";

test("a candidate carries the line in whatever form its editor takes", () => {
  const candidates = editorCandidates("darwin", "/checkout/src/app.mts", 119);
  const byId = (id: string) => {
    const candidate = candidates.find((item) => item.id === id);
    assert.ok(candidate);
    return candidate;
  };

  assert.deepEqual(byId("vscode").args, ["-g", "/checkout/src/app.mts:119"]);
  assert.deepEqual(byId("zed").args, ["/checkout/src/app.mts:119"]);
  assert.deepEqual(byId("jetbrains").args, ["--line", "119", "/checkout/src/app.mts"]);
});

test("without a line every editor is asked for the plain file", () => {
  for (const candidate of editorCandidates("darwin", "/checkout/src/app.mts", null)) {
    assert.deepEqual(candidate.args, ["/checkout/src/app.mts"], candidate.command);
  }
});

test("macOS tries an absolute launcher before the bare name, which a desktop PATH may not have", () => {
  const commands = editorCandidates("darwin", "/f.ts", null).map((candidate) => candidate.command);
  const cursor = commands.indexOf("/Applications/Cursor.app/Contents/Resources/app/bin/cursor");

  assert.ok(cursor >= 0 && cursor < commands.indexOf("cursor"));
  assert.ok(commands.indexOf("cursor") < commands.indexOf("code"), "the catalog order decides who wins");
});

test("each platform offers the launchers that exist there", () => {
  const commands = (platform: Platform | "freebsd") => editorCandidates(platform as Platform, "/f.ts", null).map((candidate) => candidate.command);

  assert.deepEqual(commands("win32"), ["cursor.cmd", "code.cmd", "windsurf.cmd", "subl.exe", "idea.bat", "webstorm.bat"]);
  assert.ok(commands("linux").includes("zed"));
  assert.deepEqual(commands("freebsd"), [], "an unknown platform has nothing to try");
});

test("a launcher that answered once is asked the same way again", () => {
  assert.deepEqual(editorLaunch("darwin", "code", "/f.ts", 4), { command: "code", args: ["-g", "/f.ts:4"] });
  assert.equal(editorLaunch("darwin", "code.cmd", "/f.ts", 4), null, "a launcher from another platform is not ours");
  assert.equal(editorLaunch("darwin", "quicktime", "/f.ts", null), null);
});

test("the floor opens a file as text rather than by its extension", () => {
  assert.deepEqual(textHandlerLaunch("darwin", "/f.mts"), { command: "open", args: ["-t", "/f.mts"] });
  assert.deepEqual(textHandlerLaunch("win32", "C:\\f.mts"), { command: "notepad.exe", args: ["C:\\f.mts"] });
  assert.equal(textHandlerLaunch("linux", "/f.mts"), null, "nothing on Linux skips the extension mapping");
});
