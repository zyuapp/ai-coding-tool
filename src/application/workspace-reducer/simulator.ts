/** The Simulator panel: which device each dock shows, booting it, and the gestures sent to it. */
import { defaultSimulator, type SimulatorDevice, type SimulatorOrientation, type SimulatorState } from "../../domain/simulator.js";
import { dockFor, dockOwner, SIMULATOR_PANEL, type ThreadDock } from "../workspace-dock.js";
import type { WorkspaceState } from "../workspace-state.js";
import type { SimulatorSliceState } from "../state/simulator.js";
import type { WorkspaceCommandResult } from "../../contracts/workspace-result.js";
import { docksOf, editDock, focusDockTabIn, persistView, showDockTabIn, type DocksEdit } from "./dock-tabs.js";
import { afterward, type SliceTransition } from "./slice.js";
import type { WorkspaceEffect, WorkspaceInput } from "./types.js";
import type { SimulatorAvailability, SimulatorInput as SimulatorGesture } from "../../domain/simulator.js";

export const SIMULATOR_INPUTS = [
  "simulator.open", "simulator.refresh", "simulator.select", "simulator.input",
  "simulator.listed", "simulator.booted", "simulator.failed", "simulator.refused", "simulator.turned", "simulator.idle",
] as const;
type SimulatorInput = Extract<WorkspaceInput, { type: (typeof SIMULATOR_INPUTS)[number] }>;

/** What the Mac said about its simulators, and how a boot or a gesture went. */
export type SimulatorEvent =
  | { type: "simulator.listed"; availability: SimulatorAvailability; devices: SimulatorDevice[] }
  | { type: "simulator.booted"; udid: string }
  | { type: "simulator.failed"; udid: string; message: string }
  | { type: "simulator.refused"; message: string }
  /** A device took a rotation, which is when the panel starts drawing it that way up. */
  | { type: "simulator.turned"; udid: string; orientation: SimulatorOrientation }
  /** A run stopped driving a device a moment ago. `seq` names the stretch of driving that ended. */
  | { type: "simulator.idle"; seq: number };

/** The simulator panel's devices. `boot` answers once the device can take input. */
export type SimulatorEffect =
  | { type: "simulator.list" }
  | { type: "simulator.boot"; udid: string }
  /** `seq` is set for a run's gesture, whose driving ends a moment after the last one. */
  | { type: "simulator.input"; udid: string; input: SimulatorGesture; taskId?: string; seq?: number };

export const SIMULATOR_UNSUPPORTED = "The simulator needs Xcode on a Mac.";
export const SIMULATOR_NOT_OPEN = "Open the simulator first.";
export const SIMULATOR_STARTING = "The simulator is still starting.";

type Own = SimulatorSliceState;

/** What an input has made of the simulator and the docks so far, and the work it asks for. */
type Work = { sim: Own; docks: DocksEdit; effects: WorkspaceEffect[] };

function workOf(state: WorkspaceState): Work {
  return { sim: { simulator: state.simulator, simulatorDevice: state.simulatorDevice }, docks: docksOf(state), effects: [] };
}

/** The answer a piece of work comes to, naming only what it changed. */
function done(state: WorkspaceState, { sim, docks, effects }: Work, result?: WorkspaceCommandResult): SliceTransition<Own> {
  const ownChanged = sim.simulator !== state.simulator || sim.simulatorDevice !== state.simulatorDevice;
  const docksChanged = docks.view.docks !== state.docks || docks.view.dockFocus !== state.dockFocus;
  return { ...(ownChanged ? { patch: sim } : {}), ...(docksChanged ? { edits: [docks] } : {}), effects, ...(result ? { result } : {}) };
}

function withSimulator(sim: Own, patch: Partial<SimulatorState>): Own {
  return { ...sim, simulator: { ...sim.simulator, ...patch } };
}

function without<Value>(record: Record<string, Value>, udid: string) {
  if (!(udid in record)) return record;
  const { [udid]: _cleared, ...rest } = record;
  return rest;
}

/** The device picked or opened by name is the one a dock with none shows from then on, across launches. */
function remember(state: WorkspaceState, work: Work, udid: string): Work {
  if (work.sim.simulatorDevice === udid) return work;
  const sim = { ...work.sim, simulatorDevice: udid };
  return { ...work, sim, effects: [...work.effects, ...persistView(afterward(state, { patch: sim, edits: [work.docks] }))] };
}

function fallbackDevice(sim: Own) {
  return defaultSimulator(sim.simulator.devices, sim.simulatorDevice);
}

/** A refusal shown in the panel rather than the workspace banner, and answered to whoever asked. */
function refused(message: string): SliceTransition<Own> {
  return { result: { ok: false, message } };
}

function device(sim: Own, udid: string): SimulatorDevice | undefined {
  return sim.simulator.devices.find((item) => item.udid === udid);
}

/** A device by its UDID, else by its name, newest runtime first. */
function named(sim: Own, name: string): SimulatorDevice | undefined {
  const wanted = name.trim().toLowerCase();
  return device(sim, name) ?? sim.simulator.devices.find((item) => item.udid.toLowerCase() === wanted || item.name.toLowerCase() === wanted);
}

/** Booting is idempotent on the Mac's side, so it is only skipped for a device already up or on its way. */
function boot(work: Work, udid: string): Work {
  const { sim } = work;
  const known = device(sim, udid);
  if (known?.state === "booted" || sim.simulator.booting.includes(udid)) return work;
  const booting = withSimulator(sim, { booting: [...sim.simulator.booting, udid], errors: without(sim.simulator.errors, udid) });
  return { ...work, sim: booting, effects: [...work.effects, { type: "simulator.boot", udid, followUp: true }] };
}

