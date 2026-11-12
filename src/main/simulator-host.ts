import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { app, clipboard } from "electron";
import { ORIENTATION_CODES, untilted, type SimulatorAvailability, type SimulatorDevice, type SimulatorDeviceState, type SimulatorElement, type SimulatorFrame, type SimulatorInput, type SimulatorOrientation, type SimulatorShot, type SimulatorSnapshot } from "../domain/simulator.js";
import { simulatorSupported } from "./platform-capabilities.js";
import { FrameReader, type HelperMessage } from "./simulator-frames.js";
import type { WindowCapability } from "./window-capability.js";

const run = promisify(execFile);

const REQUEST_TIMEOUT_MS = 15_000;
const BOOT_TIMEOUT_MS = 240_000;
const MAX_SHOTS = 20;
/** Roles worth listing even with nothing to say, since they are what a tap lands on. */
const ACTIONABLE_ROLES = new Set(["AXButton", "AXTextField", "AXSecureTextField", "AXTextArea", "AXSearchField", "AXSwitch", "AXCheckBox", "AXSlider", "AXLink", "AXCell", "AXMenuItem", "AXPopUpButton", "AXTab", "AXRadioButton", "AXIncrementor", "AXKey"]);

type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type Helper = { child: ChildProcessWithoutNullStreams; ready: Promise<void>; pending: Map<number, Pending> };
type Snapshot = { id: number; width: number; height: number; elements: SimulatorElement[] };
/** Where a touch is, with a second finger when it is a pinch. */
type Fingers = { x: number; y: number; x2?: number; y2?: number };
type Moves = { queued: boolean; next: Fingers | null };

let helper: Helper | null = null;
let unavailable: string | null = null;
let nextRequest = 1;
let nextSnapshot = 1;
let developerDir: Promise<string | null> | null = null;
let shotHome: Promise<string> | null = null;
const shots: string[] = [];
const watchers = new Map<string, number>();
const snapshots = new Map<string, Snapshot>();
const moves = new Map<string, Moves>();
/** Each device's screen in points, learned from its accessibility root. */
const screens = new Map<string, { width: number; height: number }>();
/** How each device is held, as the last rotation sent to it left it. */
const orientations = new Map<string, SimulatorOrientation>();
/** Devices this app started, which it also shuts down once nothing shows them. */
const startedHere = new Set<string>();
/** Devices whose input is already kept off the Mac's default microphone. */
const quieted = new Map<string, Promise<void>>();
/** What each device's pasteboard held when this app last read or set it. */
const pasteboards = new Map<string, string>();
/** Each device's inputs, one at a time in the order they came, so a key never overtakes a paste still being set up. */
const inputWork = new Map<string, Promise<unknown>>();
/** Each device's pasteboard work, one piece at a time, so a read never overtakes the write before it. */
const pasteboardWork = new Map<string, Promise<unknown>>();
let frameListener: ((frame: SimulatorFrame) => void) | null = null;

function helperPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "native", "aic-simulator")
    : path.join(app.getAppPath(), "dist", "native", "aic-simulator");
}

/** The Xcode the command line tools point at. Command line tools alone carry no simulators. */
function xcode() {
  return developerDir ??= run("xcode-select", ["-p"]).then(({ stdout }) => {
    const dir = stdout.trim();
    return dir && existsSync(path.join(dir, "Library", "PrivateFrameworks", "SimulatorKit.framework")) ? dir : null;
  }, () => null);
}

export async function simulatorAvailability(): Promise<SimulatorAvailability> {
  if (!simulatorSupported()) return { status: "unsupported", reason: "The simulator is only on macOS." };
  if (unavailable) return { status: "unsupported", reason: unavailable };
  if (!existsSync(helperPath())) return { status: "unsupported", reason: "This build of the app has no simulator helper." };
  if (!await xcode()) return { status: "unsupported", reason: "Install Xcode to use the simulator." };
  return { status: "available" };
}

function deviceState(state: string): SimulatorDeviceState {
  if (state === "Booted") return "booted";
  if (state === "Booting") return "booting";
  if (state === "Shutdown") return "shutdown";
  return "other";
}

