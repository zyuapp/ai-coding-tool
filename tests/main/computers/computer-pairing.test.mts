import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "vitest";
import type { WorkspaceCommandResult, WorkspaceInput } from "../../../src/application/workspace-reducer.ts";
import { registered, startMainProcess, waitFor } from "../../support/electron-harness.mjs";

type IpcEvent = { sender: unknown };

const entry = path.join(process.cwd(), "dist", "main", "main", "serve.js");

/** What the served host was named in the app that shares its data folder, which is what it tells the computers that pair with it. */
const SERVED_NAME = "Build box";

/** A headless host on this machine's loopback, the way a test can have one without a tailnet. */
async function servedHost(t: { onTestFinished(callback: () => void | Promise<void>): void }) {
  const userData = await mkdtemp(path.join(os.tmpdir(), "aicodingtool-served-"));
  await writeFile(path.join(userData, "computers.v1.json"), JSON.stringify({ version: 1, name: SERVED_NAME, computers: [] }));
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", entry, "serve", "--dev", "--local", "--user-data", userData, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  t.onTestFinished(async () => {
    child.kill("SIGINT");
    await new Promise((resolve) => child.once("exit", resolve));
    await rm(userData, { recursive: true, force: true });
  });
  await waitFor(() => /Listening on port \d+\./.test(output), `the served host to listen:\n${output}`);
  const port = /Listening on port (\d+)\./.exec(output)![1]!;
  const code = async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ["--disable-warning=ExperimentalWarning", entry, "pair", "--dev", "--user-data", userData]);
    return /code ([0-9A-HJKMNP-TV-Z]{8})/.exec(stdout)![1]!;
  };
  return { host: `127.0.0.1:${port}`, code };
}

test.skipIf(!existsSync(entry))("the app pairs with a served host by its code and holds that host's workspace beside its own", async (t) => {
  const served = await servedHost(t);
  const main = await startMainProcess(t, "aicodingtool-pairing-");
  const request = (input: WorkspaceInput) => registered<(event: IpcEvent, input?: WorkspaceInput) => Promise<WorkspaceCommandResult>>(main.handlers, "workspace-runtime:request")(main.trusted, input);
  const state = () => main.runtimeState();
  assert.equal((await state()).computers.name, os.hostname().replace(/\.local$/, ""));

  await request({ type: "computers.pair", host: served.host, name: "linux-box", code: "" });
  assert.deepEqual((await state()).computers.pairing, { host: served.host, name: "linux-box", busy: false, error: null }, "asking to pair opens the card the code goes in");
  await request({ type: "computers.pair", host: served.host, name: "linux-box", code: "WRONGCOD" });
  await waitFor(async () => (await state()).computers.pairing?.error !== null, "a wrong code being refused");
  assert.match((await state()).computers.pairing?.error ?? "", /expired/);

  await request({ type: "computers.pair", host: served.host, name: "linux-box", code: await served.code() });
  await waitFor(async () => (await state()).computers.paired[0]?.status === "connected", "the line coming up");
  await waitFor(async () => (await state()).computers.paired[0]?.name === SERVED_NAME, "the served host's own name replacing the one it was paired under");
  const paired = (await state()).computers.paired[0]!;
  assert.equal((await state()).computers.pairing, null, "the card closes once the computer is paired");
  await waitFor(async () => (await state()).computers.paired[0]?.state?.restored === true, "the served host's workspace arriving");
  assert.deepEqual((await state()).computers.paired[0]?.state?.threads, [], "a fresh host has no threads yet");

  await request({ type: "computers.forget", id: paired.id });
  await waitFor(async () => (await state()).computers.paired.length === 0, "the computer being forgotten");
});