/** Shows the panel in a dock on the device it names. Only the user's own open brings the panel to the front. */
function openIn(work: Work, owner: string, udid: string | null, byUser: boolean): Work {
  const dock = dockFor(work.docks.view, owner);
  const panels = dock.panels.includes(SIMULATOR_PANEL) ? dock.panels : [...dock.panels, SIMULATOR_PANEL];
  const placed = editDock(work.docks, owner, { panels, simulatorId: udid });
  const shown = byUser ? focusDockTabIn(showDockTabIn(placed, owner, SIMULATOR_PANEL), owner, SIMULATOR_PANEL) : { docks: placed, effects: [] };
  const listed: WorkspaceEffect[] = [{ type: "simulator.list" }];
  const opened = { ...work, docks: shown.docks, effects: [...work.effects, ...listed, ...shown.effects] };
  return udid ? boot(opened, udid) : opened;
}

/** A dock showing the panel with nothing picked yet takes the default device once there is a list to pick from. */
function adoptDefaults(work: Work): Work {
  const fallback = fallbackDevice(work.sim);
  if (!fallback) return work;
  let next = work;
  for (const [owner, dock] of Object.entries(work.docks.view.docks) as [string, ThreadDock][]) {
    if (!dock.panels.includes(SIMULATOR_PANEL)) continue;
    const kept = dock.simulatorId && device(next.sim, dock.simulatorId);
    if (kept) continue;
    next = boot({ ...next, docks: editDock(next.docks, owner, { simulatorId: fallback.udid }) }, fallback.udid);
  }
  return next;
}

function turn(sim: Own, udid: string, orientation: SimulatorOrientation): Own {
  if (sim.simulator.orientations[udid] === orientation) return sim;
  return withSimulator(sim, { orientations: { ...sim.simulator.orientations, [udid]: orientation } });
}

function patchDevice(sim: Own, udid: string, patch: Partial<SimulatorDevice>): SimulatorDevice[] {
  return sim.simulator.devices.map((item) => item.udid === udid ? { ...item, ...patch } : item);
}

export function reduceSimulator(state: WorkspaceState, input: SimulatorInput): SliceTransition<Own> {
  const work = workOf(state);
  const { sim } = work;
  switch (input.type) {
    case "simulator.open": {
      if (sim.simulator.availability.status === "unsupported") return refused(sim.simulator.availability.reason);
      const owner = dockOwner(state, input.taskId);
      const picked = input.device === undefined ? undefined : named(sim, input.device);
      if (input.device !== undefined && !picked) return refused(`No simulator is called ${input.device}.`);
      const udid = picked?.udid ?? dockFor(state, owner).simulatorId ?? fallbackDevice(sim)?.udid ?? null;
      const opened = openIn(work, owner, udid, input.taskId === undefined);
      return done(state, picked ? remember(state, opened, picked.udid) : opened);
    }

    case "simulator.refresh":
      return { effects: [{ type: "simulator.list" }] };

    case "simulator.select": {
      if (!device(sim, input.udid)) return {};
      const owner = dockOwner(state);
      return done(state, remember(state, boot({ ...work, docks: editDock(work.docks, owner, { simulatorId: input.udid }) }, input.udid), input.udid));
    }

    case "simulator.input": {
      const owner = dockOwner(state, input.taskId);
      const udid = input.udid ?? dockFor(state, owner).simulatorId;
      if (!udid) return refused(SIMULATOR_NOT_OPEN);
      const target = device(sim, udid);
      /** A person's pointer over a device still starting goes nowhere; a run is told why. */
      if (target && target.state !== "booted") return input.taskId ? refused(SIMULATOR_STARTING) : {};
      if (input.taskId === undefined) return { effects: [{ type: "simulator.input", udid, input: input.input }] };
      const seq = (sim.simulator.driver?.seq ?? 0) + 1;
      const driver = { taskId: input.taskId, udid, seq };
      return { patch: withSimulator(sim, { driver }), effects: [{ type: "simulator.input", udid, input: input.input, taskId: input.taskId, seq }] };
    }

    case "simulator.listed": {
      const booting = sim.simulator.booting.filter((udid) => input.devices.some((item) => item.udid === udid && item.state !== "booted"));
      /** A device that went down comes back up held upright. */
      const orientations = Object.fromEntries(Object.entries(sim.simulator.orientations).filter(([udid]) => input.devices.some((item) => item.udid === udid && item.state === "booted")));
      const listed = withSimulator(sim, { availability: input.availability, devices: input.devices, booting, orientations });
      return done(state, adoptDefaults({ ...work, sim: listed }));
    }

    case "simulator.booted":
      return {
        patch: withSimulator(sim, {
          devices: patchDevice(sim, input.udid, { state: "booted" }),
          orientations: device(sim, input.udid)?.state === "booted" ? sim.simulator.orientations : without(sim.simulator.orientations, input.udid),
          booting: sim.simulator.booting.filter((udid) => udid !== input.udid),
          errors: without(sim.simulator.errors, input.udid),
        }),
      };

    case "simulator.failed":
      return {
        patch: withSimulator(sim, {
          booting: sim.simulator.booting.filter((udid) => udid !== input.udid),
          errors: { ...sim.simulator.errors, [input.udid]: input.message },
        }),
        result: { ok: false, message: input.message },
      };

    /** A gesture the device would not take: answered to whoever sent it, and never drawn over the panel. */
    case "simulator.refused":
      return refused(input.message);

    case "simulator.turned":
      return done(state, { ...work, sim: turn(sim, input.udid, input.orientation) });

    case "simulator.idle":
      return sim.simulator.driver?.seq === input.seq ? { patch: withSimulator(sim, { driver: null }) } : {};
  }
}
