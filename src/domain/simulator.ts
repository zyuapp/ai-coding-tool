/** The iOS simulator panel: the devices this Mac has, and what a person or a run does to one. */

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
};

export const NO_SIMULATORS: SimulatorState = { availability: { status: "unknown" }, devices: [], booting: [], errors: {}, driver: null };

export type SimulatorButton = "home" | "lock";

/** Positions are fractions of the screen from its top left, so they hold whatever the device's size. */
export type SimulatorInput =
  | { kind: "touch"; phase: "down" | "move" | "up"; x: number; y: number }
  /** `points` measures the position in the screen's points from its top left instead of fractions. */
  | { kind: "tap"; x: number; y: number; points?: true }
  /** A tap on an element a read listed, named by the ref that read gave it. */
  | { kind: "tap-element"; ref: string }
  | { kind: "swipe"; x: number; y: number; toX: number; toY: number; durationMs?: number; points?: true }
  | { kind: "button"; button: SimulatorButton }
  | { kind: "type"; text: string }
  /** One key going down or up, by its USB HID usage, for a keyboard held over the panel. */
  | { kind: "key"; usage: number; down: boolean };

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

export function isSimulatorInput(value: unknown): value is SimulatorInput {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "touch": return (value.phase === "down" || value.phase === "move" || value.phase === "up") && fraction(value.x) && fraction(value.y);
    case "tap": return positioned(value, value.x, value.y);
    case "tap-element": return typeof value.ref === "string" && value.ref.length > 0 && value.ref.length <= 64;
    case "swipe": return positioned(value, value.x, value.y) && positioned(value, value.toX, value.toY)
      && (value.durationMs === undefined || (typeof value.durationMs === "number" && value.durationMs >= 0 && value.durationMs <= MAX_SWIPE_MS));
    case "button": return value.button === "home" || value.button === "lock";
    case "type": return typeof value.text === "string" && value.text.length > 0 && value.text.length <= MAX_SIMULATOR_TEXT;
    case "key": return Number.isInteger(value.usage) && (value.usage as number) > 0 && (value.usage as number) <= MAX_KEY_USAGE && typeof value.down === "boolean";
    default: return false;
  }
}

/** The device a panel shows when nobody has picked one: one already running, else the newest iPhone. */
export function defaultSimulator(devices: SimulatorDevice[]): SimulatorDevice | undefined {
  return devices.find((device) => device.state === "booted")
    ?? devices.find((device) => device.name.startsWith("iPhone"))
    ?? devices[0];
}

export function simulatorLabel(device: Pick<SimulatorDevice, "name" | "runtime">) {
  return `${device.name} · ${device.runtime}`;
}

/** Whether a gesture is one the agent makes rather than the drag a person's pointer streams. */
export function isDiscreteInput(input: SimulatorInput) {
  return input.kind !== "touch" && input.kind !== "key";
}

/** A piece of a device's screen stream: the H.264 decoder setup, or one encoded frame of it. */
export type SimulatorFrame =
  | { udid: string; kind: "config"; width: number; height: number; data: Uint8Array }
  | { udid: string; kind: "chunk"; key: boolean; timestamp: number; data: Uint8Array };

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const NAMED_KEYS: Record<string, number> = {
  Digit0: 39, Enter: 40, NumpadEnter: 40, Escape: 41, Backspace: 42, Tab: 43, Space: 44, Minus: 45, Equal: 46,
  BracketLeft: 47, BracketRight: 48, Backslash: 49, Semicolon: 51, Quote: 52, Backquote: 53, Comma: 54, Period: 55, Slash: 56,
  Delete: 76, ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82,
  ControlLeft: 224, ShiftLeft: 225, AltLeft: 226, ControlRight: 228, ShiftRight: 229, AltRight: 230,
};

/** The USB HID usage of a physical key, by `KeyboardEvent.code`, for the keys a phone's keyboard has. */
export function hidUsage(code: string): number | undefined {
  if (/^Key[A-Z]$/.test(code)) return 4 + LETTERS.indexOf(code.slice(3).toLowerCase());
  if (/^Digit[1-9]$/.test(code)) return 29 + Number(code.slice(5));
  return NAMED_KEYS[code];
}

/** The screen's corner radius as a fraction of its width: an iPad's corners are far tighter than a phone's. */
export function screenCornerRadius(name: string) {
  return name.startsWith("iPad") ? 0.024 : 0.137;
}
