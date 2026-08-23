import assert from "node:assert/strict";
import { test } from "vitest";
import {
  CLI_INSTALL_PATH,
  CLI_SCRIPT,
  isCliScript,
  projectPathFromArgv,
  projectPathFromUrl,
} from "../src/domain/cli.ts";

function urlFor(root: string) {
  const encoded = Buffer.from(root, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
  return `aicodingtool://open?path=${encoded}`;
}

test("reads the folder out of a URL the command wrote", () => {
  assert.equal(projectPathFromUrl(urlFor("/Users/me/code/app")), "/Users/me/code/app");
  assert.equal(projectPathFromUrl(urlFor("/Users/me/Ünïcode dir")), "/Users/me/Ünïcode dir");
});

test("refuses URLs that are not an open request for an absolute folder", () => {
  assert.equal(projectPathFromUrl("https://example.com/open?path=Lw"), null);
  assert.equal(projectPathFromUrl("aicodingtool://send?path=Lw"), null);
  assert.equal(projectPathFromUrl("aicodingtool://open"), null);
  assert.equal(projectPathFromUrl("aicodingtool://open?path=***"), null);
  assert.equal(projectPathFromUrl(urlFor("relative/path")), null);
  assert.equal(projectPathFromUrl("not a url"), null);
});

test("finds the URL among launch arguments", () => {
  assert.equal(projectPathFromArgv(["/Applications/AI Coding Tool.app", urlFor("/tmp/app")]), "/tmp/app");
  assert.equal(projectPathFromArgv(["/Applications/AI Coding Tool.app", "--updated"]), null);
});

test("the installed script is recognisable as ours and opens the folder it is given", () => {
  assert.ok(isCliScript(CLI_SCRIPT));
  assert.ok(!isCliScript("#!/bin/sh\necho hi\n"));
  assert.ok(CLI_SCRIPT.startsWith("#!/bin/sh\n"));
  assert.match(CLI_SCRIPT, /exec open "aicodingtool:\/\/open\?path=\$encoded"/);
  assert.equal(CLI_INSTALL_PATH, "/usr/local/bin/aic");
});
