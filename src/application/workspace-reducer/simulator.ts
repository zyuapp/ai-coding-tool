/** The Simulator panel: which device each dock shows, booting it, and the gestures sent to it. */
import { defaultSimulator, type SimulatorDevice } from "../../domain/simulator.js";
import { dockFor, dockOwner, SIMULATOR_PANEL, withDock, type ThreadDock } from "../workspace-dock.js";
import type { SimulatorState, WorkspaceState } from "../workspace-state.js";
import { focusDockTab, showDockTab } from "./dock-tabs.js";
import { settled } from "./shared.js";
import type { WorkspaceEffect, WorkspaceInput, WorkspaceTransition } from "./types.js";

export const SIMULATOR_INPUTS = [
  "simulator.open", "simulator.refresh", "simulator.select", "simulator.input",
  "simulator.listed", "simulator.booted", "simulator.failed", "simulator.refused", "simulator.idle",
] as const;
type SimulatorInput = Extract<WorkspaceInput, { type: (typeof SIMULATOR_INPUTS)[number] }>;

export const SIMULATOR_UNSUPPORTED = "The simulator needs Xcode on a Mac.";
export const SIMULATOR_NOT_OPEN = "Open the simulator first.";
export const SIMULATOR_STARTING = "The simulator is still starting.";

function withSimulator(state: WorkspaceState, patch: Partial<SimulatorState>): WorkspaceState {
  return { ...state, simulator: { ...state.simulator, ...patch } };
}

function withoutError(errors: Record<string, string>, udid: string) {
  if (!(udid in errors)) return errors;
  const { [udid]: _cleared, ...rest } = errors;
  return rest;
}

/** A refusal shown in the panel rather than the workspace banner, and answered to whoever asked. */
function refused(state: WorkspaceState, message: string): WorkspaceTransition {
  return { state, effects: [], result: { ok: false, message } };
}

function device(state: WorkspaceState, udid: string): SimulatorDevice | undefined {
  return state.simulator.devices.find((item) => item.udid === udid);
}

/** A device by its UDID, else by its name, newest runtime first. */
function named(state: WorkspaceState, name: string): SimulatorDevice | undefined {
  const wanted = name.trim().toLowerCase();
  return device(state, name) ?? state.simulator.devices.find((item) => item.udid.toLowerCase() === wanted || item.name.toLowerCase() === wanted);
}

/** Booting is idempotent on the Mac's side, so it is only skipped for a device already up or on its way. */
function boot(state: WorkspaceState, udid: string): WorkspaceTransition {
  const known = device(state, udid);
  if (known?.state === "booted" || state.simulator.booting.includes(udid)) return settled(state);
  const booting = withSimulator(state, { booting: [...state.simulator.booting, udid], errors: withoutError(state.simulator.errors, udid) });
  return settled(booting, [{ type: "simulator.boot", udid, followUp: true }]);
}

/** Shows the panel in a dock on the device it names. Only the user's own open brings the panel to the front. */
function openIn(state: WorkspaceState, owner: string, udid: string | null, byUser: boolean): WorkspaceTransition {
  const dock = dockFor(state, owner);
  const panels = dock.panels.includes(SIMULATOR_PANEL) ? dock.panels : [...dock.panels, SIMULATOR_PANEL];
  const placed = withDock(state, owner, { panels, simulatorId: udid });
  const shown = byUser ? focusDockTab(showDockTab(placed, owner, SIMULATOR_PANEL), owner, SIMULATOR_PANEL) : settled(placed);
  const listed: WorkspaceEffect[] = [{ type: "simulator.list" }];
  if (!udid) return settled(shown.state, [...listed, ...shown.effects]);
  const booted = boot(shown.state, udid);
  return settled(booted.state, [...listed, ...shown.effects, ...booted.effects]);
}

