import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import { DictationHost, dictationHelper } from "../../src/main/dictation-host.ts";
import { dictationModelPlace } from "../../src/main/dictation-models.ts";

/** The macOS model's files, handed to every host so these run on any computer. */
const MODEL_FILES = ["Preprocessor.mlmodelc", "Encoder.mlmodelc", "Decoder.mlmodelc", "JointDecision.mlmodelc", "parakeet_vocab.json"];
const folders: string[] = [];
const hosts: DictationHost[] = [];

/** A helper that answers like the real one: it hears "said" on start and writes it down on stop. */
const FAKE_HELPER = `#!/usr/bin/env node
const rl = require("node:readline").createInterface({ input: process.stdin });
const heardFile = require("node:path").join(__dirname, "heard.log");
const say = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let listening = null;
rl.on("line", (line) => {
  const request = JSON.parse(line);
  require("node:fs").appendFileSync(heardFile, request.op + "\\n");
  if (request.op === "start") { listening = request.id; say({ type: "level", id: request.id, value: 0.5 }); say({ type: "started", id: request.id }); }
  else if (request.op === "stop") { listening = null; say({ type: "text", id: request.id, text: process.env.FAKE_SAYS ?? "said" }); }
  else if (request.op === "cancel") { listening = null; say({ type: "cancelled", id: request.id }); }
  else if (request.op === "transcribe") say({ type: "text", id: request.id, text: require("node:fs").existsSync(request.path) ? "from file" : "" });
  else if (request.op === "download" && process.env.SLOW_DOWNLOAD) { say({ type: "model", state: "downloading", progress: 0.1 }); }
  else if (request.op === "download") { say({ type: "model", state: "downloading", progress: 0.5 }); say({ type: "model", state: "downloading" }); say({ type: "model", state: "ready" }); }
  else if (request.op === "crash") process.exit(1);
});
`;

function completeModel(models: string) {
  for (const file of ["Preprocessor.mlmodelc", "Encoder.mlmodelc", "Decoder.mlmodelc", "JointDecision.mlmodelc"]) mkdirSync(path.join(models, file), { recursive: true });
  writeFileSync(path.join(models, "parakeet_vocab.json"), "{}");
}

