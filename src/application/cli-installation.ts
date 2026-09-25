import type { CliStatus } from "../domain/cli.js";

/**
 * The terminal command the app installs: where it stands, whether the window is busy changing it,
 * and what stopped the last try.
 */
export type CliState = {
  status: CliStatus | null;
  busy: boolean;
  error: string | null;
};

export const NO_CLI: CliState = { status: null, busy: false, error: null };
