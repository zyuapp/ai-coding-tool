import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { ThreadNotice } from "../../contracts/ipc.js";
import path from "node:path";
import type { WorkspaceCommandResult, WorkspaceInput } from "../../application/workspace-reducer.js";
import type { WorkspaceState } from "../../application/workspace-state.js";
import type { ComputerQuery } from "../../contracts/computers.js";
import { MAX_COMPUTER_NAME, type ComputerLink, type ComputerStatus, type DiscoveredComputer } from "../../domain/computers.js";
import { createComputerClient, type ComputerClient, type ComputerClientOptions } from "./computer-client.mjs";
import { discoverComputers } from "./discovery.mjs";

/**
 * A computer this one has paired with, as kept on disk: the token is what gets this computer back
 * in, `name` is what that computer calls itself, and `label` is what the user here calls it instead.
 */
type StoredComputer = { id: string; name: string; label?: string; host: string; token: string; pairedAt: number };

/** `name` is what this computer calls itself when the user chose one; absent, it goes by the machine's. */
type Stored = { version: 1; name?: string; computers: StoredComputer[] };

type Held = StoredComputer & { client: ComputerClient; status: ComputerStatus; error: string | null };

/** How long a pairing may wait on the other computer's answer. */
const PAIRING_TIMEOUT_MS = 20_000;

export type ComputerLinksOptions = {
  file: string;
  /** What this computer calls itself to the others until the user chooses a name. */
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
  return typeof record.id === "string" && typeof record.name === "string" && (record.label === undefined || typeof record.label === "string")
    && typeof record.host === "string" && typeof record.token === "string" && typeof record.pairedAt === "number";
}

function readStored(file: string): Pick<Stored, "name" | "computers"> {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Stored | null;
    return {
      ...(typeof parsed?.name === "string" && parsed.name ? { name: parsed.name } : {}),
      computers: Array.isArray(parsed?.computers) ? parsed.computers.filter(isStoredComputer) : [],
    };
  } catch {
    return { computers: [] };
  }
}

/** What this computer calls itself, as kept in the links file, or the machine's own name when none was chosen. */
export function storedComputerName(file: string, fallback: string): string {
  return readStored(file).name ?? fallback;
}

/** A name as it is kept: trimmed and cut to length, so an empty one is no name at all. */
function chosen(name: string): string | undefined {
  const trimmed = name.trim().slice(0, MAX_COMPUTER_NAME);
  return trimmed || undefined;
}

/**
 * The computers this one is paired with, and a line to each. Every change to who is paired or how
 * a line stands is pushed whole, and every state a computer publishes is pushed as it arrives.
 */
export function createComputerLinks(options: ComputerLinksOptions) {
  const held = new Map<string, Held>();
  const connect = options.connect ?? createComputerClient;
  const stored = readStored(options.file);
  let ownName = stored.name;

  function write() {
    const stored: Stored = {
      version: 1,
      ...(ownName ? { name: ownName } : {}),
      computers: [...held.values()].map(({ id, name, label, host, token, pairedAt }) => ({ id, name, ...(label ? { label } : {}), host, token, pairedAt })),
    };
    mkdirSync(path.dirname(options.file), { recursive: true });
    const staging = `${options.file}.tmp`;
    writeFileSync(staging, JSON.stringify(stored), { mode: 0o600 });
    renameSync(staging, options.file);
  }

  function currentName(): string {
    return ownName ?? options.deviceName;
  }

  function links(): ComputerLink[] {
    return [...held.values()].map(({ id, name, label, host, status, error, pairedAt }) => ({ id, name: label ?? name, host, status, error, pairedAt }));
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
        /** What that computer now calls itself is kept, under whatever the user here calls it. */
        onName: (announced) => {
          const current = held.get(computer.id);
          if (!current || current.name === announced) return;
          current.name = announced;
          write();
          announce();
        },
      }),
    };
    held.set(computer.id, entry);
    return entry;
  }

  return {
    start() {
      for (const computer of stored.computers) hold(computer);
      announce();
    },
    name: currentName,
    links,
    /** What this computer calls itself from now on. Empty goes back to the machine's own name. */
    rename(next: string) {
      const chosenName = chosen(next);
      if (chosenName === ownName) return;
      ownName = chosenName;
      write();
      announce();
    },
    /** What the user here calls a paired computer. Empty, or its own name, goes back to what it announces. */
    label(id: string, next: string) {
      const computer = held.get(id);
      if (!computer) return;
      const chosenLabel = chosen(next);
      const label = chosenLabel === computer.name ? undefined : chosenLabel;
      if (label === computer.label) return;
      if (label === undefined) delete computer.label;
      else computer.label = label;
      write();
      announce();
    },
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
        deviceName: currentName(),
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
