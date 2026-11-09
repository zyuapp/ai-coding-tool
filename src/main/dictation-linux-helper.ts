/**
 * Holding to talk, on Linux: records the microphone through PipeWire, PulseAudio or ALSA, and transcribes
 * speech with Parakeet through ONNX Runtime. It runs in a process of its own and speaks the macOS helper's
 * lines (native/dictation), so DictationHost drives both alike.
 *
 * In:  {"op":"download"} {"op":"start","id"} {"op":"stop","id"} {"op":"cancel","id"} {"op":"transcribe","id","path"}
 * Out: {"type":"model","state":"ready"|"downloading"|"failed","message"?,"progress"?}
 *      {"type":"started","id"} {"type":"level","id","value"} {"type":"text","id","text"}
 *      {"type":"cancelled","id"} {"type":"error","id"?,"message"}
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, statSync } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebStream } from "node:stream/web";
import { Worker } from "node:worker_threads";
import { audioLevel, pcm16Samples, resampled, wavSamples } from "./dictation-audio.js";
import { LINUX_MODEL_FILES, dictationModelPlace } from "./dictation-models.js";
import { PARAKEET_FILES, PARAKEET_SAMPLE_RATE as SAMPLE_RATE } from "./parakeet-onnx.js";

/** Five minutes; anything past it is dropped. */
const MAX_RECORDING_BYTES = SAMPLE_RATE * 2 * 300;
const LEVEL_INTERVAL_MS = 50;
/** How long a recorder has to hear anything before the next one is tried. */
const FIRST_SOUND_MS = 2_500;
const STOP_GRACE_MS = 1_000;

/** Parakeet TDT 0.6B v2's ONNX export, pinned to one revision, with each file's size and checksum. */
const MODEL_SOURCE = "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v2-onnx/resolve/0bbb45a3365852604aef28b538a8f066f4ccaa85";
const MODEL_DOWNLOADS = [
  { file: PARAKEET_FILES.preprocessor, bytes: 139_764, sha256: "a9fde1486ebfcc08f328d75ad4610c67835fea58c73ba57e3209a6f6cf019e9f" },
  { file: PARAKEET_FILES.encoder, bytes: 652_184_014, sha256: "3e0581fda6ab843888b51e56d7ee78b6d5bc3237ec113af1f732d1d5286aa155" },
  { file: PARAKEET_FILES.decoder, bytes: 8_998_286, sha256: "a449f49acd68979d418651dd2dcb737cc0f1bf0225e009e29ee326354edbf7d3" },
  { file: PARAKEET_FILES.vocabulary, bytes: 9_384, sha256: "ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d" },
];
/** Where a download is put together, inside the model's folder so a cancelled one goes with it. */
const STAGING = ".download";

/** Raw 16 kHz mono 16-bit sound on stdout, from whichever sound system is there, in this order. */
const RECORDERS = [
  { command: "pw-record", args: ["--rate", "16000", "--channels", "1", "--format", "s16", "--raw", "-"] },
  { command: "parecord", args: ["--raw", "--rate=16000", "--channels=1", "--format=s16le"] },
  { command: "arecord", args: ["-q", "-t", "raw", "-f", "S16_LE", "-r", "16000", "-c", "1"] },
];
const NO_RECORDER = "Dictation needs pw-record, parecord or arecord to hear the microphone.";

type Request = { op?: unknown; id?: unknown; path?: unknown };

const folder = (() => {
  const at = process.argv.indexOf("--models");
  if (at >= 0 && process.argv[at + 1]) return path.resolve(process.argv[at + 1]!);
  const place = dictationModelPlace();
  if (!place) throw new Error("This computer has no place for the speech model.");
  return place.folder;
})();

