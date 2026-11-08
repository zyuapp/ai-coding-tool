import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { app } from "electron";
import { ORIENTATION_CODES, untilted, type SimulatorAvailability, type SimulatorDevice, type SimulatorDeviceState, type SimulatorElement, type SimulatorFrame, type SimulatorInput, type SimulatorOrientation, type SimulatorShot, type SimulatorSnapshot } from "../domain/simulator.js";
import { FrameReader, type HelperMessage } from "./simulator-frames.js";

const run = promisify(execFile);

const REQUEST_TIMEOUT_MS = 15_000;
const BOOT_TIMEOUT_MS = 240_000;
const MAX_SHOTS = 20;
/** Roles worth listing even with nothing to say, since they are what a tap lands on. */
const ACTIONABLE_ROLES = new Set(["AXButton", "AXTextField", "AXSecureTextField", "AXTextArea", "AXSearchField", "AXSwitch", "AXCheckBox", "AXSlider", "AXLink", "AXCell", "AXMenuItem", "AXPopUpButton", "AXTab", "AXRadioButton", "AXIncrementor", "AXKey"]);

type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type Helper = { child: ChildProcessWithoutNullStreams; ready: Promise<void>; pending: Map<number, Pending> };
type Snapshot = { id: number; width: number; height: number; elements: SimulatorElement[] };
type Moves = { inFlight: boolean; next: { x: number; y: number } | null };

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
  if (process.platform !== "darwin") return { status: "unsupported", reason: "The simulator is only on macOS." };
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
  for (const device of devices) if (device.state !== "booted") orientations.delete(device.udid);
  return { availability, devices };
}

/** `bootstatus -b` boots a device that is down and waits until it is up, so one call covers both. */
export async function bootSimulator(udid: string) {
  await run("xcrun", ["simctl", "bootstatus", udid, "-b"], { timeout: BOOT_TIMEOUT_MS });
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

/** A drag streams moves faster than the device takes them, so only the newest waiting move is kept. */
async function move(udid: string, x: number, y: number) {
  const state = moves.get(udid) ?? { inFlight: false, next: null };
  moves.set(udid, state);
  if (state.inFlight) {
    state.next = { x, y };
    return;
  }
  state.inFlight = true;
  try {
    let point: { x: number; y: number } | null = { x, y };
    while (point) {
      state.next = null;
      await request({ op: "touch", udid, phase: "move", x: point.x, y: point.y });
      point = state.next;
    }
  } finally {
    state.inFlight = false;
  }
}

/**
 * A device keeps the way it was last turned, but this app only knows the turns it made itself. The
 * first time it uses a device after starting, it turns it upright so the picture and every tap agree.
 */
async function upright(udid: string) {
  if (orientations.has(udid)) return;
  await request({ op: "rotate", udid, orientation: ORIENTATION_CODES.portrait });
  orientations.set(udid, "portrait");
}

export async function simulatorInput(udid: string, input: SimulatorInput) {
  if (input.kind !== "rotate") await upright(udid);
  switch (input.kind) {
    case "touch":
      if (input.phase === "move") return move(udid, input.x, input.y);
      /** The touch lifts or lands where it says, so a move still waiting has nothing left to add. */
      if (moves.get(udid)) moves.get(udid)!.next = null;
      await request({ op: "touch", udid, phase: input.phase, x: input.x, y: input.y });
      return;
    case "tap": await request({ op: "tap", udid, ...await fractions(udid, input.x, input.y, input.points) }); return;
    case "tap-element": await request({ op: "tap", udid, ...elementCenter(udid, input.ref) }); return;
    case "swipe": {
      const from = await fractions(udid, input.x, input.y, input.points);
      const to = await fractions(udid, input.toX, input.toY, input.points);
      await request({ op: "swipe", udid, ...from, toX: to.x, toY: to.y, durationMs: input.durationMs ?? 300 }, REQUEST_TIMEOUT_MS + (input.durationMs ?? 0));
      return;
    }
    case "button": await request({ op: "button", udid, button: input.button }); return;
    case "type": await request({ op: "type", udid, text: input.text }, REQUEST_TIMEOUT_MS + input.text.length * 40); return;
    case "key": await request({ op: "key", udid, usage: input.usage, down: input.down }); return;
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
  screens.clear();
  snapshots.clear();
  helper?.child.kill();
  helper = null;
  const home = shotHome;
  shotHome = null;
  shots.length = 0;
  if (home) void home.then((folder) => rm(folder, { recursive: true, force: true })).catch(() => undefined);
}
