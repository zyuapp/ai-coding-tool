import type { CliStatus } from "../domain/cli.js";

export type CliPort = {
  runtime: {
    /** Whether the `aic` terminal command is installed, and the path it takes. */
    cliStatus(): Promise<CliStatus>;
    /** Writes the command, asking for the administrator password when its directory needs one. */
    installCli(): Promise<CliStatus>;
    uninstallCli(): Promise<CliStatus>;
  };
};
