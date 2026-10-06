import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { ThreadNotice } from "../../contracts/ipc.js";
import path from "node:path";
import type { WorkspaceCommandResult, WorkspaceInput } from "../../application/workspace-reducer.js";
import type { WorkspaceState } from "../../application/workspace-state.js";
import type { ComputerQuery } from "../../contracts/computers.js";
import { MAX_COMPUTER_NAME, type ComputerLink, type ComputerStatus, type DiscoveredComputer } from "../../domain/computers.js";
import { createComputerClient, type ComputerClient, type ComputerClientOptions } from "./computer-client.mjs";
import { discoverComputers, tailnetPeers, type TailnetPeer } from "./discovery.mjs";

/**
 * A computer this one has paired with, as kept on disk: the token is what gets this computer back
 * in, `name` is what that computer calls itself, and `label` is what the user here calls it instead.
 * `node` is Tailscale's stable ID for the machine, which finds it again when its tailnet name moves.
 */
type StoredComputer = { id: string; name: string; label?: string; host: string; node?: string; token: string; pairedAt: number };

/** `name` is what this computer calls itself when the user chose one; absent, it goes by the machine's. */
type Stored = { version: 1; name?: string; computers: StoredComputer[] };

type Held = StoredComputer & {
  capabilities?: readonly string[];
  client: ComputerClient;
  status: ComputerStatus;
  error: string | null;
  /** When the line last stopped being connected, so a long silence can ask Tailscale where the machine went. */
  downSince: number | null;
};

/** How long a pairing may wait on the other computer's answer. */
const PAIRING_TIMEOUT_MS = 20_000;
/** How long a computer is unreachable before Tailscale is asked whether it now goes by another name. */
const RELOCATE_AFTER_MS = 60_000;
/** How often Tailscale is asked at most, however many computers are down. */
const RELOCATE_EVERY_MS = 5 * 60_000;

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
  /** The machines on the tailnet. Tailscale's own list unless a test says otherwise. */
  peers?: () => Promise<TailnetPeer[]>;
};