/** "com.apple.CoreSimulator.SimRuntime.iOS-26-4" reads as "iOS 26.4". */
function runtimeName(identifier: string) {
  const [platform, ...version] = identifier.split(".").pop()!.split("-");
  return `${platform} ${version.join(".")}`;
}

function runtimeVersion(identifier: string) {
  return identifier.split(".").pop()!.split("-").slice(1).map(Number);
}

function newer(left: number[], right: number[]) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (right[index] ?? 0) - (left[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

/** iOS devices from the newest runtime down, iPhones before iPads within each. */
export function parseDeviceList(json: string): SimulatorDevice[] {
  const listed = JSON.parse(json) as { devices?: Record<string, { udid: string; name: string; state: string; isAvailable?: boolean }[]> };
  const runtimes = Object.keys(listed.devices ?? {}).filter((runtime) => runtime.includes(".SimRuntime.iOS-")).sort((left, right) => newer(runtimeVersion(left), runtimeVersion(right)));
  return runtimes.flatMap((runtime) => (listed.devices![runtime] ?? [])
    .filter((device) => device.isAvailable !== false)
    .sort((left, right) => Number(right.name.startsWith("iPhone")) - Number(left.name.startsWith("iPhone")))
    .map((device) => ({ udid: device.udid, name: device.name, runtime: runtimeName(runtime), state: deviceState(device.state) })));
}

export async function listSimulators(): Promise<{ availability: SimulatorAvailability; devices: SimulatorDevice[] }> {
  const availability = await simulatorAvailability();
  if (availability.status !== "available") return { availability, devices: [] };
  const { stdout } = await run("xcrun", ["simctl", "list", "devices", "available", "-j"], { maxBuffer: 16 * 1024 * 1024 });
  const devices = parseDeviceList(stdout);
  /** A device that went down boots again held upright. */
  for (const device of devices) {
    if (device.state === "booted") continue;
    orientations.delete(device.udid);
    quieted.delete(device.udid);
    pasteboards.delete(device.udid);
  }
  return { availability, devices };
}

/** `bootstatus -b` boots a device that is down and waits until it is up, so one call covers both. */
export async function bootSimulator(udid: string) {
  startedHere.add(udid);
  await run("xcrun", ["simctl", "bootstatus", udid, "-b"], { timeout: BOOT_TIMEOUT_MS });
  await quiet(udid);
}

/** A device this app started goes down; one started elsewhere is left running. */
export async function shutdownSimulator(udid: string) {
  if (!startedHere.delete(udid)) return;
  quieted.delete(udid);
  orientations.delete(udid);
  pasteboards.delete(udid);
  await run("xcrun", ["simctl", "shutdown", udid]).catch(() => undefined);
}

/** Keeps a running device off the headset in use, once per boot. Sound still works if this fails. */
function quiet(udid: string) {
  let pending = quieted.get(udid);
  if (!pending) {
    pending = request({ op: "quiet-audio", udid }).then(() => undefined, (error: unknown) => {
      quieted.delete(udid);
      console.error(`[simulator] audio input left on the default device: ${error instanceof Error ? error.message : String(error)}`);
    });
    quieted.set(udid, pending);
  }
  return pending;
}

function fail(current: Helper, error: Error) {
  for (const pending of current.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  current.pending.clear();
}

function deliver(current: Helper, message: HelperMessage, markReady: () => void, markUnavailable: (reason: string) => void) {
  if (message.kind === "frame") {
    frameListener?.(message.frame);
    return;
  }
  const json = message.json;
  if (json.event === "ready") return markReady();
  if (json.event === "unavailable") return markUnavailable(typeof json.reason === "string" ? json.reason : "The simulator is unavailable.");
  if (typeof json.id !== "number") return;
  const pending = current.pending.get(json.id);
  if (!pending) return;
  current.pending.delete(json.id);
  clearTimeout(pending.timer);
  if (json.ok === true) pending.resolve((json.result ?? {}) as Record<string, unknown>);
  else pending.reject(new Error(typeof json.error === "string" ? json.error : "The simulator refused that."));
}

/** One helper serves every device. A crash rejects what it held, and the next request starts another. */
async function started(): Promise<Helper> {
  if (helper) return helper;
  const dir = await xcode();
  if (!dir) throw new Error("Install Xcode to use the simulator.");
  const child = spawn(helperPath(), [dir], { stdio: ["pipe", "pipe", "pipe"] });
  let markReady!: () => void;
  let markFailed!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { markReady = resolve; markFailed = reject; });
  const current: Helper = { child, ready, pending: new Map() };
  helper = current;
  const reader = new FrameReader((message) => deliver(current, message, markReady, (reason) => {
    unavailable = reason;
    markFailed(new Error(reason));
  }));
  child.stdout.on("data", (chunk: Buffer) => reader.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => console.error(`[simulator] ${chunk.toString().trimEnd()}`));
  child.on("error", (error) => markFailed(error));
  child.on("exit", () => {
    if (helper === current) helper = null;
    quieted.clear();
    const error = new Error("The simulator helper stopped.");
    markFailed(error);
    fail(current, error);
    /** Streams a view still watches pick up again in a new helper. */
    if (watchers.size) {
      setTimeout(() => {
        for (const [udid, count] of watchers) {
          for (let index = 0; index < count; index += 1) void request({ op: "watch", udid }).catch(() => undefined);
        }
      }, 500);
    }
  });
  await ready;
  return current;
}

async function request(body: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Record<string, unknown>> {
  const current = await started();
  const id = nextRequest++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      current.pending.delete(id);
      reject(new Error("The simulator did not answer in time."));
    }, timeoutMs);
    current.pending.set(id, { resolve, reject, timer });
    current.child.stdin.write(`${JSON.stringify({ id, ...body })}\n`);
  });
}

