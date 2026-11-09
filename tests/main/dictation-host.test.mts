import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import { DictationHost } from "../../src/main/dictation-host.ts";

const appleSilicon = process.platform === "darwin" && process.arch === "arm64";
const folders: string[] = [];
const hosts: DictationHost[] = [];

/** A helper that answers like the real one: it hears "said" on start and writes it down on stop. */
const FAKE_HELPER = `#!/usr/bin/env node
const rl = require("node:readline").createInterface({ input: process.stdin });
const say = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let listening = null;
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.op === "start") { listening = request.id; say({ type: "level", id: request.id, value: 0.5 }); say({ type: "started", id: request.id }); }
  else if (request.op === "stop") { listening = null; say({ type: "text", id: request.id, text: "said" }); }
  else if (request.op === "cancel") { listening = null; say({ type: "cancelled", id: request.id }); }
  else if (request.op === "transcribe") say({ type: "text", id: request.id, text: require("node:fs").existsSync(request.path) ? "from file" : "" });
  else if (request.op === "download" && process.env.SLOW_DOWNLOAD) { say({ type: "model", state: "downloading", progress: 0.1 }); }
  else if (request.op === "download") { say({ type: "model", state: "downloading", progress: 0.5 }); say({ type: "model", state: "downloading" }); say({ type: "model", state: "ready" }); }
  else if (request.op === "crash") process.exit(1);
});
`;

function setup(options: { models?: boolean; microphone?: () => Promise<boolean> } = {}) {
  const folder = mkdtempSync(path.join(os.tmpdir(), "aic-dictation-test-"));
  folders.push(folder);
  const helper = path.join(folder, "aic-dictation");
  writeFileSync(helper, FAKE_HELPER);
  chmodSync(helper, 0o755);
  const models = path.join(folder, "models");
  if (options.models !== false) {
    for (const file of ["Preprocessor.mlmodelc", "Encoder.mlmodelc", "Decoder.mlmodelc", "JointDecision.mlmodelc"]) mkdirSync(path.join(models, file), { recursive: true });
  }
  const host = new DictationHost({ helper, models, microphone: options.microphone ?? (async () => true) });
  hosts.push(host);
  return host;
}

function wav() {
  const bytes = Buffer.alloc(44);
  bytes.write("RIFF", 0, "ascii");
  bytes.write("WAVE", 8, "ascii");
  return bytes.toString("base64");
}

afterEach(() => {
  for (const host of hosts.splice(0)) host.stop();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

test("the model reads as ready only when its files are in the shared folder", { skip: !appleSilicon }, () => {
  const seen: string[] = [];
  setup().onDictationModel(({ model }) => seen.push(model));
  setup({ models: false }).onDictationModel(({ model }) => seen.push(model));
  assert.deepEqual(seen, ["ready", "missing"]);
});

test("a hold hears levels, and letting go answers with the words", { skip: !appleSilicon }, async () => {
  const host = setup();
  const levels: number[] = [];
  host.onDictationLevel((level) => levels.push(level));
  await host.startDictation("hold-1");
  assert.equal(await host.stopDictation("hold-1"), "said");
  assert.ok(levels.includes(0.5));
  await assert.rejects(host.stopDictation("hold-1"), /Nothing is listening/);
});

test("letting go while the microphone is still being asked for stops it once it starts", { skip: !appleSilicon }, async () => {
  let allow: (granted: boolean) => void = () => {};
  let asked = false;
  const host = setup({ microphone: () => asked ? Promise.resolve(true) : new Promise((resolve) => { asked = true; allow = resolve; }) });
  const started = host.startDictation("hold-2");
  const stopped = host.stopDictation("hold-2");
  allow(true);
  await started;
  assert.equal(await stopped, "said");
  await host.startDictation("hold-3");
  await host.cancelDictation("hold-3");
});

test("a refused microphone ends the hold with how to allow it", { skip: !appleSilicon }, async () => {
  const host = setup({ microphone: async () => false });
  await assert.rejects(host.startDictation("hold-4"), /System Settings/);
  await assert.rejects(host.stopDictation("hold-4"), /Nothing is listening/);
});

test("a phone's recording must be a small WAV before it reaches the helper", { skip: !appleSilicon }, async () => {
  const host = setup();
  assert.equal(await host.transcribeAudio(wav()), "from file");
  await assert.rejects(host.transcribeAudio(Buffer.from("not a wav file").toString("base64")), /unreadable/);
});

test("nothing is heard without the model, and a headless host has no microphone", { skip: !appleSilicon }, async () => {
  await assert.rejects(setup({ models: false }).transcribeAudio(wav()), /not ready/);
  const headless = new DictationHost({ helper: "/nonexistent" });
  hosts.push(headless);
  await assert.rejects(headless.startDictation("x"), /no dictation helper/);
});

test("a download reports how much has arrived, then preparing, then ready", { skip: !appleSilicon }, async () => {
  const host = setup({ models: false });
  const seen: string[] = [];
  host.onDictationModel(({ model, progress }) => seen.push(progress === undefined ? model : `${model} ${progress}`));
  await host.downloadDictationModel();
  for (let tries = 0; tries < 100 && seen.at(-1) !== "ready"; tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(seen, ["missing", "downloading 0", "downloading 0.5", "downloading", "ready"]);
});

test("cancelling a download stops the helper and removes the partial model", { skip: !appleSilicon }, async () => {
  process.env.SLOW_DOWNLOAD = "1";
  try {
    const host = setup({ models: false });
    const seen: string[] = [];
    host.onDictationModel(({ model }) => seen.push(model));
    await host.downloadDictationModel();
    const partial = path.join(folders.at(-1)!, "models");
    mkdirSync(path.join(partial, "Encoder.mlmodelc"), { recursive: true });
    await host.cancelDictationDownload();
    assert.equal(seen.at(-1), "missing");
    assert.equal(existsSync(partial), false);
  } finally {
    delete process.env.SLOW_DOWNLOAD;
  }
});
