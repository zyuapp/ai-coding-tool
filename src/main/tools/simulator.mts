import { z } from "zod";
import type { SimulatorRead, SimulatorReadResult, SimulatorWrite } from "../../contracts/threads.js";
import type { CoordinationRole } from "../../domain/coordination.js";
import { MAX_SIMULATOR_TEXT, MAX_SWIPE_MS, SIMULATOR_ORIENTATIONS, simulatorLabel, type SimulatorElement, type SimulatorSnapshot } from "../../domain/simulator.js";
import { bindTools, defineTool, type ToolDefinition } from "./tool-definition.mjs";
import type { ToolServer } from "./tool-server.mjs";

export const SIMULATOR_SERVER_NAME = "aicodingtool-simulator";

/** The device the thread's own Simulator panel shows: writes are commands, reads are the screen. */
export type SimulatorBridge = {
  command(write: SimulatorWrite): Promise<void>;
  read(read: SimulatorRead): Promise<SimulatorReadResult>;
};

/** A first boot of a fresh device can take minutes; one already up answers at once. */
const BOOT_WAIT_MS = 240_000;
/** Long enough for a tap's animation to land before the screen is read back. */
const SETTLE_MS = 400;
const MAX_DEPTH_INDENT = 8;

const point = (axis: string) => z.number().min(0).max(10_000).describe(`${axis} in points from the screen's top left, as simulator_read measures it.`);

function elementLine(element: SimulatorElement) {
  const [x, y, width, height] = element.frame;
  const label = element.label === undefined ? "" : ` ${JSON.stringify(element.label)}`;
  const value = element.value === undefined ? "" : ` = ${JSON.stringify(element.value)}`;
  const identifier = element.identifier === undefined ? "" : ` #${element.identifier}`;
  return `${"  ".repeat(Math.min(element.depth, MAX_DEPTH_INDENT))}[${element.ref}] ${element.role}${label}${value}${identifier} (${x},${y} ${width}x${height})`;
}

function snapshotText(snapshot: SimulatorSnapshot) {
  return [
    `${snapshot.application ?? "Unknown app"} on ${snapshot.device} — screen ${snapshot.width}x${snapshot.height} points`,
    snapshot.elements.length ? snapshot.elements.map(elementLine).join("\n") : "The app on screen exposes no accessibility elements.",
  ].join("\n");
}

function readText(result: SimulatorReadResult) {
  if (result.kind === "no-simulator") return result.reason;
  if (result.kind === "status") {
    if (result.error) return `${simulatorLabel(result.device)} could not start: ${result.error}`;
    return result.booted ? `${simulatorLabel(result.device)} is running.` : `${simulatorLabel(result.device)} is still starting.`;
  }
  const shot = result.shot ? [`Screenshot saved to ${result.shot.path} (${result.shot.width}x${result.shot.height} pixels). Open that file to see the screen.`] : [];
  return [...shot, snapshotText(result.snapshot)].join("\n\n");
}