function ratio(value: number) {
  return Math.min(1, Math.max(0, value));
}

/** The middle of an element from the latest read of this device; a ref from any older read is refused. */
function elementCenter(udid: string, ref: string) {
  const snapshot = snapshots.get(udid);
  const [readId, index] = ref.split(".").map(Number);
  if (!snapshot || readId !== snapshot.id) throw new Error(`The ref ${ref} is from an older read of the screen. Read it again, then tap.`);
  const element = snapshot.elements.find((item) => item.ref === ref);
  if (!element || index === undefined) throw new Error(`The latest read has no element ${ref}.`);
  const [x, y, width, height] = element.frame;
  return onDevice(udid, ratio((x + width / 2) / snapshot.width), ratio((y + height / 2) / snapshot.height), snapshot);
}

async function screenPoints(udid: string) {
  const known = screens.get(udid);
  if (known) return known;
  const result = await request({ op: "describe", udid });
  const frame = (Array.isArray(result.elements) ? result.elements[0] as RawElement | undefined : undefined)?.frame;
  if (!frame?.[2] || !frame[3]) throw new Error("Could not measure the simulator's screen.");
  const size = { width: frame[2], height: frame[3] };
  screens.set(udid, size);
  return size;
}

/**
 * A point as the app on screen measures it, moved onto the device's portrait screen. An app drawn
 * sideways measures from the turned screen's corner; one that stayed upright, such as the home screen
 * on a turned phone, measures from the device's own.
 */
function onDevice(udid: string, u: number, v: number, screen: { width: number; height: number }) {
  const orientation = orientations.get(udid) ?? "portrait";
  return screen.width > screen.height ? untilted(u, v, orientation) : { x: u, y: v };
}

/** A position as fractions of the screen, from points when it was given in points. */
async function fractions(udid: string, x: number, y: number, points: boolean | undefined) {
  if (!points) return { x, y };
  const screen = await screenPoints(udid);
  return onDevice(udid, ratio(x / screen.width), ratio(y / screen.height), screen);
}

function inTurn<Value>(queue: Map<string, Promise<unknown>>, udid: string, work: () => Promise<Value>): Promise<Value> {
  const turn = (queue.get(udid) ?? Promise.resolve()).then(work, work);
  const settled = turn.catch(() => undefined);
  queue.set(udid, settled);
  void settled.then(() => { if (queue.get(udid) === settled) queue.delete(udid); });
  return turn;
}

