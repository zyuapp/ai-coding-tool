import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CLI_INSTALL_PATH, CLI_SCRIPT, isCliScript, type CliStatus } from "../domain/cli.js";

const run = promisify(execFile);
const STAGING_PATH = path.join(tmpdir(), "aic-cli-install");

export async function cliStatus(): Promise<CliStatus> {
  if (process.platform !== "darwin") return { state: "unsupported", path: CLI_INSTALL_PATH };
  try {
    const contents = await readFile(CLI_INSTALL_PATH, "utf8");
    return { state: isCliScript(contents) ? "installed" : "conflict", path: CLI_INSTALL_PATH };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing", path: CLI_INSTALL_PATH };
    throw error;
  }
}

export async function installCli(): Promise<CliStatus> {
  requireDarwin();
  try {
    await mkdir(path.dirname(CLI_INSTALL_PATH), { recursive: true });
    await writeFile(CLI_INSTALL_PATH, CLI_SCRIPT, "utf8");
    await chmod(CLI_INSTALL_PATH, 0o755);
  } catch (error) {
    if (!isPermissionError(error)) throw error;
    await writeFile(STAGING_PATH, CLI_SCRIPT, "utf8");
    try {
      await elevate(`mkdir -p '${path.dirname(CLI_INSTALL_PATH)}' && cp '${STAGING_PATH}' '${CLI_INSTALL_PATH}' && chmod 755 '${CLI_INSTALL_PATH}'`);
    } finally {
      await rm(STAGING_PATH, { force: true });
    }
  }
  return cliStatus();
}

export async function uninstallCli(): Promise<CliStatus> {
  requireDarwin();
  try {
    await rm(CLI_INSTALL_PATH, { force: true });
  } catch (error) {
    if (!isPermissionError(error)) throw error;
    await elevate(`rm -f '${CLI_INSTALL_PATH}'`);
  }
  return cliStatus();
}

function requireDarwin() {
  if (process.platform !== "darwin") throw new Error("The aic command can only be installed on macOS.");
}

function isPermissionError(error: unknown) {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM" || code === "EROFS";
}

/** /usr/local/bin belongs to root on a stock Mac, so writing there asks for the password once. */
async function elevate(command: string) {
  try {
    await run("/usr/bin/osascript", ["-e", `do shell script ${JSON.stringify(command)} with administrator privileges`]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/User canceled|-128/.test(message)) throw new Error("Cancelled.");
    throw new Error(message.trim() || "The command could not be installed.");
  }
}
