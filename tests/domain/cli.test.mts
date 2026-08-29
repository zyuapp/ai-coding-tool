import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  CLI_INSTALL_PATH,
  CLI_SCRIPT,
  LINUX_CLI_SCRIPT,
  cliConfiguration,
  isCliScript,
  projectPathFromArgv,
  projectPathFromUrl,
} from "../../src/domain/cli.ts";

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

test("Linux installs in the user's local bin and opens the URL through the desktop", () => {
  assert.deepEqual(cliConfiguration("linux", "/home/me"), {
    installPath: "/home/me/.local/bin/aic",
    script: LINUX_CLI_SCRIPT,
  });
  assert.match(LINUX_CLI_SCRIPT, /exec xdg-open "\$url"/);
  assert.match(LINUX_CLI_SCRIPT, /exec gio open "\$url"/);
  assert.ok(isCliScript(LINUX_CLI_SCRIPT));
});

test("the Linux command hands xdg-open the exact folder URL", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aic-linux-cli-script-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  const project = path.join(root, "project ü");
  const command = path.join(root, "aic");
  const opened = path.join(root, "opened-url");
  await Promise.all([mkdir(bin), mkdir(project)]);
  await Promise.all([
    writeFile(command, LINUX_CLI_SCRIPT, "utf8"),
    writeFile(path.join(bin, "xdg-open"), "#!/bin/sh\nprintf %s \"$1\" > \"$AIC_TEST_OUTPUT\"\n", "utf8"),
  ]);
  await Promise.all([chmod(command, 0o755), chmod(path.join(bin, "xdg-open"), 0o755)]);

  execFileSync(command, [project], {
    env: { ...process.env, AIC_TEST_OUTPUT: opened, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
  });
  assert.equal(projectPathFromUrl(await readFile(opened, "utf8")), project);
});

test("CLI platform configuration preserves macOS and rejects unsupported systems", () => {
  assert.deepEqual(cliConfiguration("darwin", "/Users/me"), { installPath: "/usr/local/bin/aic", script: CLI_SCRIPT });
  assert.equal(cliConfiguration("win32", "C:\\Users\\me"), null);
  assert.equal(cliConfiguration("linux", "relative/home"), null);
});