/** A drag streams moves faster than the device takes them, so a move waiting its turn only ever sends the newest position. */
function move(udid: string, fingers: Fingers) {
  const state = moves.get(udid) ?? { queued: false, next: null };
  moves.set(udid, state);
  state.next = fingers;
  if (state.queued) return Promise.resolve();
  state.queued = true;
  return inTurn(inputWork, udid, async () => {
    state.queued = false;
    const next = state.next;
    state.next = null;
    if (next) await request({ op: "touch", udid, phase: "move", ...next });
  });
}

const COMMAND_KEY = 227;
const KEY_C = 6;
const KEY_V = 25;
const KEY_X = 27;
/** `simctl` reads and writes the pasteboard in the locale's encoding, which an app opened from the Finder leaves unset. */
const UTF8_ENV = { ...process.env, LANG: "en_US.UTF-8" };
/** How long the device takes to handle a paste; a key that reaches it sooner loses the paste or meets a paste prompt. */
const PASTE_SETTLE_MS = 300;
/** How long a copy on the device may take to reach its pasteboard. */
const COPY_WAIT_MS = 1_500;
const COPY_POLL_MS = 100;

function pasteboardTurn<Value>(udid: string, work: () => Promise<Value>): Promise<Value> {
  return inTurn(pasteboardWork, udid, work);
}

