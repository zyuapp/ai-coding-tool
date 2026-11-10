import type { Declarations } from "./command-declaration.js";

/**
 * The terminal command the app installs. Reading says whether it is there; installing and removing
 * answer with where it stands afterwards.
 */
export type CliCommand =
  | { type: "cli.read" }
  | { type: "cli.install" }
  | { type: "cli.uninstall" };

export const cliCommands = {
  "cli.read": { fields: {}, at: "local" },
  "cli.install": { fields: {}, at: "local" },
  "cli.uninstall": { fields: {}, at: "local" },
} satisfies Declarations<CliCommand>;
