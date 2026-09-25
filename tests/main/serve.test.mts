import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "vitest";
import { MOBILE_HEALTH_RESPONSE } from "../../src/main/mobile/addresses.mts";

const entry = path.join(process.cwd(), "dist", "main", "main", "serve.js");

/** Runs the built entry the way the installed command does, apart from the app's own Node. */
function serve(userData: string, ...args: string[]) {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", entry, "serve", "--dev", "--local", "--user-data", userData, "--port", "0", ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  async function until(pattern: RegExp, what: string) {
    const deadline = Date.now() + 20_000;
    while (!pattern.test(output)) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}. Output so far:\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return pattern.exec(output)!;
  }
  return { child, output: () => output, exited, until };
}

test.skipIf(!existsSync(entry))("aic serve runs the workspace headless, hands out pairing codes, and stops on a signal", async (t) => {
  const userData = await mkdtemp(path.join(os.tmpdir(), "aicodingtool-serve-"));
  t.onTestFinished(() => rm(userData, { recursive: true, force: true }));
  const server = serve(userData);
  t.onTestFinished(() => { if (server.child.exitCode === null) server.child.kill("SIGKILL"); });

  const [, port] = await server.until(/Listening on port (\d+)\./, "the bridge to listen");
  const health = await fetch(`http://127.0.0.1:${port}/m/health`);
  assert.equal(await health.text(), MOBILE_HEALTH_RESPONSE);

  const { stdout } = await promisify(execFile)(process.execPath, ["--disable-warning=ExperimentalWarning", entry, "pair", "--dev", "--user-data", userData]);
  assert.match(stdout, /Pair with code [0-9A-HJKMNP-TV-Z]{8} .*http:\/\/127\.0\.0\.1:\d+\/m\/#pair=/);

  const second = serve(userData);
  assert.notEqual(await second.exited, 0, "a second server on the same data refuses to start");
  assert.match(second.output(), /already serving/);

  server.child.kill("SIGINT");
  assert.equal(await server.exited, 0);
  assert.equal(existsSync(path.join(userData, "serve.lock")), false, "a stopped server leaves no lock behind");
  assert.equal(existsSync(path.join(userData, "tasks.v3.sqlite")), true, "the same store the desktop app would open");
});
