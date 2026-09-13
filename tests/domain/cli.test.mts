import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  CLI_INSTALL_PATH,
  cliConfiguration,
  isCliScript,
  linuxCliScript,
  macCliScript,
  projectPathFromArgv,
  projectPathFromUrl,
  SERVE_BOOTSTRAP,
} from "../../src/domain/cli.ts";

const CLI_SCRIPT = macCliScript("/Applications/AI Coding Tool.app/Contents/MacOS/AI Coding Tool");
const LINUX_CLI_SCRIPT = linuxCliScript("/home/me/Applications/AI-Coding-Tool.AppImage");

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
  assert.ok(isCliScript("#!/bin/sh\n# aic-cli v1\n"), "a script from before serve is still ours");
  assert.ok(!isCliScript("#!/bin/sh\necho hi\n"));
  assert.ok(CLI_SCRIPT.startsWith("#!/bin/sh\n"));
  assert.match(CLI_SCRIPT, /exec open "aicodingtool:\/\/open\?path=\$encoded"/);
  assert.match(CLI_SCRIPT, /ELECTRON_RUN_AS_NODE=1 '\/Applications\/AI Coding Tool.app\/Contents\/MacOS\/AI Coding Tool' -e/);
  assert.match(macCliScript(null), /this install cannot serve/);
  assert.equal(CLI_INSTALL_PATH, "/usr/local/bin/aic");
});

test("Linux installs in the user's local bin and opens the URL through the desktop", () => {
  assert.deepEqual(cliConfiguration("linux", "/home/me", "/home/me/Applications/AI-Coding-Tool.AppImage"), {
    installPath: "/home/me/.local/bin/aic",
    script: LINUX_CLI_SCRIPT,
  });
  assert.match(LINUX_CLI_SCRIPT, /exec xdg-open "\$url"/);
  assert.match(LINUX_CLI_SCRIPT, /exec gio open "\$url"/);
  assert.ok(isCliScript(LINUX_CLI_SCRIPT));
});

test.for([
  { name: "prefers gio when both openers are installed", gio: true, gioStatus: 0, opener: "gio", status: 0 },
  { name: "uses xdg-open when gio is unavailable", gio: false, gioStatus: 0, opener: "xdg-open", status: 0 },
  { name: "reports gio failures without falling back to a browser", gio: true, gioStatus: 42, opener: "gio", status: 42 },
])("the Linux command $name", { skip: process.platform === "win32" }, async ({ gio, gioStatus, opener, status }, t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aic-linux-cli-script-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  const project = path.join(root, "project ü");
  const command = path.join(root, "aic");
  const opened = path.join(root, "opened-url");
  await Promise.all([mkdir(bin), mkdir(project)]);
  await Promise.all([
    writeFile(command, LINUX_CLI_SCRIPT, "utf8"),
    writeFile(path.join(bin, "xdg-open"), '#!/bin/sh\nprintf "xdg-open\\n%s\\n" "$1" > "$AIC_TEST_OUTPUT"\n', { mode: 0o755 }),
    ...(gio ? [writeFile(path.join(bin, "gio"), `#!/bin/sh\nprintf 'gio\\n%s\\n%s\\n' "$1" "$2" > "$AIC_TEST_OUTPUT"\nexit ${gioStatus}\n`, { mode: 0o755 })] : []),
    ...["base64", "tr"].map((tool) => symlink(execFileSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim(), path.join(bin, tool))),
  ]);
  await chmod(command, 0o755);

  const result = spawnSync(command, [project], {
    env: { ...process.env, AIC_TEST_OUTPUT: opened, PATH: bin },
    encoding: "utf8",
  });
  assert.ifError(result.error);
  assert.equal(result.status, status, result.stderr);
  const [actualOpener, ...args] = (await readFile(opened, "utf8")).trim().split("\n");
  assert.equal(actualOpener, opener);
  assert.deepEqual(args, opener === "gio" ? ["open", urlFor(project)] : [urlFor(project)]);
});

test("CLI platform configuration preserves macOS and rejects unsupported systems", () => {
  assert.deepEqual(cliConfiguration("darwin", "/Users/me", "/Applications/AI Coding Tool.app/Contents/MacOS/AI Coding Tool"), { installPath: "/usr/local/bin/aic", script: CLI_SCRIPT });
  assert.equal(cliConfiguration("win32", "C:\\Users\\me"), null);
  assert.equal(cliConfiguration("linux", "relative/home"), null);
});

test("the command hands serve and pair to the app running as Node, with the arguments intact", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aic-serve-script-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const app = path.join(root, "app '$(false)");
  const command = path.join(root, "aic");
  const seen = path.join(root, "seen");
  await writeFile(app, `#!/bin/sh\nprintf '%s\\n' "$ELECTRON_RUN_AS_NODE" "$@" > "${seen}"\n`, { mode: 0o755 });
  await writeFile(command, linuxCliScript(app), { mode: 0o755 });
  const result = spawnSync(command, ["serve", "--port", "0"], { encoding: "utf8" });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const lines = (await readFile(seen, "utf8")).trimEnd().split("\n");
  assert.equal(lines[0], "1");
  assert.equal(lines[1], "-e");
  assert.match(lines[2] ?? "", /app\.asar/);
  assert.deepEqual(lines.slice(3), ["--", "serve", "--port", "0"]);
});

test("the bootstrap finds the serve entry beside the app binary and starts it as the command", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aic-bootstrap-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const entry = path.join(root, "resources", "app.asar", "dist", "main", "main", "serve.js");
  await mkdir(path.dirname(entry), { recursive: true });
  await writeFile(entry, "exports.cli = function () { console.log(JSON.stringify(['started', ...process.argv.slice(1)])); };\n");
  const binary = path.join(root, "app");
  await writeFile(binary, `process.execPath = ${JSON.stringify(binary)};\n`);
  const started = spawnSync(process.execPath, ["-r", binary, "-e", SERVE_BOOTSTRAP, "--", "serve", "--port", "0"], { encoding: "utf8" });
  assert.equal(started.status, 0, started.stderr);
  assert.deepEqual(JSON.parse(started.stdout.trim()), ["started", "serve", "--port", "0"]);
  const alone = spawnSync(process.execPath, ["-e", SERVE_BOOTSTRAP, "--", "serve"], { encoding: "utf8" });
  assert.equal(alone.status, 1);
  assert.match(alone.stderr, /could not find AI Coding Tool beside/);
});
