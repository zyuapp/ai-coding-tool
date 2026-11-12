/** The iOS simulator panel: the devices this Mac has, and what a person or a run does to one. */
import { rankedMatches } from "./match-rank.js";

export type SimulatorDeviceState = "booted" | "booting" | "shutdown" | "other";

export type SimulatorDevice = {
  udid: string;
  name: string;
  /** The runtime it runs, as Xcode names it, such as "iOS 26.4". */
  runtime: string;
  state: SimulatorDeviceState;
};

/** Whether this machine can run the panel at all, and why not when it cannot. */
export type SimulatorAvailability =
  | { status: "unknown" }
  | { status: "available" }
  | { status: "unsupported"; reason: string };

/**
 * The simulators this Mac has, kept for the whole app the way the browser session is. Which one a
 * dock shows is that dock's own, so one thread switching devices never moves another's taps.
 */
export type SimulatorState = {
  availability: SimulatorAvailability;
  devices: SimulatorDevice[];
  /** Devices a boot was asked for that has not answered yet. */
  booting: string[];
  /** What last went wrong with each device, until something done to it works. */
  errors: Record<string, string>;
  /** The run driving a device right now. `seq` names this stretch of driving, so an older idle report cannot end a newer one. */
  driver: { taskId: string; udid: string; seq: number } | null;
  /** How each device is turned, for a device anyone has turned since it booted. */
  orientations: Record<string, SimulatorOrientation>;
};

export const NO_SIMULATORS: SimulatorState = { availability: { status: "unknown" }, devices: [], booting: [], errors: {}, driver: null, orientations: {} };

export const SIMULATOR_ORIENTATIONS = ["portrait", "landscape-left", "landscape-right", "portrait-upside-down"] as const;

/** How the device is held, named as UIDeviceOrientation names it. */
export type SimulatorOrientation = (typeof SIMULATOR_ORIENTATIONS)[number];

/** UIDeviceOrientation's own number for each. */
export const ORIENTATION_CODES: Record<SimulatorOrientation, number> = { "portrait": 1, "portrait-upside-down": 2, "landscape-left": 3, "landscape-right": 4 };

/** How far clockwise, in quarter turns, the panel turns the device's portrait picture so it reads upright. */
const QUARTER_TURNS: Record<SimulatorOrientation, number> = { "portrait": 0, "landscape-right": 1, "portrait-upside-down": 2, "landscape-left": 3 };
const BY_TURNS: SimulatorOrientation[] = ["portrait", "landscape-right", "portrait-upside-down", "landscape-left"];

export function screenTurns(orientation: SimulatorOrientation) {
  return QUARTER_TURNS[orientation];
}

/** The orientation after turning the device a quarter turn: clockwise for 1, counterclockwise for -1. */
export function turned(orientation: SimulatorOrientation, direction: 1 | -1): SimulatorOrientation {
  return BY_TURNS[(QUARTER_TURNS[orientation] + direction + 4) % 4]!;
}

/**
 * Where a point on the turned picture lands on the device's own portrait screen, both as fractions
 * from the top left. Touches always land on the portrait screen, however the device is held.
 */
export function untilted(u: number, v: number, orientation: SimulatorOrientation): { x: number; y: number } {
  switch (QUARTER_TURNS[orientation]) {
    case 1: return { x: v, y: 1 - u };
    case 2: return { x: 1 - u, y: 1 - v };
    case 3: return { x: 1 - v, y: u };
    default: return { x: u, y: v };
  }
}

export type SimulatorButton = "home" | "lock";