/** A dock showing the panel with nothing picked yet takes the default device once there is a list to pick from. */
function adoptDefaults(state: WorkspaceState): WorkspaceTransition {
  const fallback = defaultSimulator(state.simulator.devices);
  if (!fallback) return settled(state);
  let next = state;
  let effects: WorkspaceEffect[] = [];
  for (const [owner, dock] of Object.entries(state.docks) as [string, ThreadDock][]) {
    if (!dock.panels.includes(SIMULATOR_PANEL)) continue;
    const kept = dock.simulatorId && device(next, dock.simulatorId);
    if (kept) continue;
    next = withDock(next, owner, { simulatorId: fallback.udid });
    const booted = boot(next, fallback.udid);
    next = booted.state;
    effects = [...effects, ...booted.effects];
  }
  return settled(next, effects);
}

function patchDevice(state: WorkspaceState, udid: string, patch: Partial<SimulatorDevice>): SimulatorDevice[] {
  return state.simulator.devices.map((item) => item.udid === udid ? { ...item, ...patch } : item);
}

export function reduceSimulator(state: WorkspaceState, input: SimulatorInput): WorkspaceTransition {
  switch (input.type) {
    case "simulator.open": {
      if (state.simulator.availability.status === "unsupported") return refused(state, state.simulator.availability.reason);
      const owner = dockOwner(state, input.taskId);
      const picked = input.device === undefined ? undefined : named(state, input.device);
      if (input.device !== undefined && !picked) return refused(state, `No simulator is called ${input.device}.`);
      const udid = picked?.udid ?? dockFor(state, owner).simulatorId ?? defaultSimulator(state.simulator.devices)?.udid ?? null;
      return openIn(state, owner, udid, input.taskId === undefined);
    }

    case "simulator.refresh":
      return settled(state, [{ type: "simulator.list" }]);

    case "simulator.select": {
      if (!device(state, input.udid)) return settled(state);
      const owner = dockOwner(state);
      return boot(withDock(state, owner, { simulatorId: input.udid }), input.udid);
    }

    case "simulator.input": {
      const owner = dockOwner(state, input.taskId);
      const udid = input.udid ?? dockFor(state, owner).simulatorId;
      if (!udid) return refused(state, SIMULATOR_NOT_OPEN);
      const target = device(state, udid);
      /** A person's pointer over a device still starting goes nowhere; a run is told why. */
      if (target && target.state !== "booted") return input.taskId ? refused(state, SIMULATOR_STARTING) : settled(state);
      if (input.taskId === undefined) return settled(state, [{ type: "simulator.input", udid, input: input.input }]);
      const current = state.simulator.driver;
      const seq = (current?.seq ?? 0) + 1;
      const driver = { taskId: input.taskId, udid, seq };
      return settled(withSimulator(state, { driver }), [{ type: "simulator.input", udid, input: input.input, taskId: input.taskId, seq }]);
    }

    case "simulator.listed": {
      const booting = state.simulator.booting.filter((udid) => input.devices.some((item) => item.udid === udid && item.state !== "booted"));
      const listed = withSimulator(state, { availability: input.availability, devices: input.devices, booting });
      return adoptDefaults(listed);
    }

    case "simulator.booted":
      return settled(withSimulator(state, {
        devices: patchDevice(state, input.udid, { state: "booted" }),
        booting: state.simulator.booting.filter((udid) => udid !== input.udid),
        errors: withoutError(state.simulator.errors, input.udid),
      }));

    case "simulator.failed":
      return {
        state: withSimulator(state, {
          booting: state.simulator.booting.filter((udid) => udid !== input.udid),
          errors: { ...state.simulator.errors, [input.udid]: input.message },
        }),
        effects: [],
        result: { ok: false, message: input.message },
      };

    /** A gesture the device would not take: answered to whoever sent it, and never drawn over the panel. */
    case "simulator.refused":
      return refused(state, input.message);

    case "simulator.idle":
      return state.simulator.driver?.seq === input.seq ? settled(withSimulator(state, { driver: null })) : settled(state);
  }
}