function setup(options: { models?: boolean; microphone?: () => Promise<boolean>; runtime?: { command: string; env: Record<string, string> } } = {}) {
  const folder = mkdtempSync(path.join(os.tmpdir(), "aic-dictation-test-"));
  folders.push(folder);
  const helper = path.join(folder, "aic-dictation");
  writeFileSync(helper, FAKE_HELPER);
  if (!options.runtime) chmodSync(helper, 0o755);
  const models = path.join(folder, "models");
  if (options.models !== false) completeModel(models);
  const host = new DictationHost({
    helper: { file: helper, ...(options.runtime ? { runtime: options.runtime } : {}) },
    models,
    place: { folder: models, files: MODEL_FILES },
    microphone: options.microphone ?? (async () => true),
  });
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

test("the model reads as ready only when its files are in the shared folder", () => {
  const seen: string[] = [];
  setup().onDictationModel(({ model }) => seen.push(model));
  setup({ models: false }).onDictationModel(({ model }) => seen.push(model));
  assert.deepEqual(seen, ["ready", "missing"]);
});

test("a hold hears levels, and letting go answers with the words", async () => {
  const host = setup();
  const levels: number[] = [];
  host.onDictationLevel((level) => levels.push(level));
  await host.startDictation("hold-1");
  assert.equal(await host.stopDictation("hold-1"), "said");
  assert.ok(levels.includes(0.5));
  await assert.rejects(host.stopDictation("hold-1"), /Nothing is listening/);
});

test("letting go while the microphone is still being asked for stops it once it starts", async () => {
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

test("a refused microphone ends the hold with how to allow it", async () => {
  const host = setup({ microphone: async () => false });
  await assert.rejects(host.startDictation("hold-4"), /System Settings/);
  await assert.rejects(host.stopDictation("hold-4"), /Nothing is listening/);
});

test("a phone's recording must be a small WAV before it reaches the helper", async () => {
  const host = setup();
  assert.equal(await host.transcribeAudio(wav()), "from file");
  await assert.rejects(host.transcribeAudio(Buffer.from("not a wav file").toString("base64")), /unreadable/);
});

test("nothing is heard without the model, and a headless host has no microphone", async () => {
  await assert.rejects(setup({ models: false }).transcribeAudio(wav()), /not ready/);
  const headless = new DictationHost({ helper: { file: "/nonexistent" }, place: { folder: "/nonexistent-models", files: MODEL_FILES } });
  hosts.push(headless);
  await assert.rejects(headless.startDictation("x"), /no dictation helper/);
});

test("a download reports how much has arrived, then preparing, then ready", async () => {
  const host = setup({ models: false });
  const seen: string[] = [];
  host.onDictationModel(({ model, progress }) => seen.push(progress === undefined ? model : `${model} ${progress}`));
  await host.downloadDictationModel();
  for (let tries = 0; tries < 100 && seen.at(-1) !== "ready"; tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(seen, ["missing", "downloading 0", "downloading 0.5", "downloading", "ready"]);
});

test("cancelling a download stops the helper and removes the partial model", async () => {
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

test("a model without its vocabulary is not ready, so the download is offered", () => {
  const host = setup();
  rmSync(path.join(folders.at(-1)!, "models", "parakeet_vocab.json"));
  const seen: string[] = [];
  host.onDictationModel(({ model }) => seen.push(model));
  assert.deepEqual(seen, ["missing"]);
});

test("cancelling keeps a model that became complete during the download", async () => {
  process.env.SLOW_DOWNLOAD = "1";
  try {
    const host = setup({ models: false });
    const seen: string[] = [];
    host.onDictationModel(({ model }) => seen.push(model));
    await host.downloadDictationModel();
    const models = path.join(folders.at(-1)!, "models");
    completeModel(models);
    await host.cancelDictationDownload();
    assert.equal(seen.at(-1), "ready");
    assert.equal(existsSync(path.join(models, "parakeet_vocab.json")), true);
  } finally {
    delete process.env.SLOW_DOWNLOAD;
  }
});

test("a hold that fails to start tells the helper to drop it", async () => {
  let allowed = true;
  const host = setup({ microphone: async () => allowed });
  await host.startDictation("first");
  await host.stopDictation("first");
  allowed = false;
  await assert.rejects(host.startDictation("second"), /System Settings/);
  const heard = path.join(folders.at(-1)!, "heard.log");
  for (let tries = 0; tries < 100 && !readFileSync(heard, "utf8").includes("cancel"); tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(readFileSync(heard, "utf8").trim().split("\n"), ["start", "stop", "cancel"]);
});

test("a computer with no place for the model can't dictate, and says what it needs", async () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "aic-dictation-test-"));
  folders.push(folder);
  const host = new DictationHost({ helper: { file: path.join(folder, "aic-dictation") }, place: null, microphone: async () => true });
  hosts.push(host);
  const seen: string[] = [];
  host.onDictationModel(({ model, message }) => seen.push(`${model}: ${message}`));
  assert.deepEqual(seen, ["unsupported: Dictation needs Linux or a Mac with Apple silicon."]);
  await assert.rejects(host.startDictation("x"), /Linux or a Mac/);
});

test("a helper that is a script runs through its runtime, with the runtime's environment", async () => {
  const host = setup({ runtime: { command: process.execPath, env: { FAKE_SAYS: "through the runtime" } } });
  await host.startDictation("hold-1");
  assert.equal(await host.stopDictation("hold-1"), "through the runtime");
});

test("Linux runs the helper script beside the host, and macOS its built program", () => {
  const linux = dictationHelper("/app/native", true, "linux");
  assert.equal(path.basename(linux.file), "dictation-linux-helper.js");
  assert.deepEqual(linux.runtime, { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } });
  assert.deepEqual(dictationHelper("/app/native", true, "darwin"), { file: "/app/native/aic-dictation" });
  assert.deepEqual(dictationHelper("/app/native", false, "darwin"), { file: "/app/native/aic-dictation-dev" });
});

test("the model has a place on Apple silicon and on Linux, in XDG_DATA_HOME when it is absolute", () => {
  const was = process.env.XDG_DATA_HOME;
  try {
    process.env.XDG_DATA_HOME = "/data";
    assert.equal(dictationModelPlace("linux", "x64")?.folder, "/data/aicodingtool/models/parakeet-tdt-0.6b-v2-int8");
    assert.deepEqual(dictationModelPlace("linux", "arm64")?.files, ["nemo128.onnx", "encoder-model.int8.onnx", "decoder_joint-model.int8.onnx", "vocab.txt"]);
    process.env.XDG_DATA_HOME = "relative";
    assert.equal(dictationModelPlace("linux", "x64")?.folder, path.join(os.homedir(), ".local", "share", "aicodingtool", "models", "parakeet-tdt-0.6b-v2-int8"));
  } finally {
    if (was === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = was;
  }
  assert.ok(dictationModelPlace("darwin", "arm64")?.folder.endsWith(path.join("FluidAudio", "Models", "parakeet-tdt-0.6b-v2-coreml")));
  assert.equal(dictationModelPlace("darwin", "x64"), null);
  assert.equal(dictationModelPlace("win32", "x64"), null);
});
