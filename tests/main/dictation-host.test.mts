import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