function isStoredComputer(value: unknown): value is StoredComputer {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.name === "string" && (record.label === undefined || typeof record.label === "string")
    && (record.node === undefined || typeof record.node === "string") && typeof record.host === "string" && typeof record.token === "string" && typeof record.pairedAt === "number";
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

/** The code traded for a token over a line of its own, which is hung up once the trade is done. */
async function trade(connect: (options: ComputerClientOptions) => ComputerClient, host: string, deviceName: string, code: string) {
  let settle!: (outcome: { deviceId: string; token: string }) => void;
  let fail!: (error: Error) => void;
  const settled = new Promise<{ deviceId: string; token: string }>((resolve, reject) => { settle = resolve; fail = reject; });
  const timer = setTimeout(() => fail(new Error("The other computer did not answer the code in time.")), PAIRING_TIMEOUT_MS);
  const client = connect({
    host,
    deviceName,
    credential: { code },
    onStatus: (status, error) => { if (status === "offline") fail(new Error(error ?? "The other computer could not be reached.")); },
    onPaired: (deviceId, _deviceName, token) => settle({ deviceId, token }),
    onState: () => {},
  });
  try {
    return await settled;
  } finally {
    clearTimeout(timer);
    client.stop();
  }
}

/**
 * A machine re-registered or renamed on the tailnet keeps its node ID but answers to a new name,
 * and the old name is dialled in vain. Computers down long enough are looked up by that ID, and
 * `moved` is told the name Tailscale now gives; one paired before IDs were kept learns its ID by
 * name. `learn` looks up only for that, and is how a computer that just connected learns its ID.
 */
function createRelocator(held: Map<string, Held>, peers: () => Promise<TailnetPeer[]>, moved: (computer: Held, host: string) => void, changed: () => void) {
  let lookedAt = 0;
  let looking = false;
  return {
    /** The next look is not held back by the last one. */
    soon() { lookedAt = 0; },
    async relocate(learn = false) {
      const now = Date.now();
      const lost = [...held.values()].filter((computer) => learn ? !computer.node
        : computer.status !== "connected" && computer.downSince !== null && now - computer.downSince >= RELOCATE_AFTER_MS);
      if (!lost.length || looking || now - lookedAt < (learn ? 0 : RELOCATE_EVERY_MS)) return;
      looking = true;
      lookedAt = now;
      let found: TailnetPeer[];
      try {
        found = await peers();
      } catch {
        return;
      } finally {
        looking = false;
      }
      let change = false;
      for (const computer of lost) {
        if (held.get(computer.id) !== computer) continue;
        const peer = computer.node ? found.find((entry) => entry.id === computer.node) : found.find((entry) => entry.host === computer.host);
        if (!peer?.id) continue;
        if (!computer.node) {
          computer.node = peer.id;
          change = true;
        }
        if (peer.host === computer.host || [...held.values()].some((other) => other !== computer && other.host === peer.host)) continue;
        moved(computer, peer.host);
        change = true;
      }
      if (change) changed();
    },
  };
}

/**
 * The computers this one is paired with, and a line to each. Every change to who is paired or how
 * a line stands is pushed whole, and every state a computer publishes is pushed as it arrives.
 */
export function createComputerLinks(options: ComputerLinksOptions) {
  const held = new Map<string, Held>();
  const connect = options.connect ?? createComputerClient;
  const peers = options.peers ?? tailnetPeers;
  let ownName = readStored(options.file).name;
  let relocating: ReturnType<typeof setInterval> | null = null;
  const relocator = createRelocator(held, peers, (computer, host) => {
    computer.client.stop();
    const { id, name, label, node, token, pairedAt } = computer;
    hold({ id, name, ...(label ? { label } : {}), host, ...(node ? { node } : {}), token, pairedAt });
  }, () => { write(); announce(); });

  function write() {
    const stored: Stored = {
      version: 1,
      ...(ownName ? { name: ownName } : {}),
      computers: [...held.values()].map(({ id, name, label, host, node, token, pairedAt }) => ({ id, name, ...(label ? { label } : {}), host, ...(node ? { node } : {}), token, pairedAt })),
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
    return [...held.values()].map(({ id, name, label, host, status, error, pairedAt, capabilities }) => ({ id, name: label ?? name, host, status, error, pairedAt, capabilities }));
  }

  function announce() {
    options.onChanged(links());
  }

  function hold(computer: StoredComputer) {
    /** Set once the line exists, so a status from a line since replaced is not taken for this one's. */
    let client: ComputerClient | null = null;
    const entry: Held = {
      ...computer,
      status: "connecting",
      error: null,
      downSince: Date.now(),
      client: connect({
        host: computer.host,
        deviceName: options.deviceName,
        credential: { token: computer.token },
        onStatus: (status, error) => {
          const current = held.get(computer.id);
          if (!current || current.client !== client) return;
          if (status === "connected") current.downSince = null;
          else current.downSince ??= Date.now();
          if (current.status === status && current.error === error) return;
          current.status = status;
          current.error = error;
          announce();
          if (status === "connected" && !current.node) void relocator.relocate(true);
        },
        onPaired: () => {},
        onCapabilities: (capabilities) => {
          const current = held.get(computer.id);
          if (!current) return;
          current.capabilities = capabilities;
          announce();
        },
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
    client = entry.client;
    held.set(computer.id, entry);
    return entry;
  }

  return {
    start() {
      for (const computer of readStored(options.file).computers) if (!held.has(computer.id)) hold(computer);
      relocating ??= setInterval(() => { void relocator.relocate(); }, RELOCATE_AFTER_MS);
      relocating.unref?.();
      announce();
    },
    /**
     * Dials now: every computer, or the one named, whatever its backoff or a refusal had it waiting
     * on. What wakes the machine or the user's own asking comes through here.
     */
    reconnect(id?: string) {
      for (const computer of held.values()) if (!id || computer.id === id) computer.client.reconnect();
      relocator.soon();
      void relocator.relocate();
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
      const { deviceId, token } = await trade(connect, host, currentName(), code);
      hold({ id: deviceId, name, host, token, pairedAt: Date.now() });
      write();
      announce();
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
    /** Hangs up on every computer. They are no longer held, so nothing is shown as connected; `start` brings them back. */
    stop() {
      if (relocating) clearInterval(relocating);
      relocating = null;
      for (const computer of held.values()) computer.client.stop();
      held.clear();
      announce();
    },
  };
}

export type ComputerLinks = ReturnType<typeof createComputerLinks>;