/** Positions are fractions of the screen from its top left, so they hold whatever the device's size. */
export type SimulatorInput =
  /** `x2` and `y2` place a second finger, for a pinch. */
  | { kind: "touch"; phase: "down" | "move" | "up"; x: number; y: number; x2?: number; y2?: number }
  /** `points` measures the position in the screen's points from its top left instead of fractions. */
  | { kind: "tap"; x: number; y: number; points?: true }
  /** A tap on an element a read listed, named by the ref that read gave it. */
  | { kind: "tap-element"; ref: string }
  | { kind: "swipe"; x: number; y: number; toX: number; toY: number; durationMs?: number; points?: true }
  | { kind: "button"; button: SimulatorButton }
  | { kind: "type"; text: string }
  /** One key going down or up, by its USB HID usage, for a keyboard held over the panel. */
  | { kind: "key"; usage: number; down: boolean }
  /** A ⌘ shortcut, by the HID usage of its key. ⌘C and ⌘X also bring what they copied to the Mac's clipboard. */
  | { kind: "shortcut"; usage: number }
  /** Text pasted from the Mac: it goes on the device's pasteboard, then ⌘V pastes it. */
  | { kind: "paste"; text: string }
  /**
   * A person's focus entering or leaving the screen. Entering notes what the device's pasteboard holds;
   * leaving brings anything copied on the device since to the Mac's clipboard.
   */
  | { kind: "pasteboard"; phase: "enter" | "leave" }
  | { kind: "rotate"; orientation: SimulatorOrientation };

/** One element of the app on screen, with its frame in points from the screen's top left. */
export type SimulatorElement = {
  ref: string;
  role: string;
  label?: string;
  value?: string;
  identifier?: string;
  frame: [x: number, y: number, width: number, height: number];
  depth: number;
};

export type SimulatorSnapshot = {
  udid: string;
  device: string;
  application?: string;
  /** The screen in points, which element frames and tap positions are measured in. */
  width: number;
  height: number;
  elements: SimulatorElement[];
};

export type SimulatorShot = { path: string; width: number; height: number };

export const MAX_SIMULATOR_TEXT = 2_000;
export const MAX_PASTE_TEXT = 100_000;
export const MAX_SWIPE_MS = 5_000;
/** The longest a key's HID usage code runs: the keyboard page ends at 0xE7. */
const MAX_KEY_USAGE = 0xe7;

const fraction = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The largest screen any simulator has, in points, with room to spare. */
const MAX_POINTS = 10_000;

function positioned(value: Record<string, unknown>, ...coordinates: unknown[]) {
  if (value.points === undefined) return coordinates.every(fraction);
  return value.points === true && coordinates.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate) && coordinate >= 0 && coordinate <= MAX_POINTS);
}

const keyUsage = (usage: unknown) => Number.isInteger(usage) && (usage as number) > 0 && (usage as number) <= MAX_KEY_USAGE;

/** Inputs that move text between the device and the Mac's clipboard, which only a person at the panel sends. */
export function usesMacClipboard(input: SimulatorInput) {
  return input.kind === "shortcut" || input.kind === "paste" || input.kind === "pasteboard";
}

export function isSimulatorInput(value: unknown): value is SimulatorInput {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "touch": return (value.phase === "down" || value.phase === "move" || value.phase === "up") && fraction(value.x) && fraction(value.y)
      && (value.x2 === undefined && value.y2 === undefined || fraction(value.x2) && fraction(value.y2));
    case "tap": return positioned(value, value.x, value.y);
    case "tap-element": return typeof value.ref === "string" && value.ref.length > 0 && value.ref.length <= 64;
    case "swipe": return positioned(value, value.x, value.y) && positioned(value, value.toX, value.toY)
      && (value.durationMs === undefined || (typeof value.durationMs === "number" && value.durationMs >= 0 && value.durationMs <= MAX_SWIPE_MS));
    case "button": return value.button === "home" || value.button === "lock";
    case "type": return typeof value.text === "string" && value.text.length > 0 && value.text.length <= MAX_SIMULATOR_TEXT;
    case "rotate": return SIMULATOR_ORIENTATIONS.includes(value.orientation as SimulatorOrientation);
    case "key": return keyUsage(value.usage) && typeof value.down === "boolean";
    case "shortcut": return keyUsage(value.usage);
    case "paste": return typeof value.text === "string" && value.text.length > 0 && value.text.length <= MAX_PASTE_TEXT;
    case "pasteboard": return value.phase === "enter" || value.phase === "leave";
    default: return false;
  }
}

