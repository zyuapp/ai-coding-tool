/**
 * Holding to talk, on macOS: a native helper records the microphone and runs Parakeet from the model
 * folder FluidAudio shares between apps, so a model another app downloaded is the one used here.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { DICTATION_UNSUPPORTED, MAX_DICTATION_AUDIO_BYTES, isDictationAudio } from "../domain/dictation.js";
import type { DictationModelStatus } from "../contracts/ipc.js";

/** The helper holds the model in memory, so it goes after this long without a hold. */
const IDLE_MS = 3 * 60_000;
const START_TIMEOUT_MS = 10_000;
const TRANSCRIBE_TIMEOUT_MS = 120_000;
const MODEL_FOLDER = "parakeet-tdt-0.6b-v2-coreml";
const MODEL_FILES = ["Preprocessor.mlmodelc", "Encoder.mlmodelc", "Decoder.mlmodelc", "JointDecision.mlmodelc"];
const MICROPHONE_DENIED = "AI Coding Tool can't hear you. Allow it in System Settings → Privacy & Security → Microphone.";
const UNREADABLE_RECORDING = "That recording is too long or unreadable.";

type HelperMessage =
  | { type: "model"; state: "ready" | "missing" | "downloading" | "failed"; message?: string }
  | { type: "started" | "cancelled"; id: string }
  | { type: "level"; id: string; value: number }
  | { type: "text"; id: string; text: string }
  | { type: "error"; id?: string; message: string };

