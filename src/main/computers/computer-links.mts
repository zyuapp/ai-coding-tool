import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { ThreadNotice } from "../../contracts/ipc.js";
import path from "node:path";
import type { WorkspaceCommandResult, WorkspaceInput } from "../../application/workspace-reducer.js";
import type { WorkspaceState } from "../../application/workspace-state.js";
import type { ComputerQuery } from "../../contracts/computers.js";
import type { ComputerLink, ComputerStatus, DiscoveredComputer } from "../../domain/computers.js";
import { createComputerClient, type ComputerClient, type ComputerClientOptions } from "./computer-client.mjs";
import { discoverComputers } from "./discovery.mjs";

/** A computer this one has paired with, as kept on disk: the token is what gets this computer back in. */
type StoredComputer = { id: string; name: string; host: string; token: string; pairedAt: number };

type Stored = { version: 1; computers: StoredComputer[] };

type Held = StoredComputer & { client: ComputerClient; status: ComputerStatus; error: string | null };

/** How long a pairing may wait on the other computer's answer. */
const PAIRING_TIMEOUT_MS = 20_000;

export type ComputerLinksOptions = {
  file: string;
  /** What this computer calls itself to the others. */
  deviceName: string;
  onChanged: (links: ComputerLink[]) => void;
  onState: (id: string, state: WorkspaceState) => void;
  onNotice: (id: string, notice: ThreadNotice) => void;
  /** How a line is opened. The real client unless a test dials a server of its own. */
  connect?: (options: ComputerClientOptions) => ComputerClient;
  discover?: () => Promise<DiscoveredComputer[]>;
};

function isStoredComputer(value: unknown): value is StoredComputer {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.name === "string" && typeof record.host === "string" && typeof record.token === "string" && typeof record.pairedAt === "number";
}

function readStored(file: string): StoredComputer[] {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Stored | null;
    return Array.isArray(parsed?.computers) ? parsed.computers.filter(isStoredComputer) : [];
  } catch {
    return [];
  }
}

/**
 * The computers this one is paired with, and a line to each. Every change to who is paired or how
 * a line stands is pushed whole, and every state a computer publishes is pushed as it arrives.
 */
export function createComputerLinks(options: ComputerLinksOptions) {
  const held = new Map<string, Held>();
  const connect = options.connect ?? createComputerClient;

  function write() {
    const stored: Stored = { version: 1, computers: [...held.values()].map(({ id, name, host, token, pairedAt }) => ({ id, name, host, token, pairedAt })) };
    mkdirSync(path.dirname(options.file), { recursive: true });
    const staging = `${options.file}.tmp`;
    writeFileSync(staging, JSON.stringify(stored), { mode: 0o600 });
    renameSync(staging, options.file);
  }

  function links(): ComputerLink[] {
    return [...held.values()].map(({ id, name, host, status, error, pairedAt }) => ({ id, name, host, status, error, pairedAt }));
  }

  function announce() {
    options.onChanged(links());
  }

  function hold(computer: StoredComputer) {
    const entry: Held = {
      ...computer,
      status: "connecting",
      error: null,
      client: connect({
        host: computer.host,
        deviceName: options.deviceName,
        credential: { token: computer.token },
        onStatus: (status, error) => {
          const current = held.get(computer.id);
          if (!current || (current.status === status && current.error === error)) return;
          current.status = status;
          current.error = error;
          announce();
        },
        onPaired: () => {},
        onState: (state) => options.onState(computer.id, state),
        onNotice: (notice) => options.onNotice(computer.id, notice),
      }),
    };
    held.set(computer.id, entry);
    return entry;
  }

  return {
    start() {
      for (const computer of readStored(options.file)) hold(computer);
      announce();
    },
    links,
    discover: () => (options.discover ?? discoverComputers)(),
    /** Trades the code for a token over a line of its own, then opens the computer's line with the token. */
    async pair(host: string, name: string, code: string) {
      if ([...held.values()].some((computer) => computer.host === host)) throw new Error(`${name} is already paired.`);
      let settle!: (outcome: { deviceId: string; token: string }) => void;
      let fail!: (error: Error) => void;
      const settled = new Promise<{ deviceId: string; token: string }>((resolve, reject) => { settle = resolve; fail = reject; });
      const timer = setTimeout(() => fail(new Error("The other computer did not answer the code in time.")), PAIRING_TIMEOUT_MS);
      const client = connect({
        host,
        deviceName: options.deviceName,
        credential: { code },
        onStatus: (status, error) => { if (status === "offline") fail(new Error(error ?? "The other computer could not be reached.")); },
        onPaired: (deviceId, _deviceName, token) => settle({ deviceId, token }),
        onState: () => {},
      });
      try {
        const { deviceId, token } = await settled;
        const computer: StoredComputer = { id: deviceId, name, host, token, pairedAt: Date.now() };
        hold(computer);
        write();
        announce();
      } finally {
        clearTimeout(timer);
        client.stop();
      }
    },
    async forget(id: string) {
      const computer = held.get(id);
      if (!computer) return;
      computer.client.stop();
      held.delete(id);
      write();
      announce();
    },
    send(id: string, inputs: WorkspaceInput[]): Promise<WorkspaceCommandResult> {
      const computer = held.get(id);
      if (!computer) return Promise.reject(new Error("That computer is no longer paired."));
      return computer.client.send(inputs);
    },
    query(id: string, query: ComputerQuery): Promise<unknown> {
      const computer = held.get(id);
      if (!computer) return Promise.reject(new Error("That computer is no longer paired."));
      return computer.client.query(query);
    },
    stop() {
      for (const computer of held.values()) computer.client.stop();
      held.clear();
    },
  };
}

export type ComputerLinks = ReturnType<typeof createComputerLinks>;