function emit(message: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function fail(id: string | undefined, message: string) {
  emit(id ? { type: "error", id, message } : { type: "error", message });
}

function reason(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** A recorder a quit leaves behind keeps the microphone open, so it goes with it. */
const children = new Set<ChildProcess>();

function track(child: ChildProcess) {
  children.add(child);
  child.once("close", () => children.delete(child));
  return child;
}

function modelComplete() {
  return LINUX_MODEL_FILES.every((file) => {
    try {
      return statSync(path.join(folder, file)).size > 0;
    } catch {
      return false;
    }
  });
}

/** The model, loading or loaded on its worker; transcriptions wait for it there. */
class Model {
  private readonly worker: Worker;
  private readonly waiting = new Map<number, { resolve: (text: string) => void; reject: (error: Error) => void }>();
  private next = 0;

  constructor(onGone: () => void) {
    const threads = Math.min(4, Math.max(1, Math.floor(os.availableParallelism() / 2)));
    this.worker = new Worker(path.join(__dirname, "parakeet-worker.js"), { workerData: { folder, threads } });
    this.worker.on("message", ({ id, text, error }: { id: number; text?: string; error?: string }) => {
      const waiter = this.waiting.get(id);
      this.waiting.delete(id);
      if (error === undefined) waiter?.resolve(text ?? "");
      else waiter?.reject(new Error(`The speech model could not run: ${error}`));
    });
    const gone = (error: Error) => {
      onGone();
      for (const waiter of this.waiting.values()) waiter.reject(error);
      this.waiting.clear();
    };
    this.worker.on("error", (error: unknown) => gone(new Error(`The speech model could not run: ${reason(error)}`)));
    this.worker.on("exit", () => gone(new Error("The speech model stopped.")));
  }

  transcribe(samples: Float32Array): Promise<string> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker.postMessage({ id, samples }, [samples.buffer as ArrayBuffer]);
    });
  }
}

let model: Model | null = null;

/** Starts loading the model once, off this thread, so recording goes ahead while it loads. */
function loadModel(): Model {
  if (!modelComplete()) throw new Error("The speech model is not downloaded.");
  const created = model ?? new Model(() => { if (model === created) model = null; });
  model = created;
  return created;
}

/** Under a quarter second is nothing said; under a second is padded with silence, which Parakeet needs. */
async function transcribe(sound: Float32Array, sampleRate: number): Promise<string> {
  const samples = resampled(sound, sampleRate, SAMPLE_RATE);
  if (samples.length < SAMPLE_RATE / 4) return "";
  let padded = samples;
  if (samples.length < SAMPLE_RATE) {
    padded = new Float32Array(SAMPLE_RATE);
    padded.set(samples);
  }
  return loadModel().transcribe(padded);
}

/** One recording: its sound so far, and the levels it reports while it lasts. */
class Recording {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private heard: Buffer[] = [];
  private lastLevel = 0;
  private closed = false;

  private constructor(readonly id: string, private readonly child: ChildProcess) {
    child.once("close", () => { this.closed = true; });
  }

  /** Tries each recorder until one hears something. */
  static async open(id: string): Promise<Recording> {
    let refusal: string | null = null;
    for (const { command, args } of RECORDERS) {
      const opened = await new Promise<Recording | string | null>((resolve) => {
        const child = track(spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] }));
        const recording = new Recording(id, child);
        let said = "";
        let live = false;
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve("The microphone did not start.");
        }, FIRST_SOUND_MS);
        child.stderr!.on("data", (chunk: Buffer) => { said = `${said}${chunk.toString()}`.slice(-400); });
        child.stdout!.on("data", (chunk: Buffer) => {
          if (!live) {
            live = true;
            clearTimeout(timer);
            resolve(recording);
          }
          recording.take(chunk);
        });
        child.once("error", (error: NodeJS.ErrnoException) => {
          clearTimeout(timer);
          resolve(error.code === "ENOENT" ? null : `The microphone could not start: ${error.message}`);
        });
        child.once("close", () => {
          clearTimeout(timer);
          const last = said.trim().split("\n").pop();
          resolve(last ? `The microphone could not start: ${last}` : "The microphone could not start.");
        });
      });
      if (opened instanceof Recording) return opened;
      refusal ??= opened;
    }
    throw new Error(refusal ?? NO_RECORDER);
  }

  private take(chunk: Buffer) {
    const room = MAX_RECORDING_BYTES - this.bytes;
    if (room > 0) {
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
      this.chunks.push(kept);
      this.bytes += kept.length;
    }
    this.heard.push(chunk);
    const now = Date.now();
    if (now - this.lastLevel < LEVEL_INTERVAL_MS) return;
    this.lastLevel = now;
    const level = audioLevel(pcm16Samples(Buffer.concat(this.heard)));
    this.heard = [];
    emit({ type: "level", id: this.id, value: level });
  }

  /** Stops the recorder and waits for the last of its sound. */
  async stop(): Promise<Float32Array> {
    if (!this.closed) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => this.child.kill("SIGKILL"), STOP_GRACE_MS);
        this.child.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        this.child.kill("SIGINT");
      });
    }
    return pcm16Samples(Buffer.concat(this.chunks));
  }
}

