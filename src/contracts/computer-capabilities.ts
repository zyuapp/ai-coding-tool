import type { AppCommand } from "./commands.js";
import { computerQueryDefinitions, type ComputerQuery } from "./computers.js";
import { workspaceCommandDefinitions } from "./workspace-view-input.js";

/** Capability names are open strings on the wire: a peer may know names this build has never seen.
 * Undefined identifies hosts from before capability discovery, which keep best-effort behavior. */
export type ComputerCapabilities = readonly string[] | undefined;

export const COMPUTER_CAPABILITIES: readonly string[] = [
  ...workspaceCommandDefinitions().flatMap(({ type, fields }) => [
    `command:${type}`, ...fields.map((field) => `command:${type}:${field}`),
  ]),
  ...computerQueryDefinitions().flatMap(({ kind, fields }) => [
    `query:${kind}`, ...fields.map((field) => `query:${kind}:${field}`),
  ]),
];

export const REMOTE_UNSUPPORTED = "This feature is unavailable on that computer. Updating AI Coding Tool there may help.";

const indexes = new WeakMap<readonly string[], ReadonlySet<string>>();

function supports(capabilities: ComputerCapabilities, names: readonly string[]): boolean {
  if (capabilities === undefined) return true;
  let index = indexes.get(capabilities);
  if (!index) { index = new Set(capabilities); indexes.set(capabilities, index); }
  return names.every((name) => index.has(name));
}

function requirements(prefix: string, value: object, discriminator: string): string[] {
  return [prefix, ...Object.entries(value).filter(([key, value]) => key !== discriminator && value !== undefined).map(([key]) => `${prefix}:${key}`)];
}

/** Shared by routing, controls and the socket. A new option cannot silently disappear on an old host. */
export function supportsComputerCommand(capabilities: ComputerCapabilities, command: AppCommand): boolean {
  return supports(capabilities, requirements(`command:${command.type}`, command, "type"));
}

export function supportsComputerAction(capabilities: ComputerCapabilities, type: AppCommand["type"]): boolean {
  return supports(capabilities, [`command:${type}`]);
}

export function supportsComputerQuery(capabilities: ComputerCapabilities, query: ComputerQuery): boolean {
  return supports(capabilities, requirements(`query:${query.kind}`, query, "kind"));
}