type Waiter = { resolve: (value: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export type DictationHostOptions = {
  /** Where the built helper is. */
  helper: string;
  /** Asks for the microphone. A host without one can only transcribe recordings it is handed. */
  microphone?: () => Promise<boolean>;
  /** Where the model's files are; FluidAudio's shared folder unless named. */
  models?: string;
};

function sharedModelDirectory() {
  return path.join(os.homedir(), "Library", "Application Support", "FluidAudio", "Models", MODEL_FOLDER);
}

/** A phone's recording, checked to be the small WAV it says it is before it touches the disk. */
function wavBytes(audio: string): Buffer {
  if (!isDictationAudio(audio)) throw new Error(UNREADABLE_RECORDING);
  const bytes = Buffer.from(audio, "base64");
  if (bytes.length > MAX_DICTATION_AUDIO_BYTES || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(UNREADABLE_RECORDING);
  }
  return bytes;
}

/** One helper per process, started on first use and stopped after {@link IDLE_MS} idle, since it keeps the model in memory. */
export class DictationHost {
  private helper: ChildProcessWithoutNullStreams | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private recordingId: string | null = null;
  /** The microphone on its way up, which a release or cancel waits for before stopping it. */
  private starting: Promise<void> | null = null;
  private status: DictationModelStatus = { model: "unsupported" };
  private readonly waiters = new Map<string, Waiter>();
  private readonly modelListeners = new Set<(status: DictationModelStatus) => void>();
  private levelListener: ((level: number) => void) | null = null;

  constructor(private readonly options: DictationHostOptions) {}

  onDictationModel(listener: (status: DictationModelStatus) => void) {
    this.setStatus(this.readStatus());
    this.modelListeners.add(listener);
    listener(this.status);
    return () => { this.modelListeners.delete(listener); };
  }

  onDictationLevel(listener: (level: number) => void) {
    this.levelListener = listener;
    return () => { if (this.levelListener === listener) this.levelListener = null; };
  }

  async startDictation(id: string) {
    this.usable();
    if (!this.options.microphone) throw new Error("Holding to talk needs the desktop app.");
    if (this.recordingId) throw new Error("Dictation is already listening.");
    const microphone = this.options.microphone;
    this.recordingId = id;
    const started = (async () => {
      if (!await microphone()) throw new Error(MICROPHONE_DENIED);
      await this.request("start", id, START_TIMEOUT_MS);
    })();
    this.starting = started;
    try {
      await started;
    } catch (error) {
      if (this.recordingId === id) this.recordingId = null;
      throw error;
    } finally {
      if (this.starting === started) this.starting = null;
    }
  }

  async stopDictation(id: string) {
    if (this.recordingId !== id) throw new Error("Nothing is listening.");
    await this.starting?.catch(() => undefined);
    if (this.recordingId !== id) throw new Error("Nothing is listening.");
    this.recordingId = null;
    this.levelListener?.(0);
    return this.request("stop", id, TRANSCRIBE_TIMEOUT_MS);
  }

  async cancelDictation(id: string) {
    if (this.recordingId !== id) return;
    await this.starting?.catch(() => undefined);
    if (this.recordingId !== id) return;
    this.recordingId = null;
    this.levelListener?.(0);
    await this.request("cancel", id, START_TIMEOUT_MS).catch(() => undefined);
  }

  async downloadDictationModel() {
    if (this.readStatus().model === "unsupported") throw new Error(DICTATION_UNSUPPORTED);
    this.setStatus({ model: "downloading" });
    this.keepAlive();
    this.send({ op: "download" });
  }

  async transcribeAudio(audio: string) {
    this.usable();
    const bytes = wavBytes(audio);
    const folder = await mkdtemp(path.join(os.tmpdir(), "aic-dictation-"));
    const file = path.join(folder, "speech.wav");
    try {
      await writeFile(file, bytes, { mode: 0o600 });
      return await this.request("transcribe", randomUUID(), TRANSCRIBE_TIMEOUT_MS, { path: file });
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }

  stop() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.helper?.kill();
    this.helper = null;
  }

  private setStatus(next: DictationModelStatus) {
    if (next.model === this.status.model && next.message === this.status.message) return;
    this.status = next;
    for (const listener of this.modelListeners) listener(this.status);
  }

  /** What the disk says, without starting the helper. */
  private readStatus(): DictationModelStatus {
    if (process.platform !== "darwin" || process.arch !== "arm64") return { model: "unsupported", message: DICTATION_UNSUPPORTED };
    if (!existsSync(this.options.helper)) return { model: "unsupported", message: "This build of the app has no dictation helper." };
    if (this.status.model === "downloading") return this.status;
    const folder = this.options.models ?? sharedModelDirectory();
    return MODEL_FILES.every((file) => existsSync(path.join(folder, file))) ? { model: "ready" } : { model: "missing" };
  }

  private usable() {
    const current = this.readStatus();
    this.setStatus(current);
    if (current.model !== "ready") throw new Error(current.message ?? "The speech model is not ready.");
  }

  private settle(id: string, outcome: { text: string } | { error: string }) {
    const waiter = this.waiters.get(id);
    if (!waiter) return;
    this.waiters.delete(id);
    clearTimeout(waiter.timer);
    if ("text" in outcome) waiter.resolve(outcome.text);
    else waiter.reject(new Error(outcome.error));
  }

  private heard(message: HelperMessage) {
    switch (message.type) {
      case "model":
        this.setStatus(message.state === "failed" ? { model: "failed", message: message.message ?? "The speech model could not be downloaded." } : { model: message.state });
        return;
      case "level":
        if (message.id === this.recordingId) this.levelListener?.(message.value);
        return;
      case "started":
      case "cancelled":
        this.settle(message.id, { text: "" });
        return;
      case "text":
        this.settle(message.id, { text: message.text });
        return;
      case "error":
        if (message.id) this.settle(message.id, { error: message.message });
        else console.warn("Dictation helper:", message.message);
    }
  }

  private ensureHelper(): ChildProcessWithoutNullStreams {
    if (this.helper) return this.helper;
    const child = spawn(this.options.helper, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.helper = child;
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        this.heard(JSON.parse(line) as HelperMessage);
      } catch {
        console.warn("Dictation helper said something unreadable.");
      }
    });
    child.stderr.resume();
    const gone = (reason: string) => {
      if (this.helper !== child) return;
      this.helper = null;
      this.recordingId = null;
      if (this.status.model === "downloading") this.setStatus({ model: "failed", message: reason });
      for (const id of [...this.waiters.keys()]) this.settle(id, { error: reason });
    };
    child.on("error", (error) => gone(`The dictation helper could not run: ${error.message}`));
    child.on("exit", () => gone("The dictation helper stopped."));
    return child;
  }

  private send(request: Record<string, string>) {
    this.ensureHelper().stdin.write(`${JSON.stringify(request)}\n`);
  }

  private keepAlive() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.recordingId || this.waiters.size || this.status.model === "downloading") return this.keepAlive();
      this.helper?.kill();
      this.helper = null;
    }, IDLE_MS);
  }

  private request(op: string, id: string, timeoutMs: number, extra: Record<string, string> = {}): Promise<string> {
    this.keepAlive();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.settle(id, { error: "Dictation took too long." }), timeoutMs);
      this.waiters.set(id, { resolve, reject, timer });
      this.send({ op, id, ...extra });
    });
  }
}

/** What a runtime asks of dictation, from the host `host` answers with when first asked. */
export function dictationDesktop(host: () => DictationHost) {
  return {
    onDictationModel: (listener: (status: DictationModelStatus) => void) => host().onDictationModel(listener),
    startDictation: (id: string) => host().startDictation(id),
    stopDictation: (id: string) => host().stopDictation(id),
    cancelDictation: (id: string) => host().cancelDictation(id),
    downloadDictationModel: () => host().downloadDictationModel(),
    transcribeAudio: (audio: string) => host().transcribeAudio(audio),
  };
}