let recording: Recording | null = null;

async function start(id: string) {
  if (recording) return fail(id, "Dictation is already recording.");
  if (!modelComplete()) return fail(id, "The speech model is not downloaded.");
  loadModel();
  try {
    recording = await Recording.open(id);
  } catch (error) {
    return fail(id, reason(error));
  }
  emit({ type: "started", id });
}

async function stop(id: string) {
  const taken = recording;
  if (!taken || taken.id !== id) return fail(id, "Nothing is recording.");
  recording = null;
  try {
    emit({ type: "text", id, text: await transcribe(await taken.stop(), SAMPLE_RATE) });
  } catch (error) {
    fail(id, reason(error));
  }
}

async function cancel(id: string) {
  const taken = recording;
  if (taken && taken.id === id) {
    recording = null;
    await taken.stop();
  }
  emit({ type: "cancelled", id });
}

async function transcribeFile(id: string, file: string) {
  try {
    const { samples, sampleRate } = wavSamples(await readFile(file));
    emit({ type: "text", id, text: await transcribe(samples, sampleRate) });
  } catch (error) {
    fail(id, reason(error));
  }
}

let downloading = false;

/** One file into the staging folder, checked against its pinned checksum as it arrives. */
async function fetchModelFile(source: (typeof MODEL_DOWNLOADS)[number], staging: string, arrived: (bytes: number) => void) {
  const response = await fetch(`${MODEL_SOURCE}/${source.file}`);
  if (!response.ok || !response.body) throw new Error(`The download was refused (${response.status}).`);
  const hash = createHash("sha256");
  const counted = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      arrived(chunk.length);
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body as WebStream<Uint8Array>), counted, createWriteStream(path.join(staging, source.file), { mode: 0o600 }));
  if (hash.digest("hex") !== source.sha256) throw new Error("The downloaded speech model didn't match its checksum.");
}

/** Reports whole percents while the files arrive; the model is ready once every one is checked and in place. */
async function download() {
  if (downloading) return;
  downloading = true;
  emit({ type: "model", state: "downloading", progress: 0 });
  const staging = path.join(folder, STAGING);
  const total = MODEL_DOWNLOADS.reduce((sum, source) => sum + source.bytes, 0);
  let received = 0;
  let reported = 0;
  const arrived = (bytes: number) => {
    received += bytes;
    const percent = Math.min(99, Math.floor((received / total) * 100));
    if (percent === reported) return;
    reported = percent;
    emit({ type: "model", state: "downloading", progress: percent / 100 });
  };
  try {
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true, mode: 0o700 });
    for (const source of MODEL_DOWNLOADS) await fetchModelFile(source, staging, arrived);
    for (const { file } of MODEL_DOWNLOADS) await rename(path.join(staging, file), path.join(folder, file));
    await rm(staging, { recursive: true, force: true });
    emit({ type: "model", state: "ready" });
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    emit({ type: "model", state: "failed", message: reason(error) });
  } finally {
    downloading = false;
  }
}

function parse(line: string): Request | null {
  try {
    const request: unknown = JSON.parse(line);
    return request && typeof request === "object" ? request as Request : null;
  } catch {
    return null;
  }
}

async function handle(request: Request | null) {
  if (!request) return fail(undefined, "Unreadable request.");
  const id = typeof request.id === "string" ? request.id : undefined;
  if (request.op === "start" && id) return start(id);
  if (request.op === "stop" && id) return stop(id);
  if (request.op === "cancel" && id) return cancel(id);
  if (request.op === "transcribe" && id) return typeof request.path === "string" ? transcribeFile(id, request.path) : fail(id, "No file to transcribe.");
  fail(id, `Unknown request ${String(request.op)}.`);
}

function quit() {
  for (const child of children) child.kill("SIGKILL");
  process.exit(0);
}

process.once("SIGTERM", quit);
process.once("SIGINT", quit);

/** Requests run one at a time, in the order they arrive; a download runs beside them. */
let queue = Promise.resolve();
createInterface({ input: process.stdin })
  .on("line", (line) => {
    const request = parse(line);
    if (request?.op === "download") void download();
    else queue = queue.then(() => handle(request));
  })
  .on("close", () => { void queue.then(quit); });