async function report(work: () => Promise<string>) {
  try {
    return { content: [{ type: "text" as const, text: await work() }] };
  } catch (error) {
    return { content: [{ type: "text" as const, text: `Simulator error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

/** Every gesture answers with the screen it left behind, read once the animation it started has landed. */
async function act(bridge: SimulatorBridge, write: SimulatorWrite) {
  await bridge.command(write);
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  return readText(await bridge.read({ op: "snapshot", screenshot: false }));
}

export const SIMULATOR_TOOLS: readonly ToolDefinition<SimulatorBridge>[] = [
  defineTool({
    name: "simulator_open",
    description: [
      "Start an iOS simulator in the AICodingTool Simulator panel and wait until it is running. It runs headless, so the user keeps using their computer while you test.",
      "Answers with the device's UDID: build for it with `xcodebuild -destination 'id=<UDID>'`, then `xcrun simctl install <UDID> <path.app>` and `xcrun simctl launch <UDID> <bundle id>`.",
    ].join(" "),
    input: {
      device: z.string().max(200).optional().describe("A device name such as \"iPhone 17 Pro\", or a UDID. Defaults to the device the panel already shows, else one that is running, else the newest iPhone."),
    },
    readOnly: false,
    run: (bridge, args) => report(async () => {
      await bridge.command({ type: "simulator.open", ...(args.device ? { device: args.device } : {}) });
      const status = await bridge.read({ op: "status", timeoutMs: BOOT_WAIT_MS });
      if (status.kind !== "status" || !status.booted) throw new Error(readText(status));
      return `${readText(status)} UDID: ${status.device.udid}. Read the screen with simulator_read.`;
    }),
  }),
  defineTool({
    name: "simulator_read",
    description: "Read the simulator's screen: the app on screen as accessibility elements, each with a ref, its role, label, value and frame in points, plus a screenshot file. Refs are only valid until the next read of the screen.",
    input: {
      screenshot: z.boolean().optional().describe("Also save a screenshot to look at. Defaults to true."),
    },
    readOnly: true,
    run: (bridge, args) => report(async () => readText(await bridge.read({ op: "snapshot", screenshot: args.screenshot !== false }))),
  }),
  defineTool({
    name: "simulator_tap",
    description: "Tap the simulator's screen, on an element by the ref the latest simulator_read gave it, or at a point. Answers with the elements on screen afterwards.",
    input: {
      ref: z.string().max(64).optional().describe("The element's ref from the latest simulator_read."),
      x: point("Horizontal position").optional(),
      y: point("Vertical position").optional(),
    },
    readOnly: false,
    run: (bridge, args) => report(async () => {
      if (args.ref) return act(bridge, { type: "simulator.input", input: { kind: "tap-element", ref: args.ref } });
      if (args.x === undefined || args.y === undefined) throw new Error("Give a ref, or both x and y.");
      return act(bridge, { type: "simulator.input", input: { kind: "tap", x: args.x, y: args.y, points: true } });
    }),
  }),
  defineTool({
    name: "simulator_swipe",
    description: "Drag a finger across the simulator's screen from one point to another, to scroll, swipe between pages, or pull down. Answers with the elements on screen afterwards.",
    input: {
      x: point("Starting horizontal position"),
      y: point("Starting vertical position"),
      toX: point("Ending horizontal position"),
      toY: point("Ending vertical position"),
      durationMs: z.number().min(50).max(MAX_SWIPE_MS).optional().describe("How long the drag takes. Defaults to 300; shorter flings further."),
    },
    readOnly: false,
    run: (bridge, args) => report(() => act(bridge, {
      type: "simulator.input",
      input: { kind: "swipe", x: args.x, y: args.y, toX: args.toX, toY: args.toY, points: true, ...(args.durationMs === undefined ? {} : { durationMs: args.durationMs }) },
    })),
  }),
  defineTool({
    name: "simulator_type",
    description: "Type text into whatever field has the keyboard in the simulator; tap the field first. Only characters on a US keyboard can be typed. Answers with the elements on screen afterwards.",
    input: {
      text: z.string().min(1).max(MAX_SIMULATOR_TEXT - 1).describe("The text to type."),
      submit: z.boolean().optional().describe("Press Return afterwards."),
    },
    readOnly: false,
    run: (bridge, args) => report(() => act(bridge, { type: "simulator.input", input: { kind: "type", text: args.submit ? `${args.text}\n` : args.text } })),
  }),
  defineTool({
    name: "simulator_button",
    description: "Press a hardware button on the simulator: home goes to the home screen, lock locks or wakes it. Answers with the elements on screen afterwards.",
    input: { button: z.enum(["home", "lock"]) },
    readOnly: false,
    run: (bridge, args) => report(() => act(bridge, { type: "simulator.input", input: { kind: "button", button: args.button } })),
  }),
  defineTool({
    name: "simulator_rotate",
    description: "Turn the simulator to portrait or landscape, to check how the app lays out each way. Answers with the elements on screen afterwards, measured the way the app now draws them.",
    input: { orientation: z.enum(SIMULATOR_ORIENTATIONS).describe("How to hold the device. landscape-left has the top of the screen on the left.") },
    readOnly: false,
    run: (bridge, args) => report(() => act(bridge, { type: "simulator.input", input: { kind: "rotate", orientation: args.orientation } })),
  }),
];

/** `readOnly` keeps only the read, for a run that may look at the device but never drive it. */
export function simulatorTools(bridge: SimulatorBridge, { readOnly = false } = {}) {
  return bindTools(bridge, readOnly ? SIMULATOR_TOOLS.filter((tool) => tool.readOnly) : SIMULATOR_TOOLS);
}

const SIMULATOR_INSTRUCTIONS = `To check an iOS app on a simulator, use the AICodingTool simulator tools: simulator_open starts a headless simulator in the Simulator panel and gives its UDID to build, install and launch on with xcodebuild and xcrun simctl; then simulator_read, simulator_tap, simulator_swipe, simulator_type and simulator_rotate drive it. Never open Simulator.app or drive it with computer use: the panel leaves the user's screen, mouse and focus alone.`;
const SIMULATOR_READING_INSTRUCTIONS = `Read the iOS simulator in the AICodingTool Simulator panel with simulator_read rather than guessing at it. Starting and driving it are work for a thread.`;

export const SIMULATOR_SERVER: ToolServer<{ simulator?: SimulatorBridge; coordinationRole?: CoordinationRole }> = {
  name: SIMULATOR_SERVER_NAME,
  definitions: SIMULATOR_TOOLS,
  /** Reading the simulator's screen changes nothing; booting it and tapping it do. */
  grants: "read-only",
  /** A coordinator reads the simulator's screen and never taps it. */
  serve: (run) => run.simulator ? simulatorTools(run.simulator, { readOnly: run.coordinationRole === "coordinator" }) : undefined,
  brief: (offers) => offers() ? [offers("simulator_open") ? SIMULATOR_INSTRUCTIONS : SIMULATOR_READING_INSTRUCTIONS] : [],
};