/** The device a panel shows when its dock has none: the one last picked, else one already running, else the newest iPhone. */
export function defaultSimulator(devices: SimulatorDevice[], remembered: string | null = null): SimulatorDevice | undefined {
  return devices.find((device) => device.udid === remembered)
    ?? devices.find((device) => device.state === "booted")
    ?? devices.find((device) => device.name.startsWith("iPhone"))
    ?? devices[0];
}

export function simulatorLabel(device: Pick<SimulatorDevice, "name" | "runtime">) {
  return `${device.name} · ${device.runtime}`;
}

/** A piece of a device's screen stream: the H.264 decoder setup, or one encoded frame of it. */
export type SimulatorFrame =
  | { udid: string; kind: "config"; width: number; height: number; data: Uint8Array }
  | { udid: string; kind: "chunk"; key: boolean; timestamp: number; data: Uint8Array };

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const NAMED_KEYS: Record<string, number> = {
  Digit0: 39, Enter: 40, NumpadEnter: 40, Escape: 41, Backspace: 42, Tab: 43, Space: 44, Minus: 45, Equal: 46,
  BracketLeft: 47, BracketRight: 48, Backslash: 49, Semicolon: 51, Quote: 52, Backquote: 53, Comma: 54, Period: 55, Slash: 56,
  IntlBackslash: 100, Home: 74, PageUp: 75, Delete: 76, End: 77, PageDown: 78,
  ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82,
  NumpadDivide: 84, NumpadMultiply: 85, NumpadSubtract: 86, NumpadAdd: 87, Numpad0: 98, NumpadDecimal: 99, NumpadEqual: 103,
  ControlLeft: 224, ShiftLeft: 225, AltLeft: 226, ControlRight: 228, ShiftRight: 229, AltRight: 230,
};

/** The USB HID usage of a physical key, by `KeyboardEvent.code`, for the keys a phone's keyboard has. */
export function hidUsage(code: string): number | undefined {
  if (/^Key[A-Z]$/.test(code)) return 4 + LETTERS.indexOf(code.slice(3).toLowerCase());
  if (/^Digit[1-9]$/.test(code)) return 29 + Number(code.slice(5));
  if (/^Numpad[1-9]$/.test(code)) return 88 + Number(code.slice(6));
  return NAMED_KEYS[code];
}

/** The screen's corner radius as a fraction of its width: an iPad's corners are far tighter than a phone's. */
export function screenCornerRadius(name: string) {
  return name.startsWith("iPad") ? 0.024 : 0.137;
}

export type SimulatorGroup = { label: string; running: boolean; devices: SimulatorDevice[] };

/**
 * The devices a picker lists, narrowed by what is typed: the ones running first, then the rest under
 * the runtime they run, in the order the Mac lists them, newest runtime first.
 */
export function simulatorGroups(devices: SimulatorDevice[], query: string): SimulatorGroup[] {
  const ranked = rankedMatches(devices, query, (device) => [device.name, device.runtime, `${device.runtime} ${device.name}`]);
  /** A query that names a device outright puts it first, ahead of the longer names it is the start of. */
  const wanted = query.trim().toLowerCase();
  const exact = ranked.filter((device) => device.name.toLowerCase() === wanted);
  const matched = [...exact, ...ranked.filter((device) => !exact.includes(device))];
  const running = matched.filter((device) => device.state === "booted" || device.state === "booting");
  const groups: SimulatorGroup[] = running.length ? [{ label: "Running", running: true, devices: running }] : [];
  for (const device of matched) {
    if (running.includes(device)) continue;
    const group = groups.find((item) => !item.running && item.label === device.runtime);
    if (group) group.devices.push(device);
    else groups.push({ label: device.runtime, running: false, devices: [device] });
  }
  /** While searching, the group holding the best match leads, so Enter takes what heads the list. */
  if (wanted) groups.sort((left, right) => matched.indexOf(left.devices[0]!) - matched.indexOf(right.devices[0]!));
  return groups;
}