async function readPasteboard(udid: string) {
  const { stdout } = await run("xcrun", ["simctl", "pbpaste", udid], { env: UTF8_ENV, timeout: REQUEST_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

async function writePasteboard(udid: string, text: string) {
  await new Promise<void>((resolve, reject) => {
    const child = execFile("xcrun", ["simctl", "pbcopy", udid], { env: UTF8_ENV, timeout: REQUEST_TIMEOUT_MS }, (error) => error ? reject(error) : resolve());
    child.stdin?.end(text);
  });
  pasteboards.set(udid, text);
}

/** Presses ⌘ around one key, letting go of it even when the device refuses the key. Other modifiers are the keyboard's own, already held. */
async function shortcut(udid: string, usage: number) {
  await request({ op: "key", udid, usage: COMMAND_KEY, down: true });
  try {
    await request({ op: "key", udid, usage, down: true });
    await request({ op: "key", udid, usage, down: false });
  } finally {
    await request({ op: "key", udid, usage: COMMAND_KEY, down: false }).catch(() => undefined);
  }
}

/** Puts text on the device's pasteboard and pastes it into whatever has the keyboard, holding the device's next input until the paste lands. */
async function paste(udid: string, text: string) {
  await pasteboardTurn(udid, async () => {
    await writePasteboard(udid, text);
    await shortcut(udid, KEY_V);
  });
  await delay(PASTE_SETTLE_MS);
}

/**
 * ⌘C or ⌘X on the device, then what it copied onto the Mac's clipboard once it reaches the device's
 * pasteboard. A copy that changes nothing, such as one with nothing selected, leaves the Mac's clipboard
 * alone; so does copying the very text the device's pasteboard already holds.
 */
async function copyOut(udid: string, usage: number) {
  const before = await inTurn(inputWork, udid, async () => {
    const current = await pasteboardTurn(udid, () => readPasteboard(udid));
    await shortcut(udid, usage);
    return current;
  });
  await pasteboardTurn(udid, async () => {
    for (const until = Date.now() + COPY_WAIT_MS; Date.now() < until;) {
      await delay(COPY_POLL_MS);
      const text = await readPasteboard(udid);
      if (text === before) continue;
      pasteboards.set(udid, text);
      if (text) clipboard.writeText(text);
      return;
    }
  });
}

/** Notes what the device's pasteboard holds, and on leaving brings anything copied on the device since to the Mac. */
function syncPasteboard(udid: string, phase: "enter" | "leave") {
  return pasteboardTurn(udid, async () => {
    const text = await readPasteboard(udid);
    const known = pasteboards.get(udid);
    pasteboards.set(udid, text);
    if (phase === "leave" && known !== undefined && text && text !== known) clipboard.writeText(text);
  });
}

/**
 * Text a US keyboard cannot type, which is pasted whole instead: a paste among typed keys lands before
 * iOS has taken them and is lost or met with a paste prompt. Returns at its end are still pressed, so a
 * submit still submits. Null for text the keyboard types.
 */
export function pastedText(text: string): { paste: string; returns: string } | null {
  if (/^[\x20-\x7e\n\t]*$/.test(text)) return null;
  const paste = text.replace(/\n+$/, "");
  return { paste, returns: text.slice(paste.length) };
}

async function typeText(udid: string, text: string) {
  const pasted = pastedText(text);
  if (pasted) {
    await paste(udid, pasted.paste);
    if (!pasted.returns) return;
  }
  const typed = pasted ? pasted.returns : text;
  await request({ op: "type", udid, text: typed }, REQUEST_TIMEOUT_MS + typed.length * 40);
}

/**
 * A device keeps the way it was last turned, but this app only knows the turns it made itself. The
 * first time it uses a device after starting, it turns it upright so the picture and every tap agree,
 * even over a device someone left sideways in another tool. A device that will not turn is taken as
 * upright, so its taps still land.
 */
async function upright(udid: string) {
  if (orientations.has(udid)) return;
  orientations.set(udid, "portrait");
  await request({ op: "rotate", udid, orientation: ORIENTATION_CODES.portrait }).catch(() => undefined);
}

export function simulatorInput(udid: string, input: SimulatorInput): Promise<void> {
  if (input.kind === "pasteboard") return syncPasteboard(udid, input.phase);
  if (input.kind === "shortcut" && (input.usage === KEY_C || input.usage === KEY_X)) return copyOut(udid, input.usage);
  if (input.kind === "touch" && input.phase === "move") return move(udid, fingersOf(input));
  /** A finger landing or lifting ends what a waiting move may still be folded into, so the next drag's moves queue after it. */
  if (input.kind === "touch") moves.delete(udid);
  return inTurn(inputWork, udid, () => perform(udid, input));
}

function fingersOf(input: Extract<SimulatorInput, { kind: "touch" }>): Fingers {
  return { x: input.x, y: input.y, ...(input.x2 === undefined ? {} : { x2: input.x2, y2: input.y2 }) };
}

async function perform(udid: string, input: Exclude<SimulatorInput, { kind: "pasteboard" }>) {
  if (input.kind !== "rotate") await upright(udid);
  switch (input.kind) {
    case "touch": await request({ op: "touch", udid, phase: input.phase, ...fingersOf(input) }); return;
    case "tap": await request({ op: "tap", udid, ...await fractions(udid, input.x, input.y, input.points) }); return;
    case "tap-element": await request({ op: "tap", udid, ...elementCenter(udid, input.ref) }); return;
    case "swipe": {
      const from = await fractions(udid, input.x, input.y, input.points);
      const to = await fractions(udid, input.toX, input.toY, input.points);
      await request({ op: "swipe", udid, ...from, toX: to.x, toY: to.y, durationMs: input.durationMs ?? 300 }, REQUEST_TIMEOUT_MS + (input.durationMs ?? 0));
      return;
    }
    case "button": await request({ op: "button", udid, button: input.button }); return;
    case "type": await typeText(udid, input.text); return;
    case "key": await request({ op: "key", udid, usage: input.usage, down: input.down }); return;
    case "shortcut": await shortcut(udid, input.usage); return;
    case "paste": await paste(udid, input.text); return;
    case "rotate":
      await request({ op: "rotate", udid, orientation: ORIENTATION_CODES[input.orientation] });
      orientations.set(udid, input.orientation);
      /** The app redraws for the new way up, so what was read of it before no longer holds. */
      screens.delete(udid);
      snapshots.delete(udid);
      return;
  }
}

type RawElement = { role?: string; label?: string; value?: string; identifier?: string; frame?: number[]; depth?: number };

/** What a read lists: what has something to say or can be tapped, and is on the screen at all. */
function listed(element: RawElement, width: number, height: number) {
  const [x = 0, y = 0, w = 0, h = 0] = element.frame ?? [];
  if (w <= 0 || h <= 0 || x + w <= 0 || y + h <= 0 || x >= width || y >= height) return false;
  return Boolean(element.label || element.value || element.identifier) || ACTIONABLE_ROLES.has(element.role ?? "");
}

export async function describeSimulator(udid: string, device: string): Promise<SimulatorSnapshot> {
  await upright(udid);
  const result = await request({ op: "describe", udid });
  const raw = (Array.isArray(result.elements) ? result.elements : []) as RawElement[];
  const root = raw[0]?.frame;
  const width = root?.[2] ?? 0;
  const height = root?.[3] ?? 0;
  const id = nextSnapshot++;
  const elements = raw.slice(1).filter((element) => listed(element, width, height)).map((element, index): SimulatorElement => ({
    ref: `${id}.${index + 1}`,
    role: (element.role ?? "AXUnknown").replace(/^AX/, ""),
    ...(element.label ? { label: element.label } : {}),
    ...(element.value ? { value: element.value } : {}),
    ...(element.identifier ? { identifier: element.identifier } : {}),
    frame: (element.frame ?? [0, 0, 0, 0]).map((value) => Math.round(value)) as SimulatorElement["frame"],
    depth: Math.max(0, (element.depth ?? 1) - 1),
  }));
  snapshots.set(udid, { id, width, height, elements });
  if (width && height) screens.set(udid, { width, height });
  return {
    udid,
    device,
    ...(typeof result.application === "string" ? { application: result.application } : {}),
    width: Math.round(width),
    height: Math.round(height),
    elements,
  };
}

export async function captureSimulator(udid: string): Promise<SimulatorShot> {
  await upright(udid);
  shotHome ??= mkdtemp(path.join(tmpdir(), "aicodingtool-simulator-"));
  const file = path.join(await shotHome, `${randomUUID()}.png`);
  const result = await request({ op: "screenshot", udid, path: file });
  shots.push(file);
  while (shots.length > MAX_SHOTS) {
    const oldest = shots.shift();
    if (oldest) await unlink(oldest).catch(() => undefined);
  }
  return { path: file, width: Number(result.width), height: Number(result.height) };
}

export async function watchSimulator(udid: string) {
  watchers.set(udid, (watchers.get(udid) ?? 0) + 1);
  try {
    await upright(udid);
    void quiet(udid);
    await request({ op: "watch", udid });
  } catch (error) {
    await unwatchSimulator(udid);
    throw error;
  }
}

export async function unwatchSimulator(udid: string) {
  const count = (watchers.get(udid) ?? 0) - 1;
  if (count > 0) watchers.set(udid, count);
  else watchers.delete(udid);
  if (helper) await request({ op: "unwatch", udid }).catch(() => undefined);
}

export function startSimulatorHost(onFrame: (frame: SimulatorFrame) => void) {
  frameListener = onFrame;
}

export function stopSimulatorHost() {
  frameListener = null;
  watchers.clear();
  /** A new window starts with every device upright in its record, so the devices are turned to match when next used. */
  orientations.clear();
  quieted.clear();
  screens.clear();
  snapshots.clear();
  helper?.child.kill();
  helper = null;
  const home = shotHome;
  shotHome = null;
  shots.length = 0;
  if (home) void home.then((folder) => rm(folder, { recursive: true, force: true })).catch(() => undefined);
}

/** Devices this app started go down with it, finishing after the app has gone. */
function shutdownStarted() {
  for (const udid of startedHere) spawn("xcrun", ["simctl", "shutdown", udid], { detached: true, stdio: "ignore" }).unref();
  startedHere.clear();
}

export const simulatorCapability: WindowCapability = {
  start: ({ send }) => startSimulatorHost((frame) => send("simulator:frame", frame)),
  stopWithWindow: () => {
    stopSimulatorHost();
    shutdownStarted();
  },
  stopAtQuit: () => {
    stopSimulatorHost();
    shutdownStarted();
  },
};
